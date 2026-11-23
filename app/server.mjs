/**
 * TrackGap — HTTP server.
 *
 * Bezi na loopbacku, reverse proxy (napr. Caddy) pred nim riesi TLS.
 * Ziadny framework: OAuth + par endpointov + jedna stranka.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
// Pozn.: `shopToken` sa zamerne NEIMPORTUJE. Shopify vydava len hodinove
// tokeny, takze kazde volanie Admin API musi ist cez `validToken()`, ktory
// token pred pouzitim obnovi. Priamy `shopToken()` po hodine tichu vracal
// expirovany token a volanie padlo na 401 (1.9.2026).
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
 * Kam sa vratit po OAuth callbacku.
 *
 * Embedded appka zije vnutri Shopify adminu, takze relativne `/app?shop=…`
 * sa prelozi na `/apps/app?…` a skonci na 404 (1.9.2026). Spravna cesta je
 * vzdy `https://<shop>/admin/apps/<client_id>`.
 */
function adminAppUrl(shop, params = "") {
  const host = String(shop).replace(/\.myshopify\.com$/, "") + ".myshopify.com";
  const q = params ? `?${params}` : "";
  return `https://${host}/admin/apps/${config.client_id}${q}`;
}

const PORT = process.env.PORT || 9310;
const states = new Map();     // OAuth state -> {shop, ts}

// Prebiehajuce checky na pozadi — jeden obchod nesmie mat dva naraz
// (mrhalo by to GA4 kvotou a Shopify API limitmi).
const checksInFlight = new Map();   // shop_id -> Promise

function refreshInBackground(shop) {
  if (checksInFlight.has(shop.id)) return;
  const p = runCheck(shop)
    .catch((e) => console.error("bg check:", shop.shop_domain, e.message))
    .finally(() => checksInFlight.delete(shop.id));
  checksInFlight.set(shop.id, p);
}

/* ---------- ochrana /pixel/event (audit, bod 8) ----------
   Endpoint sa vola zo storefrontu, takze nemoze byt za session tokenom.
   Bez limitov by kdokolvek mohol nafuknut DB alebo podvrhnut gclid k cudzej
   objednavke a prepisat tak priradenie konverzie. */
const PIXEL_MAX_BODY = 8 * 1024;          // 8 KB staci s velkou rezervou
const PIXEL_RATE_MAX = 60;                // poziadaviek na IP
const PIXEL_RATE_WINDOW = 60_000;         // za minutu
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

// mapa nesmie rast donekonecna
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of pixelHits) if (now > r.resetAt) pixelHits.delete(ip);
}, 5 * 60_000).unref?.();

/**
 * Prepusti len polia, ktore naozaj pouzivame, a v ocakavanom formate.
 * Vracia null, ak z payloadu nie je pouzitelna ziadna identita — nema zmysel
 * ukladat prazdny riadok. Cely raw payload sa uz neuklada.
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
    // GA4 client_id ma tvar <nahodne>.<timestamp>
    ga_client_id: str(id.ga_client_id, /^\d+\.\d+$/, 64),
    ga_session_id: str(id.ga_session_id, /^\d+$/, 32),
    gclid: str(id.gclid, /^[A-Za-z0-9_-]+$/, 200),
    fbclid: str(id.fbclid, /^[A-Za-z0-9_.-]+$/, 200),
    consent: str(id.consent, /^(granted|denied|unknown)$/i, 16),
    // Shopify `clientId` — stabilny po celu navstevu vratane checkoutu.
    // Je to jediny kluc, ktorym sa da spojit `page_viewed` (ma `_ga` cookie,
    // nema token) s `checkout_completed` (ma token, `_ga` uz neprecita).
    shopify_client_id: str(p.client_id_shopify ?? id.client_id_shopify,
                           /^[A-Za-z0-9._:-]+$/, 128),
  };

  // Ulozime aj zaznam BEZ identifikatorov, ak je naviazany na objednavku alebo
  // checkout. Obchod nemusi mat GA4 vobec — vtedy `_ga` cookie neexistuje a
  // ziadne client_id nie je co citat. Tento zaznam je dokaz, ze pixel bezal
  // a ze objednavka realne nema com byt priradena (31.8.2026: predtym server
  // vratil 400 a merchant nevidel rozdiel medzi "pixel nebezi" a
  // "pixel bezi, ale nie je co zachytit").
  const anchored = out.checkout_token || out.order_id;
  const usable = out.ga_client_id || out.gclid || out.fbclid
    || out.shopify_client_id;
  return (usable || anchored) ? out : null;
}

/**
 * Udalost z pixelu ako DOKAZ merania (tretia vrstva).
 *
 * sanitizeIdentity() rieši identifikatory na doplnanie konverzii; toto je iny
 * ucel: zaznamenat, ZE event opustil prehliadac. Preto vlastna validacia —
 * suma a mena sa do identit vobec neukladaju.
 */
