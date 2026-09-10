import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateAddress, resolveLogoUrl } from "../src/board/logo.js";

test("anything that is not out on the open internet is refused", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.7", "172.16.0.1", "172.31.255.254",
                    "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
                    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "104.18.32.7", "172.15.0.1", "172.32.0.1",
                    "192.167.1.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
});

test("the cloud metadata address in particular", () => {
  // a launcher setting their logo to this is trying to read the box the board runs on
  assert.equal(isPrivateAddress("169.254.169.254"), true);
});

test("only http, https and ipfs turn into something fetchable", () => {
  const ipfs = resolveLogoUrl("ipfs://bafkreihd72vwt3o6nnjek2tova6eslz2f5dew6fbcd6jovvneslqqhygg4");
  assert.ok(ipfs.length > 1, "one gateway is one point of failure");
  for (const u of ipfs) assert.match(u, /^https:\/\/[^/]+\/ipfs\/bafkrei/);
  assert.deepEqual(resolveLogoUrl("https://img.koyen.fun/a.jpg"), ["https://img.koyen.fun/a.jpg"]);
  assert.deepEqual(resolveLogoUrl("http://j7m.io/m/x"), ["http://j7m.io/m/x"]);
  for (const bad of ["", "   ", "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd",
                     "ipfs://../../etc/passwd", "not a url", "vbscript:x"]) {
    assert.deepEqual(resolveLogoUrl(bad), [], `${JSON.stringify(bad)} should not resolve`);
  }
});

test("an ipfs path with a traversal in it does not become a gateway url", () => {
  assert.deepEqual(resolveLogoUrl("ipfs://abcdefghijkl/../../secret"), []);
});
