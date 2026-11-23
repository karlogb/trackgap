/**
 * TrackGap - third measurement layer (our own web pixel).
 *
 * WHY THIS EXISTS:
 * Shopify knows an order was created. GA4 knows whether it arrived. In
 * between there is a gap: when an order is missing in GA4, the difference
 * alone does NOT say whether
 *   (a) the event never fired in the browser, or
 *   (b) it fired but never reached GA4.
 * These are two entirely different failures with different fixes:
 *   (a) theme / consent banner / GTM trigger bug   -> merchant fixes the site
 *   (b) GA4 tag, configuration or blocking issue -> merchant fixes tracking
 *
 * Our pixel runs in the Shopify sandbox, which the merchant cannot break by
 * accident, and is fully independent of GTM and GA4. When it reports a
 * `purchase`, we know for sure the conversion LEFT the browser. Cross-checked
 * against real GA4 data, this shows exactly WHERE the chain broke.
 *
 * PCD Level 1: we store only checkout_token, order_id, amount, currency,
 * time and consent state. No name, e-mail, address or phone.
 */
import { db } from "./db.mjs";

/**
 * Records a pixel event.
 *
 * Idempotent: the pixel sends a `keepalive` fetch that may repeat when the
 * tab closes, and `checkout_completed` can also fire on a thank-you page
 * refresh. Without this one order would generate several rows and look like
 * a self-inflicted duplicate.
 */
export function recordPixelEvent(shopId, ev) {
  const token = ev.checkout_token || null;
  const orderId = ev.order_id ? String(ev.order_id) : null;
  if (!token && !orderId) return false;      // nothing to anchor

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
 * Fills in the order_id for an event that arrived with only a checkout_token.
 *
 * Called from the orders/create webhook, the only moment where the token and
 * the order number meet. Without this step pixel_events could never be
 * matched to orders and the whole layer would be useless.
 *
 * Uniqueness is based on checkout_token, not order_id, so filling in the
 * order_id can never cause a conflict.
 */
export function linkOrderToPixel(shopId, checkoutToken, orderId) {
  if (!checkoutToken || !orderId) return 0;
  return db.prepare(`
    UPDATE pixel_events SET order_id = ?
    WHERE shop_id = ? AND checkout_token = ? AND order_id IS NULL
  `).run(String(orderId), shopId, String(checkoutToken)).changes;
}

/**
 * Since when the pixel has actually been sending.
 *
 * CRITICAL FOR AN HONEST RESULT: the pixel never saw orders placed before the
 * app was installed. Without this boundary we would mark all of them as
 * "event never fired" and report a failure that does not exist.
 * Everything older goes into the "before_pixel" category and is excluded
 * from conclusions.
 */
export function pixelActiveSince(shopId) {
  const r = db.prepare(
    `SELECT MIN(fired_at) AS first_seen FROM pixel_events WHERE shop_id = ?`,
  ).get(shopId);
  return r?.first_seen || null;
}

/** Set of order_ids for which the pixel confirmed a purchase. */
export function purchasedOrderIds(shopId) {
  const rows = db.prepare(
    `SELECT DISTINCT order_id FROM pixel_events
     WHERE shop_id = ? AND event_type = 'purchase' AND order_id IS NOT NULL`,
  ).all(shopId);
  return new Set(rows.map((r) => String(r.order_id)));
}

/** Summary for the dashboard and onboarding: is the pixel running at all? */
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
