/**
 * TrackGap — Meta (Facebook) connector.
 *
 * Verified against developers.facebook.com on 2026-08-31:
 *
 * READ: Insights API returns AGGREGATES ONLY (per campaign x day). There is no
 * endpoint that lists individual conversions with an order ID — CAPI /events is
 * write-only. So unlike GA4 we cannot name the missing orders, only compare
 * daily counts. Untracked has the same limitation ("Daily conversion counts and
 * values from the account you link — nothing else").
 *
 * WRITE: Conversions API accepts server-side Purchase events. Meta's own docs
 * recommend using the order number as event_id, which is exactly what we have.
 * Hard limit: event_time may not be older than 7 DAYS — a single stale event
 * makes Meta reject the whole request. Since we run off the orders/create
 * webhook we are inside that window within seconds.
 *
 * AUTH: merchant pastes an access token generated in Events Manager. This
 * deliberately avoids Meta App Review — reading someone else's ad account via
 * OAuth would need Advanced access plus business verification.
 */
import crypto from "node:crypto";
import { db, encrypt, decrypt } from "./db.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta reports the same sale under several action types. Picking two that
 *  overlap double-counts every order, so the merchant chooses exactly one. */
export const PURCHASE_ACTION_TYPES = [
  { id: "offsite_conversion.fb_pixel_purchase",
    label: "Pixel / CAPI purchases (recommended)" },
  { id: "purchase", label: "Purchase" },
  { id: "omni_purchase", label: "Omni purchase (web + app + offline)" },
];

db.exec(`
CREATE TABLE IF NOT EXISTS meta_config (
  shop_id        INTEGER PRIMARY KEY REFERENCES shops(id),
  ad_account_id  TEXT,
  pixel_id       TEXT,
  token_enc      TEXT,
  action_type    TEXT DEFAULT 'offsite_conversion.fb_pixel_purchase',
  capi_enabled   INTEGER DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta_daily (
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  date        TEXT NOT NULL,
  conversions REAL,
  value       REAL,
  spend       REAL,
  PRIMARY KEY (shop_id, date)
);
`);

export function saveMetaConfig(shopId, cfg) {
  const prev = db.prepare("SELECT * FROM meta_config WHERE shop_id = ?").get(shopId);
  // Ciastkovy update nesmie zmazat token — vola sa aj bez neho (napr. pri
  // vybere ad uctu po OAuth prihlaseni).
  const tokenEnc = cfg.token !== undefined && cfg.token !== null
    ? encrypt(cfg.token)
    : (prev?.token_enc ?? null);

  db.prepare(`INSERT INTO meta_config
      (shop_id, ad_account_id, pixel_id, token_enc, action_type, capi_enabled)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(shop_id) DO UPDATE SET
        ad_account_id = excluded.ad_account_id,
        pixel_id      = excluded.pixel_id,
        token_enc     = excluded.token_enc,
        action_type   = excluded.action_type,
        capi_enabled  = excluded.capi_enabled`)
    .run(shopId,
         cfg.ad_account_id ?? prev?.ad_account_id ?? null,
         cfg.pixel_id ?? prev?.pixel_id ?? null,
         tokenEnc,
         cfg.action_type || prev?.action_type || "offsite_conversion.fb_pixel_purchase",
         cfg.capi_enabled ?? prev?.capi_enabled ?? 0);
}

export function metaConfig(shopId) {
  const r = db.prepare("SELECT * FROM meta_config WHERE shop_id = ?").get(shopId);
  if (!r) return null;
  return { ...r, token: r.token_enc ? decrypt(r.token_enc) : null };
}

