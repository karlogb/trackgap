/**
 * TrackGap — tretia vrstva merania (vlastny web pixel).
 *
 * PRECO TO EXISTUJE:
 * Shopify vie, ze objednavka vznikla. GA4 vie, ze prisla (alebo neprisla).
 * Medzi tym je diera: ked objednavka v GA4 chyba, sam rozdiel NEPOVIE, ci
 *   (a) sa event vobec neodpalil v prehliadaci, alebo
 *   (b) odpalil sa, ale do GA4 nedorazil.
 * Su to dve uplne ine poruchy s inou opravou:
 *   (a) chyba v theme / consent banneri / GTM triggeri  -> merchant opravuje web
 *   (b) chyba v GA4 tagu, konfiguracii alebo blokovanie -> merchant opravuje meranie
 *
 * Nas pixel bezi v Shopify sandboxe, ktory merchant nevie omylom rozbit, a je
 * uplne nezavisly od GTM aj GA4. Ked od neho mame `purchase`, vieme s istotou,
 * ze konverzia prehliadac OPUSTILA. To je presne dokaz, ktory konkurencia
 * (Untracked: Conversion Monitor) ma tiez — ale my ho krizime s realnym GA4,
 * takze vieme ukazat, KDE presne sa retazec pretrhol.
 *
 * PCD Level 1: ukladame len checkout_token, order_id, sumu, menu, cas a stav
 * suhlasu. Ziadne meno, e-mail, adresa ani telefon.
 */
import { db } from "./db.mjs";

/**
 * Zapise udalost z pixelu.
 *
 * Idempotentne: pixel posiela `keepalive` fetch, ktory sa pri zatvarani karty
 * moze zopakovat, a `checkout_completed` sa da vyvolat aj obnovenim dakovnej
 * stranky. Bez toho by jedna objednavka vygenerovala niekolko riadkov a
 * vyzerala by ako duplicita, ktoru sme si sposobili sami.
 */
export function recordPixelEvent(shopId, ev) {
  const token = ev.checkout_token || null;
  const orderId = ev.order_id ? String(ev.order_id) : null;
  if (!token && !orderId) return false;      // niet co zakotvit

  db.prepare(`
    INSERT INTO pixel_events
      (shop_id, checkout_token, order_id, event_type, total, currency, consent)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (shop_id, event_type, COALESCE(checkout_token, order_id, ''))
    DO UPDATE SET
      order_id = COALESCE(pixel_events.order_id, excluded.order_id),
      total    = COALESCE(excluded.total, pixel_events.total),
      currency = COALESCE(excluded.currency, pixel_events.currency),
      consent  = COALESCE(excluded.consent, pixel_events.consent)
  `).run(shopId, token, orderId, ev.event_type,
         Number.isFinite(ev.total) ? ev.total : null,
         ev.currency || null, ev.consent || null);
  return true;
}

/**
 * Doplni order_id k udalosti, ktora prisla len s checkout_token.
 *
 * Vola sa z webhooku orders/create — to je jediny moment, kedy sa token a
 * cislo objednavky stretnu. Bez tohto kroku by pixel_events zostali navzdy
 * nesparovatelne s objednavkami a cela vrstva by bola k nicomu.
 *
 * Jedinecnost stoji na checkout_tokene, nie na order_id, takze doplnenie
 * order_id nikdy nemoze sposobit konflikt.
 */
export function linkOrderToPixel(shopId, checkoutToken, orderId) {
  if (!checkoutToken || !orderId) return 0;
  return db.prepare(`
    UPDATE pixel_events SET order_id = ?
    WHERE shop_id = ? AND checkout_token = ? AND order_id IS NULL
  `).run(String(orderId), shopId, String(checkoutToken)).changes;
}

/**
 * Odkedy pixel realne posiela.
 *
 * KRITICKE PRE POCTIVOST VYSLEDKU: objednavky spred instalacie appky pixel
 * nikdy nevidel. Bez tejto hranice by sme ich vsetky oznacili za "event sa
 * neodpalil" a merchantovi by sme nahlasili poruchu, ktora neexistuje.
 * Vsetko starsie ide do kategorie "before_pixel" a do zaverov sa neratá.
 */
export function pixelActiveSince(shopId) {
  const r = db.prepare(
    `SELECT MIN(fired_at) AS first_seen FROM pixel_events WHERE shop_id = ?`,
  ).get(shopId);
  return r?.first_seen || null;
}

/** Mnozina order_id, pre ktore mame od pixelu potvrdeny purchase. */
export function purchasedOrderIds(shopId) {
  const rows = db.prepare(
    `SELECT DISTINCT order_id FROM pixel_events
     WHERE shop_id = ? AND event_type = 'purchase' AND order_id IS NOT NULL`,
  ).all(shopId);
  return new Set(rows.map((r) => String(r.order_id)));
}

/** Prehlad pre dashboard aj onboarding: bezi pixel vobec? */
export function pixelHealth(shopId) {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                   AS events,
      SUM(CASE WHEN event_type = 'purchase' THEN 1 ELSE 0 END)   AS purchases,
      SUM(CASE WHEN event_type = 'purchase' AND order_id IS NULL
               THEN 1 ELSE 0 END)                                AS unlinked,
      MAX(fired_at)                                              AS last_seen,
      MIN(fired_at)                                              AS first_seen
    FROM pixel_events WHERE shop_id = ?
  `).get(shopId) || {};

  const recent = db.prepare(
    `SELECT COUNT(*) n FROM pixel_events
     WHERE shop_id = ? AND fired_at > datetime('now', '-7 days')`,
  ).get(shopId).n;

  return {
    installed: (row.events || 0) > 0,
    events: row.events || 0,
    purchases: row.purchases || 0,
    unlinked_purchases: row.unlinked || 0,
    events_last_7d: recent,
    first_seen: row.first_seen || null,
    last_seen: row.last_seen || null,
  };
}
