/**
 * TrackGap - Shopify OAuth + admin API.
 *
 * Deliberately framework-free: the whole flow is ~150 lines, and the Shopify
 * React Router package would pull in an entire build pipeline for what is
 * one redirect and one token exchange.
 */
import crypto from "node:crypto";
import { readSecret } from "./secrets.mjs";

const CFG = readSecret("shopify.json");
if (!CFG) throw new Error("missing .secrets/shopify.json (set TRACKGAP_SECRETS?)");
export const API_VERSION = "2026-07";
// Keep OAuth scopes in source control alongside shopify.app.toml. A stale
// value in the local secret file previously meant installs never requested
// read_pixels even after the TOML was fixed.
export const OAUTH_SCOPES =
  "read_orders,read_pixels,write_pixels,read_customer_events";

/** Verifies the HMAC signature on the OAuth callback (Shopify sends ?hmac=). */
export function verifyOAuthHmac(query) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(rest[k])}`)
    .join("&");
  const digest = crypto.createHmac("sha256", CFG.client_secret)
    .update(msg).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"),
                                  Buffer.from(hmac, "utf8"));
  } catch {
    return false;
  }
}

/** Verifies the webhook HMAC (X-Shopify-Hmac-Sha256 header, base64 over the body). */
export function verifyWebhookHmac(rawBody, header) {
  if (!header) return false;
  const digest = crypto.createHmac("sha256", CFG.client_secret)
    .update(rawBody, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
  } catch {
    return false;
  }
}

/** Shopify only allows *.myshopify.com; without this check it is an open redirect. */
export function validShop(shop) {
  return typeof shop === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

export function installUrl(shop, state) {
  const p = new URLSearchParams({
    client_id: CFG.client_id,
    scope: OAUTH_SCOPES,
    redirect_uri: `${CFG.app_url}/auth/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${p}`;
}

/**
 * Exchanges the OAuth code for an access token.
 *
 * Shopify NO LONGER ACCEPTS permanent (non-expiring) tokens: the response
 * contains `expires_in` and `refresh_token`, and the old token eventually
 * stops working. Without refreshing, the app would silently stop working
 * after a few hours.
 */
export async function exchangeToken(shop, code) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CFG.client_id,
      client_secret: CFG.client_secret,
      code,
      // Without this Shopify returns a PERMANENT token, which the Admin API
      // rejects since 2026 ("Non-expiring access tokens are no longer accepted").
      // The parameter belongs here in the code exchange, NOT in the authorize URL.
      expiring: 1,
    }),
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();   // { access_token, scope, expires_in, refresh_token }
}

/**
 * Token exchange: session token (ID token from App Bridge) -> offline access token.
 *
 * WHY: the app uses managed installation. Shopify installs it itself and does
 * NOT call our /auth/callback, so `exchangeToken()` never obtains a token and
 * every Admin API call ends in 401. In that state a store could have the app
 * installed with no row in our DB, and clicking Start trial returned a bare
 * JSON {"error":"not authenticated"}.
 *
 * The ID token is short-lived, so it is not cached; each exchange uses the
 * one from the current request.
 */
export async function tokenExchange(shop, idToken) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CFG.client_id,
      client_secret: CFG.client_secret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type:
        "urn:shopify:params:oauth:token-type:offline-access-token",
      // same reason as in exchangeToken(): the Admin API now rejects permanent
      // tokens ("Non-expiring access tokens are no longer accepted")
      expiring: 1,
    }),
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();   // { access_token, expires_in, refresh_token, scope }
}

/** Refreshes an expiring offline token using the refresh_token. */
export async function refreshAccessToken(shop, refreshToken) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CFG.client_id,
      client_secret: CFG.client_secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!r.ok) throw new Error(`token refresh ${r.status}: ${await r.text()}`);
  return r.json();
}

/** GraphQL Admin API. */
export async function gql(shop, token, query, variables = {}) {
  const r = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/**
 * Fetches orders. PCD Level 1: we request ONLY what is needed for matching;
 * no customer name, e-mail, address or phone.
 */
const ORDERS_QUERY = `
query Orders($cursor: String, $q: String) {
  orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      cancelledAt
      displayFinancialStatus
      currentTotalPriceSet   { shopMoney { amount currencyCode } }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      currentTotalTaxSet      { shopMoney { amount } }
      totalDiscountsSet       { shopMoney { amount } }
      customerJourneySummary {
        firstVisit { landingPage referrerUrl source sourceType utmParameters { source medium campaign } }
      }
    }
  }
}`;

const money = (n) => parseFloat(n?.shopMoney?.amount ?? 0);

export async function fetchOrders(shop, token, sinceISO) {
  const out = [];
  let cursor = null;
  // 200 pages x 250 = 50,000 orders. Previously 40 pages (10,000) silently
  // truncated large stores and reconcile then reported false "missing"
  // orders.
  const MAX_PAGES = 200;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await gql(shop, token, ORDERS_QUERY, {
      cursor,
      q: `created_at:>='${sinceISO}'`,
    });
    const o = d.orders;
    for (const n of o.nodes) {
      const utm = n.customerJourneySummary?.firstVisit?.utmParameters || {};
      const total = money(n.currentTotalPriceSet);
      const subtotal = money(n.currentSubtotalPriceSet);
      const shipping = money(n.currentShippingPriceSet);
      const tax = money(n.currentTotalTaxSet);
      out.push({
        order_id: n.id.split("/").pop(),
        order_number: n.name,
        total,
        subtotal,
        shipping,
        tax,
        discounts: money(n.totalDiscountsSet),
        // 0/1, not boolean: better-sqlite3 does not bind booleans and the whole
        // INSERT fails with "SQLite3 can only bind numbers, strings, bigints,
        // buffers, and null". Callers previously had to convert it themselves
        // and /overview forgot to.
        cancelled: n.cancelledAt ? 1 : 0,
        financial_status: n.displayFinancialStatus || null,
        currency: n.currentTotalPriceSet?.shopMoney?.currencyCode || null,
        created_at: n.createdAt,
        landing_site: n.customerJourneySummary?.firstVisit?.landingPage || null,
        referring_site: n.customerJourneySummary?.firstVisit?.referrerUrl || null,
        utm_source: utm.source || n.customerJourneySummary?.firstVisit?.source || null,
        utm_medium: utm.medium || null,
        utm_campaign: utm.campaign || null,
      });
    }
    if (!o.pageInfo.hasNextPage) break;
    cursor = o.pageInfo.endCursor;
    // hit the cap and there is more to fetch -> the result is incomplete
    if (page === MAX_PAGES - 1) truncated = true;
  }
  // The flag travels with the array itself, so reconcile knows the "missing"
  // orders may just be truncation, not a real tracking gap.
  out.truncated = truncated;
  return out;
}

/**
 * Activates our web pixel on the store.
 *
 * Without this the pixel exists in the app bundle but does not run on the
 * storefront, and without it we have no GA4 client_id, so conversion
 * backfill is dead. `shopify app deploy` alone does NOT activate the pixel;
 * webPixelCreate is required.
 *
 * Requires the `write_pixels` scope.
 */
const PIXEL_CREATE = `
mutation Create($settings: JSON!) {
  webPixelCreate(webPixel: { settings: $settings }) {
    userErrors { field message }
    webPixel { id settings }
  }
}`;

const PIXEL_UPDATE = `
mutation Update($id: ID!, $settings: JSON!) {
  webPixelUpdate(id: $id, webPixel: { settings: $settings }) {
    userErrors { field message }
    webPixel { id settings }
  }
}`;

export async function ensureWebPixel(shop, token, settings = {}) {
  // NOTE: a field declared in shopify.extension.toml must not be empty;
  // Shopify returns "[measurementId] - can't be blank". If the merchant does
  // not have it yet, we send a placeholder; the pixel then finds the _ga_*
  // cookie itself, and the `client_id` from `_ga` works without it.
  const payload = JSON.stringify({
    endpoint: `${CFG.app_url}/pixel/event`,
    measurementId: settings.measurementId || "not-set",
  });

  // does it already exist? (webPixel returns ONLY our own pixel, not others)
  let existing = null;
  try {
    const d = await gql(shop, token, "{ webPixel { id } }");
    existing = d.webPixel?.id || null;
  } catch (e) {
    // RESOURCE_NOT_FOUND = the pixel does not exist yet, which is normal on the
    // first install -> proceed to create.
    // Anything else (e.g. missing read_pixels scope) must NOT trigger a blind
    // create: if the pixel exists, create only returns a duplicate error and
    // the Measurement ID silently stays stale.
    const notFound = /RESOURCE_NOT_FOUND|No web pixel was found/i.test(e.message);
    if (!notFound) {
      return { ok: false, error: `Could not read web pixel: ${e.message}` };
    }
  }

  const q = existing ? PIXEL_UPDATE : PIXEL_CREATE;
  const vars = existing ? { id: existing, settings: payload } : { settings: payload };

  try {
    const d = await gql(shop, token, q, vars);
    const r = d.webPixelCreate || d.webPixelUpdate;
    const errs = r?.userErrors || [];
    if (errs.length) {
      return { ok: false, error: errs.map((e) => e.message).join("; ") };
    }
    return { ok: true, id: r?.webPixel?.id, updated: !!existing };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const SHOP_INFO = `{
  shop {
    name
    myshopifyDomain
    primaryDomain { host }
    currencyCode
    ianaTimezone
  }
}`;

/** The store's real domain; .myshopify.com is unreadable for the merchant. */
export async function shopInfo(shop, token) {
  const d = await gql(shop, token, SHOP_INFO);
  const s = d.shop || {};
  return {
    name: s.name || null,
    primary_domain: s.primaryDomain?.host || null,
    currency: s.currencyCode || null,
    timezone: s.ianaTimezone || null,
  };
}

/**
 * Verifies the App Proxy request signature.
 *
 * WHY: requests via /apps/trackgap come from the store's domain (first-party,
 * so ad blockers and ITP do not block them). Shopify adds a `signature`: an
 * HMAC of all query parameters sorted by name and joined without separators.
 * Without verification anyone could send foreign data through that path.
 *
 * Note: App Proxy uses `signature`, NOT `hmac` like OAuth, and parameters
 * are joined differently (no & between them).
 */
export function verifyProxySignature(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => {
      const v = Array.isArray(rest[k]) ? rest[k].join(",") : rest[k];
      return `${k}=${v}`;
    })
    .join("");

  const digest = crypto.createHmac("sha256", CFG.client_secret)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(String(signature), "utf8"),
    );
  } catch {
    return false;
  }
}

export const config = CFG;

/**
 * Webhook registration. Without orders/create there is no near-real-time
 * backfill; without GDPR webhooks Shopify will not approve the app.
 */
const WEBHOOK_MUTATION = `
mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic,
    webhookSubscription: { callbackUrl: $url, format: JSON }) {
    userErrors { field message }
    webhookSubscription { id }
  }
}`;

export async function registerWebhooks(shop, token) {
  const base = CFG.app_url;
  // GDPR topics (CUSTOMERS_DATA_REQUEST, CUSTOMERS_REDACT, SHOP_REDACT) CANNOT
  // be registered via the API; Shopify only accepts them from the Partner
  // Dashboard (App setup -> Compliance webhooks). The API returns
  // "Variable $topic ... invalid value".
  const subs = [
    ["ORDERS_CREATE", `${base}/webhooks/orders`],
    ["ORDERS_UPDATED", `${base}/webhooks/orders`],
    ["APP_UNINSTALLED", `${base}/webhooks/app`],
    // without this we never learn about a declined payment, a freeze or a
    // cancelled subscription; the merchant would keep paid features without paying
    ["APP_SUBSCRIPTIONS_UPDATE", `${base}/webhooks/billing`],
  ];
  const out = [];
  for (const [topic, url] of subs) {
    try {
      const d = await gql(shop, token, WEBHOOK_MUTATION, { topic, url });
      const err = d.webhookSubscriptionCreate?.userErrors || [];
      out.push({
        topic,
        ok: !err.length,
        // a duplicate registration is not an error; the app may have been reinstalled
        error: err.map((e) => e.message).join("; ") || null,
      });
    } catch (e) {
      out.push({ topic, ok: false, error: e.message });
    }
  }
  return out;
}
