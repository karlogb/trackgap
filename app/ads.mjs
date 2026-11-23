/**
 * TrackGap — Google Ads cez GA4.
 *
 * PRECO CEZ GA4 A NIE CEZ ADS API:
 * Google Ads API vyzaduje developer token, ktory Google schvaluje tyzdne az
 * mesiace a pri novej firme ho casto zamietne. GA4 Data API pritom vracia
 * spend, klikymi aj nazvy kampani cez merchantov existujuci OAuth — teda
 * ziadne dalsie schvalovanie a ziadny dalsi krok v onboardingu.
 *
 * CO TO NEVIE (a treba to hovorit nahlas):
 * GA4 NEDAVA stav conversion action v Google Ads. Nevieme teda povedat
 * "konverzna akcia je mrtva" tak, ako to vidi Ads UI. Vieme vsak nieco
 * prakticky rovnako uzitocne: kampan MINULA peniaze a priniesla kliky, ale
 * nemá ziadnu transakciu — a zaroven vieme zo Shopify, ci v tom case
 * objednavky realne chodili. To odlisi "kampan nepredava" (realny vysledok)
 * od "kampan predava, ale meranie to nevidi" (porucha, ktora stoji peniaze).
 *
 * Overene 31.8.2026 na zivej property: dimenzie sessionGoogleAdsCampaignName,
 * sessionGoogleAdsAccountName a metriky advertiserAdCost, advertiserAdClicks
 * su v /metadata dostupne a v runReport kombinovatelne s transactions.
 */

const API = "https://analyticsdata.googleapis.com/v1beta";

/** Kampan, ktora minula aspon tolko, aby mal nalez zmysel. */
const MIN_SPEND = Number(process.env.TRACKGAP_ADS_MIN_SPEND ?? 1);

async function runReport(token, propertyId, body) {
  const r = await fetch(`${API}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`runReport ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Vykon Google Ads kampani za obdobie.
 *
 * Session-scoped dimenzie (sessionGoogleAds*) su tu spravna volba: zaujima
 * nas, ci navsteva Z TEJTO kampane viedla k transakcii. First-user scope by
 * priradzoval podla prveho kontaktu vobec a pri dlhsom rozhodovani by
 * ukazoval kampane, ktore s objednavkou nemaju nic spolocne.
 */
export async function fetchAdsCampaigns(token, propertyId, startDate, endDate) {
  const j = await runReport(token, propertyId, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: "sessionGoogleAdsCampaignName" },
      { name: "sessionGoogleAdsAccountName" },
    ],
    metrics: [
      { name: "advertiserAdCost" },
      { name: "advertiserAdClicks" },
      { name: "transactions" },
      { name: "purchaseRevenue" },
      { name: "sessions" },
    ],
    limit: 10000,
    returnPropertyQuota: true,
  });

  const rows = (j.rows || []).map((row) => {
    const [campaign, account] = row.dimensionValues.map((d) => d.value);
    const [cost, clicks, transactions, revenue, sessions] =
      row.metricValues.map((m) => parseFloat(m.value || 0));
    return {
      campaign,
      account,
      cost: +cost.toFixed(2),
      clicks: Math.round(clicks),
      transactions: Math.round(transactions),
      revenue: +revenue.toFixed(2),
      sessions: Math.round(sessions),
      roas: cost > 0 ? +(revenue / cost).toFixed(2) : null,
    };
  }).filter((r) =>
    // "(not set)" a organicke riadky nie su Ads kampane
    r.campaign && r.campaign !== "(not set)" && r.campaign !== "(organic)");

  return { rows, quota: j.propertyQuota || null };
}

/**
 * Najde kampane, ktore platia a nemeraju.
 *
 * `ordersInPeriod` je pocet objednavok zo Shopify za to iste obdobie. Je to
 * dolezita poistka: ked obchod v tom case NIC nepredal, nulove konverzie su
 * spravny udaj a nie porucha merania. Bez tejto kontroly by appka strasila
 * kazdy obchod, ktory ma slaby tyzden.
 */
export function analyseAds(rows, ordersInPeriod = 0) {
  const spending = rows.filter((r) => r.cost >= MIN_SPEND);
  const totalCost = +spending.reduce((s, r) => s + r.cost, 0).toFixed(2);
  const totalRev = +spending.reduce((s, r) => s + r.revenue, 0).toFixed(2);
  const totalTx = spending.reduce((s, r) => s + r.transactions, 0);

  const findings = [];

  // 1) Kampan minula peniaze, ma kliky, ale ZIADNU transakciu — a obchod
  //    pritom v tom obdobi predaval. To je typicky obraz rozbitej konverzie.
  const silent = spending.filter((r) => r.transactions === 0 && r.clicks > 0);
  const silentCost = +silent.reduce((s, r) => s + r.cost, 0).toFixed(2);

  if (silent.length && ordersInPeriod > 0) {
    findings.push({
      type: "ads_no_conversions",
      severity: silentCost > totalCost * 0.3 ? "high" : "medium",
      count: silent.length,
      detail: {
        wasted_spend: silentCost,
        orders_in_period: ordersInPeriod,
        campaigns: silent.slice(0, 25).map((r) => ({
          campaign: r.campaign,
          cost: r.cost,
          clicks: r.clicks,
          sessions: r.sessions,
        })),
        note: `${silent.length} Google Ads campaign(s) spent ${silentCost} and `
            + "sent paid clicks to your store, but GA4 attributes zero "
            + `transactions to them — while your store did take `
            + `${ordersInPeriod} orders in the same period. Either the "`
            + "conversion never gets measured for this traffic, or Google Ads "
            + "is optimising against data it does not have.",
      },
    });
  }

  // 2) Cely ucet mina a nemeria nic. Samostatny, tvrdsi nalez: nejde
  //    o jednu zle nastavenu kampan, ale o cele mrtve meranie Ads.
  if (totalCost >= MIN_SPEND && totalTx === 0 && ordersInPeriod > 0) {
    findings.push({
      type: "ads_all_silent",
      severity: "high",
      count: spending.length,
      detail: {
        wasted_spend: totalCost,
        orders_in_period: ordersInPeriod,
        note: `Google Ads spent ${totalCost} across ${spending.length} `
            + "campaign(s) and GA4 recorded no transactions from paid search "
            + `at all, although the store received ${ordersInPeriod} orders. `
            + "This points at conversion tracking for Google Ads being broken "
            + "rather than at the campaigns underperforming.",
      },
    });
  }

  return {
    summary: {
      campaigns: spending.length,
      cost: totalCost,
      revenue: totalRev,
      transactions: totalTx,
      roas: totalCost > 0 ? +(totalRev / totalCost).toFixed(2) : null,
      silent_campaigns: silent.length,
      wasted_spend: silentCost,
    },
    // najdrahsie hore — tam je najviac penazi v hre
    campaigns: [...spending].sort((a, b) => b.cost - a.cost).slice(0, 50),
    findings,
  };
}

/**
 * GA4 nevie stav conversion action v Google Ads — hovorime to nahlas,
 * nech si merchant (ani my) nemysli, ze appka vidi viac, nez vidi.
 */
export const LIMITATIONS = [
  "GA4 does not expose the status of Google Ads conversion actions. "
  + "TrackGap can show spend, clicks and the transactions GA4 attributes to "
  + "a campaign, but it cannot tell you whether a conversion action itself "
  + "is disabled or unverified inside Google Ads.",
];
