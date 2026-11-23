/**
 * TrackGap - Google Ads via GA4.
 *
 * WHY GA4 AND NOT THE ADS API:
 * The Google Ads API requires a developer token, which Google takes weeks to
 * months to approve and often rejects for new companies. The GA4 Data API
 * returns spend, clicks and campaign names through the merchant's existing
 * OAuth, so there is no extra approval and no extra onboarding step.
 *
 * WHAT IT CANNOT DO (and we say so openly):
 * GA4 does NOT expose the status of a Google Ads conversion action, so we
 * cannot say "the conversion action is dead" the way the Ads UI does. We can
 * say something almost as useful: the campaign SPENT money and got clicks but
 * has no transactions, while Shopify shows that orders were coming in at the
 * same time. That separates "the campaign does not sell" (a real result) from
 * "the campaign sells but tracking does not see it" (a costly failure).
 *
 * The dimensions sessionGoogleAdsCampaignName, sessionGoogleAdsAccountName and
 * the metrics advertiserAdCost, advertiserAdClicks are available in /metadata
 * and can be combined with transactions in runReport.
 */

const API = "https://analyticsdata.googleapis.com/v1beta";

/** Minimum campaign spend for a finding to be meaningful. */
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
 * Google Ads campaign performance for a period.
 *
 * Session-scoped dimensions (sessionGoogleAds*) are the right choice here: we
 * care whether a visit FROM THIS campaign led to a transaction. First-user
 * scope would attribute by the very first touch and, with longer purchase
 * decisions, would show campaigns unrelated to the order.
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
    // "(not set)" and organic rows are not Ads campaigns
    r.campaign && r.campaign !== "(not set)" && r.campaign !== "(organic)");

  return { rows, quota: j.propertyQuota || null };
}

/**
 * Finds campaigns that spend money but record no conversions.
 *
 * `ordersInPeriod` is the number of Shopify orders in the same period. It is
 * an important safeguard: if the store sold NOTHING in that period, zero
 * conversions is correct data, not a tracking failure. Without this check the
 * app would alarm every store that has a slow week.
 */
export function analyseAds(rows, ordersInPeriod = 0) {
  const spending = rows.filter((r) => r.cost >= MIN_SPEND);
  const totalCost = +spending.reduce((s, r) => s + r.cost, 0).toFixed(2);
  const totalRev = +spending.reduce((s, r) => s + r.revenue, 0).toFixed(2);
  const totalTx = spending.reduce((s, r) => s + r.transactions, 0);

  const findings = [];

  // 1) The campaign spent money and has clicks but NO transactions, while the
  //    store was selling in that period. Typical sign of a broken conversion.
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
            + `transactions to them - while your store did take `
            + `${ordersInPeriod} orders in the same period. Either the "`
            + "conversion never gets measured for this traffic, or Google Ads "
            + "is optimising against data it does not have.",
      },
    });
  }

  // 2) The whole account spends and tracks nothing. A separate, harsher
  //    finding: not one misconfigured campaign, but dead Ads tracking overall.
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
    // most expensive first: that is where the most money is at stake
    campaigns: [...spending].sort((a, b) => b.cost - a.cost).slice(0, 50),
    findings,
  };
}

/**
 * GA4 does not expose Google Ads conversion action status. State it openly so
 * that neither the merchant nor we assume the app sees more than it does.
 */
export const LIMITATIONS = [
  "GA4 does not expose the status of Google Ads conversion actions. "
  + "TrackGap can show spend, clicks and the transactions GA4 attributes to "
  + "a campaign, but it cannot tell you whether a conversion action itself "
  + "is disabled or unverified inside Google Ads.",
];
