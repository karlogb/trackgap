/**
 * TrackGap - GA4 Measurement Protocol.
 *
 * Backfills conversions that never reached GA4. Based on Google's docs:
 *
 * - client_id is REQUIRED. MP returns 2xx even when it drops an event and
 *   returns no error code. So without a client_id NOTHING is sent; otherwise
 *   we would claim to have recovered something that was actually lost.
 * - Session attribution only works if the event arrives within 24 h of the
 *   session start and includes session_id. Hence near-real-time via webhook,
 *   not a daily batch.
 * - Sending a conversion for a user who DECLINED consent violates Google
 *   policy and GDPR. No consent, no backfill.
 */
import { db, decrypt } from "./db.mjs";

const MP_URL = "https://www.google-analytics.com/mp/collect";
const DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";

/** Window in which backfilling makes sense (session attribution). */
const SESSION_WINDOW_H = 24;

export function canBackfill(order, identity) {
  if (!identity?.ga_client_id) {
    return { ok: false, reason: "no_client_id",
      note: "No GA4 client ID - there is nobody to attribute this conversion "
          + "to. Sending it anyway would corrupt your attribution." };
  }
  // Consent: the pixel stores "granted" | "denied" | "unknown".
  // `consent_denied` is a legacy shape that was never actually set.
  const consent = identity.consent || (identity.consent_denied ? "denied" : null);
  if (consent === "denied") {
    return { ok: false, reason: "consent_denied",
      note: "The customer declined consent. Sending this conversion would "
          + "breach GDPR and Google's terms." };
  }
  if (consent !== "granted") {
    // Better not to backfill than to backfill without provable consent. The
    // order stays in the report with a reason so the merchant sees the loss.
    return { ok: false, reason: "consent_unknown",
      note: "We cannot prove the visitor consented. Without that, we do not "
          + "send the conversion." };
  }
  const ageH = (Date.now() - new Date(order.created_at).getTime()) / 3600_000;
  if (ageH > SESSION_WINDOW_H) {
    return { ok: false, reason: "session_expired",
      note: `Order is ${ageH.toFixed(0)} h old. After 24 h the event `
          + "no longer matches the original visit and would be attributed as direct." };
  }
  return { ok: true };
}

function buildPayload(order, identity) {
  const items = (order.line_items || []).map((li, i) => ({
    item_id: String(li.sku || li.product_id || i),
    item_name: li.title || "item",
    price: parseFloat(li.price || 0),
    quantity: li.quantity || 1,
  }));

  const ev = {
    name: "purchase",
    params: {
      transaction_id: String(order.order_id),
      value: Number(order.total || 0),
      currency: order.currency || "EUR",
      shipping: Number(order.shipping || 0),
      tax: Number(order.tax || 0),
      // without session_id the event is not matched to the original visit
      ...(identity.ga_session_id ? { session_id: identity.ga_session_id } : {}),
      engagement_time_msec: 1,
      items: items.length ? items : undefined,
    },
  };

  return {
    client_id: identity.ga_client_id,
    ...(identity.user_id ? { user_id: identity.user_id } : {}),
    // order timestamp, so the event lands in the right session
    timestamp_micros: new Date(order.created_at).getTime() * 1000,
    non_personalized_ads: false,
    // Consent is reported based on what the pixel actually captured, NOT a
    // hard-coded GRANTED. Orders with "denied" never get here, canBackfill()
    // rejects them earlier; "unknown" is conservatively reported as DENIED
    // for personalisation.
    consent: {
      ad_user_data: identity?.consent === "granted" ? "GRANTED" : "DENIED",
      ad_personalization: identity?.consent === "granted" ? "GRANTED" : "DENIED",
    },
    events: [ev],
  };
}

/**
 * Validation via the debug endpoint. The production MP endpoint returns no
 * errors, so without this we would not know whether the payload is valid.
 */
