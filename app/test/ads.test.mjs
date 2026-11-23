/**
 * Google Ads analysis tests.
 *
 * MIND THE SCOPE: these tests verify OUR logic on top of GA4 data, not that
 * GA4 returns correct numbers. The response shape was checked against the
 * live API (the dimensions and metrics exist in /metadata), but no property
 * with real Ads spend was available.
 *
 * The most important case is the last one: when the store sold nothing,
 * zero conversions are NOT a failure. Without this safeguard the app would
 * alarm every store that has a slow week, the fastest route to an uninstall.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyseAds } from "../ads.mjs";

const campaign = (name, cost, clicks, transactions, revenue = 0) => ({
  campaign: name,
  account: "acc",
  cost,
  clicks,
  transactions,
  revenue,
  sessions: clicks,
  roas: cost > 0 ? revenue / cost : null,
});

test("campaign spends, clicks come in, no conversions -> finding", () => {
  const rows = [
    campaign("Brand", 500, 900, 0),
    campaign("Shopping", 300, 400, 12, 1500),
  ];
  const r = analyseAds(rows, 40);
  const f = r.findings.find((x) => x.type === "ads_no_conversions");
  assert.ok(f, "a finding must be raised");
  assert.equal(f.count, 1);
  assert.equal(f.detail.wasted_spend, 500);
  assert.equal(r.summary.silent_campaigns, 1);
});

test("when the store sold NOTHING, zero conversions are not a failure", () => {
  // this is the safeguard against false alarms
  const rows = [campaign("Brand", 500, 900, 0)];
  const r = analyseAds(rows, 0);
  assert.equal(r.findings.length, 0, "no finding without orders in the period");
});

test("whole account spends and tracks nothing -> separate, harsher finding", () => {
  const rows = [
    campaign("Brand", 400, 500, 0),
    campaign("Shopping", 600, 700, 0),
  ];
  const r = analyseAds(rows, 80);
  const all = r.findings.find((x) => x.type === "ads_all_silent");
  assert.ok(all, "ads_all_silent must be raised");
  assert.equal(all.severity, "high");
  assert.equal(all.detail.wasted_spend, 1000);
});

test("a healthy account reports nothing", () => {
  const rows = [
    campaign("Brand", 400, 500, 20, 2000),
    campaign("Shopping", 600, 700, 30, 4000),
  ];
  const r = analyseAds(rows, 80);
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.roas, 6);
  assert.equal(r.summary.transactions, 50);
});

test("campaigns below the spend threshold are ignored", () => {
  // 0.40 EUR over 60 days is not a signal, it is noise
  const rows = [campaign("Test", 0.4, 2, 0)];
  const r = analyseAds(rows, 50);
  assert.equal(r.summary.campaigns, 0);
  assert.equal(r.findings.length, 0);
});

test("most expensive campaigns come first: that is where the most money is at stake", () => {
  const rows = [
    campaign("Maly", 10, 10, 1, 50),
    campaign("Velky", 5000, 4000, 100, 20000),
    campaign("Stredny", 800, 900, 20, 3000),
  ];
  const r = analyseAds(rows, 200);
  assert.deepEqual(r.campaigns.map((c) => c.campaign),
                   ["Velky", "Stredny", "Maly"]);
});
