/**
 * Identita prichadza po kusoch — test, ze sa poskladá, nie prepise.
 *
 * Toto je jadro appky: bez `ga_client_id` sa konverzia nema ako priradit
 * a doplnenie do GA4 je mrtve. Na zivom obchode (1.9.2026) sa ukazalo, ze
 * `page_viewed` prinesie client_id, ale checkout uz `_ga` cookie neprecita
 * (bezi na inej domene), takze `INSERT OR REPLACE` prepisal client_id na NULL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Vlastna DB pre test — na produkcnu sa nesiaha.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-ident-"));
process.env.TRACKGAP_DB = path.join(tmp, "test.db");

const { db } = await import("../db.mjs");
const { saveIdentity, identityForOrder } = await import("../backfill.mjs");

db.prepare("INSERT INTO shops (id, shop_domain) VALUES (1,'t.myshopify.com')").run();

const SFCID = "00000000-0000-4000-8000-000000000001";
const CID = "1234567890.1788203022";

test("checkout bez _ga cookie zdedi client_id z tej istej navstevy", () => {
  // 1) page_viewed: ma client_id, este nema token
  saveIdentity(1, {
    checkout_token: null,
    shopify_client_id: SFCID,
    identity: { ga_client_id: CID, ga_session_id: "1788203022", consent: "granted" },
  });

  // 2) checkout_completed: ma token aj order_id, ale `_ga` uz neprecita
  saveIdentity(1, {
    checkout_token: "tok_abc",
    order_id: "555",
    shopify_client_id: SFCID,
    identity: { consent: "granted" },
  });

  const row = db.prepare(
    "SELECT * FROM identities WHERE shop_id=1 AND checkout_token='tok_abc'").get();
  assert.equal(row.ga_client_id, CID, "client_id sa mal doplnit z navstevy");
  assert.equal(row.order_id, "555");
});

test("neskorsi event NEPREPISE uz zname client_id hodnotou NULL", () => {
  saveIdentity(1, {
    checkout_token: "tok_keep",
    shopify_client_id: "visit-2",
    identity: { ga_client_id: "999.888", consent: "granted" },
  });
  // ten isty checkout, ale event bez identity (napr. retry)
  saveIdentity(1, { checkout_token: "tok_keep", order_id: "777", identity: {} });

  const row = db.prepare(
    "SELECT * FROM identities WHERE shop_id=1 AND checkout_token='tok_keep'").get();
  assert.equal(row.ga_client_id, "999.888", "client_id sa nesmie stratit");
  assert.equal(row.order_id, "777", "order_id sa mal doplnit");
});

test("identityForOrder najde client_id cez navstevu, ked ho zaznam nema", () => {
  saveIdentity(1, {
    checkout_token: null,
    shopify_client_id: "visit-3",
    identity: { ga_client_id: "111.222", consent: "granted" },
  });
  // zaznam objednavky vznikol bez client_id a bez moznosti dohladania pri zapise
  db.prepare(`INSERT INTO identities
    (shop_id,checkout_token,order_id,consent,shopify_client_id)
    VALUES (1,'tok_v3','900','denied','visit-3')`).run();

  const got = identityForOrder(1, "900", "tok_v3", null);
  assert.equal(got.ga_client_id, "111.222");
  assert.equal(got.source, "pixel_visit");
  // suhlas sa berie z objednavky, nie zo skorsieho zobrazenia stranky
  assert.equal(got.consent, "denied");
});

test("bez spolocnej navstevy sa identita NEHADA", () => {
  db.prepare(`INSERT INTO identities
    (shop_id,checkout_token,order_id,shopify_client_id)
    VALUES (1,'tok_lonely','901','visit-neznama')`).run();
  assert.equal(identityForOrder(1, "901", "tok_lonely", null), null);
});

test("note_attributes maju prednost pred pixelom", () => {
  const got = identityForOrder(1, "555", "tok_abc",
    [{ name: "__tg_cid", value: "from.notes" }]);
  assert.equal(got.ga_client_id, "from.notes");
  assert.equal(got.source, "note_attributes");
});