function sanitizePixelEvent(p) {
  const type = String(p.type || "");
  // ukladame len to, co ma vypovednu hodnotu o konverzii
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
 * Appka stratila pristup k zdroju dat (Shopify token, Google ucet).
 *
 * Vlastny typ preto, aby sa strata pristupu dala odlisit od skutocnej chyby
 * v kode. Tieto dve veci maju uplne iny nasledok: chybu opravujeme my,
 * odpojeny ucet vie napravit LEN merchant — a preto sa o nom musi dozvediet.
 * Predtym oboje skoncilo ako `internal error` 500 a splynulo.
 */
class AccessError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Appka este NIE JE NASTAVENA — chyba krok onboardingu.
 *
 * Zamerne to NIE JE AccessError. Strata pristupu znamena "fungovalo to
 * a prestalo"; toto znamena "este sa nezacalo". Merchantovi treba povedat
 * uplne ine vety a appka si to NESMIE zapisat ako vlastnu poruchu — z takeho
 * zaznamu po case dozreje poplasny e-mail o strate pristupu, ktora nikdy
 * nenastala.
 *
 * Cerstvo nainstalovany obchod je presne ten stav, v ktorom appku vidi
 * reviewer zo Shopify. Doteraz na nom `/check` vracal 500 "internal error"
 * (chybajuca GA4 property), co vyzera ako rozbita appka.
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
   * Domena obchodu overena session tokenom. `?shop=` sa na autorizaciu
   * NEPOUZIVA — pred touto zmenou stacilo poznat domenu obchodu na citanie
   * trzieb a prepisanie Measurement ID.
   *
   * Vracia null, ak volajuci nie je overeny. Kazdy merchant endpoint musi
   * zavolat requireShop() a pri null skoncit s 401.
   */
  const authShop = () => authenticatedShop(req, url) || devShopOverride(url);
  // Overeny session token tejto poziadavky. Posiela sa do `validToken()`, aby
  // sa dal pri managed installation vymenit za access token.
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

    // --- inštalácia: /auth?shop=xyz.myshopify.com ---
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
      // Shopify uz vydava len expirujuce tokeny — ukladame aj refresh_token
      upsertShop(q.shop, t.access_token, t.refresh_token || null,
                 t.expires_in || null, true);
      // Webhook subscriptions are app-managed in shopify.app.toml. Registering
      // them again per installation creates duplicate deliveries and lets a
      // failed background registration go unnoticed.
      // Aktivuj web pixel — bez neho nemame GA4 client_id.
      // Measurement ID MUSI ist so sebou: pri reinstalacii by sa inak prepisalo
      // na "not-set", pixel by nenasiel _ga_<ID> cookie a prestal by posielat.
      const mid = db.prepare(
        "SELECT mp_measurement_id FROM shops WHERE shop_domain=?",
      ).get(q.shop)?.mp_measurement_id || null;
      ensureWebPixel(q.shop, t.access_token, { measurementId: mid })
        .then((r) => console.log("web pixel:", JSON.stringify(r)))
        .catch((e) => console.error("web pixel:", e.message));

      // Casova zona obchodu uz pri instalacii. Scheduler podla nej urcuje,
      // kedy je v obchode 7:00 — bez nej by prva denna kontrola bezala v UTC,
      // teda pre vacsinu sveta v nevhodnu hodinu. Cakat na to, kym niekto
      // otvori dashboard, sa neda: prave merchant, ktory do appky nechodi,
      // ma alert dostat (1.9.2026).
      shopInfo(q.shop, t.access_token)
        .then((info) => db.prepare(
          `UPDATE shops SET primary_domain=COALESCE(?,primary_domain),
             shop_name=COALESCE(?,shop_name),
             timezone=COALESCE(?,timezone),
             currency=COALESCE(?,currency)
           WHERE shop_domain=?`).run(
          info.primary_domain || null, info.name || null,
          info.timezone || null, info.currency || null, q.shop))
        .catch((e) => console.error("shopInfo pri instalacii:", e.message));
      // Po instalacii patri merchant do Shopify adminu, nie na nasu domenu.
      // Embedded appka sa otvara cez /admin/apps/<client_id> — vlastne /app
      // by ho vyhodilo mimo admin a bez session tokenu skoncil na 404
      // (1.9.2026: presne to sa dialo pri natacani screencastu).
      res.writeHead(302, { Location: adminAppUrl(q.shop) });
      return res.end();
    }

    // --- prijem udalosti z web pixelu ---
    // --- App Proxy: /apps/trackgap/event na domene obchodu ---
    // Shopify sem preposle poziadavku zo storefrontu. Ide o first-party cestu,
    // takze ju neblokuju adblockery ani ITP. Podpis MUSI sediet — inak by
    // tadialto mohol ktokolvek posielat cudzie data.
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

      // Dokaz merania sa uklada NEZAVISLE od identity: objednavka bez GA4
      // cookie ziadnu pouzitelnu identitu nema, ale prave vtedy je informacia
      // "purchase event odisiel z prehliadaca" najcennejsia.
      const ev = sanitizePixelEvent(p);
      if (ev) recordPixelEvent(s.id, ev);
      const clean = sanitizeIdentity(p);
      if (clean) saveIdentity(s.id, clean);
      if (!ev && !clean) return send(res, 400, { error: "no usable payload" });
      return send(res, 200, { ok: true });
    }

    // --- web pixel: prijem identity zo storefrontu ---
    // CORS: pixel bezi na domene obchodu, takze ide o cross-origin request.
    // Bez odpovede na OPTIONS prehliadac skutocny POST vobec neodosle —
    // prejavilo sa to ako "404 OPTIONS" v logu a 0 identit v DB (31.8.2026).
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
      // Endpoint je zamerne bez autentifikacie — vola sa zo storefrontu, kde
      // ziadny session token neexistuje. Preto tu musia byt vlastne mantinely
      // (audit, bod 8): limit velkosti, rate limit a validacia formatu.
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

      // Tretia vrstva merania: zaznam, ze event realne opustil prehliadac.
      // Uklada sa aj vtedy, ked z payloadu nie je ziadna identita — inak by
      // sme prisli prave o dokaz pri objednavkach bez GA4 cookie.
      const ev = sanitizePixelEvent(p);
      if (ev) recordPixelEvent(s.id, ev);

      const clean = sanitizeIdentity(p);
      if (clean) saveIdentity(s.id, clean);
      if (!ev && !clean) return send(res, 400, { error: "no usable payload" });

      // pixel nesmie cakat — odpovedame hned
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- Shopify webhooky (GDPR + orders) ---
    if (url.pathname.startsWith("/webhooks/")) {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = await rawBody(req, WEBHOOK_BODY_LIMIT);
      if (!verifyWebhookHmac(body, req.headers["x-shopify-hmac-sha256"])) {
        return send(res, 401, { error: "bad hmac" });
      }
      const topic = req.headers["x-shopify-topic"] || "";
      const shop = req.headers["x-shopify-shop-domain"];
      const webhookId = req.headers["x-shopify-webhook-id"];

      // orders/create — near-real-time doplnenie
      if (topic.startsWith("orders/") && shop) {
        // Shopify negarantuje poradie ani jedinecnost -> dedupe cez webhook id
        const seen = webhookId && db.prepare(
          "SELECT 1 FROM webhook_log WHERE webhook_id = ?").get(webhookId);
        if (!seen) {
          if (webhookId) {
            db.prepare("INSERT OR IGNORE INTO webhook_log (webhook_id, topic) VALUES (?,?)")
              .run(webhookId, topic);
          }
          // Spracuj na pozadi, Shopify ma 5 s timeout.
          // JSON.parse MUSI byt vnutri async funkcie — mimo nej by neodchytena
          // vynimka zhodila cely proces (audit, bod 9).
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
        // Tokeny a tajomstva mazeme HNED, nie az o 48 h pri shop/redact —
        // po odinstalovani na ne uz nemame pravny dovod (audit, bod 6).
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
            catch { /* tabulka nemusi existovat */ }
          }
        }
        // Shopify pri odinstalovani ZRUSI predplatne na svojej strane. Ak si
        // plan nechame v nasej DB, merchant po preinstalovani dostane platenu
        // uroven zadarmo a appka uz nikdy nepoziada o schvalenie platby.
        // Presne tento flow reviewer testuje (App Store req. 1.2.2).
        setPlan(shop, "free", null, "CANCELLED");
      }

      if (topic === "shop/redact" && shop) {
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
        if (s) {
          // vsetky tabulky viazane na obchod — predtym tu chybali
          // subscriptions, meta_* a meta_daily (audit, bod 6)
          for (const t of ["orders", "pixel_events", "ga4_events", "findings",
                           "identities", "backfills", "check_history", "alerts",
                           "check_cache", "subscriptions", "meta_oauth",
                           "meta_config", "meta_daily", "privacy_requests",
                           "kv_cache"]) {
            try { db.prepare(`DELETE FROM ${t} WHERE shop_id = ?`).run(s.id); }
            catch { /* tabulka nemusi existovat */ }
          }
          db.prepare("DELETE FROM shops WHERE id = ?").run(s.id);
        }
      }

      // Zakaznicke udaje neukladame (PCD Level 1 — ziadne meno, mail, adresa).
      // Drzime vsak pseudonymne identifikatory (GA4 client_id, gclid) viazane
      // na order_id, takze customers/redact ich musi zmazat (audit, bod 6).
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
            console.log(`customers/redact: ${shop}, ${ids.length} objednavok`);
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


    // --- pripojenie GA4 ---
    if (url.pathname === "/ga4/connect") {
      // OAuth start musi byt overeny — inak si utocnik pripoji vlastny
      // Google ucet k cudziemu obchodu
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
      // pouzivatel mohol pripojenie odmietnut — nesmie to skoncit chybou 500
      if (q.error) {
        res.writeHead(302, {
          Location: adminAppUrl(st.shop, "ga4=denied"),
        });
        return res.end();
      }
      const tok = await googleExchange(q.code, `${config.app_url}/ga4/callback`);
      // Pripojenie Google zaroven rusi zaznam o strate pristupu — inak by
      // banner ostal svietit aj po tom, co merchant urobil presne to,
      // o co sme ho ziadali.
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
    // (rieseny vyssie pri /pixel/event)

    // --- prehlad bez GA4 ---
    // Co vieme povedat hned po instalacii, bez akehokolvek pripojenia:
    // kolko objednavok obchod ma a kolko z nich vobec MOZE byt spravne
    // priradenych (maju client_id a suhlas). Bez tohto videl merchant po
    // instalacii prazdnu obrazovku a ziadal sa od neho OAuth skor, nez
    // dostal akukolvek hodnotu.
    if (url.pathname === "/overview") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });

      const days = Math.min(Number(q.days) || 30, 90);
      const since = new Date(Date.now() - days * 86400_000).toISOString();

      // objednavky uz mame zo Shopify (webhooky + prvotny import)
      let orders = db.prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders
         WHERE shop_id=? AND created_at >= ? AND COALESCE(cancelled,0)=0`,
      ).get(s.id, since);

      // ak este nic nemame, dotiahneme ich teraz — merchant nema cakat
      if (!orders.n) {
        const token = await validToken(shop, sessionToken);
        if (token) {
          try {
            // poradie argumentov je (shop, token, sinceISO) — prehodene to
            // stavalo URL z tokenu a padalo na "fetch failed" (10.9.2026).
            // Nevsimli sme si to, lebo bez tokenu sa sem kod vobec nedostal.
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

      // co o nich vie pixel
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

      // Menu berieme z objednavok, nie z nastaveni obchodu — je to mena,
      // v ktorej zakaznik realne zaplatil.
      const cur = db.prepare(
        `SELECT currency, COUNT(*) n FROM orders
         WHERE shop_id=? AND created_at >= ? AND currency IS NOT NULL
         GROUP BY currency ORDER BY n DESC LIMIT 1`,
      ).get(s.id, since);

      // hodnota objednavok, ktore sa nedaju priradit
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
        // objednavky, ktore uz teraz vieme, ze sa nedaju spolahlivo priradit
        unattributable: Math.max(0, total - withId),
        unattributable_pct: total ? Math.round((total - withId) / total * 1000) / 10 : 0,
        ga4_connected: !!s.google_refresh_enc,
        pixel_seen: db.prepare(
          "SELECT COUNT(*) n FROM identities WHERE shop_id=?").get(s.id).n,
      });
    }

    // --- stav obchodu: pouziva ho UI, aby nemusel vyberat property znova ---
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

      // Domenu, casovu zonu a menu dotiahneme raz a ulozime.
      //
      // TIMEZONE JE DOLEZITA: scheduler podla nej urcuje, ci je v obchode
      // DAILY_HOUR (7:00). Zapisoval sa vsak len `primary_domain` a `shop_name`,
      // hoci `shopInfo()` zonu aj menu vracia — stlpec `shops.timezone` zostal
      // NULL a `localHour()` padol na UTC. Merchantovi na zapadnom pobrezi USA
      // by tak denna kontrola bezala o polnoci (1.9.2026).
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
          } catch { /* nie je kriticke */ }
        }
      }
      return send(res, 200, {
        shop: s.shop_domain,
        plan: s.plan,
        ga4_connected: !!s.ga4_connected,
        ga4_property_id: s.ga4_property_id,
        backfill_enabled: !!s.backfill_enabled,
        // len ID, secret sa NIKDY nevracia von
        mp_measurement_id: s.mp_measurement_id || null,
        primary_domain: s.primary_domain,
        shop_name: s.shop_name,
        // adresa pre alerty — UI podla nej vie, ci je onboarding dokonceny
        alert_email: s.alert_email || null,
        // Sama adresa nestaci: `unverified` znamena, ze sme na nu este nic
        // nedorucili. Onboarding sa nesmie tvarit hotovo skor, nez vieme,
        // ze sa kanal pre alerty da naozaj pouzit.
        alert_email_status: s.alert_email ? (s.alert_email_status || "unverified") : null,
        alert_email_error: s.alert_email_error || null,
        meta_oauth_available: isOAuthConfigured(),
        last_sync_at: s.last_sync_at,
        // tretia vrstva merania — onboarding aj dashboard potrebuju vediet,
        // ci pixel realne hlasi; bez neho vieme povedat len ZE nieco chyba,
        // nie preco
        pixel: pixelHealth(
          db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop).id,
        ),
        // Ked appka stratila pristup, MUSI to priznat hned na urovni stavu.
        // Dashboard inak ukazoval posledny (uz neplatny) vysledok z cache
        // a vyzeral presne ako appka, ktora vsetko strazi.
        access_lost: s.access_broken_kind
          ? { kind: s.access_broken_kind, since: s.access_broken_since }
          : null,
      });
    }

    // --- zoznam GA4 property ---
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
      if (s) invalidate(s.id);     // zmena property -> stara cache uz neplati
      return send(res, 200, { ok: true });
    }

    // --- spustenie kontroly ---
    if (url.pathname === "/check") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT * FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      if (q.force === "1") invalidate(s.id);
      // Ked appka stratila pristup, vysledok v cache uz NIE JE aktualny stav
      // obchodu — je to posledna snimka spred poruchy. Servirovat ju bez
      // oznacenia znamena tvrdit "takto to u teba vyzera teraz", co appka
      // v tej chvili nevie. Priznak si nesie kazda odpoved z cache.
      const stamp = (payload) => (s.access_broken_kind
        ? { ...payload, access_lost: { kind: s.access_broken_kind,
                                       since: s.access_broken_since } }
        : payload);
      const cached = getCached(s.id);
      if (cached) return send(res, 200, stamp({ ...cached, cached: true }));
      // Stale-while-revalidate: posledny vysledok ide merchantovi HNED,
      // cerstvy sa dopocita na pozadi a UI si zan pride znova. Plny check
      // (60 dni Shopify + GA4) sa caka len pri uplne prvom behu a pri
      // explicitnom Refresh (force=1 zmaze aj stale zaznam).
      const stale = getStale(s.id);
      if (stale) {
        refreshInBackground(s);
        return send(res, 200,
          stamp({ ...stale, cached: true, refreshing: true }));
      }
      // ziadny vysledok v cache — ak uz check bezi (Refresh pocas bg behu),
      // pockame nan namiesto druheho paralelneho behu
      if (checksInFlight.has(s.id)) {
        await checksInFlight.get(s.id);
        const fresh = getCached(s.id);
        if (fresh) return send(res, 200, { ...fresh, cached: true });
      }
      const result = await runCheck(s);
      return send(res, 200, result);
    }

    // --- Meta OAuth: zaciatok prihlasenia ---
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

    // --- Meta OAuth: navrat ---
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
        // kratkodoby token plati ~1-2 h -> hned vymenit za 60-dnovy
        const long = await longLivedToken(short.access_token);
        const info = await inspectToken(long.access_token);
        const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?")
          .get(st.shop);
        // fb_user_id treba, aby deauthorize vedel odpojit spravny obchod
        let fbUserId = null;
        try {
          const me = await fetch(
            "https://graph.facebook.com/v21.0/me?fields=id&access_token="
            + encodeURIComponent(long.access_token)).then((x) => x.json());
          fbUserId = me?.id || null;
        } catch { /* nie je kriticke */ }
        saveOAuthToken(s.id, long.access_token, long.expires_in, info.scopes, fbUserId);
        // ten isty token pouzijeme aj pre citanie/zapis v meta.mjs
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

    // --- Meta: odobratie pristupu (Deauthorize callback) ---
    // Meta sem posle signed_request, ked pouzivatel odoberie appke pristup.
    if (url.pathname === "/meta/deauthorize" && req.method === "POST") {
      const body = await rawBody(req);
      const sr = new URLSearchParams(body).get("signed_request");
      const parsed = parseSignedRequest(sr);
      if (!parsed) return send(res, 400, { error: "bad signed_request" });
      // LEN obchody, ktore pripojil prave tento Facebook pouzivatel.
      // Predtym sa mazali tokeny vsetkych merchantov (audit, bod 2).
      const r = disconnectByFbUser(parsed.user_id);
      console.log("meta deauthorize:", JSON.stringify(r));
      return send(res, 200, { ok: true });
    }

    // --- Meta: ziadost o zmazanie dat (povinne pre App Review) ---
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

        // Nemame ziadne osobne udaje od Meta — len ad account tokeny.
        // Mazeme LEN to, co patri tomuto FB pouzivatelovi (audit, bod 2).
        const del = disconnectByFbUser(parsed.user_id);
        console.log("meta data deletion:", JSON.stringify(del));
        return send(res, 200, {
          url: `${config.app_url}/meta/data-deletion?code=${code}`,
          confirmation_code: code,
        });
      }
      // GET — stranka so stavom, na ktoru Meta odkazuje pouzivatela
      const code = q.code || "";
      let status = "unknown";
      try {
        const r = db.prepare(
          "SELECT status, created_at FROM deletion_requests WHERE code=?").get(code);
        if (r) status = r.status;
      } catch { /* tabulka este nemusi existovat */ }
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
        <title>TrackGap — data deletion</title>
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

    // --- Meta: list ad accounts a token overit ---
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
          // token z Events Managera nema ads_read — pixel cast aj tak funguje
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

    // --- Meta: ulozit konfiguraciu ---
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

    // --- Meta: denne porovnanie ---
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

    // --- billing: plany a stav ---
    if (url.pathname === "/billing/plans") {
      const shop = requireShop();
      if (!shop) return;
      const cur = currentPlan(shop);
      const lim = checkLimit(shop);
      return send(res, 200, {
        plans: Object.values(PLANS).map((p) => ({
          ...p,
          // Cena za oba cykly naraz — UI prepina lokalne, bez dalsieho requestu.
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

    // --- billing: zacatie predplatneho ---
    if (url.pathname === "/billing/subscribe") {
      const shop = requireShop();
      if (!shop) return;
      const token = await validToken(shop, sessionToken);
      // Sem sa chodi TOP-LEVEL navigaciou z ui.html, nie fetchom. Surovy JSON
      // by merchantovi ostal na bielej stranke — presne to videl reviewer
      // 10.9.2026. Posleme ho radsej na reautorizaciu.
      if (!token) {
        res.writeHead(302, { Location: `/auth?shop=${encodeURIComponent(shop)}` });
        return res.end();
      }
      try {
        // Test charge na development store. Bez toho by Shopify od reviewera
        // pytal realne peniaze a ten by predplatne nedokoncil.
        const isTest = process.env.TRACKGAP_BILLING_TEST === "1"
                    || await isDevelopmentStore(shop, token);
        // Neznamy cyklus z URL nesmie zhodit request na 400 — fallback na
        // mesacny je bezpecnejsi nez odmietnut platbu.
        const cycle = BILLING_CYCLES[q.cycle] ? q.cycle : "monthly";
        // vzdy overena domena z tokenu — q.shop by mohol byt iny obchod
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

    // --- billing: navrat po potvrdeni v Shopify admine ---
    if (url.pathname === "/billing/callback") {
      if (!validShop(q.shop)) return send(res, 400, { error: "invalid shop" });
      const expectedPlan = PLANS[q.plan] ? q.plan : null;
      const expectedCycle = BILLING_CYCLES[q.cycle] ? q.cycle : "monthly";
      if (!expectedPlan
          || !verifyBillingState(q.state, q.shop, expectedPlan, expectedCycle)) {
        return send(res, 400, { error: "invalid or expired billing state" });
      }
      // Sem presmerovava Shopify, session token teda nemame — spoliehame sa na
      // ulozeny access token. Ak chyba (obchod odinstalovany), nesmie to byt 500.
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

    // --- nastavenie doplnania konverzii (Measurement Protocol) ---
    if (url.pathname === "/backfill/setup" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      p.shop = shop;              // telo sa na autorizaciu NEPOUZIVA
      if (!/^G-[A-Z0-9]+$/i.test(p.measurement_id || "")) {
        return send(res, 400, { error: "measurement_id must look like G-XXXXXXX" });
      }
      if (!p.api_secret || p.api_secret.length < 10) {
        return send(res, 400, { error: "api_secret is required" });
      }
      // pixel musi poznat Measurement ID, aby vedel precitat spravnu
      // _ga_<ID> cookie pre session_id
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

    // --- prehlad doplnania ---
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

    // --- denny rozpad pre graf ---
    if (url.pathname === "/daily") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      const days = Math.min(parseInt(q.days || "30", 10), 90);
      // Cakacie okno je vypnute (MIN_AGE_HOURS=0), takze graf ukazuje
      // chybajuce objednavky hned — rovnako ako porovnavaci engine.
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

    // --- Google Ads cez GA4 ---
    // Ziadny developer token: citame spend a kampane z merchantovej GA4
    // property, ktoru uz pripojil. Vysledok sa cachuje na hodinu — GA4 ma
    // tokenovu kvotu na property a tu mina merchant, nie my.
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

      // Objednavky za to iste obdobie su poistka proti falosnemu poplachu:
      // ked obchod nic nepredal, nulove konverzie su spravny udaj.
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

    // --- historia behov ---
    if (url.pathname === "/history") {
      const shop = requireShop();
      if (!shop) return;
      const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shop);
      if (!s) return send(res, 404, { error: "shop not found" });
      return send(res, 200, history(s.id));
    }

    // --- nastavenie alertov ---
    if (url.pathname === "/alerts/setup" && req.method === "POST") {
      const shop = requireShop();
      if (!shop) return;
      const body = await rawBody(req);
      let p;
      try { p = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
      p.shop = shop;

      // ADRESU OVERUJEME V DNS, nie len regexom.
      //
      // Regex prepusti `app-review@example.com` — a presne to sa 1.9.2026
      // stalo: adresa sa ulozila, onboarding dostal zelenu fajku, UI napisalo
      // "check your inbox" a o hodinu a pol prisiel NAM bounce
      // "Domain example.com does not accept mail (nullMX)".
      //
      // Appka teda tvrdila, ze alerty su nastavene, hoci sa na tu adresu nikdy
      // nic nedoruci. To je ta ista tichá slepota, ktoru u merchanta hlasime —
      // len o poschodie vyssie a o to horsia, ze sa tyka jedineho kanala,
      // ktorym vieme dat vediet o comkolvek.
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
          // Prevzatie Bridgeom NIE JE dorucenie — status ostava 'unverified'
          // az kym mail naozaj nedojde. Tvrdit merchantovi "hotovo" v moment,
          // ked spravu prevzal nas vlastny relay, je presne ta domienka,
          // ktora nas dostala.
        } catch (e) {
          db.prepare(`UPDATE shops SET alert_email_status='failed',
                        alert_email_error=? WHERE shop_domain=?`)
            .run(String(e.message).slice(0, 300), p.shop);
          return send(res, 200, { ok: true, test_failed: e.message });
        }
      }
      return send(res, 200, { ok: true });
    }

    // --- staticke subory (logo, screenshoty) ---
    if (url.pathname.startsWith("/assets/")) {
      const name = url.pathname.replace("/assets/", "");
      // ziadne ../ — cesta musi ostat v assets adresari
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

    // --- privacy policy a terms (povinne pre App Store aj Google OAuth) ---
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

    // Verejny A/B nahlad novej landing page. Povodna homepage na `/`
    // zostava nedotknuta, kym sa vedome nerozhodne o jej nahradeni.
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
    // Shopify pri nacitani embedded appky vzdy pripaja ?shop=. Bez neho ide
    // o beznu navstevu z internetu -> verejna stranka o produkte.
    if (url.pathname === "/app" || url.pathname === "/") {
      const isEmbedded = !!q.shop || !!q.host || url.pathname === "/app";
      const file = isEmbedded ? "./ui.html" : "./landing.html";
      let html = fs.readFileSync(new URL(file, import.meta.url), "utf8");

      // App Bridge sa BEZ data-api-key vobec neinicializuje: window.shopify
      // neexistuje, session token sa neda ziskat a druhe volanie skonci na 401
      // (App Store req. 1.1.1). Klucom je client_id, doplna sa az tu, aby
      // nebolo natvrdo v HTML.
      if (isEmbedded) {
        html = html.replace(
          '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">',
          `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" `
          + `data-api-key="${config.client_id}">`,
        );
      }

      // Embedded appka sa MUSI dat vlozit do Shopify adminu a nikam inam.
      // Bez tejto hlavicky App Store review neprejde.
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
    // Strata pristupu nie je nasa chyba a merchant s nou VIE nieco spravit.
    // Ako 500 "internal error" to vyzeralo ako porucha appky, takze jedina
    // rozumna reakcia bola cakat — a cakanim sa to nikdy nespravi.
    if (e instanceof SetupError) {
      // 428 Precondition Required: poziadavka je v poriadku, len sa najprv
      // musi dokoncit krok nastavenia. Zamerne nie 500 (vyzera ako nasa
      // porucha, na ktoru sa da len cakat) a nie 409 access_lost (tvrdilo by,
      // ze sa nieco pokazilo — pritom sa este nic nezacalo).
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
    // Klientovi ide vseobecna hlaska — interne detaily (GraphQL chyby, cesty,
    // nazvy tabuliek) patria do logu, nie do odpovede (audit, bod 11).
    send(res, 500, { error: "internal error" });
  }
});

