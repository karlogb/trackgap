/**
 * TrackGap - HTTP server.
 *
 * Runs on loopback; a reverse proxy in front (e.g. Caddy) handles TLS.
 * No framework: OAuth + a few endpoints + one page.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
// Note: `shopToken` is deliberately NOT imported. Shopify only issues
// one-hour tokens, so every Admin API call must go through `validToken()`,
// which refreshes the token before use. A direct `shopToken()` silently
// returned an expired token after an hour and the call failed with 401.
import {
  db, upsertShop, shopTokenInfo, encrypt, decrypt,
  markAccessBroken, clearAccessBroken, markShopSessionSeen, isStaleUninstall,
} from "./db.mjs";
import {
  installUrl, exchangeToken, verifyOAuthHmac, verifyWebhookHmac,
  validShop, fetchOrders, config, shopInfo, ensureWebPixel,
  verifyProxySignature, refreshAccessToken, tokenExchange, gql,
} from "./shopify.mjs";
import {
  googleAuthUrl, googleExchange, accessToken, listProperties, fetchTransactions,
} from "./ga4.mjs";
import { reconcile } from "./reconcile.mjs";
import {
  getCached, getStale, setCached, invalidate, recordRun, detectRegressions,
  saveAlerts, history,
} from "./monitor.mjs";
import {
  saveIdentity, identityForOrder, canBackfill, sendPurchase,
  recordBackfill, backfillStats,
} from "./backfill.mjs";
import {
  saveMetaConfig, metaConfig, listAdAccounts, listPixels, fetchDailyConversions,
  storeDaily, compareDaily, sendCapiPurchase, PURCHASE_ACTION_TYPES,
} from "./meta.mjs";
import {
  PLANS, BILLING_CYCLES, cyclePrice, createSubscription, verifyBillingState,
  subscriptionMatchesExpected, waitForExpectedSubscription,
  reconcileSubscriptionUpdate, setPlan, currentPlan, checkLimit,
} from "./billing.mjs";
import {
  isOAuthConfigured, metaAppConfig, metaAuthUrl, metaExchange, longLivedToken,
  inspectToken, saveOAuthToken, oauthToken, disconnectByFbUser,
} from "./meta_oauth.mjs";
import { flushAlerts, sendTest } from "./alerts.mjs";
import { checkMailDomain } from "./mailcheck.mjs";
import { appUrl } from "./secrets.mjs";
import { authenticatedShop, devShopOverride, sessionTokenFrom } from "./auth.mjs";
import { startScheduler, runScheduledChecks } from "./scheduler.mjs";
import {
  recordPixelEvent, linkOrderToPixel, pixelActiveSince, purchasedOrderIds,
  pixelHealth,
} from "./pixel.mjs";
import { fetchAdsCampaigns, analyseAds, LIMITATIONS as ADS_LIMITS } from "./ads.mjs";

/**
 * Where to return after the OAuth callback.
 *
 * The embedded app lives inside the Shopify admin, so a relative
 * `/app?shop=…` resolves to `/apps/app?…` and ends in a 404. The correct
 * path is always `https://<shop>/admin/apps/<client_id>`.
 */
function adminAppUrl(shop, params = "") {
  const host = String(shop).replace(/\.myshopify\.com$/, "") + ".myshopify.com";
  const q = params ? `?${params}` : "";
  return `https://${host}/admin/apps/${config.client_id}${q}`;
}

const PORT = process.env.PORT || 9310;
const states = new Map();     // OAuth state -> {shop, ts}

// Background checks in progress: one store must never run two at once
// (it would waste GA4 quota and Shopify API limits).
const checksInFlight = new Map();   // shop_id -> Promise

function refreshInBackground(shop) {
  if (checksInFlight.has(shop.id)) return;
  const p = runCheck(shop)
    .catch((e) => console.error("bg check:", shop.shop_domain, e.message))
    .finally(() => checksInFlight.delete(shop.id));
  checksInFlight.set(shop.id, p);
}

/* ---------- /pixel/event protection ----------
   The endpoint is called from the storefront, so it cannot sit behind a
   session token. Without limits anyone could bloat the DB or attach a forged
   gclid to someone else's order and so rewrite conversion attribution. */
const PIXEL_MAX_BODY = 8 * 1024;          // 8 KB is plenty
const PIXEL_RATE_MAX = 60;                // requests per IP
const PIXEL_RATE_WINDOW = 60_000;         // per minute
const pixelHits = new Map();              // ip -> {count, resetAt}

function pixelRateOk(ip) {
  const now = Date.now();
  const rec = pixelHits.get(ip);
  if (!rec || now > rec.resetAt) {
    pixelHits.set(ip, { count: 1, resetAt: now + PIXEL_RATE_WINDOW });
    return true;
  }
  rec.count += 1;
  return rec.count <= PIXEL_RATE_MAX;
}

// the map must not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of pixelHits) if (now > r.resetAt) pixelHits.delete(ip);
}, 5 * 60_000).unref?.();

/**
 * Passes through only the fields we actually use, in the expected format.
 * Returns null if the payload has no usable identity; there is no point in
 * storing an empty row. The full raw payload is no longer stored.
 */
function sanitizeIdentity(p) {
  const id = p.identity || p;
  const str = (v, re, max = 128) => {
    if (typeof v !== "string") return null;
    const s = v.trim().slice(0, max);
    return s && (!re || re.test(s)) ? s : null;
  };

  const out = {
    checkout_token: str(p.checkout_token, /^[A-Za-z0-9._-]+$/, 128),
    order_id: str(p.order_id ?? id.order_id, /^[A-Za-z0-9/._-]+$/, 64),
    // GA4 client_id has the form <random>.<timestamp>
    ga_client_id: str(id.ga_client_id, /^\d+\.\d+$/, 64),
    ga_session_id: str(id.ga_session_id, /^\d+$/, 32),
    gclid: str(id.gclid, /^[A-Za-z0-9_-]+$/, 200),
    fbclid: str(id.fbclid, /^[A-Za-z0-9_.-]+$/, 200),
    consent: str(id.consent, /^(granted|denied|unknown)$/i, 16),
    // Shopify `clientId`: stable for the whole visit including checkout.
    // It is the only key that links `page_viewed` (has the `_ga` cookie,
    // no token) with `checkout_completed` (has the token, cannot read `_ga`).
    shopify_client_id: str(p.client_id_shopify ?? id.client_id_shopify,
                           /^[A-Za-z0-9._:-]+$/, 128),
  };

  // We also store a record WITHOUT identifiers if it is tied to an order or
  // checkout. A store may not use GA4 at all; then there is no `_ga` cookie
  // and no client_id to read. This record proves the pixel was running and
  // that the order genuinely has nothing to be attributed by (previously the
  // server returned 400 and the merchant could not tell "pixel not running"
  // from "pixel running, but nothing to capture").
  const anchored = out.checkout_token || out.order_id;
  const usable = out.ga_client_id || out.gclid || out.fbclid
    || out.shopify_client_id;
  return (usable || anchored) ? out : null;
}

/**
 * Pixel event as PROOF of measurement (third layer).
 *
 * sanitizeIdentity() handles identifiers for conversion backfill; this has a
 * different purpose: recording THAT the event left the browser. Hence its own
 * validation; amount and currency are never stored with identities.
 */
function sanitizePixelEvent(p) {
  const type = String(p.type || "");
  // store only what says something about the conversion
  if (!["purchase", "checkout_started"].includes(type)) return null;

  const token = typeof p.checkout_token === "string"
    && /^[A-Za-z0-9._-]{1,128}$/.test(p.checkout_token) ? p.checkout_token : null;
  const rawOrder = p.order_id ?? p.identity?.order_id;
  const orderId = typeof rawOrder === "string" || typeof rawOrder === "number"
    ? String(rawOrder).replace(/^gid:\/\/shopify\/Order\//, "").slice(0, 64)
    : null;
  if (!token && !orderId) return null;

  const total = Number(p.total);
  const consent = typeof p.identity?.consent === "string"
    && /^(granted|denied|unknown)$/i.test(p.identity.consent)
    ? p.identity.consent.toLowerCase() : null;

  return {
    event_type: type,
    checkout_token: token,
    order_id: orderId && /^[A-Za-z0-9._-]+$/.test(orderId) ? orderId : null,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    currency: typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency)
      ? p.currency : null,
    consent,
  };
}


setInterval(() => {
  const cut = Date.now() - 600_000;
  for (const [k, v] of states) if (v.ts < cut) states.delete(k);
}, 60_000).unref();