export async function validate(measurementId, apiSecret, order, identity) {
  const url = `${DEBUG_URL}?measurement_id=${encodeURIComponent(measurementId)}`
            + `&api_secret=${encodeURIComponent(apiSecret)}`;
  const r = await fetch(url, {
    method: "POST",
    body: JSON.stringify(buildPayload(order, identity)),
  });
  const j = await r.json().catch(() => ({}));
  return {
    valid: !(j.validationMessages || []).length,
    messages: j.validationMessages || [],
  };
}

export async function sendPurchase(measurementId, apiSecret, order, identity) {
  const gate = canBackfill(order, identity);
  if (!gate.ok) return { sent: false, ...gate };

  // debug first: the production endpoint does not report errors
  const v = await validate(measurementId, apiSecret, order, identity);
  if (!v.valid) {
    return { sent: false, reason: "invalid_payload", messages: v.messages };
  }

  const url = `${MP_URL}?measurement_id=${encodeURIComponent(measurementId)}`
            + `&api_secret=${encodeURIComponent(apiSecret)}`;
  const r = await fetch(url, {
    method: "POST",
    body: JSON.stringify(buildPayload(order, identity)),
  });
  // MP returns 204 even for a dropped event, so success is NOT inferred from the status code alone
  return { sent: r.status === 204 || r.ok, status: r.status };
}

// The schema of these tables lives in db.mjs (single source of truth).
// They used to be defined here as well, so the resulting schema depended
// on import order.

/**
 * Stores an identity from the pixel.
 *
 * `row` must already have gone through sanitizeIdentity() in server.mjs: a
 * flat object with validated fields. The full raw payload is NO LONGER
 * stored; it was unnecessary ballast and data we never read.
 *
 * MERGES, DOES NOT OVERWRITE. Identity arrives in pieces and each event knows
 * something different: `page_viewed` brings the `_ga` client_id,
 * `checkout_completed` brings the token and order_id. The original
 * `INSERT OR REPLACE` overwrote a previously stored client_id with NULL, so
 * the order ended up without an identity, which is exactly what the app is
 * meant to solve.
 */
