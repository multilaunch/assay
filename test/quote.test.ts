import assert from "node:assert/strict";
import { test } from "node:test";
import { buyQuote } from "../src/board/quote.js";

const OK = "0x000000000000000000000000000000000000dEaD";

/** Every case here is refused on the input alone, before the chain is ever asked. */
test("a quote refuses anything it cannot price, and says which", async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ token: "nope", buyer: OK, quoteIn: "10000000000000000" }, /not a token address/],
    [{ token: OK, buyer: "", quoteIn: "10000000000000000" }, /connect a wallet/],
    [{ token: OK, buyer: "0x123", quoteIn: "10000000000000000" }, /connect a wallet/],
    [{ token: OK, buyer: OK, quoteIn: "1.5" }, /integer number of wei/],
    [{ token: OK, buyer: OK, quoteIn: "" }, /integer number of wei/],
    [{ token: OK, buyer: OK, quoteIn: "1" }, /too small/],
    [{ token: OK, buyer: OK, quoteIn: "2000000000000000000" }, /not quote more than 1 ETH/],
  ];
  for (const [input, expected] of cases) {
    const r = await buyQuote(input as never);
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
    if (!r.ok) assert.match(r.error, expected);
  }
});

test("an amount at the very edge of the bounds is not refused for being at the edge", async () => {
  // both of these get past the input check and go on to ask the chain, which is what we want to
  // prove; the chain answer itself is not this test's business
  for (const wei of ["1000000000000", "1000000000000000000"]) {
    const r = await buyQuote({ token: OK, buyer: OK, quoteIn: wei });
    if (!r.ok) assert.doesNotMatch(r.error, /too small|more than 1 ETH/, `${wei} was rejected on size`);
  }
});
