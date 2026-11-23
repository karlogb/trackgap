/**
 * TrackGap - cache and monitoring.
 *
 * Cache: a check pulls 60 days of Shopify orders and 60 days from GA4.
 * Without a cache every dashboard open would trigger dozens of API calls.
 * GA4 also has a per-property token quota; pointless runs burn the
 * merchant's quota.
 *
 * Monitoring: without it the merchant would have to click manually. The
 * point of the product is to speak up on the day tracking breaks, not a
 * month later at invoicing time.
 */
import { db } from "./db.mjs";

const CACHE_TTL_MIN = 60;

// The schema of these tables lives in db.mjs (single source of truth).
// They used to be defined here as well, so the resulting schema depended
// on import order.

export function getCached(shopId) {
  const r = db.prepare(
    `SELECT payload, created_at FROM check_cache
     WHERE shop_id = ?
       AND created_at > datetime('now', '-${CACHE_TTL_MIN} minutes')`,
  ).get(shopId);
  return r ? { ...JSON.parse(r.payload), _cached_at: r.created_at } : null;
}

/**
 * Latest result REGARDLESS of TTL, for stale-while-revalidate.
 * The dashboard shows it immediately and a fresh one is computed in the
 * background; without this the merchant waited for the full 60-day check
 * on every open.
 */
export function getStale(shopId) {
  const r = db.prepare(
    "SELECT payload, created_at FROM check_cache WHERE shop_id = ?",
  ).get(shopId);
  return r ? { ...JSON.parse(r.payload), _cached_at: r.created_at } : null;
}

export function setCached(shopId, payload) {
  db.prepare(`INSERT INTO check_cache (shop_id, payload, created_at)
              VALUES (?, ?, datetime('now'))
              ON CONFLICT(shop_id) DO UPDATE SET
                payload = excluded.payload,
                created_at = excluded.created_at`)
    .run(shopId, JSON.stringify(payload));
}

export function invalidate(shopId) {
  db.prepare("DELETE FROM check_cache WHERE shop_id = ?").run(shopId);
}

export function recordRun(shopId, result) {
  const s = result.summary;
  db.prepare(`INSERT INTO check_history
    (shop_id,missing,missing_pct,duplicates,ghosts,orders,ga4_rows,value_kind,
     never_fired,delivery_broken,pixel_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(shopId, s.missing, s.missing_pct, s.duplicates, s.ghosts,
         s.orders_compared, s.ga4_transactions, s.value_gap_kind,
         s.never_fired ?? null, s.delivery_broken ?? null,
         s.pixel_active ? 1 : 0);
}

/**
 * Compares the latest run with previous ones and returns alerts.
 * Reports only a CHANGE FOR THE WORSE, not a state that has lasted for weeks.
 */
export function detectRegressions(shopId, result) {
  const prev = db.prepare(
    `SELECT * FROM check_history WHERE shop_id = ?
     ORDER BY ran_at DESC LIMIT 5 OFFSET 1`,
  ).all(shopId);
  if (!prev.length) return [];

  const s = result.summary;
  const alerts = [];
  const baseline = prev.reduce((a, p) => a + (p.missing_pct || 0), 0) / prev.length;

  // 1) sudden jump in missing orders
  if (s.missing_pct > baseline + 10 && s.missing_pct > 10) {
    alerts.push({
      kind: "missing_spike",
      message: `Untracked orders jumped to ${s.missing_pct}% `
             + `(previously around ${baseline.toFixed(1)}%). Something in your `
             + "tracking most likely broke - check recent changes in GTM or "
             + "your theme.",
    });
  }

  // 2) GA4 stopped receiving entirely
  if (s.ga4_transactions === 0 && prev[0].ga4_rows > 0) {
    alerts.push({
      kind: "ga4_silent",
      message: "GA4 recorded no transactions at all in this period, "
             + "although it did before. Tracking is almost certainly broken.",
    });
  }

  // 3) duplicates appeared where there were none
  if (s.duplicates > 0 && prev.every((p) => (p.duplicates || 0) === 0)) {
    alerts.push({
      kind: "duplicates_new",
      message: `${s.duplicates} duplicate transactions appeared. `
             + "This usually means a second tracking source is sending the "
             + "same orders again.",
    });
  }

  // 4) the nature of the value difference changed
  if (prev[0].value_kind && prev[0].value_kind !== s.value_gap_kind
      && s.value_gap_kind === "inconsistent") {
    alerts.push({
      kind: "value_broke",
      message: "Order values sent to GA4 stopped differing in a "
             + "predictable way. The gap used to be consistent (shipping or "
             + "VAT); now it is random.",
    });
  }

  // 5) the pixel stopped reporting
  //
  // This is a failure of the MEASUREMENT ITSELF, not the store: the pixel
  // used to send data and now does not. The merchant has no other way to
  // learn about it; the dashboard would just silently lose the ability to
  // tell why orders are missing.
  if (prev.some((p) => p.pixel_active) && !s.pixel_active) {
    alerts.push({
      kind: "pixel_silent",
      message: "TrackGap stopped receiving events from your storefront. "
             + "The app's web pixel was reporting before and now sends "
             + "nothing, so we can no longer tell whether a conversion left "
             + "the browser. Reopen the app to reactivate it.",
    });
  }

  return alerts;
}

export function saveAlerts(shopId, alerts) {
  const ins = db.prepare(
    "INSERT INTO alerts (shop_id, kind, message) VALUES (?,?,?)");
  db.transaction(() => {
    for (const a of alerts) {
      // do not send the same thing twice within 24 h
      const dup = db.prepare(
        `SELECT 1 FROM alerts WHERE shop_id=? AND kind=?
           AND created_at > datetime('now','-1 day')`).get(shopId, a.kind);
      if (!dup) ins.run(shopId, a.kind, a.message);
    }
  })();
}

export function pendingAlerts() {
  return db.prepare(
    `SELECT a.*, s.shop_domain FROM alerts a
     JOIN shops s ON s.id = a.shop_id
     WHERE a.sent_at IS NULL`).all();
}

export function markSent(id) {
  db.prepare("UPDATE alerts SET sent_at = datetime('now') WHERE id = ?").run(id);
}

export function history(shopId, limit = 30) {
  return db.prepare(
    `SELECT ran_at, missing, missing_pct, duplicates, ghosts, orders
     FROM check_history WHERE shop_id = ? ORDER BY ran_at DESC LIMIT ?`,
  ).all(shopId, limit);
}
