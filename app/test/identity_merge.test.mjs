/**
 * Identity arrives in pieces: test that it is merged, not overwritten.
 *
 * This is the core of the app: without `ga_client_id` a conversion cannot be
 * attributed and GA4 backfill is dead. On a live store, `page_viewed`
 * brought the client_id, but checkout could no longer read the `_ga` cookie
 * (it runs on another domain), so `INSERT OR REPLACE` overwrote client_id with NULL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Separate DB for the test; the production one is never touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-ident-"));
process.env.TRACKGAP_DB = path.join(tmp, "test.db");

const { db } = await import("../db.mjs");
const { saveIdentity, identityForOrder } = await import("../backfill.mjs");

db.prepare("INSERT INTO shops (id, shop_domain) VALUES (1,'t.myshopify.com')").run();

const SFCID = "00000000-0000-4000-8000-000000000001";
const CID = "1234567890.1788203022";

test("checkout without a _ga cookie inherits client_id from the same visit", () => {
  // 1) page_viewed: has client_id, no token yet
  saveIdentity(1, {
    checkout_token: null,
    shopify_client_id: SFCID,
    identity: { ga_client_id: CID, ga_session_id: "1788203022", consent: "granted" },
  });

  // 2) checkout_completed: has token and order_id, but can no longer read `_ga`
  saveIdentity(1, {
    checkout_token: "tok_abc",
    order_id: "555",
    shopify_client_id: SFCID,
    identity: { consent: "granted" },
  });

  const row = db.prepare(
    "SELECT * FROM identities WHERE shop_id=1 AND checkout_token='tok_abc'").get();
  assert.equal(row.ga_client_id, CID, "client_id should have been filled in from the visit");
  assert.equal(row.order_id, "555");
});

test("a later event does NOT overwrite a known client_id with NULL", () => {
  saveIdentity(1, {
    checkout_token: "tok_keep",
    shopify_client_id: "visit-2",
    identity: { ga_client_id: "999.888", consent: "granted" },
  });
  // same checkout, but an event without identity (e.g. a retry)
  saveIdentity(1, { checkout_token: "tok_keep", order_id: "777", identity: {} });

  const row = db.prepare(
    "SELECT * FROM identities WHERE shop_id=1 AND checkout_token='tok_keep'").get();
  assert.equal(row.ga_client_id, "999.888", "client_id must not be lost");
  assert.equal(row.order_id, "777", "order_id should have been filled in");
});

test("identityForOrder finds client_id via the visit when the record lacks it", () => {
  saveIdentity(1, {
    checkout_token: null,
    shopify_client_id: "visit-3",
    identity: { ga_client_id: "111.222", consent: "granted" },
  });
  // the order record was created without client_id and with no way to look it up at write time
  db.prepare(`INSERT INTO identities
    (shop_id,checkout_token,order_id,consent,shopify_client_id)
    VALUES (1,'tok_v3','900','denied','visit-3')`).run();

  const got = identityForOrder(1, "900", "tok_v3", null);
  assert.equal(got.ga_client_id, "111.222");
  assert.equal(got.source, "pixel_visit");
  // consent is taken from the order, not from an earlier page view
  assert.equal(got.consent, "denied");
});

test("without a shared visit the identity is NOT guessed", () => {
  db.prepare(`INSERT INTO identities
    (shop_id,checkout_token,order_id,shopify_client_id)
    VALUES (1,'tok_lonely','901','visit-neznama')`).run();
  assert.equal(identityForOrder(1, "901", "tok_lonely", null), null);
});

test("note_attributes take precedence over the pixel", () => {
  const got = identityForOrder(1, "555", "tok_abc",
    [{ name: "__tg_cid", value: "from.notes" }]);
  assert.equal(got.ga_client_id, "from.notes");
  assert.equal(got.source, "note_attributes");
});
