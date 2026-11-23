/**
 * TrackGap - e-mail alerts.
 *
 * The point of the product is to speak up on the DAY tracking breaks.
 * A dashboard nobody looks at does not solve the problem.
 *
 * We send ONLY when something got worse compared to previous runs
 * (monitor.mjs -> detectRegressions). A daily "all is well" summary teaches
 * the merchant to set up a filter and stop reading alerts.
 */
import fs from "node:fs";
import { db } from "./db.mjs";
import { pendingAlerts, markSent } from "./monitor.mjs";
import { smtpConfigPath, smtpConfigFromEnv, appUrl } from "./secrets.mjs";
import { sendMail as smtpSend } from "./smtp.mjs";

const FROM = process.env.TRACKGAP_MAIL_FROM || "TrackGap <alerts@example.com>";
const REPLY_TO = process.env.TRACKGAP_MAIL_REPLYTO || "support@example.com";

function smtpConfig() {
  const p = smtpConfigPath();
  const c = fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf8"))
    : smtpConfigFromEnv();
  if (!c) return null;
  return {
    host: c.host,
    port: c.smtp_port || 1025,
    user: c.user,
    pass: c.password,
    helo: new URL(appUrl()).hostname,
  };
}

/**
 * Sends a mail through Proton Bridge.
 *
 * The SMTP dialogue lives in smtp.mjs. An earlier version here did not do
 * STARTTLS (Bridge refuses AUTH without it) and advanced its state on every
 * TCP chunk, so a multi-line reply made it send commands out of order. The
 * alert would then fail exactly when it matters most.
 */
async function sendMail({ to, subject, text }) {
  const cfg = smtpConfig();
  if (!cfg) throw new Error("no smtp config");
  return smtpSend(cfg, { from: FROM, replyTo: REPLY_TO, to, subject, text });
}

const SUBJECTS = {
  missing_spike: "Tracking gap opened on your store",
  ga4_silent: "Your analytics stopped recording orders",
  duplicates_new: "Duplicate conversions detected",
  value_broke: "Order values no longer match your analytics",
  pixel_silent: "TrackGap stopped receiving data from your store",
  access_lost: "TrackGap can no longer check your tracking",
};

/**
 * Finding severity; decides the mail subject when several findings arrive at
 * once. GA4 silence and a blind pixel are tracking outages; duplicates and
 * value mismatches are inaccuracies. The former must be fixed today.
 */
const SEVERITY = {
  // Highest severity of all: after losing access the app CANNOT SAY ANYTHING.
  // A GA4 outage is a detected problem; this is blindness, because any other
  // finding during that time is missing, having nothing to be derived from.
  access_lost: 6,
  ga4_silent: 5,
  pixel_silent: 4,
  missing_spike: 3,
  duplicates_new: 2,
  value_broke: 1,
};

function buildBody(shopDomain, alerts, summary) {
  const app = `${appUrl()}/app?shop=${encodeURIComponent(shopDomain)}`;
  const list = Array.isArray(alerts) ? alerts : [alerts];
  const lines = [];

  // LOST ACCESS must not be mixed with numbers from the last check. Those are
  // stale and the app no longer knows whether they hold; showing them next to
  // "we cannot see your store" contradicts the purpose of this mail.
  // The merchant should get one thing: what to click so the app can see again.
  const blind = list.find((a) => a.kind === "access_lost");
  if (blind) {
    return [
      blind.message,
      "",
      "Until this is fixed, TrackGap is NOT checking your tracking. If your",
      "analytics break in the meantime, we will not be able to warn you.",
      "",
      `Reconnect here: ${app}`,
      "",
      "-",
      "This is the only case where we email you about TrackGap itself",
      "rather than about your store.",
    ].join("\n");
  }

  // Several findings = numbered list. A single item is not numbered so a
  // mail about one problem does not look like a report.
  if (list.length === 1) {
    lines.push(list[0].message);
  } else {
    lines.push(`We found ${list.length} problems with tracking on your store:`, "");
    list.forEach((a, i) => lines.push(`${i + 1}. ${a.message}`, ""));
  }

  lines.push(
    "",
    "Where things stand right now:",
    `  Orders compared:     ${summary?.orders_compared ?? "-"}`,
    `  Missing in GA4:      ${summary?.missing ?? "-"} (${summary?.missing_pct ?? "-"}%)`,
    `  Duplicates:          ${summary?.duplicates ?? "-"}`,
  );

  // The per-layer breakdown is the most valuable thing we can say: it tells
  // the merchant WHAT to fix, not just that something does not match.
  const nf = summary?.never_fired;
  const db_ = summary?.delivery_broken;
  if (nf || db_) {
    lines.push("", "Where the chain breaks:");
    if (db_) {
      lines.push(
        `  ${db_} order(s): the purchase event fired in the browser, but GA4`,
        "    never recorded it. Look at your GA4 tag and measurement ID.",
      );
    }
    if (nf) {
      lines.push(
        `  ${nf} order(s): no purchase event fired in the browser at all.`,
        "    Look at your thank-you page, consent banner or GTM trigger.",
      );
    }
  }

  lines.push(
    "",
    `Open TrackGap: ${app}`,
    "",
    "-",
    "You are getting this because tracking on your store changed for the worse.",
    "TrackGap does not send routine summaries - only real problems.",
  );
  return lines.join("\n");
}

