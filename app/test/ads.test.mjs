/**
 * Testy analyzy Google Ads.
 *
 * POZOR NA ROZSAH: tieto testy overuju NASU logiku nad datami z GA4, nie to,
 * ze GA4 vracia spravne cisla. Tvar odpovede je overeny proti zivemu API
 * (dimenzie aj metriky existuju v /metadata), ale property s realnym Ads
 * spendom sme k dispozicii nemali.
 *
 * Najdolezitejsi pripad je ten posledny: ked obchod nic nepredal, nulove
 * konverzie NIE SU porucha. Bez tejto poistky by appka strasila kazdy obchod,
 * ktory ma slaby tyzden — a to je najrychlejsia cesta k odinstalovaniu.
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

test("kampan mina, kliky chodia, konverzie ziadne -> nalez", () => {
  const rows = [
    campaign("Brand", 500, 900, 0),
    campaign("Shopping", 300, 400, 12, 1500),
  ];
  const r = analyseAds(rows, 40);
  const f = r.findings.find((x) => x.type === "ads_no_conversions");
  assert.ok(f, "musi vzniknut nalez");
  assert.equal(f.count, 1);
  assert.equal(f.detail.wasted_spend, 500);
  assert.equal(r.summary.silent_campaigns, 1);
});

test("ked obchod NIC nepredal, nulove konverzie nie su porucha", () => {
  // toto je ta poistka proti falosnym poplachom
  const rows = [campaign("Brand", 500, 900, 0)];
  const r = analyseAds(rows, 0);
  assert.equal(r.findings.length, 0, "ziadny nalez bez objednavok v obdobi");
});

test("cely ucet mina a nemeria nic -> tvrdsi samostatny nalez", () => {
  const rows = [
    campaign("Brand", 400, 500, 0),
    campaign("Shopping", 600, 700, 0),
  ];
  const r = analyseAds(rows, 80);
  const all = r.findings.find((x) => x.type === "ads_all_silent");
  assert.ok(all, "musi vzniknut ads_all_silent");
  assert.equal(all.severity, "high");
  assert.equal(all.detail.wasted_spend, 1000);
});

test("zdravy ucet nehlasi nic", () => {
  const rows = [
    campaign("Brand", 400, 500, 20, 2000),
    campaign("Shopping", 600, 700, 30, 4000),
  ];
  const r = analyseAds(rows, 80);
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.roas, 6);
  assert.equal(r.summary.transactions, 50);
});

test("kampane pod hranicou spendu sa ignoruju", () => {
  // 0,40 EUR za 60 dni nie je signal, je to sum
  const rows = [campaign("Test", 0.4, 2, 0)];
  const r = analyseAds(rows, 50);
  assert.equal(r.summary.campaigns, 0);
  assert.equal(r.findings.length, 0);
});

test("najdrahsie kampane su hore — tam je najviac penazi v hre", () => {
  const rows = [
    campaign("Maly", 10, 10, 1, 50),
    campaign("Velky", 5000, 4000, 100, 20000),
    campaign("Stredny", 800, 900, 20, 3000),
  ];
  const r = analyseAds(rows, 200);
  assert.deepEqual(r.campaigns.map((c) => c.campaign),
                   ["Velky", "Stredny", "Maly"]);
});
