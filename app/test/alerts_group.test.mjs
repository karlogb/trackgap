/**
 * Alerty: jedna kontrola = JEDEN mail na obchod.
 *
 * PRECO TENTO TEST: 1.9.2026 poslal jeden beh na demo obchode dva samostatne
 * maily (`duplicates_new` + `value_broke`). Merchant, ktoreho appka zasype
 * viacerymi mailmi z jednej kontroly, si na nu nastavi filter — a alert,
 * kvoli ktoremu appka existuje, sa uz nikdy neprecita.
 *
 * Testuje sa proti SKUTOCNEMU SMTP serveru na loopbacku, nie proti podvrhnutej
 * funkcii: ESM export sa prepisat neda a hlavne — takto prejde aj realny
 * dialog z smtp.mjs (STARTTLS sa v tomto sinku neponuka, takze sa preskoci).
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

/** Minimalny SMTP sink — zapamata si prijate spravy. */
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
      sock.on("error", () => { /* klient zavesil */ });
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
    try { fs.unlinkSync(f); } catch { /* nevadi */ }
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

test("dva nalezy z jednej kontroly = jeden mail", async () => {
  seed();
  add("duplicates_new", "4 duplicate transactions appeared.");
  add("value_broke", "Order values stopped matching.");

  const r = await alerts.flushAlerts();
  assert.equal(r.sent, 1, "mal odist prave jeden mail");
  assert.equal(outbox.length, 1, "na drote sa objavila viac nez jedna sprava");
  // oba nalezy musia byt v tele — zoskupenie nesmie ziadny zahodit
  assert.match(outbox[0], /duplicate transactions/);
  assert.match(outbox[0], /Order values stopped matching/);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM alerts WHERE sent_at IS NULL").get().c, 0);
});

test("predmet urcuje najzavaznejsi nalez, nie poradie v DB", async () => {
  seed();
  add("duplicates_new", "dupes");        // vlozene PRV
  add("ga4_silent", "GA4 recorded nothing.");

  await alerts.flushAlerts();
  assert.match(outbox[0], /Subject: .*stopped recording orders/,
    "predmet ma patrit vypadku GA4, nie duplicitam");
  assert.match(outbox[0], /\+1 more/);
});

test("jediny nalez nie je cislovany zoznam", async () => {
  seed();
  add("ga4_silent", "GA4 recorded nothing.");
  await alerts.flushAlerts();
  assert.doesNotMatch(outbox[0], /We found \d+ problems/);
  assert.doesNotMatch(outbox[0], /\+\d+ more/);
});

test("obchod bez adresy: nic sa neposiela, ale alerty sa nehromadia", async () => {
  seed(null);
  add("ga4_silent", "x");
  const r = await alerts.flushAlerts();
  assert.equal(r.sent, 0);
  assert.equal(outbox.length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM alerts WHERE sent_at IS NULL").get().c, 0,
    "nedorucitelne alerty by sa inak hromadili donekonecna");
});