function send(res, code, body, type = "application/json") {
  const b = type === "application/json" ? JSON.stringify(body, null, 1) : body;
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` });
  res.end(b);
}

const DEFAULT_BODY_LIMIT = 64 * 1024;
const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024;

class PayloadTooLargeError extends Error {}

/**
 * The app lost access to a data source (Shopify token, Google account).
 *
 * A dedicated type so that lost access can be told apart from a real bug in
 * the code. The two have entirely different consequences: we fix bugs, but
 * ONLY the merchant can fix a disconnected account, so they must be told.
 * Previously both ended up as a 500 `internal error` and were indistinguishable.
 */
class AccessError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * The app is NOT SET UP yet: an onboarding step is missing.
 *
 * Deliberately NOT an AccessError. Lost access means "it worked and
 * stopped"; this means "it has not started yet". The merchant needs to hear
 * something entirely different, and the app must NOT record this as its own
 * failure; such a record would eventually turn into an alarm e-mail about
 * lost access that never happened.
 *
 * A freshly installed store is exactly the state in which a Shopify reviewer
 * sees the app. Previously `/check` returned 500 "internal error" there
 * (missing GA4 property), which looks like a broken app.
 */
class SetupError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

async function rawBody(req, maxBytes = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError("payload too large");
  }
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new PayloadTooLargeError("payload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);

  /**
   * Store domain verified by the session token. `?shop=` is NOT used for
   * authorization; before this change, knowing a store's domain was enough to
   * read its revenue and overwrite its Measurement ID.
   *
   * Returns null if the caller is not verified. Every merchant endpoint must
   * call requireShop() and respond with 401 on null.
   */
  const authShop = () => authenticatedShop(req, url) || devShopOverride(url);
  // Verified session token of this request. Passed to `validToken()` so it
  // can be exchanged for an access token under managed installation.
  const sessionToken = sessionTokenFrom(req, url);
  const requireShop = () => {
    const s = authShop();
    if (!s) {
      send(res, 401, {
        error: "unauthorized",
        detail: "Missing or invalid session token. Open the app from your "
              + "Shopify admin.",
      });
      return null;
    }
    if (sessionToken) markShopSessionSeen(s);
    return s;
  };

  try {
    // --- health ---
    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, ts: new Date().toISOString() });
    }

    // --- installation: /auth?shop=xyz.myshopify.com ---
    if (url.pathname === "/auth") {
      if (!validShop(q.shop)) return send(res, 400, { error: "invalid shop" });
      const state = crypto.randomBytes(16).toString("hex");
      states.set(state, { shop: q.shop, ts: Date.now() });
      res.writeHead(302, { Location: installUrl(q.shop, state) });
      return res.end();
    }

    // --- OAuth callback ---
    if (url.pathname === "/auth/callback") {
      if (!verifyOAuthHmac(q)) return send(res, 401, { error: "bad hmac" });
      const st = states.get(q.state);
      if (!st || st.shop !== q.shop) {
        return send(res, 401, { error: "bad state" });
      }
      states.delete(q.state);
      const t = await exchangeToken(q.shop, q.code);
      // Shopify only issues expiring tokens now, so the refresh_token is stored too
      upsertShop(q.shop, t.access_token, t.refresh_token || null,
                 t.expires_in || null, true);
      // Webhook subscriptions are app-managed in shopify.app.toml. Registering
      // them again per installation creates duplicate deliveries and lets a
      // failed background registration go unnoticed.
      // Activate the web pixel; without it we have no GA4 client_id.
      // The Measurement ID MUST be passed along: on reinstall it would otherwise
      // be overwritten with "not-set", the pixel would not find the _ga_<ID>
      // cookie and would stop sending.
      const mid = db.prepare(
        "SELECT mp_measurement_id FROM shops WHERE shop_domain=?",
      ).get(q.shop)?.mp_measurement_id || null;
      ensureWebPixel(q.shop, t.access_token, { measurementId: mid })
        .then((r) => console.log("web pixel:", JSON.stringify(r)))
        .catch((e) => console.error("web pixel:", e.message));

      // Store time zone right at install. The scheduler uses it to decide
      // when it is 7:00 in the store; without it the first daily check would
      // run in UTC, i.e. at an awkward hour for most of the world. Waiting
      // until someone opens the dashboard is not an option: precisely the
      // merchant who does not open the app should get the alert.
      shopInfo(q.shop, t.access_token)
        .then((info) => db.prepare(
          `UPDATE shops SET primary_domain=COALESCE(?,primary_domain),
             shop_name=COALESCE(?,shop_name),
             timezone=COALESCE(?,timezone),
             currency=COALESCE(?,currency)
           WHERE shop_domain=?`).run(
          info.primary_domain || null, info.name || null,
          info.timezone || null, info.currency || null, q.shop))
        .catch((e) => console.error("shopInfo on install:", e.message));
      // After install the merchant belongs in the Shopify admin, not on our
      // domain. The embedded app opens via /admin/apps/<client_id>; our own
      // /app would take them out of the admin and, without a session token,
      // end in a 404.
      res.writeHead(302, { Location: adminAppUrl(q.shop) });
      return res.end();
    }

    // --- receiving events from the web pixel ---
    // --- App Proxy: /apps/trackgap/event on the store domain ---
    // Shopify forwards the storefront request here. It is a first-party path,
    // so ad blockers and ITP do not block it. The signature MUST match;
    // otherwise anyone could send foreign data through it.
    if (url.pathname === "/proxy/event" && req.method === "POST") {
      if (!verifyProxySignature(q)) {
        return send(res, 401, { error: "bad signature" });
      }
      const shopDomain = q.shop;
      if (!validShop(shopDomain)) return send(res, 400, { error: "invalid shop" });

      const len = Number(req.headers["content-length"] || 0);
      if (len > PIXEL_MAX_BODY) return send(res, 413, { error: "payload too large" });

      let body = "";
      try { body = await rawBody(req); } catch { return send(res, 400, { error: "bad body" }); }
      if (body.length > PIXEL_MAX_BODY) return send(res, 413, { error: "payload too large" });

      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }

      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shopDomain);
      if (!s) return send(res, 404, { error: "unknown shop" });

      // Measurement proof is stored INDEPENDENTLY of identity: an order without
      // a GA4 cookie has no usable identity, but that is exactly when
      // "the purchase event left the browser" is most valuable.
      const ev = sanitizePixelEvent(p);
      if (ev) recordPixelEvent(s.id, ev);
      const clean = sanitizeIdentity(p);
      if (clean) saveIdentity(s.id, clean);
      if (!ev && !clean) return send(res, 400, { error: "no usable payload" });
      return send(res, 200, { ok: true });
    }

    // --- web pixel: receiving identity from the storefront ---
    // CORS: the pixel runs on the store domain, so this is a cross-origin
    // request. Without an OPTIONS response the browser never sends the actual
    // POST (it showed up as "404 OPTIONS" in the log and 0 identities in the DB).
    if (url.pathname === "/pixel/event" && req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }

    if (url.pathname === "/pixel/event" && req.method === "POST") {
      // The endpoint is deliberately unauthenticated: it is called from the
      // storefront, where no session token exists. Hence its own guard rails:
      // size limit, rate limit and format validation.
      const len = Number(req.headers["content-length"] || 0);
      if (len > PIXEL_MAX_BODY) {
        return send(res, 413, { error: "payload too large" });
      }
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress || "unknown";
      if (!pixelRateOk(ip)) {
        return send(res, 429, { error: "rate limit" });
      }

      let body = "";
      try {
        body = await rawBody(req, PIXEL_MAX_BODY);
      } catch {
        return send(res, 400, { error: "bad body" });
      }
      if (body.length > PIXEL_MAX_BODY) {
        return send(res, 413, { error: "payload too large" });
      }

      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      if (!validShop(p.shop)) return send(res, 400, { error: "invalid shop" });
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(p.shop);
      if (!s) return send(res, 404, { error: "unknown shop" });

      // Third measurement layer: a record that the event actually left the
      // browser. Stored even when the payload has no identity; otherwise we
      // would lose exactly the proof for orders without a GA4 cookie.
      const ev = sanitizePixelEvent(p);
      if (ev) recordPixelEvent(s.id, ev);

      const clean = sanitizeIdentity(p);
      if (clean) saveIdentity(s.id, clean);
      if (!ev && !clean) return send(res, 400, { error: "no usable payload" });

      // the pixel must not wait: respond immediately
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- Shopify webhooks (GDPR + orders) ---
    if (url.pathname.startsWith("/webhooks/")) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = await rawBody(req, WEBHOOK_BODY_LIMIT);
      if (!verifyWebhookHmac(body, req.headers["x-shopify-hmac-sha256"])) {
        return send(res, 401, { error: "bad hmac" });
      }
      const topic = req.headers["x-shopify-topic"] || "";
      const shop = req.headers["x-shopify-shop-domain"];
      const webhookId = req.headers["x-shopify-webhook-id"];

      // orders/create: near-real-time backfill
      if (topic.startsWith("orders/") && shop) {
        // Shopify guarantees neither order nor uniqueness -> dedupe by webhook id
        const seen = webhookId && db.prepare(
          "SELECT 1 FROM webhook_log WHERE webhook_id = ?").get(webhookId);
        if (!seen) {
          if (webhookId) {
            db.prepare("INSERT OR IGNORE INTO webhook_log (webhook_id, topic) VALUES (?,?)")
              .run(webhookId, topic);
          }
          // Process in the background; Shopify has a 5 s timeout.
          // JSON.parse MUST be inside the async function; outside it an
          // uncaught exception would crash the whole process.
          setImmediate(() => (async () => {
            const payload = JSON.parse(body);
            await handleOrderWebhook(shop, payload);
          })().catch((e) => console.error("webhook order:", e.message)));
        }
        return send(res, 200, { ok: true });
      }

      // A plan replacement produces multiple update webhooks: the old charge
      // is CANCELLED and the new one becomes ACTIVE. Persist each transition
      // with its event timestamp so late/retried deliveries cannot win.
      if (topic === "app_subscriptions/update" && shop) {
        try {
          const p = JSON.parse(body);
          const sub = {
            ...(p.app_subscription || {}),
            triggered_at: req.headers["x-shopify-triggered-at"] || null,
          };
          const real = await reconcileSubscriptionUpdate(shop, null, sub);
          console.log(`billing sync: ${shop} -> ${real.plan} (${real.status})`);
          return send(res, 200, { ok: true });
        } catch (e) {
          // Do not acknowledge a transition we failed to persist; Shopify will retry.
          console.error("webhook billing:", e.message);
          return send(res, 500, { error: "billing update failed" });
        }
      }

      if (topic === "app/uninstalled" && shop) {
        // Delivery can arrive after the merchant has already reinstalled and
        // minted a new token. Never let an older installation generation erase
        // the current one.
        const triggeredAt = req.headers["x-shopify-triggered-at"];
        if (isStaleUninstall(shop, triggeredAt)) {
          console.log(`ignored stale uninstall: ${shop} (${triggeredAt})`);
          return send(res, 200, { ok: true });
        }
        // Tokens and secrets are deleted IMMEDIATELY, not 48 h later on
        // shop/redact; after uninstall we have no legal basis to keep them.
        db.prepare(`UPDATE shops SET uninstalled_at = datetime('now'),
                    access_token_enc = NULL,
                    google_refresh_enc = NULL,
                    mp_api_secret_enc = NULL,
                    backfill_enabled = 0
                    WHERE shop_domain = ?`).run(shop);
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
        if (s) {
          for (const t of ["meta_oauth", "meta_config"]) {
            try { db.prepare(`DELETE FROM ${t} WHERE shop_id = ?`).run(s.id); }
            catch { /* table may not exist */ }
          }
        }
        // Shopify CANCELS the subscription on its side on uninstall. If we kept
        // the plan in our DB, the merchant would get the paid tier for free
        // after reinstalling and the app would never ask for payment approval
        // again. Reviewers test exactly this flow (App Store req. 1.2.2).
        setPlan(shop, "free", null, "CANCELLED");
      }

      if (topic === "shop/redact" && shop) {
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
        if (s) {
          // all store-bound tables; subscriptions, meta_* and meta_daily
          // used to be missing here
          for (const t of ["orders", "pixel_events", "ga4_events", "findings",
                           "identities", "backfills", "check_history", "alerts",
                           "check_cache", "subscriptions", "meta_oauth",
                           "meta_config", "meta_daily", "privacy_requests",
                           "kv_cache"]) {
            try { db.prepare(`DELETE FROM ${t} WHERE shop_id = ?`).run(s.id); }
            catch { /* table may not exist */ }
          }
          db.prepare("DELETE FROM shops WHERE id = ?").run(s.id);
        }
      }

      // We do not store customer data (PCD Level 1: no name, e-mail, address).
      // We do keep pseudonymous identifiers (GA4 client_id, gclid) tied to
      // order_id, so customers/redact must delete them.
      if (topic === "customers/redact" && shop) {
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
        if (s) {
          try {
            const p = JSON.parse(body);
            const ids = (p.orders_to_redact || []).map(String);
            for (const oid of ids) {
              db.prepare("DELETE FROM identities WHERE shop_id=? AND order_id=?")
                .run(s.id, oid);
              db.prepare("DELETE FROM orders WHERE shop_id=? AND order_id=?")
                .run(s.id, oid);
              db.prepare("DELETE FROM backfills WHERE shop_id=? AND order_id=?")
                .run(s.id, oid);
            }
            console.log(`customers/redact: ${shop}, ${ids.length} orders`);
          } catch (e) {
            console.error("customers/redact:", e.message);
          }
        }
      }

      if (topic === "customers/data_request" && shop) {
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
        if (s) {
          try {
            const p = JSON.parse(body);
            const ids = (p.orders_requested || []).map(String);
            const orders = [];
            const identities = [];
            for (const oid of ids) {
              const order = db.prepare(
                `SELECT order_id,order_number,total,currency,created_at,
                        landing_site,referring_site,utm_source,utm_medium,
                        utm_campaign FROM orders WHERE shop_id=? AND order_id=?`,
              ).get(s.id, oid);
              if (order) orders.push(order);
              const identity = db.prepare(
                `SELECT order_id,ga_client_id,ga_session_id,gclid,fbclid,
                        consent,seen_at FROM identities
                 WHERE shop_id=? AND order_id=?`,
              ).get(s.id, oid);
              if (identity) identities.push(identity);
            }
            const exportData = JSON.stringify({ shop, orders, identities });
            db.prepare(`INSERT INTO privacy_requests
              (request_id,shop_id,topic,order_ids,export_json)
              VALUES (?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`)
              .run(webhookId || crypto.randomUUID(), s.id, topic,
                   JSON.stringify(ids), exportData);
            console.log(`customers/data_request queued: ${shop}, ${ids.length} orders`);
          } catch (e) {
            console.error("customers/data_request:", e.message);
          }
        }
      }

      return send(res, 200, { ok: true });
    }


    // --- GA4 connection ---
    if (url.pathname === "/ga4/connect") {
      // The OAuth start must be verified; otherwise an attacker could attach
      // their own Google account to someone else's store
      const shop = requireShop();
      if (!shop) return;
      const state = crypto.randomBytes(16).toString("hex");
      states.set(state, { shop, ts: Date.now() });
      const redirect = `${config.app_url}/ga4/callback`;
      res.writeHead(302, { Location: googleAuthUrl(state, redirect) });
      return res.end();
    }

    if (url.pathname === "/ga4/callback") {
      const st = states.get(q.state);
      if (!st) return send(res, 401, { error: "bad state" });
      states.delete(q.state);
      // the user may have declined the connection; that must not end in a 500
      if (q.error) {
        res.writeHead(302, {
          Location: adminAppUrl(st.shop, "ga4=denied"),
        });
        return res.end();
      }
      const tok = await googleExchange(q.code, `${config.app_url}/ga4/callback`);
      // Connecting Google also clears the lost-access record; otherwise the
      // banner would stay on even after the merchant did exactly what we
      // asked them to do.
      db.prepare(`UPDATE shops SET google_refresh_enc = ?,
                    ga4_connected_at = COALESCE(ga4_connected_at, CURRENT_TIMESTAMP),
                    access_broken_kind = NULL, access_broken_since = NULL,
                    access_broken_detail = NULL
                  WHERE shop_domain = ?`)
        .run(encrypt(tok.refresh_token), st.shop);
      res.writeHead(302, {
        Location: adminAppUrl(st.shop, "ga4=connected"),
      });
      return res.end();
    }

    // --- CORS preflight ---
    // (handled above at /pixel/event)

    // --- overview without GA4 ---
    // What we can say right after install, without any connection: how many
    // orders the store has and how many of them CAN be attributed correctly
    // at all (they have a client_id and consent). Without this the merchant
    // saw an empty screen after install and was asked for OAuth before
    // getting any value.
    if (url.pathname === "/overview") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });

      const days = Math.min(Number(q.days) || 30, 90);
      const since = new Date(Date.now() - days * 86400_000).toISOString();

      // orders are already in from Shopify (webhooks + initial import)
      let orders = db.prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders
         WHERE shop_id=? AND created_at >= ? AND COALESCE(cancelled,0)=0`,
      ).get(s.id, since);

      // if we have nothing yet, fetch them now; the merchant should not have to wait
      if (!orders.n) {
        const token = await validToken(shop, sessionToken);
        if (token) {
          try {
            // argument order is (shop, token, sinceISO); swapped, it built
            // the URL from the token and failed with "fetch failed". It went
            // unnoticed because without a token the code never got here.
            const fetched = await fetchOrders(shop, token, since);
            const ins = db.prepare(`INSERT OR REPLACE INTO orders
              (shop_id,order_id,order_number,total,subtotal,shipping,tax,
               discounts,cancelled,financial_status,currency,created_at,
               landing_site,referring_site,utm_source,utm_medium,utm_campaign)
              VALUES (@shop_id,@order_id,@order_number,@total,@subtotal,@shipping,
                      @tax,@discounts,@cancelled,@financial_status,@currency,
                      @created_at,@landing_site,@referring_site,@utm_source,
                      @utm_medium,@utm_campaign)`);
            const tx = db.transaction((rows) => {
              for (const o of rows) ins.run({ ...o, shop_id: s.id });
            });
            tx(fetched);
            orders = db.prepare(
              `SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders
               WHERE shop_id=? AND created_at >= ? AND COALESCE(cancelled,0)=0`,
            ).get(s.id, since);
          } catch (e) {
            console.error("overview fetchOrders:", e.message);
          }
        }
      }

      // what the pixel knows about them
      const ident = db.prepare(
        `SELECT COUNT(DISTINCT o.order_id) n FROM orders o
         JOIN identities i ON i.shop_id=o.shop_id AND i.order_id=o.order_id
         WHERE o.shop_id=? AND o.created_at >= ? AND i.ga_client_id IS NOT NULL`,
      ).get(s.id, since);

      const consent = db.prepare(
        `SELECT COUNT(DISTINCT o.order_id) n FROM orders o
         JOIN identities i ON i.shop_id=o.shop_id AND i.order_id=o.order_id
         WHERE o.shop_id=? AND o.created_at >= ? AND i.consent='granted'`,
      ).get(s.id, since);

      const total = orders.n || 0;
      const withId = ident.n || 0;

      // Currency is taken from orders, not store settings: it is the currency
      // the customer actually paid in.
      const cur = db.prepare(
        `SELECT currency, COUNT(*) n FROM orders
         WHERE shop_id=? AND created_at >= ? AND currency IS NOT NULL
         GROUP BY currency ORDER BY n DESC LIMIT 1`,
      ).get(s.id, since);

      // value of orders that cannot be attributed
      const lost = db.prepare(
        `SELECT COALESCE(SUM(o.total),0) v FROM orders o
         WHERE o.shop_id=? AND o.created_at >= ? AND COALESCE(o.cancelled,0)=0
           AND NOT EXISTS (SELECT 1 FROM identities i
             WHERE i.shop_id=o.shop_id AND i.order_id=o.order_id
               AND i.ga_client_id IS NOT NULL)`,
      ).get(s.id, since);

      return send(res, 200, {
        days,
        orders: total,
        revenue: Math.round((orders.v || 0) * 100) / 100,
        unattributable_revenue: Math.round((lost.v || 0) * 100) / 100,
        currency: cur?.currency || s.currency || null,
        with_identity: withId,
        with_consent: consent.n || 0,
        // orders we already know cannot be reliably attributed
        unattributable: Math.max(0, total - withId),
        unattributable_pct: total ? Math.round((total - withId) / total * 1000) / 10 : 0,
        ga4_connected: !!s.google_refresh_enc,
        pixel_seen: db.prepare(
          "SELECT COUNT(*) n FROM identities WHERE shop_id=?").get(s.id).n,
      });
    }

    // --- store state: used by the UI so the property need not be picked again ---
    if (url.pathname === "/state") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare(
        `SELECT shop_domain, plan, ga4_property_id, last_sync_at, backfill_enabled,
                primary_domain, shop_name, mp_measurement_id, timezone,
                alert_email,
                alert_email_status, alert_email_error,
                access_broken_kind, access_broken_since,
                (google_refresh_enc IS NOT NULL) AS ga4_connected
         FROM shops WHERE shop_domain = ?`).get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });

      // Domain, time zone and currency are fetched once and stored.
      //
      // THE TIME ZONE MATTERS: the scheduler uses it to decide whether it is
      // DAILY_HOUR (7:00) in the store. Only `primary_domain` and `shop_name`
      // used to be written although `shopInfo()` also returns zone and
      // currency; `shops.timezone` stayed NULL and `localHour()` fell back to
      // UTC. A merchant on the US west coast would get the daily check at
      // midnight.
      if (!s.primary_domain || !s.timezone) {
        const tok = await validToken(shop, sessionToken);
        if (tok) {
          try {
            const info = await shopInfo(shop, tok);
            db.prepare(`UPDATE shops SET primary_domain=?, shop_name=?,
                        timezone=COALESCE(?, timezone),
                        currency=COALESCE(?, currency)
                        WHERE shop_domain=?`)
              .run(info.primary_domain, info.name, info.timezone || null,
                info.currency || null, shop);
            s.primary_domain = info.primary_domain;
            s.shop_name = info.name;
          } catch { /* not critical */ }
        }
      }
      return send(res, 200, {
        shop: s.shop_domain,
        plan: s.plan,
        ga4_connected: !!s.ga4_connected,
        ga4_property_id: s.ga4_property_id,
        backfill_enabled: !!s.backfill_enabled,
        // ID only; the secret is NEVER returned
        mp_measurement_id: s.mp_measurement_id || null,
        primary_domain: s.primary_domain,
        shop_name: s.shop_name,
        // alert address: the UI uses it to know whether onboarding is complete
        alert_email: s.alert_email || null,
        // The address alone is not enough: `unverified` means nothing has been
        // delivered to it yet. Onboarding must not look finished before we
        // know the alert channel actually works.
        alert_email_status: s.alert_email ? (s.alert_email_status || "unverified") : null,
        alert_email_error: s.alert_email_error || null,
        meta_oauth_available: isOAuthConfigured(),
        last_sync_at: s.last_sync_at,
        // third measurement layer: onboarding and the dashboard need to know
        // whether the pixel actually reports; without it we can only say THAT
        // something is missing, not why
        pixel: pixelHealth(
          db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop).id,
        ),
        // When the app has lost access it MUST admit it right in the state.
        // Otherwise the dashboard showed the last (no longer valid) cached
        // result and looked exactly like an app that is watching everything.
        access_lost: s.access_broken_kind
          ? { kind: s.access_broken_kind, since: s.access_broken_since }
          : null,
      });
    }

    // --- GA4 property list ---
    if (url.pathname === "/ga4/properties") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s?.google_refresh_enc) return send(res, 400, { error: "ga4 not connected" });
      const tok = await accessToken(decrypt(s.google_refresh_enc));
      return send(res, 200, await listProperties(tok));
    }

    if (url.pathname === "/ga4/select" && q.property) {
      const shop = requireShop();
      if (!shop) return;
      db.prepare("UPDATE shops SET ga4_property_id=? WHERE shop_domain=?")
        .run(q.property, shop);
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (s) invalidate(s.id);     // property changed -> old cache is no longer valid
      return send(res, 200, { ok: true });
    }

    // --- run a check ---
    if (url.pathname === "/check") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      if (q.force === "1") invalidate(s.id);
      // When the app has lost access, the cached result is NOT the current
      // state of the store; it is the last snapshot before the failure.
      // Serving it unmarked would claim "this is how things look now", which
      // the app does not know at that moment. Every cached response carries the flag.
      const stamp = (payload) => (s.access_broken_kind
        ? { ...payload, access_lost: { kind: s.access_broken_kind,
                                       since: s.access_broken_since } }
        : payload);
      const cached = getCached(s.id);
      if (cached) return send(res, 200, stamp({ ...cached, cached: true }));
      // Stale-while-revalidate: the last result goes to the merchant
      // IMMEDIATELY, a fresh one is computed in the background and the UI
      // fetches it again. A full check (60 days of Shopify + GA4) is awaited
      // only on the very first run and on explicit Refresh (force=1 also
      // drops the stale record).
      const stale = getStale(s.id);
      if (stale) {
        refreshInBackground(s);
        return send(res, 200,
          stamp({ ...stale, cached: true, refreshing: true }));
      }
      // no cached result: if a check is already running (Refresh during a
      // background run), wait for it instead of starting a second one
      if (checksInFlight.has(s.id)) {
        await checksInFlight.get(s.id);
        const fresh = getCached(s.id);
        if (fresh) return send(res, 200, { ...fresh, cached: true });
      }
      const result = await runCheck(s);
      return send(res, 200, result);
    }

    // --- Meta OAuth: start login ---
    if (url.pathname === "/meta/connect") {
      const shop = requireShop();
      if (!shop) return;
      if (!isOAuthConfigured()) {
        return send(res, 400, {
          error: "Meta sign-in is not configured yet. Use the access token "
               + "method for now.",
        });
      }
      const state = crypto.randomBytes(16).toString("hex");
      states.set(state, { shop: shop, ts: Date.now() });
      const redirect = `${config.app_url}/meta/callback`;
      res.writeHead(302, { Location: metaAuthUrl(state, redirect) });
      return res.end();
    }

    // --- Meta OAuth: callback ---
    if (url.pathname === "/meta/callback") {
      const st = states.get(q.state);
      if (!st) return send(res, 401, { error: "bad state" });
      states.delete(q.state);
      if (q.error) {
        res.writeHead(302, {
          Location: adminAppUrl(st.shop, "meta=denied"),
        });
        return res.end();
      }
      const redirect = `${config.app_url}/meta/callback`;
      try {
        const short = await metaExchange(q.code, redirect);
        // a short-lived token lasts ~1-2 h -> exchange it for a 60-day one right away
        const long = await longLivedToken(short.access_token);
        const info = await inspectToken(long.access_token);
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?")
          .get(st.shop);
        // fb_user_id is needed so deauthorize can disconnect the right store
        let fbUserId = null;
        try {
          const me = await fetch(
            "https://graph.facebook.com/v21.0/me?fields=id&access_token="
            + encodeURIComponent(long.access_token)).then((x) => x.json());
          fbUserId = me?.id || null;
        } catch { /* not critical */ }
        saveOAuthToken(s.id, long.access_token, long.expires_in, info.scopes, fbUserId);
        // the same token is used for reading/writing in meta.mjs
        saveMetaConfig(s.id, { token: long.access_token });
      } catch (e) {
        console.error("meta oauth:", e.message);
        res.writeHead(302, {
          Location: adminAppUrl(st.shop, "meta=error"),
        });
        return res.end();
      }
      res.writeHead(302, {
        Location: adminAppUrl(st.shop, "meta=connected"),
      });
      return res.end();
    }

    // --- Meta: access removal (Deauthorize callback) ---
    // Meta sends a signed_request here when a user removes the app's access.
    if (url.pathname === "/meta/deauthorize" && req.method === "POST") {
      const body = await rawBody(req);
      const sr = new URLSearchParams(body).get("signed_request");
      const parsed = parseSignedRequest(sr);
      if (!parsed) return send(res, 400, { error: "bad signed_request" });
      // ONLY stores connected by this particular Facebook user.
      // Previously the tokens of all merchants were deleted.
      const r = disconnectByFbUser(parsed.user_id);
      console.log("meta deauthorize:", JSON.stringify(r));
      return send(res, 200, { ok: true });
    }

    // --- Meta: data deletion request (required for App Review) ---
    if (url.pathname === "/meta/data-deletion") {
      if (req.method === "POST") {
        const body = await rawBody(req);
        const sr = new URLSearchParams(body).get("signed_request");
        const parsed = parseSignedRequest(sr);
        if (!parsed) return send(res, 400, { error: "bad signed_request" });

        const code = crypto.randomBytes(8).toString("hex");
        db.exec(`CREATE TABLE IF NOT EXISTS deletion_requests (
          code TEXT PRIMARY KEY, fb_user_id TEXT, status TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
        db.prepare(`INSERT INTO deletion_requests (code, fb_user_id, status)
                    VALUES (?,?,?)`).run(code, parsed.user_id || null, "done");

        // We hold no personal data from Meta, only ad account tokens.
        // Delete ONLY what belongs to this FB user.
        const del = disconnectByFbUser(parsed.user_id);
        console.log("meta data deletion:", JSON.stringify(del));
        return send(res, 200, {
          url: `${config.app_url}/meta/data-deletion?code=${code}`,
          confirmation_code: code,
        });
      }
      // GET: status page Meta links the user to
      const code = q.code || "";
      let status = "unknown";
      try {
        const r = db.prepare(
          "SELECT status, created_at FROM deletion_requests WHERE code=?").get(code);
        if (r) status = r.status;
      } catch { /* table may not exist yet */ }
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
        <title>TrackGap - data deletion</title>
        <style>body{font:15px/1.6 -apple-system,sans-serif;max-width:620px;
        margin:60px auto;padding:0 20px;color:#1a1c1d}
        code{background:#f0f1f3;padding:2px 6px;border-radius:4px}</style></head>
        <body><h1>Data deletion request</h1>
        <p>Request <code>${code.replace(/[^a-f0-9]/g, "")}</code>:
        <strong>${status === "done" ? "completed" : "not found"}</strong></p>
        <p>TrackGap does not store personal data from Meta. We hold only the
        access token you granted for reading your own advertising reports, and
        aggregate daily conversion counts. Both are deleted immediately on
        request or when you uninstall the app.</p>
        <p>Questions: <a href="mailto:karol@nulllogic.eu">karol@nulllogic.eu</a></p>
        </body></html>`;
      return send(res, 200, html, "text/html");
    }

    // --- Meta: list ad accounts and verify the token ---
    if (url.pathname === "/meta/accounts" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      if (!p.token) return send(res, 400, { error: "missing token" });
      try {
        let accounts = [];
        let accountsError = null;
        try {
          accounts = await listAdAccounts(p.token);
        } catch (e) {
          // an Events Manager token lacks ads_read; the pixel part works anyway
          accountsError = e.message;
        }
        const pixels = await listPixels(p.token, accounts.map((a) => a.id));
        return send(res, 200, {
          accounts,
          accounts_error: accountsError,
          pixels,
          can_read: accounts.length > 0,
          action_types: PURCHASE_ACTION_TYPES,
        });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // --- Meta: save configuration ---
    if (url.pathname === "/meta/setup" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      p.shop = shop;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      saveMetaConfig(s.id, p);
      return send(res, 200, { ok: true });
    }

    // --- Meta: daily comparison ---
    if (url.pathname === "/meta/compare") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      const cfg = metaConfig(s.id);
      if (!cfg?.token || !cfg.ad_account_id) {
        return send(res, 200, { configured: false });
      }
      if (q.refresh === "1") {
        const until = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
        const since = new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 10);
        try {
          const rows = await fetchDailyConversions(
            cfg.token, cfg.ad_account_id, since, until, cfg.action_type);
          storeDaily(s.id, rows);
        } catch (e) {
          return send(res, 200, { configured: true, error: e.message });
        }
      }
      const rows = compareDaily(s.id);
      const totalShop = rows.reduce((a, r) => a + (r.shopify_orders || 0), 0);
      const totalMeta = rows.reduce((a, r) => a + (r.meta_conversions || 0), 0);
      return send(res, 200, {
        configured: true,
        rows,
        summary: {
          shopify_orders: totalShop,
          meta_conversions: +totalMeta.toFixed(0),
          gap: +(totalShop - totalMeta).toFixed(0),
          gap_pct: totalShop ? +(((totalShop - totalMeta) / totalShop) * 100).toFixed(1) : 0,
          spend: +rows.reduce((a, r) => a + (r.meta_spend || 0), 0).toFixed(2),
        },
        caveat: "Meta credits a conversion to the day of the click, not the day "
              + "of the order, so day-by-day differences are normal. Only a "
              + "sustained gap means something is broken.",
      });
    }

    // --- billing: plans and status ---
    if (url.pathname === "/billing/plans") {
      const shop = requireShop();
      if (!shop) return;
      const cur = currentPlan(shop);
      const lim = checkLimit(shop);
      return send(res, 200, {
        plans: Object.values(PLANS).map((p) => ({
          ...p,
          // Prices for both cycles at once; the UI switches locally without another request.
          annual_price: cyclePrice(p.id, "annual"),
          annual_saving: p.price * 2,
        })),
        cycles: Object.values(BILLING_CYCLES),
        current: cur.id,
        current_cycle: cur.cycle,
        status: cur.status,
        usage: lim,
      });
    }

    // --- billing: start a subscription ---
    if (url.pathname === "/billing/subscribe") {
      const shop = requireShop();
      if (!shop) return;
      const token = await validToken(shop, sessionToken);
      // This is reached by TOP-LEVEL navigation from ui.html, not by fetch. Raw
      // JSON would leave the merchant on a blank page, so send them to
      // reauthorization instead.
      if (!token) {
        res.writeHead(302, { Location: `/auth?shop=${encodeURIComponent(shop)}` });
        return res.end();
      }
      try {
        // Test charge on a development store. Without it Shopify would ask
        // the reviewer for real money and the subscription would not complete.
        const isTest = process.env.TRACKGAP_BILLING_TEST === "1"
                    || await isDevelopmentStore(shop, token);
        // An unknown cycle in the URL must not fail the request with 400; falling
        // back to monthly is safer than refusing the payment.
        const cycle = BILLING_CYCLES[q.cycle] ? q.cycle : "monthly";
        // always the domain verified from the token; q.shop could be another store
        const r = await createSubscription(shop, token, q.plan, isTest, cycle);
        if (r.free) {
          res.writeHead(302, { Location: adminAppUrl(shop) });
          return res.end();
        }
        res.writeHead(302, { Location: r.confirmationUrl });
        return res.end();
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // --- billing: return after confirmation in the Shopify admin ---
    if (url.pathname === "/billing/callback") {
      if (!validShop(q.shop)) return send(res, 400, { error: "invalid shop" });
      const expectedPlan = PLANS[q.plan] ? q.plan : null;
      const expectedCycle = BILLING_CYCLES[q.cycle] ? q.cycle : "monthly";
      if (!expectedPlan
          || !verifyBillingState(q.state, q.shop, expectedPlan, expectedCycle)) {
        return send(res, 400, { error: "invalid or expired billing state" });
      }
      // Shopify redirects here, so there is no session token; we rely on the
      // stored access token. If it is missing (store uninstalled), this must not be a 500.
      const token = await validToken(q.shop);
      if (!token) {
        res.writeHead(302, { Location: `/auth?shop=${encodeURIComponent(q.shop)}` });
        return res.end();
      }
      // Only commit the verified state when Shopify already exposes the exact
      // plan this callback requested. During replacement, a transient snapshot
      // can still show the old subscription; the ACTIVE webhook will finish the
      // update without allowing that stale snapshot to win.
      const real = await waitForExpectedSubscription(
        q.shop, token, expectedPlan, expectedCycle,
      );
      const confirmed = subscriptionMatchesExpected(
        real, expectedPlan, expectedCycle,
      );
      if (confirmed) {
        setPlan(q.shop, real.plan, real.charge_id, real.status, real.cycle);
      }
      res.writeHead(302, {
        Location: adminAppUrl(q.shop, confirmed ? "billing=ok" : "billing=pending"),
      });
      return res.end();
    }

    // --- conversion backfill setup (Measurement Protocol) ---
    if (url.pathname === "/backfill/setup" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      p.shop = shop;              // the body is NOT used for authorization
      if (!/^G-[A-Z0-9]+$/i.test(p.measurement_id || "")) {
        return send(res, 400, { error: "measurement_id must look like G-XXXXXXX" });
      }
      if (!p.api_secret || p.api_secret.length < 10) {
        return send(res, 400, { error: "api_secret is required" });
      }
      // the pixel needs the Measurement ID to read the correct
      // _ga_<ID> cookie for session_id
      const tok = await validToken(p.shop, sessionToken);
      if (!tok) return send(res, 401, { error: "shop is not installed" });
      const pixel = await ensureWebPixel(
        p.shop, tok, { measurementId: p.measurement_id },
      );
      if (!pixel.ok) {
        console.error("pixel update:", pixel.error);
        return send(res, 502, {
          error: "Could not configure the web pixel. Reauthorize the app and try again.",
        });
      }
      db.prepare(`UPDATE shops SET mp_measurement_id=?, mp_api_secret_enc=?,
                  backfill_enabled=1 WHERE shop_domain=?`)
        .run(p.measurement_id, encrypt(p.api_secret), p.shop);
      return send(res, 200, { ok: true });
    }

    // --- backfill overview ---
    if (url.pathname === "/backfill/stats") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      const stats = backfillStats(s.id);
      const recent = db.prepare(
        `SELECT order_id, status, reason, created_at FROM backfills
         WHERE shop_id=? ORDER BY created_at DESC LIMIT 20`).all(s.id);
      return send(res, 200, { stats, recent });
    }

    // --- daily breakdown for the chart ---
    if (url.pathname === "/daily") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      const days = Math.min(parseInt(q.days || "30", 10), 90);
      // The waiting window is disabled (MIN_AGE_HOURS=0), so the chart shows
      // missing orders immediately, same as the reconciliation engine.
      const rows = db.prepare(`
        SELECT substr(o.created_at,1,10) AS d,
               COUNT(*) AS orders,
               SUM(o.total) AS revenue,
               SUM(CASE WHEN g.transaction_id IS NULL THEN 1 ELSE 0 END) AS missing,
               SUM(CASE WHEN g.transaction_id IS NULL THEN o.total ELSE 0 END)
                 AS missing_revenue,
               0 AS pending
        FROM orders o
        LEFT JOIN ga4_events g
          ON g.shop_id = o.shop_id AND g.transaction_id = o.order_id
        WHERE o.shop_id = ?
          AND o.created_at >= date('now', '-${days} days')
        GROUP BY d ORDER BY d`).all(s.id);
      return send(res, 200, rows);
    }

    // --- Google Ads via GA4 ---
    // No developer token: spend and campaigns are read from the merchant's
    // already connected GA4 property. The result is cached for an hour; GA4
    // has a per-property token quota, which the merchant spends, not us.
    if (url.pathname === "/ads") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      if (!s.google_refresh_enc || !s.ga4_property_id) {
        return send(res, 400, {
          error: "Connect GA4 and pick a property first.",
        });
      }

      const days = Math.min(Number(q.days) || 30, 90);
      const cacheKey = `ads:${s.id}:${days}`;
      const cached = db.prepare(
        `SELECT payload FROM kv_cache WHERE cache_key = ?
           AND created_at > datetime('now','-60 minutes')`,
      ).get(cacheKey);
      if (cached && q.force !== "1") {
        return send(res, 200, { ...JSON.parse(cached.payload), cached: true });
      }

      const gtok = await accessToken(decrypt(s.google_refresh_enc));
      const { rows, quota } = await fetchAdsCampaigns(
        gtok, s.ga4_property_id, `${days}daysAgo`, "yesterday");

      // Orders for the same period guard against a false alarm: if the store
      // sold nothing, zero conversions is correct data.
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const orders = db.prepare(
        `SELECT COUNT(*) n FROM orders
         WHERE shop_id=? AND created_at >= ? AND COALESCE(cancelled,0)=0`,
      ).get(s.id, since).n;

      const result = {
        ...analyseAds(rows, orders),
        days,
        orders_in_period: orders,
        limitations: ADS_LIMITS,
        quota,
      };
      db.prepare(`INSERT INTO kv_cache (cache_key, shop_id, payload, created_at)
                  VALUES (?,?,?,datetime('now'))
                  ON CONFLICT(cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    created_at = excluded.created_at`)
        .run(cacheKey, s.id, JSON.stringify(result));
      return send(res, 200, result);
    }

    // --- run history ---
    if (url.pathname === "/history") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      return send(res, 200, history(s.id));
    }

    // --- alert setup ---
    if (url.pathname === "/alerts/setup" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      p.shop = shop;

      // THE ADDRESS IS VERIFIED VIA DNS, not just with a regex.
      //
      // A regex lets `app-review@example.com` through, which is exactly what
      // happened: the address was saved, onboarding got a green check mark,
      // the UI said "check your inbox", and an hour and a half later a bounce
      // came back to US: "Domain example.com does not accept mail (nullMX)".
      //
      // The app thus claimed alerts were set up although nothing would ever
      // be delivered to that address. That is the same silent blindness we
      // report for merchants, one level up, and worse because it affects the
      // only channel we have to tell them anything.
      if (p.email) {
        const chk = await checkMailDomain(p.email);
        if (!chk.ok) {
          return send(res, 400, {
            error: chk.detail,
            reason: chk.reason,
          });
        }
      }

      db.prepare(`UPDATE shops SET alert_email=?,
                    alert_email_status = CASE WHEN ? IS NULL THEN NULL
                                              ELSE 'unverified' END,
                    alert_email_error = NULL
                  WHERE shop_domain=?`)
        .run(p.email || null, p.email || null, p.shop);

      if (p.test && p.email) {
        try {
          await sendTest(p.shop, p.email);
          // Acceptance by Bridge is NOT delivery: the status stays 'unverified'
          // until a mail actually arrives. Telling the merchant "done" the moment
          // our own relay accepted the message would be an unverified
          // assumption.
        } catch (e) {
          db.prepare(`UPDATE shops SET alert_email_status='failed',
                        alert_email_error=? WHERE shop_domain=?`)
            .run(String(e.message).slice(0, 300), p.shop);
          return send(res, 200, { ok: true, test_failed: e.message });
        }
      }
      return send(res, 200, { ok: true });
    }

    // --- static files (logo, screenshots) ---
    if (url.pathname.startsWith("/assets/")) {
      const name = url.pathname.replace("/assets/", "");
      // no ../ : the path must stay inside the assets directory
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        return send(res, 400, { error: "bad name" });
      }
      const p = new URL(`../assets/${name}`, import.meta.url);
      if (!fs.existsSync(p)) return send(res, 404, { error: "not found" });
      const ext = name.split(".").pop().toLowerCase();
      const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                      svg: "image/svg+xml", ico: "image/x-icon",
                      webp: "image/webp" };
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(fs.readFileSync(p));
    }

    // --- privacy policy and terms (required for App Store and Google OAuth) ---
    if (url.pathname === "/privacy" || url.pathname === "/terms") {
      const f = url.pathname === "/terms" ? "./terms.html" : "./privacy.html";
      const html = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      return send(res, 200, html, "text/html");
    }

    if (url.pathname === "/robots.txt") {
      return send(res, 200,
        `User-agent: *\nAllow: /\nSitemap: ${appUrl()}/sitemap.xml\n`,
        "text/plain");
    }

    if (url.pathname === "/sitemap.xml") {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${appUrl()}/</loc><lastmod>2026-08-31</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${appUrl()}/privacy</loc><lastmod>2026-08-31</lastmod><changefreq>yearly</changefreq><priority>0.3</priority></url>
  <url><loc>${appUrl()}/terms</loc><lastmod>2026-08-31</lastmod><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>`;
      return send(res, 200, xml, "application/xml");
    }

    // Public A/B preview of the new landing page. The original homepage on `/`
    // stays untouched until a deliberate decision to replace it.
    if (url.pathname === "/v2" || url.pathname === "/v2/") {
      const html = fs.readFileSync(
        new URL("./landing-v2.html", import.meta.url), "utf8",
      );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors 'none';",
      });
      return res.end(html);
    }

    // --- UI ---
    // Shopify always appends ?shop= when loading the embedded app. Without it
    // this is an ordinary visit from the internet -> public product page.
    if (url.pathname === "/app" || url.pathname === "/") {
      const isEmbedded = !!q.shop || !!q.host || url.pathname === "/app";
      const file = isEmbedded ? "./ui.html" : "./landing.html";
      let html = fs.readFileSync(new URL(file, import.meta.url), "utf8");

      // Without data-api-key App Bridge does not initialise at all:
      // window.shopify does not exist, no session token can be obtained and
      // the second call ends in 401 (App Store req. 1.1.1). The key is the
      // client_id, injected here so it is not hard-coded in the HTML.
      if (isEmbedded) {
        html = html.replace(
          '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">',
          `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" `
          + `data-api-key="${config.client_id}">`,
        );
      }

      // The embedded app MUST be embeddable in the Shopify admin and nowhere
      // else. App Store review does not pass without this header.
      const headers = { "Content-Type": "text/html; charset=utf-8" };
      if (isEmbedded) {
        const s = validShop(q.shop) ? q.shop : "*.myshopify.com";
        headers["Content-Security-Policy"] =
          `frame-ancestors https://${s} https://admin.shopify.com;`;
      } else {
        headers["Content-Security-Policy"] = "frame-ancestors 'none';";
      }
      res.writeHead(200, headers);
      return res.end(html);
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      return send(res, 413, { error: "payload too large" });
    }
    // Lost access is not our bug, and the merchant CAN do something about it.
    // As a 500 "internal error" it looked like an app failure, so the only
    // sensible reaction was to wait, and waiting never fixes it.
    if (e instanceof SetupError) {
      // 428 Precondition Required: the request is fine, a setup step just has
      // to be completed first. Deliberately not 500 (looks like our failure,
      // where all you can do is wait) and not 409 access_lost (would claim
      // something broke, when nothing has started yet).
      return send(res, 428, {
        error: "setup_required",
        step: e.step,
        message: e.message,
      });
    }
    if (e instanceof AccessError) {
      return send(res, 409, {
        error: "access_lost",
        kind: e.kind,
        message: e.kind === "google_auth"
          ? "TrackGap can no longer read your Google Analytics. Reconnect "
            + "your Google account to resume checks."
          : "TrackGap can no longer read your Shopify orders. Reopen the app "
            + "from your Shopify admin to reauthorize it.",
      });
    }
    console.error(`[${new Date().toISOString()}]`, e.stack || e.message);
    // The client gets a generic message; internal details (GraphQL errors,
    // paths, table names) belong in the log, not in the response.
    send(res, 500, { error: "internal error" });
  }
});

