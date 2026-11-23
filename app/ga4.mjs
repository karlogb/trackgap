/**
 * TrackGap - GA4 connector.
 *
 * The merchant connects their own Google account via OAuth; we read with
 * their credentials, so Data API quotas go to their project, not ours.
 * The scope is read-only.
 *
 * transactionId is returned as a dimension that can be combined with
 * date/source/medium; in testing, '(other)' rows did not appear even for
 * stores with thousands of transactions over 30 days.
 */
import { readSecret } from "./secrets.mjs";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

function googleCfg() {
  return readSecret("google.json");
}

export function googleAuthUrl(state, redirectUri) {
  const c = googleCfg();
  const p = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function googleExchange(code, redirectUri) {
  const c = googleCfg();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.client_id,
      client_secret: c.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new Error(`google token ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function accessToken(refreshToken) {
  const c = googleCfg();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

/** GA4 properties the merchant has access to. */
export async function listProperties(token) {
  const r = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`accountSummaries ${r.status}`);
  const j = await r.json();
  const out = [];
  for (const a of j.accountSummaries || []) {
    for (const p of a.propertySummaries || []) {
      out.push({ id: p.property.split("/").pop(), name: p.displayName });
    }
  }
  return out;
}

/**
 * Fetches GA4 transactions for a period.
 * Returns [{transaction_id, revenue, event_count, date, source, medium}]
 */
export async function fetchTransactions(token, propertyId, startDate, endDate) {
  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: "transactionId" },
      { name: "date" },
      { name: "sessionSource" },
      { name: "sessionMedium" },
    ],
    metrics: [
      { name: "purchaseRevenue" },
      { name: "transactions" },
    ],
    limit: 250000,
    returnPropertyQuota: true,
  };
  const r = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`runReport ${r.status}: ${await r.text()}`);
  const j = await r.json();

  // aggregate by transaction_id: one order can arrive in several rows
  // (different sources), and a repeated occurrence is a duplicate signal
  const map = new Map();
  for (const row of j.rows || []) {
    const [tid, date, source, medium] = row.dimensionValues.map((d) => d.value);
    const rev = parseFloat(row.metricValues[0].value || 0);
    const cnt = parseInt(row.metricValues[1].value || 0, 10);
    const prev = map.get(tid);
    if (prev) {
      prev.revenue += rev;
      prev.event_count += cnt;
    } else {
      map.set(tid, {
        transaction_id: tid,
        revenue: rev,
        event_count: cnt,
        date,
        source,
        medium,
      });
    }
  }
  return {
    rows: [...map.values()],
    rowCount: j.rowCount || 0,
    quota: j.propertyQuota || null,
  };
}
