/**
 * TrackGap — Shopify web pixel extension.
 *
 * Bezi v strict sandboxe (web worker): ziadny DOM, ziadny document.cookie.
 * Shopify vsak poskytuje browser.cookie.get() — oficialne API, ktore
 * "replaces the native document.cookie API" a vykonava sa v top frame.
 *
 * PRECO TO EXISTUJE: server-side doplnenie konverzie do GA4 potrebuje
 * client_id z _ga cookie. Shopify Admin API ho nema. Bez neho by sa doplnena
 * konverzia priradila nespravne a merchantovi by to pokazilo atribuciu —
 * co je horsie, nez ked konverzia chyba.
 *
 * Zapisuje do cart attributes, lebo tie sa pri checkoute prepisu do
 * order.note_attributes a pridu priamo vo webhooku orders/create.
 */
import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, init, settings }) => {
  const ENDPOINT = settings.endpoint || "https://trackgap.example.com/pixel/event";
  const shop = init?.data?.shop?.myshopifyDomain || "";

  /** client_id z _ga cookie. Format: GA1.1.<client_id>.<timestamp> */
  async function gaClientId() {
    try {
      const raw = await browser.cookie.get("_ga");
      if (!raw) return null;
      const parts = String(raw).split(".");
      return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : null;
    } catch {
      return null;
    }
  }

  /**
   * GA4 session_id z cookie `_ga_<MEASUREMENT_ID>`.
   *
   * Format sa lisi podla verzie GA4:
   *   GS1.1.1788178526.2.1.1788178600.0.0.0
   *   GS2.1.s1788178526$o2$g1$t1788178600$j60$l0$h0
   * Preto sa timestamp hlada tolerantne, nie fixnou poziciou.
   *
   * DOLEZITE: Measurement ID je len skratka. Ked ho merchant nezadal (alebo
   * zadal ine, nez ma obchod nasadene), skusame vsetky `_ga_*` cookies —
   * `client_id` z `_ga` mame tak ci tak a appka musi fungovat aj bez nastavenia
   * GA4 v UI. Bez tohto fallbacku by novy merchant nedostal nic.
   */
  async function gaSessionId(measurementId) {
    const parse = (raw) => {
      if (!raw) return null;
      const s = String(raw);
      let m = s.match(/[.$]s(\d{9,})/);      // novy format
      if (m) return m[1];
      m = s.match(/^GS\d\.\d\.(\d{9,})/);    // stary format
      return m ? m[1] : null;
    };

    // 1) presna cookie podla nastaveneho Measurement ID
    try {
      if (measurementId && measurementId !== "not-set") {
        const name = "_ga_" + String(measurementId).replace(/^G-/, "");
        const parsed = parse(await browser.cookie.get(name));
        if (parsed) return parsed;
      }
    } catch {
      /* skusame dalej */
    }

    // 2) Fallback: bezne pouzivane GA4 property na obchode nepoznáme a
    //    `browser.cookie.get()` bez argumentu Shopify sandbox NEPODPORUJE
    //    (zhodilo to cely handler — 31.8.2026). Bez Measurement ID teda
    //    session_id nemame, ale to NIE JE kriticke: `client_id` z `_ga`
    //    funguje vzdy a appka je pouzitelna aj bez nastavenia GA4 v UI.
    //    Session_id len spresnuje priradenie ku konkretnej navsteve.
    return null;
  }

  /** Reklamne identifikatory z URL. */
  function clickIds(ctx) {
    const url = ctx?.document?.location?.href || "";
    const out = {};
    for (const k of ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"]) {
      const m = url.match(new RegExp(`[?&]${k}=([^&#]+)`));
      if (m) out[k] = decodeURIComponent(m[1]);
    }
    return out;
  }

  /**
   * Skutocny stav suhlasu z Shopify Customer Privacy API.
   *
   * Predtym sa do GA4 posielalo natvrdo `GRANTED`, hoci sme realny stav nikdy
   * nezistili — to je porusenie Google policy aj GDPR (audit, bod 5).
   * Pixel sam sa v EU bez suhlasu nespusti, ale ked bezi, stav vieme precitat
   * a ulozit, aby sa rozhodovalo podla neho a nie podla domnienky.
   */
  function readConsent(ctx) {
    try {
      const c = (ctx && ctx.document && ctx.document.customerPrivacy)
        || (typeof init !== "undefined" && init && init.customerPrivacy)
        || null;
      if (!c) return "unknown";
      const analytics = c.analyticsProcessingAllowed;
      const marketing = c.marketingAllowed;
      if (analytics === false || marketing === false) return "denied";
      if (analytics === true && marketing === true) return "granted";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async function collectIdentity(ctx) {
    const [cid, sid] = await Promise.all([
      gaClientId(),
      gaSessionId(settings.measurementId),
    ]);
    return {
      ga_client_id: cid,
      ga_session_id: sid,
      consent: readConsent(ctx),
      ...clickIds(ctx),
    };
  }

  /**
   * Ulozi identitu do cart attributes. Odtial sa pri checkoute prepise
   * do order.note_attributes a dorazi s webhookom.
   *
   * POZOR: pixel bezi v sandboxe (web worker), kde relativna URL neukazuje
   * na domenu obchodu. Preto sa absolutna URL sklada z event kontextu.
   */
  async function persistToCart(identity, ctx) {
    const attrs = {};
    if (identity.ga_client_id) attrs.__tg_cid = identity.ga_client_id;
    if (identity.ga_session_id) attrs.__tg_sid = identity.ga_session_id;
    // Consent must travel with the cart attributes as well. The order webhook
    // prefers note_attributes over the ingest DB, so omitting this value made
    // otherwise valid recoveries fail closed as `consent_unknown`.
    if (identity.consent) attrs.__tg_consent = identity.consent;
    for (const k of ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"]) {
      if (identity[k]) attrs["__tg_" + k] = identity[k];
    }
    if (!Object.keys(attrs).length) return false;

    const origin = ctx?.document?.location?.origin
      || (shop ? `https://${shop}` : null);
    if (!origin) return false;

    try {
      await fetch(`${origin}/cart/update.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: attrs }),
      });
      return true;
    } catch {
      // cart update zlyhal — identitu aspon posleme na nas endpoint,
      // odtial sa spari s objednavkou cez checkout_token
      return false;
    }
  }

  /**
   * Posle udalost na nas server. Nikdy neblokuje stranku.
   *
   * Posiela sa PRIAMO na nas endpoint (CORS je na serveri povoleny).
   *
   * App Proxy (`/apps/trackgap/event`) je pripraveny na serveri aj v
   * shopify.app.toml, ale pixel ho zatial nepouziva: proxy sa aktivuje az po
   * preinstalovani appky a kym nie je aktivny, kazde volanie skoncilo 404 a
   * meranie stichlo (31.8.2026). Prepneme az ked bude proxy overene zive.
   */
  function report(type, payload) {
    try {
      fetch(ENDPOINT, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, type, ts: Date.now(), ...payload }),
      });
    } catch {
      /* ticho — meranie nikdy nesmie zhodit obchod */
    }
  }

  // --- zachytenie identity co najskor v ceste zakaznika ---
  // Identitu hlasime aj na nas endpoint, nielen do cart attributes:
  // (a) da sa tak overit, ze pixel realne bezi, bez cakania na objednavku,
  // (b) ak cart update zlyha, mame zalozny zdroj sparovatelny cez checkout token.
  let reportedOnce = false;

  analytics.subscribe("page_viewed", async (event) => {
    const identity = await collectIdentity(event.context);
    if (!identity.ga_client_id && !identity.gclid && !identity.fbclid) return;
    await persistToCart(identity, event.context);
    if (!reportedOnce) {
      reportedOnce = true;          // raz za nacitanie, nie pri kazdom pohybe
      report("identity", { identity, client_id_shopify: event.clientId || null });
    }
  });

  analytics.subscribe("checkout_started", async (event) => {
    const identity = await collectIdentity(event.context);
    await persistToCart(identity, event.context);
    report("checkout_started", {
      checkout_token: event.data?.checkout?.token || null,
      identity,
      client_id_shopify: event.clientId || null,
    });
  });

  /**
   * Nezavisly dokaz, ze konverzia opustila prehliadac.
   * Ak toto pride a GA4 transakciu nema, chyba je medzi prehliadacom a GA4.
   * Ak nepride ani toto, event sa vobec neodpalil.
   */
  analytics.subscribe("checkout_completed", async (event) => {
    const c = event.data?.checkout;
    const identity = await collectIdentity(event.context);
    await persistToCart(identity, event.context);
    report("purchase", {
      checkout_token: c?.token || null,
      order_id: c?.order?.id || null,
      total: c?.totalPrice?.amount ?? null,
      currency: c?.currencyCode || null,
      identity,
      client_id_shopify: event.clientId || null,
    });
  });
});