/**
 * Handles the orders/create webhook.
 *
 * Runs in the background because Shopify has a 5 s timeout. The goal is to
 * backfill the conversion within 24 h of the session start; after that it
 * no longer matches the original visit.
 */
async function handleOrderWebhook(shopDomain, order) {
  const shop = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shopDomain);
  if (!shop) return;

  const orderId = String(order.id);
  const row = {
    order_id: orderId,
    order_number: order.name || null,
    total: parseFloat(order.total_price || 0),
    subtotal: parseFloat(order.subtotal_price || 0),
    shipping: parseFloat(
      order.total_shipping_price_set?.shop_money?.amount || 0),
    tax: parseFloat(order.total_tax || 0),
    discounts: parseFloat(order.total_discounts || 0),
    cancelled: order.cancelled_at ? 1 : 0,
    financial_status: order.financial_status || null,
    currency: order.currency || null,
    created_at: order.created_at,
    landing_site: order.landing_site || null,
    referring_site: order.referring_site || null,
    utm_source: null, utm_medium: null, utm_campaign: null,
    line_items: order.line_items || [],
  };

  db.prepare(`INSERT OR REPLACE INTO orders
    (shop_id,order_id,order_number,total,subtotal,shipping,tax,discounts,
     cancelled,financial_status,currency,created_at,landing_site,
     referring_site,utm_source,utm_medium,utm_campaign)
    VALUES (@shop_id,@order_id,@order_number,@total,@subtotal,@shipping,@tax,
            @discounts,@cancelled,@financial_status,@currency,@created_at,
            @landing_site,@referring_site,@utm_source,@utm_medium,@utm_campaign)`)
    .run({ ...row, shop_id: shop.id });

  // Link the pixel proof to the order. `checkout_completed` often has no
  // order_id; this is where the token and the order number first meet.
  // Without it pixel_events could not be matched and the third layer would be useless.
  if (order.checkout_token) {
    try {
      linkOrderToPixel(shop.id, order.checkout_token, orderId);
    } catch (e) {
      console.error("linkOrderToPixel:", e.message);
    }
  }

  // Do NOT invalidate the check cache here: a fresh order is "too recent to
  // compare" for reconcile, so the result would not change, and every
  // invalidation means the next dashboard open runs a full 60-day check
  // (Shopify + GA4 API). On an active store the cache would never survive.
  // Freshness is handled by the 60-min TTL and the Refresh button (?force=1).

  // backfill only if the merchant enabled it and we have somewhere to send to
  if (!shop.mp_measurement_id || !shop.mp_api_secret_enc) return;

  const identity = identityForOrder(
    shop.id, orderId, order.checkout_token, order.note_attributes);

  if (!identity) {
    recordBackfill(shop.id, orderId, "skipped", "no_identity", {
      note: "No GA4 client ID - the pixel did not capture an identity and none "
          + "arrived in the order note attributes.",
    });
    return;
  }

  const gate = canBackfill(row, identity);
  if (!gate.ok) {
    recordBackfill(shop.id, orderId, "skipped", gate.reason, { note: gate.note });
    return;
  }

  // Have we already sent this order once?
  //
  // NOTE: a SELECT alone is not enough. orders/create and orders/updated often
  // arrive in the same second; both pass the check before either one writes,
  // and the conversion is sent TWICE (reproduced in production). So we first
  // reserve the slot atomically: a unique index on (shop_id, order_id) lets
  // only the first through, the second gets an exception and stops.
  try {
    db.prepare(`INSERT INTO backfill_locks (shop_id, order_id) VALUES (?,?)`)
      .run(shop.id, orderId);
  } catch {
    return;                       // another webhook is already handling it
  }

  const alreadySent = db.prepare(
    "SELECT 1 FROM backfills WHERE shop_id=? AND order_id=? AND status='sent'",
  ).get(shop.id, orderId);
  if (alreadySent) return;

  // if the transaction is already in GA4, do not send; it would create a duplicate
  const exists = db.prepare(
    "SELECT 1 FROM ga4_events WHERE shop_id=? AND transaction_id=?",
  ).get(shop.id, orderId);
  if (exists) {
    recordBackfill(shop.id, orderId, "skipped", "already_in_ga4", null);
    return;
  }

  const r = await sendPurchase(
    shop.mp_measurement_id, decrypt(shop.mp_api_secret_enc), row, identity);
  recordBackfill(shop.id, orderId, r.sent ? "sent" : "failed",
                 r.reason || null, r);

  // Meta CAPI, if the merchant connected a pixel. Runs independently of GA4:
  // event_id = order number, so Meta deduplicates against its own pixel.
  // Previously sendCapiPurchase was imported but never called.
  try {
    const mcfg = metaConfig(shop.id);
    if (mcfg?.capi_enabled && mcfg.pixel_id && mcfg.token) {
      const mr = await sendCapiPurchase(mcfg, row, identity);
      console.log(`meta capi ${orderId}:`,
                  mr.sent ? "sent" : `skipped (${mr.reason})`);
    }
  } catch (e) {
    // a Meta failure must not break the GA4 branch
    console.error("meta capi:", e.message);
  }
}