/**
 * Spracovanie webhooku orders/create.
 *
 * Bezi na pozadi, lebo Shopify ma 5 s timeout. Cielom je doplnit konverziu
 * do 24 h od startu session — po tom sa uz nesparuje s povodnou navstevou.
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

  // Spoj dokaz od pixelu s objednavkou. `checkout_completed` casto nema
  // order_id — az tu sa token a cislo objednavky prvykrat stretnu. Bez toho
  // by pixel_events zostali nesparovatelne a tretia vrstva by bola k nicomu.
  if (order.checkout_token) {
    try {
      linkOrderToPixel(shop.id, order.checkout_token, orderId);
    } catch (e) {
      console.error("linkOrderToPixel:", e.message);
    }
  }

  // Cache kontroly tu NEinvalidovat: cerstva objednavka je pre reconcile
  // "too recent to compare", takze vysledok nezmeni — a kazda invalidacia
  // znamena, ze dalsie otvorenie dashboardu bezi plny 60-dnovy check
  // (Shopify + GA4 API). Pri aktivnom obchode by cache nikdy nezila.
  // Cerstvost riesi 60-min TTL a tlacidlo Refresh (?force=1).

  // backfill len ak si to merchant zapol a mame kam posielat
  if (!shop.mp_measurement_id || !shop.mp_api_secret_enc) return;

  const identity = identityForOrder(
    shop.id, orderId, order.checkout_token, order.note_attributes);

  if (!identity) {
    recordBackfill(shop.id, orderId, "skipped", "no_identity", {
      note: "No GA4 client ID — the pixel did not capture an identity and none "
          + "arrived in the order note attributes.",
    });
    return;
  }

  const gate = canBackfill(row, identity);
  if (!gate.ok) {
    recordBackfill(shop.id, orderId, "skipped", gate.reason, { note: gate.note });
    return;
  }

  // Uz sme tuto objednavku raz poslali?
  //
  // POZOR: samotny SELECT nestaci. orders/create a orders/updated chodia casto
  // v tej istej sekunde, obidva prejdu kontrolou skor, nez ktorykolvek stihne
  // zapisat — a konverzia odide DVAKRAT (overene naostro 31.8.2026, #11333).
  // Preto si najprv atomicky rezervujeme miesto: unikatny index na
  // (shop_id, order_id) prepusti len prveho, druhy dostane vynimku a skonci.
  try {
    db.prepare(`INSERT INTO backfill_locks (shop_id, order_id) VALUES (?,?)`)
      .run(shop.id, orderId);
  } catch {
    return;                       // uz to spracovava iny webhook
  }

  const alreadySent = db.prepare(
    "SELECT 1 FROM backfills WHERE shop_id=? AND order_id=? AND status='sent'",
  ).get(shop.id, orderId);
  if (alreadySent) return;

  // ak uz transakcia v GA4 je, neposielame — vznikla by duplicita
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

  // Meta CAPI — ak si merchant pripojil pixel. Bezi nezavisle od GA4:
  // event_id = cislo objednavky, takze Meta deduplikuje voci vlastnemu pixelu.
  // Predtym bolo sendCapiPurchase importovane, ale nikdy sa nevolalo.
  try {
    const mcfg = metaConfig(shop.id);
    if (mcfg?.capi_enabled && mcfg.pixel_id && mcfg.token) {
      const mr = await sendCapiPurchase(mcfg, row, identity);
      console.log(`meta capi ${orderId}:`,
                  mr.sent ? "odoslane" : `preskocene (${mr.reason})`);
    }
  } catch (e) {
    // zlyhanie Meta nesmie zhodit GA4 vetvu
    console.error("meta capi:", e.message);
  }
}

/**
 * Overi a rozbali signed_request od Meta (deauthorize, data deletion).
 * Podpis je HMAC-SHA256 s app secret — bez overenia by ktokolvek mohol
 * poslat poziadavku na zmazanie cudzich dat.
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
 * Platny access token pre obchod. Ked je pred expiraciou, obnovi ho.
 *
 * Shopify uz nevydava trvale tokeny. Bez tohto by appka po niekolkych hodinach
 * ticho prestala fungovat — vsetky volania Admin API by zacali padat na 401
 * a merchant by videl len prazdny dashboard (31.8.2026).
 */
