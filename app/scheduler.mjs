/**
 * TrackGap - scheduler for periodic checks.
 *
 * WHY: without it a check ran ONLY when the merchant opened the dashboard.
 * The product promise ("we tell you the day tracking breaks") and the paid
 * plans ("Daily checks", "Email alerts") could not be fulfilled: a merchant
 * who stopped opening the app got nothing, exactly when an alert is needed
 * most.
 *
 * Cadence by plan:
 *   free    weekly
 *   others  daily
 *
 * Runs in the same process as the server (one store = a few HTTP calls per
 * day; a separate worker is not needed yet).
 */
import { db } from "./db.mjs";
import { PLANS } from "./billing.mjs";
import { flushAlerts } from "./alerts.mjs";
import { saveAlerts } from "./monitor.mjs";

/**
 * How long we tolerate lost access before e-mailing the merchant.
 *
 * Not on the first failure: a short Shopify/Google API or server outage
 * would otherwise produce a "lost access" mail that fixes itself within an
 * hour. A false alarm from a monitoring app costs more than an hour of
 * delay; after one, the merchant stops taking further mails seriously.
 */
const ACCESS_GRACE_H = Number(process.env.TRACKGAP_ACCESS_GRACE_H ?? 6);

const HOUR = 3600_000;
const TICK_MS = 30 * 60_000;        // how often we check whether something is due

/**
 * Hour (in store time) at which the daily check runs.
 *
 * WHY A FIXED HOUR: without it the cadence was counted from the last run, so
 * the check time drifted every day and an alert could arrive at 3 a.m. The
 * merchant should get the mail in the morning when they can act on it, and
 * only once GA4 has processed the previous day.
 */
const DAILY_HOUR = Number(process.env.TRACKGAP_DAILY_HOUR ?? 7);

/**
 * Minimum hours since the last run before another one starts.
 * Prevents the check from running more than once within the DAILY_HOUR window.
 */
const MIN_GAP_H = 20;

/** Local hour in the store's time zone (fallback: server time). */
function localHour(tz) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC", hour: "numeric", hour12: false,
    }).format(new Date()));
  } catch {
    return new Date().getHours();
  }
}

/** How often the check runs for a plan, in hours. */
function cadenceHours(plan) {
  return plan === "free" ? 24 * 7 : 24;
}

/**
 * Stores whose cadence has elapsed.
 *
 * Only stores that HAVE BEEN set up at least once (have a GA4 property
 * selected); otherwise there is nothing to compare.
 *
 * We deliberately do NOT filter on token presence here. This used to be
 * `access_token_enc IS NOT NULL AND google_refresh_enc IS NOT NULL`, so a
 * store that just lost access silently DROPPED OUT of the scheduler. It was
 * no longer checked and no alert could be raised; the app had no way to
 * report its own blindness. We let them through, `runCheck` fails with
 * AccessError and the merchant gets a mail.
 */
function dueShops() {
  const rows = db.prepare(`
    SELECT s.shop_domain, s.plan, s.id, s.timezone,
           (SELECT MAX(ran_at) FROM check_history h WHERE h.shop_id = s.id) AS last_run
    FROM shops s
    WHERE s.uninstalled_at IS NULL
      AND s.ga4_property_id IS NOT NULL
  `).all();

  const now = Date.now();
  return rows.filter((r) => {
    if (!r.last_run) return true;                 // never ran yet
    const age = now - new Date(r.last_run.replace(" ", "T") + "Z").getTime();

    // Safety net: if the check has not run for much longer than it should
    // (server down, store without GA4), run it regardless of the hour.
    if (age >= cadenceHours(r.plan) * HOUR + 12 * HOUR) return true;

    // The plan cadence always applies: free gets a weekly, not daily, check.
    // A small margin is subtracted so the 7:00 run is not a few minutes "too
    // early" and pushed back by a whole day (or week).
    if (age < cadenceHours(r.plan) * HOUR - 2 * HOUR) return false;
    if (age < MIN_GAP_H * HOUR) return false;

    // within the day, wait for the set hour in STORE time
    return localHour(r.timezone) === DAILY_HOUR;
  });
}

let running = false;

/**
 * When the app has lost access for longer than ACCESS_GRACE_H, create an
 * alert: the app must SAY that it stopped watching.
 *
 * The text depends on who can fix it and how: Shopify access is restored by
 * opening the app in the admin, Google by reconnecting the account in
 * settings. A generic "an error occurred" would not help the merchant.
 */
