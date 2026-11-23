import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = path.join(os.tmpdir(), `tg_install_generation_${process.pid}.db`);
process.env.TRACKGAP_DB = DB;

let dbm;
before(async () => {
  dbm = await import("../db.mjs");
});

after(() => {
  dbm?.db.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
});

test("billing schema is versioned and includes event ordering tables", () => {
  const migration = dbm.db.prepare(
    "SELECT 1 FROM schema_migrations WHERE version=11",
  ).get();
  const columns = dbm.db.prepare("PRAGMA table_info(subscriptions)").all()
    .map((row) => row.name);
  const ledger = dbm.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_terminal_events'",
  ).get();
  assert.ok(migration);
  assert.ok(columns.includes("cycle"));
  assert.ok(columns.includes("event_at"));
  assert.ok(ledger);
});

test("plan and shop entitlement update atomically", async () => {
  const shop = "atomic-test.myshopify.com";
  dbm.db.prepare("INSERT INTO shops (shop_domain) VALUES (?)").run(shop);
  dbm.db.exec(`CREATE TRIGGER fail_shop_plan BEFORE UPDATE OF plan ON shops
    BEGIN SELECT RAISE(ABORT, 'forced shops update failure'); END`);
  const { setPlan } = await import("../billing.mjs");
  assert.throws(
    () => setPlan(shop, "growth", "gid://shopify/AppSubscription/test", "ACTIVE"),
    /forced shops update failure/,
  );
  const row = dbm.db.prepare(`SELECT sub.plan FROM subscriptions sub
    JOIN shops s ON s.id=sub.shop_id WHERE s.shop_domain=?`).get(shop);
  assert.equal(row, undefined, "failed shops update must roll back subscription upsert");
  dbm.db.exec("DROP TRIGGER fail_shop_plan");
});

test("reinstall session rejects an uninstall from the previous generation", () => {
  const shop = "reinstall-test.myshopify.com";
  dbm.db.prepare(`INSERT INTO shops
      (shop_domain, installed_at, uninstalled_at)
    VALUES (?, '2026-09-20 10:00:00', NULL)`).run(shop);

  // Accepting a new installation token must advance the barrier atomically,
  // before a delayed uninstall can erase that token.
  dbm.upsertShop(shop, "new-token", "new-refresh", 3600, true);
  const seen = dbm.db.prepare(
    "SELECT session_seen_at FROM shops WHERE shop_domain=?",
  ).get(shop).session_seen_at;
  const barrier = Date.parse(seen);
  const before = new Date(barrier - 5000).toISOString();
  const afterSeen = new Date(barrier + 5000).toISOString();

  assert.equal(
    dbm.isStaleUninstall(shop, before),
    true,
    "an uninstall triggered before the new authenticated session is stale",
  );
  assert.equal(
    dbm.isStaleUninstall(shop, afterSeen),
    false,
    "an uninstall triggered after the latest session belongs to this generation",
  );
  assert.equal(dbm.isStaleUninstall(shop, null), false);
});
