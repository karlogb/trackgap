/**
 * Adresa pre alerty musi byt DORUCITELNA, nie len syntakticky platna.
 *
 * Regresia z 1.9.2026: `app-review@example.com` presiel regexom, ulozil sa,
 * onboarding dostal zelenu fajku — a bounce ("nullMX") prisiel NAM, nie
 * merchantovi. Appka tvrdila, ze alerty su nastavene, hoci nemala ako dat
 * vediet o comkolvek.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkMailDomain, EMAIL_RE } from "../mailcheck.mjs";

test("nullMX domenu odmietne (presne ten pripad, co nas dostal)", async () => {
  const r = await checkMailDomain("app-review@example.com");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "null_mx");
  // Regex ju pritom povazuje za platnu — preto samotny regex nestacil.
  assert.ok(EMAIL_RE.test("app-review@example.com"));
});

test("neexistujucu domenu odmietne", async () => {
  const r = await checkMailDomain("x@thisdomaindoesnotexist-zzq9x.eu");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_domain");
});

test("nezmysel odmietne uz na syntaxi", async () => {
  assert.equal((await checkMailDomain("bad")).reason, "syntax");
  assert.equal((await checkMailDomain("")).reason, "syntax");
  assert.equal((await checkMailDomain(null)).reason, "syntax");
});

test("bezne domeny prejdu", async () => {
  for (const e of ["x@gmail.com", "karol@nulllogic.eu", "x@shopify.com"]) {
    assert.equal((await checkMailDomain(e)).ok, true, e);
  }
});

test("vypadok DNS adresu NEZABLOKUJE", async () => {
  // Nasa nedostupnost nesmie merchantovi zabranit nastavit si alerty.
  // Netvrdime `unknown:true` — pri 1 ms timeoute moze DNS odpovedat
  // z cache a legitimne vratit MX. Zaruka, na ktorej zalezi, je jedina:
  // z tejto vetvy sa NIKDY nevrati `ok:false`, teda merchant neuvizne.
  const r = await checkMailDomain("someone@gmail.com", { timeoutMs: 1 });
  assert.equal(r.ok, true);
});