/**
 * Sends pending alerts. Called after every check.
 * Never throws: a failed mail must not break the check.
 *
 * ONE MAIL PER STORE: previously a mail was sent for EVERY finding, so a
 * single check could send several mails in a row (e.g. `duplicates_new` and
 * `value_broke` from one run produced two separate mails). A merchant warned
 * three times in one morning sets up a filter, and the alert the app exists
 * for is never read again.
 */
export async function flushAlerts() {
  const pending = pendingAlerts();
  if (!pending.length) return { sent: 0 };

  // group by store
  const byShop = new Map();
  for (const a of pending) {
    if (!byShop.has(a.shop_id)) byShop.set(a.shop_id, []);
    byShop.get(a.shop_id).push(a);
  }

  let sent = 0;
  for (const [shopId, group] of byShop) {
    const shop = db.prepare(
      "SELECT id, shop_domain, alert_email FROM shops WHERE id = ?").get(shopId);
    const to = shop?.alert_email;
    if (!to) {
      // no address to send to: mark as processed so they do not pile up
      for (const a of group) markSent(a.id);
      continue;
    }

    // Sending proves the channel is not broken. We do NOT say `delivered`:
    // bounces arrive asynchronously, so at this point we only know the relay
    // accepted the message. `sent` is exactly what we know; calling it
    // `delivered` would be an unverified assumption.
    const markMail = (status, err) => db.prepare(
      "UPDATE shops SET alert_email_status=?, alert_email_error=? WHERE id=?")
      .run(status, err, shopId);

    const last = db.prepare(
      `SELECT missing, missing_pct, duplicates, orders AS orders_compared,
              never_fired, delivery_broken
       FROM check_history WHERE shop_id = ? ORDER BY ran_at DESC LIMIT 1`)
      .get(shopId);

    // The subject is decided by the MOST SEVERE finding, not the first one
    // from the DB. The merchant only sees the subject in the inbox and should
    // be able to tell a tracking outage from mere duplicates.
    const primary = [...group].sort(
      (a, b) => (SEVERITY[b.kind] ?? 0) - (SEVERITY[a.kind] ?? 0))[0];
    const subject = group.length === 1
      ? (SUBJECTS[primary.kind] || "TrackGap alert")
      : `${SUBJECTS[primary.kind] || "TrackGap alert"} (+${group.length - 1} more)`;

    try {
      await sendMail({
        to, subject, text: buildBody(shop.shop_domain, group, last),
      });
      for (const a of group) markSent(a.id);
      markMail("sent", null);
      sent += 1;
    } catch (e) {
      console.error(`alert mail failed (${shop.shop_domain}):`, e.message);
      // A failed alert must NOT be marked as sent: it stays pending and is
      // retried. We also record it on the store so the merchant sees it in
      // the UI; otherwise the app would stay silent and look as if it were
      // silent because everything is fine.
      markMail("failed", String(e.message).slice(0, 300));
    }
  }
  return { sent };
}

export async function sendTest(shopDomain, to) {
  return sendMail({
    to,
    subject: "TrackGap - test alert",
    text: [
      `This is a test alert for ${shopDomain}.`,
      "",
      "If you are reading this, alerts are working. You will only hear from us",
      "when something about your tracking gets worse - not on a schedule.",
      "",
      `${appUrl()}/app?shop=${encodeURIComponent(shopDomain)}`,
    ].join("\n"),
  });
}
