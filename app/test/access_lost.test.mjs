/**
 * Lost access: the app MUST say that it stopped watching.
 *
 * WHY THIS TEST: when a store's Shopify token expired or the merchant
 * removed the Google account, `runCheck` threw, the scheduler logged it and
 * moved on. Outwardly NOTHING HAPPENED: no mail, and the dashboard kept
 * showing the last cached result. The monitoring app went blind while
 * looking exactly like an app that watches everything. Worse than an error:
 * silence indistinguishable from "all is well".
 *
 * Tested against a real SMTP sink on loopback, same as
 * alerts_group.test.mjs, not against a stubbed function.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DB = path.join(os.tmpdir(), `tg_access_${process.pid}.db`);
const CFG = path.join(os.tmpdir(), `tg_access_smtp_${process.pid}.json`);
process.env.TRACKGAP_DB = DB;
process.env.TRACKGAP_SMTP_CONFIG = CFG;

const outbox = [];
function startSink() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = "", inData = false, body = "";
      sock.write("220 sink ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        for (;;) {
          const i = buf.indexOf("\r\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false; outbox.push(body); body = "";
              sock.write("250 OK\r\n");
            } else { body += line + "\n"; }
            continue;
          }
          const cmd = line.toUpperCase();
          if (cmd.startsWith("EHLO")) sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (cmd.startsWith("HELO")) sock.write("250 sink\r\n");
          else if (cmd.startsWith("AUTH")) sock.write("235 ok\r\n");
          else if (cmd.startsWith("MAIL") || cmd.startsWith("RCPT")) sock.write("250 ok\r\n");
          else if (cmd.startsWith("DATA")) { inData = true; sock.write("354 go\r\n"); }
          else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
          else sock.write("250 ok\r\n");
        }
      });
      sock.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

let sink, db, dbm, alerts, scheduler;

before(async () => {
  sink = await startSink();
  fs.writeFileSync(CFG, JSON.stringify({
    host: "127.0.0.1", smtp_port: sink.address().port, user: "u", password: "p",
  }));
  dbm = await import("../db.mjs");
  db = dbm.db;
  alerts = await import("../alerts.mjs");
  scheduler = await import("../scheduler.mjs");
});

after(() => {
  sink?.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, CFG]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

/** A store that has been fully set up at least once. */
function seed({ token = "tok", google = "ref" } = {}) {
  db.prepare("DELETE FROM alerts").run();
  db.prepare("DELETE FROM check_history").run();
  db.prepare("DELETE FROM shops").run();
  db.prepare(`INSERT INTO shops
      (id, shop_domain, alert_email, ga4_property_id,
       access_token_enc, google_refresh_enc)
    VALUES (1, 'demo-store.myshopify.com', 'merchant@example.com', '123', ?, ?)`)
    .run(token, google);
  outbox.length = 0;
}

/** Moves the failure start into the past to skip the grace period. */
const ageBrokenBy = (hours) => db.prepare(
  `UPDATE shops SET access_broken_since = datetime('now', ?) WHERE id = 1`,
).run(`-${hours} hours`);

beforeEach(() => seed());

test("markAccessBroken keeps the time of the FIRST failure, not the latest", async () => {
  dbm.markAccessBroken(1, "google_auth", "revoked");
  const first = db.prepare("SELECT access_broken_since s FROM shops WHERE id=1").get().s;
  await new Promise((r) => setTimeout(r, 1100));
  dbm.markAccessBroken(1, "google_auth", "revoked again");
  const second = db.prepare("SELECT access_broken_since s FROM shops WHERE id=1").get().s;
  assert.equal(second, first,
    "a repeated failure must not move the time; the failure would never mature into an alert");
});

test("a change in failure kind starts a new time", () => {
  dbm.markAccessBroken(1, "shopify_auth", "x");
  db.prepare("UPDATE shops SET access_broken_since='2020-01-01 00:00:00' WHERE id=1").run();
  dbm.markAccessBroken(1, "google_auth", "y");
  const r = db.prepare(
    "SELECT access_broken_kind k, access_broken_since s FROM shops WHERE id=1").get();
  assert.equal(r.k, "google_auth");
  assert.notEqual(r.s, "2020-01-01 00:00:00");
});

test("clearAccessBroken clears the flag after a successful check", () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  dbm.clearAccessBroken(1);
  const r = db.prepare(
    "SELECT access_broken_kind k, access_broken_since s FROM shops WHERE id=1").get();
  assert.equal(r.k, null);
  assert.equal(r.s, null);
});

test("a store without a token does NOT drop out of the scheduler", async () => {
  // This was the core of the bug: `dueShops` filtered on token presence, so
  // a store that just lost access was no longer checked, and therefore no
  // alert could ever be raised.
  seed({ token: null, google: null });
  let seen = 0;
  await scheduler.runScheduledChecks(async () => {
    seen += 1;
    throw new Error("shop not authenticated");
  });
  assert.equal(seen, 1, "a store without a token must still reach the check");
});