async function validToken(shopDomain, idToken = null) {
  const info = shopTokenInfo(shopDomain);
  // Ziadny ulozeny token. Pri managed installation je to NORMALNY stav hned
  // po instalacii, nie chyba — Shopify nas OAuth nikdy nezavolal, takze si
  // token vypytame sami zo session tokenu tejto poziadavky.
  if (!info) return mintToken(shopDomain, idToken);
  if (!info.needs_refresh || !info.refresh) return info.token;
  try {
    const t = await refreshAccessToken(shopDomain, info.refresh);
    upsertShop(shopDomain, t.access_token, t.refresh_token || info.refresh,
               t.expires_in || null);
    console.log(`token obnoveny: ${shopDomain}`);
    return t.access_token;
  } catch (e) {
    console.error(`token refresh (${shopDomain}):`, e.message);
    // Refresh token uz neplati (napr. po reinstalle). Ak sme v poziadavke z
    // admina, token exchange nas vytiahne bez toho, aby merchant cokolvek
    // klikal. Az ked ani to nejde, skusime este stary token.
    return (await mintToken(shopDomain, idToken)) || info.token;
  }
}

/**
 * Je to development store? Rozhoduje o tom, ci ma byt charge testovaci.
 * Pri chybe radsej vratime false — radsej realny charge nez tichy test charge
 * u platiaceho merchanta, za ktory by sme nikdy nedostali zaplatene.
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

/** Session token -> offline access token. Vrati null, ak sa to nepodari. */
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
    // Appka stratila pristup do obchodu. Zapisat to je dolezitejsie nez
    // samotna vynimka: bez zaznamu porucha zostane len v logu, ktory nikto
    // necita, a merchant sa nedozvie, ze uz nie je strazeny.
    markAccessBroken(shop.id, "shopify_auth",
      "Shopify access token is gone or could not be refreshed");
    throw new AccessError("shopify_auth", "shop not authenticated");
  }
  if (!shop.ga4_property_id) {
    throw new SetupError("ga4_property",
      "Select which Google Analytics property belongs to this store.");
  }
  if (!shop.google_refresh_enc) {
    // Rozlisenie, ktore rozhoduje o tom, ci ide o poruchu alebo o onboarding.
    //
    // Bez `ga4_connected_at` sa nedalo odlisit "ucet nikdy nebol pripojeny"
    // od "spojenie sa stratilo" — appka preto cerstvo nainstalovanemu obchodu
    // hlasila stratu pristupu k niecomu, co nikdy nemala, zapisala si to ako
    // vlastnu poruchu a po 6 h z toho dozrel e-mail "prestali sme strazit".
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

  // Google refresh token moze prestat platit bez toho, aby nam to niekto
  // oznamil: merchant odvola pristup, zmeni heslo, alebo (nas pripad)
  // OAuth klient je v "Testing" mode a token plati 7 dni. Vysledok je vzdy
  // rovnaky — appka prestane vidiet do GA4 a bez tohto zapisu o tom mlci.
  let gtok;
  try {
    gtok = await accessToken(decrypt(shop.google_refresh_enc));
  } catch (e) {
    markAccessBroken(shop.id, "google_auth", e.message);
    throw new AccessError("google_auth", `google auth failed: ${e.message}`);
  }
  const { rows: ga4rows, quota } = await fetchTransactions(
    gtok, shop.ga4_property_id, "60daysAgo", "yesterday");

  // Dosiahli sme obe strany porovnania -> pristup je v poriadku.
  clearAccessBroken(shop.id);

  // uloz
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

  // identita z pixelu — potrebna na rozdelenie chybajucich podla priciny
  const identityFor = (orderId) =>
    identityForOrder(shop.id, String(orderId), null, null);

  // Tretia vrstva: co realne odislo z prehliadaca. Vdaka nej vie engine
  // odlisit "GA4 to nedostalo" od "nikdy to neodislo" — dve poruchy s uplne
  // inou opravou.
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

  // monitoring: zapis behu, porovnaj s historiou, vytvor alerty
  recordRun(shop.id, result);
  const alerts = detectRegressions(shop.id, result);
  if (alerts.length) {
    saveAlerts(shop.id, alerts);
    // mail nesmie zhodit kontrolu — chyby len logujeme
    flushAlerts().catch((e) => console.error("flushAlerts:", e.message));
  }

  const payload = { ...result, alerts, quota };
  setCached(shop.id, payload);
  return payload;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`TRACKGAP_READY port=${PORT}`);
  // Pravidelne kontroly + alerty. Bez toho by sa kontrola spustila len pri
  // otvoreni dashboardu a alerty by nikdy neprisli samy (audit, bod 4).
  startScheduler(runCheck);
});
