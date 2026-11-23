/**
 * Alerts: one check = ONE mail per store.
 *
 * WHY THIS TEST: a single run once sent two separate mails
 * (`duplicates_new` + `value_broke`). A merchant flooded with several mails
 * from one check sets up a filter, and the alert the app exists for is never
 * read again.
 *
 * Tested against a REAL SMTP server on loopback, not a stubbed function:
 * an ESM export cannot be overwritten and, more importantly, this exercises
 * the real dialogue from smtp.mjs (this sink does not offer STARTTLS, so it
 * is skipped).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DB = path.join(os.tmpdir(), `tg_alerts_${process.pid}.db`);
const CFG = path.join(os.tmpdir(), `tg_smtp_${process.pid}.json`);
process.env.TRACKGAP_DB = DB;
process.env.TRACKGAP_SMTP_CONFIG = CFG;

/** Minimal SMTP sink that remembers received messages. */
const outbox = [];
function startSink() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = "";
      let inData = false;
      let body = "";
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
      sock.on("error", () => { /* client hung up */ });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

let sink;
let db;
let alerts;

before(async () => {
  sink = await startSink();
  fs.writeFileSync(CFG, JSON.stringify({
    host: "127.0.0.1", smtp_port: sink.address().port, user: "u", password: "p",
  }));
  ({ db } = await import("../db.mjs"));
  alerts = await import("../alerts.mjs");
});

after(() => {
  sink?.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, CFG]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function seed(email = "merchant@example.com") {
  db.prepare("DELETE FROM alerts").run();
  db.prepare("DELETE FROM shops").run();
  db.prepare(`INSERT INTO shops (id, shop_domain, alert_email)
              VALUES (1, 'demo-store.myshopify.com', ?)`).run(email);
  outbox.length = 0;
}

const add = (kind, msg) => db.prepare(
  "INSERT INTO alerts (shop_id, kind, message) VALUES (1,?,?)").run(kind, msg);

test("two findings from one check = one mail", async () => {
  seed();
  add("duplicates_new", "4 duplicate transactions appeared.");
  add("value_broke", "Order values stopped matching.");

  const r = await alerts.flushAlerts();
  assert.equal(r.sent, 1, "exactly one mail should have been sent");
  assert.equal(outbox.length, 1, "more than one message appeared on the wire");
  // both findings must be in the body; grouping must not drop any
  assert.match(outbox[0], /duplicate transactions/);
  assert.match(outbox[0], /Order values stopped matching/);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM alerts WHERE sent_at IS NULL").get().c, 0);
});

test("the subject is set by the most severe finding, not DB order", async () => {
  seed();
  add("duplicates_new", "dupes");        // inserted FIRST
  add("ga4_silent", "GA4 recorded nothing.");

  await alerts.flushAlerts();
  assert.match(outbox[0], /Subject: .*stopped recording orders/,
    "the subject should belong to the GA4 outage, not to duplicates");
  assert.match(outbox[0], /\+1 more/);
});

test("a single finding is not a numbered list", async () => {
  seed();
  add("ga4_silent", "GA4 recorded nothing.");
  await alerts.flushAlerts();
  assert.doesNotMatch(outbox[0], /We found \d+ problems/);
  assert.doesNotMatch(outbox[0], /\+\d+ more/);
});

test("store without an address: nothing is sent, but alerts do not pile up", async () => {
  seed(null);
  add("ga4_silent", "x");
  const r = await alerts.flushAlerts();
  assert.equal(r.sent, 0);
  assert.equal(outbox.length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM alerts WHERE sent_at IS NULL").get().c, 0,
    "undeliverable alerts would otherwise pile up forever");
});