/** Ad accounts the token can see — lets the merchant pick from a list. */
export async function listAdAccounts(token) {
  const r = await fetch(
    `${GRAPH}/me/adaccounts?fields=id,name,account_status,currency`
    + `&limit=100&access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return (j.data || []).map((a) => ({
    id: a.id, name: a.name, currency: a.currency,
    active: a.account_status === 1,
  }));
}

/**
 * Pixely, ktore token vidi. Merchant tak nemusi hladat Pixel ID rucne —
 * staci mu vlozit token a vybrat zo zoznamu.
 */
export async function listPixels(token, adAccountIds = []) {
  const out = [];
  const seen = new Set();

  // 1) pixely naviazane na reklamne ucty
  for (const acc of adAccountIds.slice(0, 10)) {
    try {
      const r = await fetch(
        `${GRAPH}/${acc}/adspixels?fields=id,name&limit=50`
        + `&access_token=${encodeURIComponent(token)}`);
      const j = await r.json();
      for (const p of j.data || []) {
        if (!seen.has(p.id)) { seen.add(p.id); out.push({ id: p.id, name: p.name }); }
      }
    } catch { /* ucet nemusi mat pixel */ }
  }

  // 2) pixely cez business ucty — token z Events Managera casto vidi len tieto
  if (!out.length) {
    try {
      const b = await fetch(`${GRAPH}/me/businesses?fields=id,name&limit=25`
        + `&access_token=${encodeURIComponent(token)}`);
      const bj = await b.json();
      for (const biz of bj.data || []) {
        const r = await fetch(`${GRAPH}/${biz.id}/owned_pixels?fields=id,name&limit=50`
          + `&access_token=${encodeURIComponent(token)}`);
        const j = await r.json();
        for (const p of j.data || []) {
          if (!seen.has(p.id)) { seen.add(p.id); out.push({ id: p.id, name: p.name }); }
        }
      }
    } catch { /* nemusi mat pravo na business */ }
  }
  return out;
}

/** Daily purchase counts and values. Aggregates only — Meta has nothing finer. */
export async function fetchDailyConversions(token, adAccountId, since, until,
                                            actionType) {
  const params = new URLSearchParams({
    time_range: JSON.stringify({ since, until }),
    time_increment: "1",
    fields: "spend,actions,action_values",
    level: "account",
    access_token: token,
  });
  const r = await fetch(`${GRAPH}/${adAccountId}/insights?${params}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);

  return (j.data || []).map((row) => {
    const pick = (list) =>
      parseFloat(list?.find((a) => a.action_type === actionType)?.value || 0);
    return {
      date: row.date_start,
      conversions: pick(row.actions),
      value: pick(row.action_values),
      spend: parseFloat(row.spend || 0),
    };
  });
}

const sha256 = (v) =>
  crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

/**
 * Send a Purchase event to Meta.
 *
 * event_id = order number, per Meta's own deduplication guidance: if the pixel
 * already sent the same order, Meta keeps one (48h window).
 *
 * We refuse to send when we have no identifier at all — an unmatched event
 * cannot be used for attribution or optimisation, so it is noise.
 */
export async function sendCapiPurchase(cfg, order, identity) {
  if (!cfg.pixel_id || !cfg.token) {
    return { sent: false, reason: "not_configured" };
  }

  const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 86400_000;
  if (ageDays > 7) {
    return { sent: false, reason: "older_than_7_days",
      note: "Meta rejects events with event_time older than 7 days — and a "
          + "single stale event makes it drop the whole request." };
  }

  const user = {};
  if (identity?.fbp) user.fbp = identity.fbp;
  if (identity?.fbc) user.fbc = identity.fbc;
  if (identity?.email) user.em = [sha256(identity.email)];
  if (identity?.phone) user.ph = [sha256(identity.phone)];
  if (identity?.ip) user.client_ip_address = identity.ip;
  if (identity?.user_agent) user.client_user_agent = identity.user_agent;

  if (!Object.keys(user).length) {
    return { sent: false, reason: "no_identifier",
      note: "No fbp/fbc or hashed contact detail — Meta could not match the "
          + "event to a person, so it would not count for attribution." };
  }

  const payload = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(new Date(order.created_at).getTime() / 1000),
      event_id: String(order.order_number || order.order_id),
      action_source: "website",
      event_source_url: identity?.event_source_url || order.landing_site || undefined,
      user_data: user,
      custom_data: {
        value: Number(order.total || 0),
        currency: order.currency || "EUR",
        order_id: String(order.order_id),
      },
    }],
  };

  const r = await fetch(
    `${GRAPH}/${cfg.pixel_id}/events?access_token=${encodeURIComponent(cfg.token)}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload) });
  const j = await r.json();
  if (j.error) return { sent: false, reason: "api_error", detail: j.error.message };
  return { sent: true, events_received: j.events_received ?? null };
}

export function storeDaily(shopId, rows) {
  const ins = db.prepare(`INSERT OR REPLACE INTO meta_daily
    (shop_id,date,conversions,value,spend) VALUES (?,?,?,?,?)`);
  db.transaction(() => rows.forEach((r) =>
    ins.run(shopId, r.date, r.conversions, r.value, r.spend)))();
}

/**
 * Compare Shopify orders against what Meta reports, per day.
 *
 * Caveat we surface in the UI rather than hide: Meta credits a conversion to
 * the day of the CLICK, not the day of the order, so day-level differences are
 * expected. Only a sustained gap is meaningful.
 */
export function compareDaily(shopId, days = 30) {
  return db.prepare(`
    SELECT d.date,
           COALESCE(o.orders, 0)      AS shopify_orders,
           COALESCE(o.revenue, 0)     AS shopify_revenue,
           d.conversions              AS meta_conversions,
           d.value                    AS meta_value,
           d.spend                    AS meta_spend
    FROM meta_daily d
    LEFT JOIN (
      SELECT substr(created_at,1,10) AS dt, COUNT(*) AS orders, SUM(total) AS revenue
      FROM orders WHERE shop_id = ? GROUP BY dt
    ) o ON o.dt = d.date
    WHERE d.shop_id = ? AND d.date >= date('now', '-${days} days')
    ORDER BY d.date`).all(shopId, shopId);
}