/**
 * Verifies and decodes a signed_request from Meta (deauthorize, data deletion).
 * The signature is HMAC-SHA256 with the app secret; without verification
 * anyone could request deletion of someone else's data.
 */
function parseSignedRequest(sr) {
  if (!sr || !sr.includes(".")) return null;
  const cfg = metaAppConfig();
  if (!cfg?.app_secret) return null;
  const [encSig, payload] = sr.split(".", 2);
  const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expected = crypto.createHmac("sha256", cfg.app_secret)
    .update(payload).digest();
  try {
    if (!crypto.timingSafeEqual(b64(encSig), expected)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(b64(payload).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * A valid access token for the store, refreshed when close to expiry.
 *
 * Shopify no longer issues permanent tokens. Without this the app would
 * silently stop working after a few hours: every Admin API call would start
 * failing with 401 and the merchant would only see an empty dashboard.
 */
async function validToken(shopDomain, idToken = null) {
  const info = shopTokenInfo(shopDomain);
  // No stored token. Under managed installation this is the NORMAL state
  // right after install, not an error: Shopify never called our OAuth, so we
  // request the token ourselves using this request's session token.
  if (!info) return mintToken(shopDomain, idToken);
  if (!info.needs_refresh || !info.refresh) return info.token;
  try {
    const t = await refreshAccessToken(shopDomain, info.refresh);
    upsertShop(shopDomain, t.access_token, t.refresh_token || info.refresh,
               t.expires_in || null);
    console.log(`token refreshed: ${shopDomain}`);
    return t.access_token;
  } catch (e) {
    console.error(`token refresh (${shopDomain}):`, e.message);
    // The refresh token is no longer valid (e.g. after a reinstall). If this
    // request comes from the admin, token exchange recovers without the
    // merchant clicking anything. Only if that fails too do we try the old token.
    return (await mintToken(shopDomain, idToken)) || info.token;
  }
}

/**
 * Is this a development store? Decides whether the charge should be a test.
 * On error return false: a real charge is better than a silent test charge
 * for a paying merchant that would never actually be paid.
 */
async function isDevelopmentStore(shop, token) {
  try {
    const d = await gql(shop, token, "{ shop { plan { partnerDevelopment } } }");
    return !!d.shop?.plan?.partnerDevelopment;
  } catch (e) {
    console.error(`shop plan (${shop}):`, e.message);
    return false;
  }
}

/** Session token -> offline access token. Returns null on failure. */
async function mintToken(shopDomain, idToken) {
  if (!idToken) return null;
  try {
    const t = await tokenExchange(shopDomain, idToken);
    upsertShop(shopDomain, t.access_token, t.refresh_token || null,
               t.expires_in || null, true);
    console.log(`token exchange: ${shopDomain}`);
    return t.access_token;
  } catch (e) {
    console.error(`token exchange (${shopDomain}):`, e.message);
    return null;
  }
}

export async function runCheck(shop) {
  const token = await validToken(shop.shop_domain);
  if (!token) {
    // The app lost access to the store. Recording it matters more than the
    // exception itself: without a record the failure stays only in a log
    // nobody reads, and the merchant never learns they are no longer watched.
    markAccessBroken(shop.id, "shopify_auth",
      "Shopify access token is gone or could not be refreshed");
    throw new AccessError("shopify_auth", "shop not authenticated");
  }
  if (!shop.ga4_property_id) {
    throw new SetupError("ga4_property",
      "Select which Google Analytics property belongs to this store.");
  }
  if (!shop.google_refresh_enc) {
    // The distinction that decides between a failure and onboarding.
    //
    // Without `ga4_connected_at` it was impossible to tell "the account was
    // never connected" from "the connection was lost"; the app therefore told
    // a freshly installed store it had lost access to something it never had,
    // recorded it as its own failure, and after 6 h that turned into a
    // "we stopped watching" e-mail.
    if (!shop.ga4_connected_at) {
      throw new SetupError("ga4_connect",
        "Connect your Google account so TrackGap can compare orders with GA4.");
    }
    markAccessBroken(shop.id, "google_auth",
      "Google account is no longer connected");
    throw new AccessError("google_auth", "google not connected");
  }

  const since = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const orders = await fetchOrders(shop.shop_domain, token, since);

  // A Google refresh token can stop working without anyone telling us: the
  // merchant revokes access, changes their password, or the OAuth client is
  // in "Testing" mode where tokens last 7 days. The result is always the
  // same: the app can no longer see GA4 and, without this record, stays silent.
  let gtok;
  try {
    gtok = await accessToken(decrypt(shop.google_refresh_enc));
  } catch (e) {
    markAccessBroken(shop.id, "google_auth", e.message);
    throw new AccessError("google_auth", `google auth failed: ${e.message}`);
  }
  const { rows: ga4rows, quota } = await fetchTransactions(
    gtok, shop.ga4_property_id, "60daysAgo", "yesterday");

  // We reached both sides of the comparison -> access is fine.
  clearAccessBroken(shop.id);

  // store
  const ins = db.prepare(`INSERT OR REPLACE INTO orders
    (shop_id,order_id,order_number,total,subtotal,shipping,tax,discounts,
     cancelled,financial_status,currency,created_at,landing_site,
     referring_site,utm_source,utm_medium,utm_campaign)
    VALUES (@shop_id,@order_id,@order_number,@total,@subtotal,@shipping,@tax,
            @discounts,@cancelled,@financial_status,@currency,@created_at,
            @landing_site,@referring_site,@utm_source,@utm_medium,@utm_campaign)`);
  db.transaction((rows) => rows.forEach((r) =>
    ins.run({ ...r, shop_id: shop.id, cancelled: r.cancelled ? 1 : 0 })))(orders);

  const insG = db.prepare(`INSERT OR REPLACE INTO ga4_events
    (shop_id,transaction_id,revenue,event_count,date,source,medium)
    VALUES (@shop_id,@transaction_id,@revenue,@event_count,@date,@source,@medium)`);
  db.transaction((rows) => rows.forEach((r) =>
    insG.run({ ...r, shop_id: shop.id })))(ga4rows);

  // identity from the pixel: needed to split missing orders by cause
  const identityFor = (orderId) =>
    identityForOrder(shop.id, String(orderId), null, null);

  // Third layer: what actually left the browser. It lets the engine tell
  // "GA4 did not receive it" from "it never left", two failures with
  // entirely different fixes.
  const pixelSince = pixelActiveSince(shop.id);
  const pixel = {
    active: !!pixelSince,
    since: pixelSince,
    purchased: purchasedOrderIds(shop.id),
  };

  const result = reconcile(orders, ga4rows, identityFor, pixel);

  const insF = db.prepare(`INSERT INTO findings
    (shop_id,type,severity,count,detail) VALUES (?,?,?,?,?)`);
  db.transaction(() => {
    for (const f of result.findings) {
      insF.run(shop.id, f.type, f.severity, f.count, JSON.stringify(f.detail));
    }
  })();
  db.prepare("UPDATE shops SET last_sync_at=datetime('now') WHERE id=?")
    .run(shop.id);

  // monitoring: record the run, compare with history, create alerts
  recordRun(shop.id, result);
  const alerts = detectRegressions(shop.id, result);
  if (alerts.length) {
    saveAlerts(shop.id, alerts);
    // a mail must not break the check; errors are only logged
    flushAlerts().catch((e) => console.error("flushAlerts:", e.message));
  }

  const payload = { ...result, alerts, quota };
  setCached(shop.id, payload);
  return payload;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`TRACKGAP_READY port=${PORT}`);
  // Periodic checks + alerts. Without this a check would only run when the
  // dashboard is opened and alerts would never arrive on their own.
  startScheduler(runCheck);
});
