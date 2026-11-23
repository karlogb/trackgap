/**
 * TrackGap — GA4 Measurement Protocol.
 *
 * Doplna konverzie, ktore do GA4 nedorazili. Overene 31.8.2026 v Google docs:
 *
 * - client_id je POVINNY. MP vracia 2xx aj ked event zahodi a nevracia error
 *   kod. Preto sa bez client_id NEPOSIELA NIC — inak by sme tvrdili, ze sme
 *   doplnili nieco, co sa stratilo.
 * - Session attribution funguje len ak event pride do 24 h od startu session
 *   a posle sa session_id. Preto near-real-time cez webhook, nie denny batch.
 * - Posielat konverziu za pouzivatela, ktory ODMIETOL suhlas, je porusenie
 *   Google policy aj GDPR. Bez suhlasu nedoplnujeme.
 */
import { db, decrypt } from "./db.mjs";

const MP_URL = "https://www.google-analytics.com/mp/collect";
const DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";

/** Okno, v ktorom ma zmysel doplnat (session attribution). */
const SESSION_WINDOW_H = 24;

export function canBackfill(order, identity) {
  if (!identity?.ga_client_id) {
    return { ok: false, reason: "no_client_id",
      note: "No GA4 client ID — there is nobody to attribute this conversion "
          + "to. Sending it anyway would corrupt your attribution." };
  }
  // Suhlas: pixel uklada "granted" | "denied" | "unknown".
  // `consent_denied` je stary tvar, ktory nikto nikdy nenastavil (audit, bod 5).
  const consent = identity.consent || (identity.consent_denied ? "denied" : null);
  if (consent === "denied") {
    return { ok: false, reason: "consent_denied",
      note: "The customer declined consent. Sending this conversion would "
          + "breach GDPR and Google's terms." };
  }
  if (consent !== "granted") {
    // Radsej nedoplnit, nez doplnit bez preukazatelneho suhlasu. Objednavka
    // zostane v reporte s dovodom, aby merchant videl, kolko mu takto unika.
    return { ok: false, reason: "consent_unknown",
      note: "We cannot prove the visitor consented. Without that, we do not "
          + "send the conversion." };
  }
  const ageH = (Date.now() - new Date(order.created_at).getTime()) / 3600_000;
  if (ageH > SESSION_WINDOW_H) {
    return { ok: false, reason: "session_expired",
      note: `Order is ${ageH.toFixed(0)} h. Po 24 h sa už event `
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
      // bez session_id sa event nespari s povodnou navstevou
      ...(identity.ga_session_id ? { session_id: identity.ga_session_id } : {}),
      engagement_time_msec: 1,
      items: items.length ? items : undefined,
    },
  };

  return {
    client_id: identity.ga_client_id,
    ...(identity.user_id ? { user_id: identity.user_id } : {}),
    // timestamp objednavky, aby event sedel do spravnej session
    timestamp_micros: new Date(order.created_at).getTime() * 1000,
    non_personalized_ads: false,
    // Suhlas hlasime podla toho, co realne zachytil pixel — NIE natvrdo
    // GRANTED (audit, bod 5). Objednavky s "denied" sa sem vobec nedostanu,
    // canBackfill() ich odmietne skor; "unknown" hlasime konzervativne ako
    // DENIED pre personalizaciu.
    consent: {
      ad_user_data: identity?.consent === "granted" ? "GRANTED" : "DENIED",
      ad_personalization: identity?.consent === "granted" ? "GRANTED" : "DENIED",
    },
    events: [ev],
  };
}

/**
 * Validacia cez debug endpoint. MP produkcny endpoint nevracia chyby,
 * takze bez tohoto by sme netusili, ci payload sedi.
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

  // najprv debug — produkcny endpoint chyby nehlasi
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
  // MP vracia 204 aj pri zahodenom evente — preto sa uspech NETVRDI len z kodu
  return { sent: r.status === 204 || r.ok, status: r.status };
}

// Schema tychto tabuliek zije v db.mjs (jedno miesto pravdy).
// Predtym boli definovane aj tu, takze vysledna schema zavisela
// od poradia importov — audit 31.8.2026, bod 3.

/**
 * Ulozi identitu z pixelu.
 *
 * `row` uz musi byt prejdene cez sanitizeIdentity() v server.mjs — plochy
 * objekt s overenymi polami. Cely raw payload sa uz NEUKLADA: bol to zbytocny
 * balast a zaroven ulozisko dat, ktore sme nikdy necitali (audit, bod 8).
 *
 * ZLUCUJE, NEPREPISUJE. Identita prichadza po kusoch a kazdy event vie nieco
 * ine: `page_viewed` prinesie `_ga` client_id, `checkout_completed` az token
 * a order_id. Povodne `INSERT OR REPLACE` prepisalo skor ulozene client_id
 * hodnotou NULL, takze objednavka skoncila bez identity — presne to, co ma
 * appka riesit (overene na zivom obchode 1.9.2026).
 */
export function saveIdentity(shopId, row) {
  const id = row.identity || row;      // znasa aj stary tvar
  const sfcid = row.shopify_client_id || id.shopify_client_id || null;
  const token = row.checkout_token || null;
  const orderId = row.order_id || id.order_id || null;

  // Chyba nam client_id, ale pozname Shopify clientId? Dotiahni ho zo
  // skorsieho zaznamu tej istej navstevy — inak je konverzia nepriraditelna.
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

  // Bez checkout_tokenu nemame kluc na zlucenie (PK je shop_id+token a NULL
  // sa v SQLite nikdy nerovna NULL). Taky zaznam je len "pixel bezi" stopa.
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
  // 1) note_attributes z objednavky — najspolahlivejsie
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
  // 2) z pixelu podla checkout_token
  const byToken = checkoutToken && db.prepare(
    "SELECT * FROM identities WHERE shop_id=? AND checkout_token=?",
  ).get(shopId, checkoutToken);
  if (byToken?.ga_client_id) return { ...byToken, source: "pixel_token" };

  // 3) podla order_id
  const byOrder = db.prepare(
    "SELECT * FROM identities WHERE shop_id=? AND order_id=?",
  ).get(shopId, String(orderId));
  if (byOrder?.ga_client_id) return { ...byOrder, source: "pixel_order" };

  // 4) cez Shopify clientId — ta ista navsteva, iny event.
  //    Zaznam objednavky moze mat token aj order_id, ale ziadne `_ga`
  //    client_id (checkout bezi na inej domene a cookie tam neprecitame).
  //    Client_id sme videli skor pri `page_viewed` v tej istej navsteve;
  //    `clientId` zo Shopify je jediny kluc, ktory ich spaja.
  const anchor = byToken || byOrder;
  if (anchor?.shopify_client_id) {
    const byVisit = db.prepare(
      `SELECT * FROM identities
       WHERE shop_id=? AND shopify_client_id=? AND ga_client_id IS NOT NULL
       ORDER BY seen_at DESC LIMIT 1`).get(shopId, anchor.shopify_client_id);
    if (byVisit?.ga_client_id) {
      return {
        ...byVisit,
        // suhlas patri k objednavke, nie k skorsiemu zobrazeniu stranky
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
