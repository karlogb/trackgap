# TrackGap - Google Ads API Tool Documentation

**Company:** NullLogic s.r.o. (Slovakia)
**Product:** TrackGap
**Website:** https://trackgap.example.com
**Distribution:** Shopify App Store
**Contact:** karol@nulllogic.eu
**Requested access level:** Basic
**Permissible use:** Reporting (read-only)

---

## 1. What the tool does

TrackGap is a subscription application for Shopify merchants that verifies
whether their conversion tracking is working.

E-commerce merchants routinely see three different numbers for the same period:
the orders recorded by their store, the conversions recorded by their analytics,
and the conversions reported by their advertising platforms. When these diverge,
the merchant has no practical way to determine whether the difference is a
tracking failure, a consent decision by the visitor, or an attribution window.

TrackGap answers that question. It reads the merchant's orders server-side from
the Shopify Admin API - the one source that ad blockers and consent banners
cannot suppress - and compares them against what each connected platform
actually recorded.

## 2. What we use the Google Ads API for

**Read-only reporting, on the authenticated customer's own account, under their
explicit OAuth consent.**

Two specific reports:

**a) Conversion action health.** We query `conversion_action` to detect
conversion actions that have recorded zero conversions over a sustained period
while the store continued to sell. This is a common and expensive failure:
a tag removed during a site migration goes unnoticed for months while the
bidding algorithm optimises against incomplete data.

**b) Aggregate conversion counts.** We query campaign-level conversion metrics
to compare the number of conversions Google Ads reports against the number of
orders the store actually recorded for the same period, so the merchant can see
whether a sustained gap exists.

### API surface used

```
GoogleAdsService.SearchStream   (read)
GoogleAdsService.Search         (read)
```

Resources queried: `conversion_action`, `campaign`, `customer`, and the
associated metrics fields.

### What we never do

- We do not create, modify, pause or delete campaigns, ad groups, ads,
  keywords, budgets or bids.
- We do not create Google Ads accounts.
- We do not manage users or account access.
- We do not use Keyword Planner, Reach Planner or Audience Insights.
- We do not modify billing or payment settings.
- We do not write any data to Google Ads.

## 3. Authentication and authorisation

Each merchant connects their own Google Ads account through the standard OAuth
2.0 consent flow. We store only the refresh token, encrypted at rest with
AES-256-GCM. We never ask for, receive or store Google account credentials.

A merchant can revoke access at any time from their Google account settings or
by uninstalling the app, which deletes all stored tokens within 48 hours.

The developer token is used solely by our own application. It is not shared
with merchants or third parties.

## 4. Who uses the tool

E-commerce merchants operating Shopify stores who advertise on Google Ads -
typically small and mid-sized businesses managing their own advertising
accounts. The tool is distributed publicly through the Shopify App Store.

Each merchant sees only their own data. Data is never aggregated across
merchants, never sold, never shared with third parties, and never used to
train models.

## 5. Expected API volume

Reporting queries run once per day per connected account, plus on-demand when a
merchant opens the dashboard (rate-limited and cached for 60 minutes to avoid
redundant calls).

Estimated at launch: fewer than 100 connected accounts, under 500 operations
per day in total. Basic access (15,000 operations per day) provides substantial
headroom for growth.

## 6. Data handling

| Data | Purpose | Retention |
|---|---|---|
| Conversion action names, status, counts | Detect actions that stopped recording | 90 days |
| Aggregate conversion metrics by campaign and day | Compare against store orders | 90 days |
| OAuth refresh token | Maintain the connection | Until uninstall |

We do not request or store any personally identifiable information from the
Google Ads API. All data is stored on a dedicated server in the European Union.

Privacy policy: https://trackgap.example.com/privacy

## 7. User interface

The merchant sees a dashboard inside their Shopify admin showing:

- the share of orders that were not tracked, and their value
- that gap split by cause - broken tracking, declined consent, or no identifier
- per-platform comparison of orders against reported conversions
- alerts by email when tracking degrades compared with previous checks

Screenshots and a live demonstration are available at
https://trackgap.example.com

## 8. Compliance

- Read-only access, limited to the minimum resources required.
- Explicit OAuth consent per merchant, revocable at any time.
- No modification of any Google Ads entity.
- Developer token not shared with end users.
- Terms of service and privacy policy published and publicly accessible.
