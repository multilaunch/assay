import assert from "node:assert/strict";
import { test } from "node:test";
import { clearCookie, hashPassword, LoginThrottle, readCookie, sessionCookie, Sessions, verifyPassword } from "../src/board/auth.js";

test("a password verifies against its own hash and nothing else", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.ok(await verifyPassword("correct horse battery staple", h));
  assert.equal(await verifyPassword("correct horse battery stapl", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("two hashes of the same password differ, so the salt is doing its job", async () => {
  const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("same", a));
  assert.ok(await verifyPassword("same", b));
});

test("a missing or malformed hash refuses everything instead of letting everyone in", async () => {
  for (const bad of ["", "not-a-hash", "scrypt$x$8$1$aa$bb", "bcrypt$1$2$3$4$5", "scrypt$32768$8$1$$", "$$$$$"]) {
    assert.equal(await verifyPassword("anything", bad), false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(await verifyPassword("", bad), false);
  }
});

test("a session is valid until it expires, and using it pushes the expiry out", () => {
  const s = new Sessions({ ttlMs: 1000 });
  const t = s.create(0);
  assert.equal(s.verify(t, 500), true);      // slides expiry to 1500
  assert.equal(s.verify(t, 1400), true);     // would have died at 1000 without the slide
  assert.equal(s.verify(t, 3000), false);
  assert.equal(s.verify(t, 3001), false);    // and stays dead
});

test("an unknown or empty token is never a session", () => {
  const s = new Sessions();
  assert.equal(s.verify(undefined), false);
  assert.equal(s.verify(""), false);
  assert.equal(s.verify("x".repeat(43)), false);
});

test("logging out ends that session and no other", () => {
  const s = new Sessions();
  const a = s.create(), b = s.create();
  s.destroy(a);
  assert.equal(s.verify(a), false);
  assert.equal(s.verify(b), true);
});

test("a login loop cannot grow the session map without bound", () => {
  const s = new Sessions({ max: 4 });
  for (let i = 0; i < 50; i++) s.create(i);
  assert.ok(s.count(50) <= 4);
});

test("failed logins back off, a good one clears the debt", () => {
  const th = new LoginThrottle(1000, 60_000);
  assert.equal(th.retryAfter("1.2.3.4", 0), 0);
  th.fail("1.2.3.4", 0);
  assert.equal(th.retryAfter("1.2.3.4", 0), 1000);
  th.fail("1.2.3.4", 1000);
  assert.equal(th.retryAfter("1.2.3.4", 1000), 2000);   // doubling
  assert.equal(th.retryAfter("5.6.7.8", 1000), 0);      // and only for that caller
  th.succeed("1.2.3.4");
  assert.equal(th.retryAfter("1.2.3.4", 1000), 0);
});

test("the backoff is capped, so a mistyped password is not a lockout", () => {
  const th = new LoginThrottle(1000, 5000);
  for (let i = 0; i < 40; i++) th.fail("k", 0);
  assert.equal(th.retryAfter("k", 0), 5000);
});

test("cookies are read by exact name, not by prefix", () => {
  const h = "other=1; assay_session=abc.def; assay_session_x=nope";
  assert.equal(readCookie(h, "assay_session"), "abc.def");
  assert.equal(readCookie(h, "assay"), undefined);
  assert.equal(readCookie(undefined, "assay_session"), undefined);
  assert.equal(readCookie("malformed", "assay_session"), undefined);
});

test("the cookie is HttpOnly and SameSite=Strict, and Secure only over https", () => {
  const https = sessionCookie("tok", { secure: true, maxAgeSec: 60 });
  assert.match(https, /HttpOnly/);
  assert.match(https, /SameSite=Strict/);
  assert.match(https, /Secure/);
  // over an SSH tunnel the page is plain http on loopback; a Secure cookie there is dropped
  // silently and locks the operator out of their own board
  assert.doesNotMatch(sessionCookie("tok", { secure: false, maxAgeSec: 60 }), /Secure/);
  assert.match(clearCookie(true), /Max-Age=0/);
});
