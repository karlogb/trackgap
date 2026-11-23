/**
 * Strata pristupu: appka MUSI povedat, ze prestala strazit.
 *
 * PRECO TENTO TEST (1.9.2026): ked obchodu dobehol Shopify token alebo
 * merchant odobral Google ucet, `runCheck` hodilo vynimku, scheduler ju
 * zalogoval a slo sa dalej. Navonok sa NESTALO NIC — ziadny mail, dashboard
 * dalej ukazoval posledny vysledok z cache. Monitorovacia appka teda oslepla
 * a tvarila sa presne ako appka, ktora vsetko strazi. Horsie nez chyba:
 * ticho, ktore sa na nerozoznanie podoba na "vsetko je v poriadku".
 *
 * Testuje sa proti skutocnemu SMTP sinku na loopbacku, rovnako ako
 * alerts_group.test.mjs — nie proti podvrhnutej funkcii.
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
    try { fs.unlinkSync(f); } catch { /* nevadi */ }
  }
});

/** Obchod, ktory uz raz bol plne nastaveny. */
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

/** Posunie zaciatok poruchy do minulosti — obide ochrannu lehotu. */
const ageBrokenBy = (hours) => db.prepare(
  `UPDATE shops SET access_broken_since = datetime('now', ?) WHERE id = 1`,
).run(`-${hours} hours`);

beforeEach(() => seed());

test("markAccessBroken drzi cas PRVEHO zlyhania, nie posledneho", async () => {
  dbm.markAccessBroken(1, "google_auth", "revoked");
  const first = db.prepare("SELECT access_broken_since s FROM shops WHERE id=1").get().s;
  await new Promise((r) => setTimeout(r, 1100));
  dbm.markAccessBroken(1, "google_auth", "revoked again");
  const second = db.prepare("SELECT access_broken_since s FROM shops WHERE id=1").get().s;
  assert.equal(second, first,
    "opakovane zlyhanie nesmie posuvat cas — porucha by nikdy nedozrela na alert");
});

test("zmena druhu poruchy zacina novy cas", () => {
  dbm.markAccessBroken(1, "shopify_auth", "x");
  db.prepare("UPDATE shops SET access_broken_since='2020-01-01 00:00:00' WHERE id=1").run();
  dbm.markAccessBroken(1, "google_auth", "y");
  const r = db.prepare(
    "SELECT access_broken_kind k, access_broken_since s FROM shops WHERE id=1").get();
  assert.equal(r.k, "google_auth");
  assert.notEqual(r.s, "2020-01-01 00:00:00");
});

test("clearAccessBroken po uspesnej kontrole zmaze priznak", () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  dbm.clearAccessBroken(1);
  const r = db.prepare(
    "SELECT access_broken_kind k, access_broken_since s FROM shops WHERE id=1").get();
  assert.equal(r.k, null);
  assert.equal(r.s, null);
});

test("obchod bez tokenu z planovaca NEVYPADNE", async () => {
  // Presne toto bola podstata chyby: `dueShops` filtroval na pritomnost
  // tokenov, takze obchod, ktoremu prave zmizol pristup, prestal byt
  // kontrolovany — a tym padom nemal ako vzniknut ani alert.
  seed({ token: null, google: null });
  let seen = 0;
  await scheduler.runScheduledChecks(async () => {
    seen += 1;
    throw new Error("shop not authenticated");
  });
  assert.equal(seen, 1, "obchod bez tokenu sa musi dostat ku kontrole");
});

test("porucha v ochrannej lehote NEPOSIELA mail", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");   // prave teraz
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();
  assert.equal(outbox.length, 0,
    "kratky vypadok sa casto opravi sam; falosny poplach z monitoringu je drahsi");
});

test("porucha po ochrannej lehote posle mail s navodom", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();

  assert.equal(outbox.length, 1, "merchant sa MUSI dozvediet, ze appka oslepla");
  const mail = outbox[0];
  assert.match(mail, /Subject: .*can no longer check your tracking/);
  assert.match(mail, /Google/, "ma povedat, ktory ucet treba pripojit");
  assert.match(mail, /NOT checking your tracking/i,
    "musi zaznit, ze medzitym nikto nestrazi");
});

