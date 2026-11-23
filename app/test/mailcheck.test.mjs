/**
 * The alert address must be DELIVERABLE, not just syntactically valid.
 *
 * Regression: `app-review@example.com` passed the regex, was saved,
 * onboarding got a green check mark, and the bounce ("nullMX") came to US,
 * not the merchant. The app claimed alerts were set up while having no way
 * to notify anyone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkMailDomain, EMAIL_RE } from "../mailcheck.mjs";

test("rejects a nullMX domain (the exact case that caused the bug)", async () => {
  const r = await checkMailDomain("app-review@example.com");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "null_mx");
  // The regex considers it valid, which is why the regex alone was not enough.
  assert.ok(EMAIL_RE.test("app-review@example.com"));
});

test("rejects a non-existent domain", async () => {
  const r = await checkMailDomain("x@thisdomaindoesnotexist-zzq9x.eu");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_domain");
});

test("rejects nonsense already at syntax level", async () => {
  assert.equal((await checkMailDomain("bad")).reason, "syntax");
  assert.equal((await checkMailDomain("")).reason, "syntax");
  assert.equal((await checkMailDomain(null)).reason, "syntax");
});

test("common domains pass", async () => {
  for (const e of ["x@gmail.com", "karol@nulllogic.eu", "x@shopify.com"]) {
    assert.equal((await checkMailDomain(e)).ok, true, e);
  }
});
test("a DNS outage does NOT block the address", async () => {
  // Our own unavailability must not stop the merchant from setting up alerts.
  // We do not assert `unknown:true`: with a 1 ms timeout DNS may answer from
  // cache and legitimately return MX. The only guarantee that matters:
  // this branch NEVER returns `ok:false`, so the merchant is never stuck.
  const r = await checkMailDomain("someone@gmail.com", { timeoutMs: 1 });
  assert.equal(r.ok, true);
});
