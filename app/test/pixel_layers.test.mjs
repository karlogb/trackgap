/**
 * Testy tretej vrstvy merania (web pixel) a rozpadu chybajucich objednavok.
 *
 * Preco prave tieto pripady: rozdiel medzi "never_fired" a "delivery_broken"
 * je jediny dovod, preco vlastny pixel mame. Ked sa pomiesa, appka posle
 * merchanta opravovat nespravnu vec — co je horsie, nez keby nepovedala nic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../reconcile.mjs";

const order = (id, iso, total = 100) => ({
  order_id: String(id),
  order_number: `#${id}`,
  total,
  subtotal: total,
  shipping: 0,
  tax: 0,
  created_at: iso,
});

const YESTERDAY = new Date(Date.now() - 86400_000).toISOString();
const LAST_WEEK = new Date(Date.now() - 7 * 86400_000).toISOString();

test("bez pixelu sa pricina NEHADA — vsetko je unknown", () => {
  const orders = [order(1, YESTERDAY), order(2, YESTERDAY)];
  const r = reconcile(orders, [], null, null);
  assert.equal(r.summary.missing, 2);
  assert.equal(r.layers.unknown, 2);
  assert.equal(r.layers.never_fired, 0);
  assert.equal(r.layers.delivery_broken, 0);
  assert.equal(r.summary.pixel_active, false);
  // ziadny nalez o vrstvach, kym nemame dokaz
  assert.equal(r.findings.some((f) => f.type === "never_fired"), false);
  assert.equal(r.findings.some((f) => f.type === "delivery_broken"), false);
});

test("pixel videl purchase, GA4 nie -> delivery_broken", () => {
  const orders = [order(1, YESTERDAY)];
  const pixel = {
    active: true,
    since: "2020-01-01 00:00:00",
    purchased: new Set(["1"]),
  };
  const r = reconcile(orders, [], null, pixel);
  assert.equal(r.layers.delivery_broken, 1);
  assert.equal(r.layers.never_fired, 0);
  const f = r.findings.find((x) => x.type === "delivery_broken");
  assert.ok(f, "musi vzniknut nalez delivery_broken");
  assert.deepEqual(f.detail.order_numbers, ["#1"]);
});

test("pixel nevidel nic a GA4 tiez nie -> never_fired", () => {
  const orders = [order(1, YESTERDAY)];
  const pixel = {
    active: true,
    since: "2020-01-01 00:00:00",
    purchased: new Set(),
  };
  const r = reconcile(orders, [], null, pixel);
  assert.equal(r.layers.never_fired, 1);
  assert.equal(r.layers.delivery_broken, 0);
  const f = r.findings.find((x) => x.type === "never_fired");
  assert.ok(f, "musi vzniknut nalez never_fired");
});

test("objednavky spred instalacie pixelu sa NERATAJU ako porucha", () => {
  // toto je ta chyba, ktora by robila falosne poplachy kazdemu novemu
  // merchantovi: pixel tie objednavky nikdy nemohol vidiet
  const orders = [order(1, LAST_WEEK), order(2, YESTERDAY)];
  const since = new Date(Date.now() - 2 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const pixel = { active: true, since, purchased: new Set() };
  const r = reconcile(orders, [], null, pixel);
  assert.equal(r.layers.before_pixel, 1, "stara objednavka -> before_pixel");
  assert.equal(r.layers.never_fired, 1, "len ta novsia sa posudzuje");
});

test("co je v GA4, nie je missing a do vrstiev nevstupuje", () => {
  const orders = [order(1, YESTERDAY), order(2, YESTERDAY)];
  const ga4 = [{ transaction_id: "1", revenue: 100, event_count: 1 }];
  const pixel = {
    active: true,
    since: "2020-01-01 00:00:00",
    purchased: new Set(["1", "2"]),
  };
  const r = reconcile(orders, ga4, null, pixel);
  assert.equal(r.summary.missing, 1);
  assert.equal(r.layers.delivery_broken, 1);   // len objednavka 2
  assert.equal(r.layers.never_fired, 0);
});

test("summary nesie vrstvy pre alert aj historiu", () => {
  const orders = [order(1, YESTERDAY), order(2, YESTERDAY)];
  const pixel = {
    active: true,
    since: "2020-01-01 00:00:00",
    purchased: new Set(["1"]),
  };
  const r = reconcile(orders, [], null, pixel);
  assert.equal(r.summary.delivery_broken, 1);
  assert.equal(r.summary.never_fired, 1);
  assert.equal(r.summary.pixel_active, true);
});
