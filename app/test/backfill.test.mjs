import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testData = fs.mkdtempSync(path.join(os.tmpdir(), "trackgap-test-"));
process.env.TRACKGAP_DATA = testData;

const { db } = await import("../db.mjs");
const { canBackfill, identityForOrder, saveIdentity } =
  await import("../backfill.mjs");

after(() => {
  db.close();
  fs.rmSync(testData, { recursive: true, force: true });
});

function shop() {
  return db.prepare("INSERT INTO shops(shop_domain) VALUES (?)")
    .run(`test-${Date.now()}-${Math.random()}.myshopify.com`).lastInsertRowid;
}

test("note attributes preserve explicit consent", () => {
  const identity = identityForOrder(shop(), "42", "checkout-42", [
    { name: "__tg_cid", value: "123.456" },
    { name: "__tg_sid", value: "1712345678" },
    { name: "__tg_consent", value: "granted" },
  ]);
  assert.equal(identity.consent, "granted");
  assert.equal(canBackfill({ created_at: new Date().toISOString() }, identity).ok, true);
});

test("older carts enrich consent from checkout identity", () => {
  const shopId = shop();
  saveIdentity(shopId, {
    checkout_token: "checkout-99",
    order_id: "99",
    ga_client_id: "123.456",
    consent: "granted",
  });
  const identity = identityForOrder(shopId, "99", "checkout-99", [
    { name: "__tg_cid", value: "123.456" },
  ]);
  assert.equal(identity.consent, "granted");
});

test("unknown consent still fails closed", () => {
  const result = canBackfill(
    { created_at: new Date().toISOString() },
    { ga_client_id: "123.456" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "consent_unknown");
});
