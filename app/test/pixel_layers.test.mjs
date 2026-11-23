/**
 * Tests for the third measurement layer (web pixel) and the breakdown of
 * missing orders.
 *
 * Why these cases: the difference between "never_fired" and
 * "delivery_broken" is the whole reason we have our own pixel. If they get
 * mixed up, the app sends the merchant to fix the wrong thing, which is
 * worse than saying nothing.
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

test("without a pixel the cause is NOT guessed: everything is unknown", () => {
  const orders = [order(1, YESTERDAY), order(2, YESTERDAY)];
  const r = reconcile(orders, [], null, null);
  assert.equal(r.summary.missing, 2);
  assert.equal(r.layers.unknown, 2);
  assert.equal(r.layers.never_fired, 0);
  assert.equal(r.layers.delivery_broken, 0);
  assert.equal(r.summary.pixel_active, false);
  // no layer finding until we have proof
  assert.equal(r.findings.some((f) => f.type === "never_fired"), false);
  assert.equal(r.findings.some((f) => f.type === "delivery_broken"), false);
});

test("pixel saw the purchase, GA4 did not -> delivery_broken", () => {
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
  assert.ok(f, "a delivery_broken finding must be raised");
  assert.deepEqual(f.detail.order_numbers, ["#1"]);
});

test("pixel saw nothing and neither did GA4 -> never_fired", () => {
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
  assert.ok(f, "a never_fired finding must be raised");
});

test("orders placed before the pixel was installed do NOT count as a failure", () => {
  // this is the bug that would raise false alarms for every new merchant:
  // the pixel could never have seen those orders
  const orders = [order(1, LAST_WEEK), order(2, YESTERDAY)];
  const since = new Date(Date.now() - 2 * 86400_000)
    .toISOString().replace("T", " ").slice(0, 19);
  const pixel = { active: true, since, purchased: new Set() };
  const r = reconcile(orders, [], null, pixel);
  assert.equal(r.layers.before_pixel, 1, "old order -> before_pixel");
  assert.equal(r.layers.never_fired, 1, "only the newer one is assessed");
});

test("what is in GA4 is not missing and does not enter the layers", () => {
  const orders = [order(1, YESTERDAY), order(2, YESTERDAY)];
  const ga4 = [{ transaction_id: "1", revenue: 100, event_count: 1 }];
  const pixel = {
    active: true,
    since: "2020-01-01 00:00:00",
    purchased: new Set(["1", "2"]),
  };
  const r = reconcile(orders, ga4, null, pixel);
  assert.equal(r.summary.missing, 1);
  assert.equal(r.layers.delivery_broken, 1);   // only order 2
  assert.equal(r.layers.never_fired, 0);
});

test("summary carries the layers for alerts and history", () => {
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
