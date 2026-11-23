/**
 * TrackGap — Shopify OAuth + admin API.
 *
 * Zamerne bez frameworku: cely tok je ~150 riadkov, a Shopify React Router
 * balik by sem tahal cely build pipeline pre nieco, co je jeden redirect
 * a jeden token exchange.
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

/** Overi HMAC podpis na OAuth callbacku (Shopify posiela ?hmac=). */
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

/** Overi HMAC na webhooku (hlavicka X-Shopify-Hmac-Sha256, base64 nad telom). */
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

/** Shopify povoluje len *.myshopify.com — bez tejto kontroly je to open redirect. */
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
 * Vymena OAuth kodu za access token.
 *
 * Shopify uz NEPRIJIMA trvale (non-expiring) tokeny — odpoved obsahuje
 * `expires_in` a `refresh_token`, a stary token po case prestane platit.
 * Bez obnovovania by appka po niekolkych hodinach ticho prestala fungovat
 * (zistene 31.8.2026 pri instalacii na dev store).
 */
export async function exchangeToken(shop, code) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CFG.client_id,
      client_secret: CFG.client_secret,
      code,
      // Bez tohto Shopify vrati TRVALY token, ktory Admin API od 2026 odmieta
      // ("Non-expiring access tokens are no longer accepted"). Parameter patri
      // sem do vymeny kodu, NIE do autorizacnej URL (31.8.2026).
      expiring: 1,
    }),
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();   // { access_token, scope, expires_in, refresh_token }
}

/**
 * Token exchange: session token (ID token z App Bridge) -> offline access token.
 *
 * PRECO: appka pouziva managed installation. Shopify si ju nainstaluje sam a
 * nas /auth/callback pri tom NEZAVOLA, takze cez `exchangeToken()` sa k tokenu
 * nikdy nedostaneme a kazde volanie Admin API skonci na 401. Presne to videl
 * App Store reviewer 10.9.2026: obchod v00jsq-81 mal appku nainstalovanu, ale
 * v nasej DB nemal ani riadok, a klik na Start trial vratil holy JSON
 * {"error":"not authenticated"}.
 *
 * ID token je kratkozivy, takze ho necachujeme — na kazdu vymenu berieme ten
 * z aktualnej poziadavky.
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
      // rovnaky dovod ako pri exchangeToken(): trvale tokeny uz Admin API
      // odmieta ("Non-expiring access tokens are no longer accepted")
      expiring: 1,
    }),
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();   // { access_token, expires_in, refresh_token, scope }
}

/** Obnovi expirujuci offline token pomocou refresh_token. */
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
 * Nacita objednavky. PCD Level 1: ziadame LEN to, co potrebujeme na parovanie —
 * ziadne meno, e-mail, adresa ani telefon zakaznika.
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
  // 200 stran x 250 = 50 000 objednavok. Predtym 40 stran (10 000) tichu
  // orezalo velky obchod a reconcile potom hlasil falosne "chybajuce"
  // objednavky (audit, bod 12).
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
        // 0/1, nie boolean: better-sqlite3 boolean neviaze a cely INSERT padne
        // na "SQLite3 can only bind numbers, strings, bigints, buffers, and
        // null". Volajuci si to predtym musel prevadzat sam a /overview na to
        // zabudol (10.9.2026).
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
    // dosli sme na strop a este je co brat -> vysledok je neuplny
    if (page === MAX_PAGES - 1) truncated = true;
  }
  // Priznak si nesie samotne pole — reconcile tak vie, ze "chybajuce"
  // objednavky mozu byt len orezanie, a nie skutocna diera v merani.
  out.truncated = truncated;
  return out;
}

/**
 * Aktivuje nas web pixel na obchode.
 *
 * Bez tohto pixel existuje v app balíku, ale na storefronte nebezi — a bez neho
 * nemame GA4 client_id, takze doplnanie konverzii je mrtve. Overene 31.8.2026:
 * samotny `shopify app deploy` pixel NEAKTIVUJE, treba webPixelCreate.
 *
 * Vyzaduje scope `write_pixels`.
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
  // POZOR: pole deklarovane v shopify.extension.toml nesmie byt prazdne —
  // Shopify vrati "[measurementId] - can't be blank". Ked ho merchant este
  // nema, posielame zastupny retazec; pixel si vtedy najde _ga_* cookie sam
  // a `client_id` z `_ga` funguje aj bez neho.
  const payload = JSON.stringify({
    endpoint: `${CFG.app_url}/pixel/event`,
    measurementId: settings.measurementId || "not-set",
  });

  // existuje uz? (webPixel vracia LEN nas vlastny pixel, nie cudzie)
  let existing = null;
  try {
    const d = await gql(shop, token, "{ webPixel { id } }");
    existing = d.webPixel?.id || null;
  } catch (e) {
    // RESOURCE_NOT_FOUND = pixel este neexistuje, to je normalny stav pri prvej
    // instalacii -> pokracujeme na create.
    // Cokolvek ine (chybajuci read_pixels scope) NESMIE spustit slepy create:
    // ak pixel existuje, create vrati len duplicate error a Measurement ID
    // ticho zostane stare.
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

/** Skutocna domena obchodu — .myshopify.com je pre merchanta necitatelne. */
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
 * Overi podpis App Proxy poziadavky.
 *
 * PRECO: cez /apps/trackgap chodi request z domeny obchodu (first-party, takze
 * ho neblokuju adblockery ani ITP). Shopify k nemu prida `signature` — HMAC
 * vsetkych query parametrov zoradenych podla nazvu, spojenych bez oddelovacov.
 * Bez overenia by ktokolvek mohol tou cestou posielat cudzie data.
 *
 * Pozor: App Proxy pouziva `signature`, NIE `hmac` ako OAuth, a parametre sa
 * spajaju inak (bez & medzi nimi).
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
 * Registracia webhookov. Bez orders/create niet near-real-time doplnania,
 * bez GDPR webhookov appku Shopify neschvali.
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
  // GDPR temy (CUSTOMERS_DATA_REQUEST, CUSTOMERS_REDACT, SHOP_REDACT) sa cez
  // API registrovat NEDAJU — Shopify ich prijima len z Partner Dashboardu
  // (App setup -> Compliance webhooks). Overene 31.8.2026: API vrati
  // "Variable $topic ... invalid value".
  const subs = [
    ["ORDERS_CREATE", `${base}/webhooks/orders`],
    ["ORDERS_UPDATED", `${base}/webhooks/orders`],
    ["APP_UNINSTALLED", `${base}/webhooks/app`],
    // bez tohto sa nedozvieme o zamietnutej platbe, zmrazeni ani zruseni
    // predplatneho — merchant by mal platene funkcie a neplatil (audit, bod 7)
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
        // duplicitna registracia nie je chyba — appka sa mohla preinstalovat
        error: err.map((e) => e.message).join("; ") || null,
      });
    } catch (e) {
      out.push({ topic, ok: false, error: e.message });
    }
  }
  return out;
}