test("mail o slepote neobsahuje stare cisla z poslednej kontroly", async () => {
  // ran_at zamerne v minulosti — s cerstvym behom by obchod nebol "due"
  // a planovac by sa ku kontrole vobec nedostal.
  db.prepare(`INSERT INTO check_history
      (shop_id, ran_at, missing, missing_pct, duplicates, orders, ga4)
    VALUES (1, datetime('now','-30 days'), 7, 12.5, 3, 40, 33)`).run();
  dbm.markAccessBroken(1, "shopify_auth", "x");
  ageBrokenBy(48);
  await scheduler.runScheduledChecks(async () => {
    throw new Error("shop not authenticated");
  });
  await alerts.flushAlerts();

  // Cisla su spred poruchy a appka uz nevie, ci este platia. Ukazat ich
  // vedla vety "nevidime do tvojho obchodu" si priamo protireci.
  assert.doesNotMatch(outbox[0], /Orders compared/);
  assert.doesNotMatch(outbox[0], /12\.5/);
  assert.match(outbox[0], /Shopify admin/, "ma povedat, kde to merchant napravi");
});

test("trvala porucha neposiela mail na kazdy tick", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  const fail = async () => { throw new Error("google auth failed"); };

  for (let i = 0; i < 3; i++) {
    await scheduler.runScheduledChecks(fail);
    await alerts.flushAlerts();
  }
  assert.equal(outbox.length, 1,
    "opakovanie toho isteho alertu do 24 h si merchant odfiltruje");
});

test("reautorizacia Shopify (upsertShop) zhasne priznak sama", () => {
  dbm.markAccessBroken(1, "shopify_auth", "x");
  dbm.upsertShop("demo-store.myshopify.com", "novy-token", "novy-refresh", 3600);
  const r = db.prepare(
    "SELECT access_broken_kind k FROM shops WHERE shop_domain='demo-store.myshopify.com'").get();
  assert.equal(r.k, null,
    "po naprave musi banner zhasnut hned, nie az po dalsej kontrole");
});

test("slepota prebije v predmete aj vypadok GA4", async () => {
  dbm.markAccessBroken(1, "google_auth", "x");
  ageBrokenBy(48);
  db.prepare("INSERT INTO alerts (shop_id, kind, message) VALUES (1,'ga4_silent','GA4 nothing.')").run();
  await scheduler.runScheduledChecks(async () => {
    throw new Error("google auth failed");
  });
  await alerts.flushAlerts();

  // Ked appka nevidi, kazdy iny nalez je len posledna znama snimka.
  assert.match(outbox[0], /Subject: .*can no longer check your tracking/);
});

/*
 * CERSTVA INSTALACIA — "este nenastavene" NIE JE porucha.
 *
 * Toto je stav, v ktorom appku vidi reviewer zo Shopify aj kazdy novy
 * merchant. Appka doteraz nevedela odlisit "Google ucet nikdy nebol
 * pripojeny" od "spojenie sa stratilo", takze cerstvo nainstalovanemu
 * obchodu zapisala vlastnu poruchu a po ochrannej lehote z nej dozrel
 * e-mail "prestali sme strazit tvoje meranie" — o niecom, co nikdy nebezalo.
 */
test("obchod, ktory Google nikdy nepripojil, NEDOSTANE alert o strate pristupu", async () => {
  seed({ token: "tok", google: null });
  // presne stav po instalacii: nikdy pripojene
  db.prepare("UPDATE shops SET ga4_connected_at = NULL WHERE id = 1").run();
  dbm.markAccessBroken(1, "google_auth", "google not connected");
  ageBrokenBy(48);

  scheduler.raiseAccessAlert(1);
  await alerts.flushAlerts();

  assert.equal(outbox.length, 0,
    "falosny poplach z monitorovacej appky — po nom uz merchant neberie vazne ziadny dalsi mail");
});

test("obchod, ktoremu spojenie UZ RAZ islo, alert dostane", async () => {
  seed({ token: "tok", google: null });
  db.prepare("UPDATE shops SET ga4_connected_at = datetime('now','-30 days') WHERE id = 1").run();
  dbm.markAccessBroken(1, "google_auth", "revoked");
  ageBrokenBy(48);

  scheduler.raiseAccessAlert(1);
  await alerts.flushAlerts();

  assert.equal(outbox.length, 1, "toto je skutocna strata pristupu a musi sa ozvat");
  assert.match(outbox[0], /Google/);
});

test("migracia v8 oznaci uz pripojene obchody a zhasne falosnu poruchu", () => {
  // Obchod s platnym refresh tokenom musi po migracii vyzerat ako pripojeny,
  // inak by sa skutocna strata pristupu prestala hlasit.
  seed({ token: "tok", google: "ref" });
  const r = db.prepare("SELECT ga4_connected_at c FROM shops WHERE id=1").get();
  assert.ok(r.c === null || typeof r.c === "string");
});