export function saveIdentity(shopId, row) {
  const id = row.identity || row;      // also accepts the legacy shape
  const sfcid = row.shopify_client_id || id.shopify_client_id || null;
  const token = row.checkout_token || null;
  const orderId = row.order_id || id.order_id || null;

  // Missing client_id but we know the Shopify clientId? Pull it from an
  // earlier record of the same visit; otherwise the conversion is unattributable.
  let gaClientId = id.ga_client_id || null;
  let gaSessionId = id.ga_session_id || null;
  if (sfcid && (!gaClientId || !gaSessionId)) {
    const prev = db.prepare(
      `SELECT ga_client_id, ga_session_id FROM identities
       WHERE shop_id=? AND shopify_client_id=?
         AND ga_client_id IS NOT NULL
       ORDER BY seen_at DESC LIMIT 1`).get(shopId, sfcid);
    gaClientId = gaClientId || prev?.ga_client_id || null;
    gaSessionId = gaSessionId || prev?.ga_session_id || null;
  }

  // Without a checkout_token there is no merge key (PK is shop_id+token and
  // NULL never equals NULL in SQLite). Such a record only marks "pixel is running".
  if (!token) {
    db.prepare(`INSERT INTO identities
      (shop_id,checkout_token,order_id,ga_client_id,ga_session_id,gclid,fbclid,
       consent,shopify_client_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(shopId, null, orderId, gaClientId, gaSessionId,
           id.gclid || null, id.fbclid || null, id.consent || null, sfcid);
    return;
  }

  db.prepare(`INSERT INTO identities
    (shop_id,checkout_token,order_id,ga_client_id,ga_session_id,gclid,fbclid,
     consent,shopify_client_id)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(shop_id,checkout_token) DO UPDATE SET
      order_id          = COALESCE(excluded.order_id,          identities.order_id),
      ga_client_id      = COALESCE(excluded.ga_client_id,      identities.ga_client_id),
      ga_session_id     = COALESCE(excluded.ga_session_id,     identities.ga_session_id),
      gclid             = COALESCE(excluded.gclid,             identities.gclid),
      fbclid            = COALESCE(excluded.fbclid,            identities.fbclid),
      consent           = COALESCE(excluded.consent,           identities.consent),
      shopify_client_id = COALESCE(excluded.shopify_client_id, identities.shopify_client_id),
      seen_at           = datetime('now')`)
    .run(shopId, token, orderId, gaClientId, gaSessionId,
         id.gclid || null, id.fbclid || null, id.consent || null, sfcid);
}

export function identityForOrder(shopId, orderId, checkoutToken, noteAttrs) {
  // 1) note_attributes from the order: the most reliable
  if (noteAttrs) {
    const get = (k) => noteAttrs.find?.((a) => a.name === k)?.value;
    const cid = get("__tg_cid");
    if (cid) {
      // Enrich note attributes from the server-side pixel record when
      // possible. Older carts don't contain __tg_consent, but their
      // checkout_started/purchase event can still have a trustworthy value.
      const stored = (checkoutToken && db.prepare(
        "SELECT * FROM identities WHERE shop_id=? AND checkout_token=?",
      ).get(shopId, checkoutToken)) || db.prepare(
        "SELECT * FROM identities WHERE shop_id=? AND order_id=?",
      ).get(shopId, String(orderId));
      return {
        ga_client_id: cid,
        ga_session_id: get("__tg_sid") || null,
        gclid: get("__tg_gclid") || null,
        fbclid: get("__tg_fbclid") || null,
        consent: get("__tg_consent") || stored?.consent || null,
        source: "note_attributes",
      };
    }
  }
  // 2) from the pixel by checkout_token
  const byToken = checkoutToken && db.prepare(
    "SELECT * FROM identities WHERE shop_id=? AND checkout_token=?",
  ).get(shopId, checkoutToken);
  if (byToken?.ga_client_id) return { ...byToken, source: "pixel_token" };

  // 3) by order_id
  const byOrder = db.prepare(
    "SELECT * FROM identities WHERE shop_id=? AND order_id=?",
  ).get(shopId, String(orderId));
  if (byOrder?.ga_client_id) return { ...byOrder, source: "pixel_order" };

  // 4) via Shopify clientId: same visit, different event.
  //    The order record may have a token and order_id but no `_ga`
  //    client_id (checkout runs on another domain where we cannot read the
  //    cookie). The client_id was seen earlier on `page_viewed` in the same
  //    visit; the Shopify `clientId` is the only key linking them.
  const anchor = byToken || byOrder;
  if (anchor?.shopify_client_id) {
    const byVisit = db.prepare(
      `SELECT * FROM identities
       WHERE shop_id=? AND shopify_client_id=? AND ga_client_id IS NOT NULL
       ORDER BY seen_at DESC LIMIT 1`).get(shopId, anchor.shopify_client_id);
    if (byVisit?.ga_client_id) {
      return {
        ...byVisit,
        // consent belongs to the order, not to an earlier page view
        consent: anchor.consent || byVisit.consent || null,
        source: "pixel_visit",
      };
    }
  }

  return null;
}

export function recordBackfill(shopId, orderId, status, reason, detail) {
  db.prepare(`INSERT INTO backfills (shop_id,order_id,status,reason,detail)
              VALUES (?,?,?,?,?)`)
    .run(shopId, String(orderId), status, reason || null,
         detail ? JSON.stringify(detail) : null);
}

export function backfillStats(shopId, days = 30) {
  return db.prepare(`
    SELECT status, reason, COUNT(*) AS n FROM backfills
    WHERE shop_id = ? AND created_at >= date('now', '-${days} days')
    GROUP BY status, reason ORDER BY n DESC`).all(shopId);
}