export function raiseAccessAlert(shopId) {
  const s = db.prepare(
    `SELECT access_broken_kind AS kind, access_broken_since AS since,
            ga4_connected_at, google_refresh_enc
     FROM shops WHERE id = ?`).get(shopId);
  if (!s?.kind || !s.since) return;

  // A store that never connected Google had nothing to lose. Telling it "we
  // stopped watching your tracking" is a false alarm from a monitoring app,
  // after which the merchant stops taking any further mail seriously.
  if (s.kind === "google_auth" && !s.ga4_connected_at && !s.google_refresh_enc) {
    return;
  }

  const age = Date.now() - new Date(s.since.replace(" ", "T") + "Z").getTime();
  if (age < ACCESS_GRACE_H * HOUR) return;

  const message = s.kind === "google_auth"
    ? "TrackGap has lost access to your Google Analytics, so it has stopped "
      + "checking your tracking. This usually happens when the Google account "
      + "connection is revoked or expires. Reconnect Google to resume."
    : "TrackGap has lost access to your Shopify orders, so it has stopped "
      + "checking your tracking. Open the app from your Shopify admin to "
      + "reauthorize it.";

  // saveAlerts itself filters repeats of the same kind within 24 h, so a
  // lasting failure sends one mail per day, not one per tick.
  saveAlerts(shopId, [{ kind: "access_lost", message }]);
}

/**
 * One pass. A failure in one store must not stop the others; each runs in
 * its own try/catch.
 */
export async function runScheduledChecks(runCheck) {
  if (running) return { skipped: "already running" };
  running = true;
  const done = [];
  try {
    for (const shop of dueShops()) {
      try {
        const row = db.prepare("SELECT * FROM shops WHERE id = ?").get(shop.id);
        const r = await runCheck(row);
        done.push({
          shop: shop.shop_domain,
          missing: r?.summary?.missing ?? null,
          pct: r?.summary?.missing_pct ?? null,
        });
      } catch (e) {
        console.error(`scheduled check failed (${shop.shop_domain}):`, e.message);
        done.push({ shop: shop.shop_domain, error: e.message });
        // A failed check must not end with just a log entry. That is how the
        // app used to go blind silently: the exception was logged, the loop
        // kept spinning and the merchant believed they were being watched.
        raiseAccessAlert(shop.id);
      }
    }
    if (done.length) {
      // alerts only after all checks, so each store gets a single mail
      await flushAlerts().catch((e) =>
        console.error("flushAlerts:", e.message));
    }
  } finally {
    running = false;
  }
  return { checked: done.length, done };
}

/** Cleans up old records; otherwise they grow forever. */
export function pruneOldRows() {
  const stmts = [
    "DELETE FROM webhook_log WHERE seen_at < datetime('now','-7 days')",
    "DELETE FROM identities WHERE seen_at < datetime('now','-30 days')",
    "DELETE FROM orders WHERE created_at < datetime('now','-90 days')",
    `DELETE FROM ga4_events
     WHERE date(substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2))
           < date('now','-90 days')`,
    "DELETE FROM pixel_events WHERE fired_at < datetime('now','-90 days')",
    "DELETE FROM check_history WHERE ran_at < datetime('now','-12 months')",
    "DELETE FROM backfills WHERE created_at < datetime('now','-12 months')",
    "DELETE FROM findings WHERE detected_at < datetime('now','-12 months')",
    // The Ads report is only a cache; after a day it is worthless and just takes space.
    "DELETE FROM kv_cache WHERE created_at < datetime('now','-1 day')",
  ];
  let total = 0;
  for (const s of stmts) {
    try { total += db.prepare(s).run().changes; } catch { /* table may be missing */ }
  }
  return total;
}

export function startScheduler(runCheck) {
  const tick = async () => {
    try {
      const r = await runScheduledChecks(runCheck);
      if (r.checked) console.log(`scheduler: ${r.checked} checks`);
    } catch (e) {
      console.error("scheduler tick:", e.message);
    }
  };

  // first run one minute after start, so a restart does not fire everything at once
  setTimeout(tick, 60_000);
  const t1 = setInterval(tick, TICK_MS);

  const t2 = setInterval(() => {
    const n = pruneOldRows();
    if (n) console.log(`scheduler: cleaned up ${n} old rows`);
  }, 24 * HOUR);

  // do not let the interval keep the process alive on shutdown
  t1.unref?.();
  t2.unref?.();
  console.log(`scheduler: started (tick ${TICK_MS / 60000} min)`);
}