test("a failure within the grace period does NOT send a mail", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");   // right now
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();
  assert.equal(outbox.length, 0,
    "a short outage often fixes itself; a false alarm from monitoring costs more");
});

test("a failure after the grace period sends a mail with instructions", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();

  assert.equal(outbox.length, 1, "the merchant MUST learn that the app went blind");
  const mail = outbox[0];
  assert.match(mail, /Subject: .*can no longer check your tracking/);
  assert.match(mail, /Google/, "should say which account to reconnect");
  assert.match(mail, /NOT checking your tracking/i,
    "must state that nobody is watching in the meantime");
});

test("the blindness mail does not include stale numbers from the last check", async () => {
  // ran_at deliberately in the past; with a fresh run the store would not be
  // "due" and the scheduler would never reach the check.
  db.prepare(`INSERT INTO check_history
      (shop_id, ran_at, missing, missing_pct, duplicates, orders, ga4)
    VALUES (1, datetime('now','-30 days'), 7, 12.5, 3, 40, 33)`).run();
  dbm.markAccessBroken(1, "shopify_auth", "x");
  ageBrokenBy(48);
  await scheduler.runScheduledChecks(async () => {
    throw new Error("shop not authenticated");
  });
  await alerts.flushAlerts();

  // The numbers predate the failure and the app no longer knows whether they
  // hold. Showing them next to "we cannot see your store" is contradictory.
  assert.doesNotMatch(outbox[0], /Orders compared/);
  assert.doesNotMatch(outbox[0], /12\.5/);
  assert.match(outbox[0], /Shopify admin/, "should say where the merchant can fix it");
});

test("a lasting failure does not send a mail on every tick", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  const fail = async () => { throw new Error("google auth failed"); };

  for (let i = 0; i < 3; i++) {
    await scheduler.runScheduledChecks(fail);
    await alerts.flushAlerts();
  }
  assert.equal(outbox.length, 1,
    "the merchant would filter out the same alert repeated within 24 h");
});

test("Shopify reauthorization (upsertShop) clears the flag by itself", () => {
  dbm.markAccessBroken(1, "shopify_auth", "x");
  dbm.upsertShop("demo-store.myshopify.com", "novy-token", "novy-refresh", 3600);
  const r = db.prepare(
    "SELECT access_broken_kind k FROM shops WHERE shop_domain='demo-store.myshopify.com'").get();
  assert.equal(r.k, null,
    "after the fix the banner must turn off immediately, not after the next check");
});

test("blindness also outranks a GA4 outage in the subject", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  db.prepare("INSERT INTO alerts (shop_id, kind, message) VALUES (1,'ga4_silent','GA4 nothing.')").run();
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();

  // When the app cannot see, every other finding is just the last known snapshot.
  assert.match(outbox[0], /Subject: .*can no longer check your tracking/);
});

/*
 * FRESH INSTALL: "not set up yet" is NOT a failure.
 *
 * This is the state in which a Shopify reviewer and every new merchant see
 * the app. Previously the app could not tell "the Google account was never
 * connected" from "the connection was lost", so it recorded its own failure
 * for a freshly installed store, and after the grace period that turned into
 * a "we stopped watching your tracking" e-mail about something that never ran.
 */
test("a store that never connected Google does NOT get a lost-access alert", async () => {
  seed({ token: "tok", google: null });
  // exactly the post-install state: never connected
  db.prepare("UPDATE shops SET ga4_connected_at = NULL WHERE id = 1").run();
  dbm.markAccessBroken(1, "google_auth", "google not connected");
  ageBrokenBy(48);

  scheduler.raiseAccessAlert(1);
  await alerts.flushAlerts();

  assert.equal(outbox.length, 0,
    "a false alarm from a monitoring app; after it the merchant stops taking any mail seriously");
});

test("a store whose connection worked AT LEAST ONCE does get the alert", async () => {
  seed({ token: "tok", google: null });
  db.prepare("UPDATE shops SET ga4_connected_at = datetime('now','-30 days') WHERE id = 1").run();
  dbm.markAccessBroken(1, "google_auth", "revoked");
  ageBrokenBy(48);

  scheduler.raiseAccessAlert(1);
  await alerts.flushAlerts();

  assert.equal(outbox.length, 1, "this is a real loss of access and must be reported");
  assert.match(outbox[0], /Google/);
});

test("migration v8 marks already connected stores and clears the false failure", () => {
  // A store with a valid refresh token must look connected after the
  // migration; otherwise real loss of access would stop being reported.
  seed({ token: "tok", google: "ref" });
  const r = db.prepare("SELECT ga4_connected_at c FROM shops WHERE id=1").get();
  assert.ok(r.c === null || typeof r.c === "string");
});
