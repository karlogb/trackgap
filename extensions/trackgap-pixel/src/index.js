/**
 * TrackGap - Shopify web pixel extension.
 *
 * Runs in a strict sandbox (web worker): no DOM, no document.cookie.
 * Shopify does provide browser.cookie.get(), an official API that
 * "replaces the native document.cookie API" and runs in the top frame.
 *
 * WHY THIS EXISTS: server-side GA4 conversion backfill needs the client_id
 * from the _ga cookie. The Shopify Admin API does not have it. Without it a
 * backfilled conversion would be misattributed and break the merchant's
 * attribution, which is worse than a missing conversion.
 *
 * Writes into cart attributes, because those are copied into
 * order.note_attributes at checkout and arrive directly in the
 * orders/create webhook.
 */
import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, init, settings }) => {
  const ENDPOINT = settings.endpoint || "https://trackgap.example.com/pixel/event";
  const shop = init?.data?.shop?.myshopifyDomain || "";

  /** client_id from the _ga cookie. Format: GA1.1.<client_id>.<timestamp> */
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
   * GA4 session_id from the `_ga_<MEASUREMENT_ID>` cookie.
   *
   * The format differs between GA4 versions:
   *   GS1.1.1788178526.2.1.1788178600.0.0.0
   *   GS2.1.s1788178526$o2$g1$t1788178600$j60$l0$h0
   * So the timestamp is located tolerantly, not by a fixed position.
   *
   * IMPORTANT: the Measurement ID is only a shortcut. If the merchant has not
   * entered it (or entered a different one than the store uses), we try all
   * `_ga_*` cookies; the `client_id` from `_ga` is available anyway and the
   * app must work without GA4 being configured in the UI. Without this
   * fallback a new merchant would get nothing.
   */
  async function gaSessionId(measurementId) {
    const parse = (raw) => {
      if (!raw) return null;
      const s = String(raw);
      let m = s.match(/[.$]s(\d{9,})/);      // new format
      if (m) return m[1];
      m = s.match(/^GS\d\.\d\.(\d{9,})/);    // old format
      return m ? m[1] : null;
    };

    // 1) the exact cookie for the configured Measurement ID
    try {
      if (measurementId && measurementId !== "not-set") {
        const name = "_ga_" + String(measurementId).replace(/^G-/, "");
        const parsed = parse(await browser.cookie.get(name));
        if (parsed) return parsed;
      }
    } catch {
      /* keep trying */
    }

    // 2) Fallback: we do not know which GA4 property the store uses, and
    //    the Shopify sandbox does NOT support `browser.cookie.get()` without
    //    an argument (it crashed the whole handler). So without a Measurement
    //    ID there is no session_id, but that is NOT critical: the `client_id`
    //    from `_ga` always works and the app is usable without GA4 configured
    //    in the UI. session_id only refines attribution to a specific visit.
    return null;
  }

  /** Ad identifiers from the URL. */
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
   * Actual consent state from the Shopify Customer Privacy API.
   *
   * Previously a hard-coded `GRANTED` was sent to GA4 although the real state
   * was never checked, which violates Google policy and GDPR. In the EU the
   * pixel does not run without consent at all, but when it runs we can read
   * and store the state so decisions are based on it, not on assumptions.
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
   * Stores the identity in cart attributes. From there it is copied into
   * order.note_attributes at checkout and arrives with the webhook.
   *
   * NOTE: the pixel runs in a sandbox (web worker) where a relative URL does
   * not point to the store domain, so the absolute URL is built from the
   * event context.
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
      // cart update failed: at least send the identity to our endpoint,
      // where it is matched to the order via checkout_token
      return false;
    }
  }

  /**
   * Sends an event to our server. Never blocks the page.
   *
   * Sent DIRECTLY to our endpoint (CORS is enabled on the server).
   *
   * The App Proxy (`/apps/trackgap/event`) is ready on the server and in
   * shopify.app.toml, but the pixel does not use it yet: the proxy only
   * activates after the app is reinstalled, and until then every call ended
   * in 404 and measurement went silent. Switch once the proxy is verified live.
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
      /* silent: measurement must never break the store */
    }
  }

  // --- capture identity as early as possible in the customer journey ---
  // Identity is also reported to our endpoint, not only to cart attributes:
  // (a) it proves the pixel is actually running without waiting for an order,
  // (b) if the cart update fails, there is a fallback matchable via checkout token.
  let reportedOnce = false;

  analytics.subscribe("page_viewed", async (event) => {
    const identity = await collectIdentity(event.context);
    if (!identity.ga_client_id && !identity.gclid && !identity.fbclid) return;
    await persistToCart(identity, event.context);
    if (!reportedOnce) {
      reportedOnce = true;          // once per load, not on every move
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
   * Independent proof that the conversion left the browser.
   * If this arrives and GA4 has no transaction, the problem is between the
   * browser and GA4. If even this does not arrive, the event never fired.
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
