import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcGate, parseEndpointEnv } from "../src/util/rpc.js";

/** Swap global fetch for a scripted one; returns the calls it saw and a restore function. */
function fakeFetch(script: (url: string, body: { method: string }) => { status: number; body: unknown }) {
  const calls: { url: string; method: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = JSON.parse(String(init?.body)) as { method: string; id: number };
    calls.push({ url, method: parsed.method });
    const r = script(url, parsed);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("RPC_URL parsing: labels from hostnames, #nologs strips the logs capability", () => {
  const eps = parseEndpointEnv("https://a.example.com/x#nologs, https://rpc.b.io/v1/KEY");
  assert.equal(eps.length, 2);
  assert.deepEqual(eps[0]!.caps, ["state"]);
  assert.deepEqual(eps[1]!.caps, ["state", "logs"]);
  assert.equal(eps[0]!.url, "https://a.example.com/x");
  assert.equal(eps[1]!.label, "rpc.b");
});

test("eth_getLogs is routed only to an endpoint that advertises logs", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: [] } }));
  try {
    const g = new RpcGate([
      { url: "https://state.only", label: "state", caps: ["state"] },
      { url: "https://full.node", label: "full", caps: ["state", "logs"] },
    ], { spacingMs: 0, logsSpacingMs: 0 });
    await g.request("eth_getLogs", [{}]);
    await g.request("eth_blockNumber", []);
    assert.equal(f.calls[0]!.url, "https://full.node");
    assert.equal(f.calls[1]!.url, "https://state.only"); // first healthy endpoint with the capability
  } finally { f.restore(); }
});

test("a 429 benches the endpoint and the request moves to the next one", async () => {
  let hits = 0;
  const f = fakeFetch((url) => {
    hits++;
    if (url.includes("flaky")) return { status: 429, body: "rate limited" };
    return { status: 200, body: { jsonrpc: "2.0", id: 1, result: "0x1" } };
  });
  try {
    const g = new RpcGate([
      { url: "https://flaky", label: "flaky", caps: ["state"] },
      { url: "https://steady", label: "steady", caps: ["state"] },
    ], { spacingMs: 0, retries: 3 });
    const r = await g.request<string>("eth_chainId");
    assert.equal(r, "0x1");
    assert.ok(hits >= 2);
    const st = g.status();
    assert.equal(st.find((s) => s.label === "flaky")!.rejected, 1);
    assert.equal(st.find((s) => s.label === "flaky")!.benched, true);
    // while benched, the next call goes straight to steady
    const before = f.calls.length;
    await g.request("eth_chainId");
    assert.equal(f.calls[before]!.url, "https://steady");
  } finally { f.restore(); }
});

test("a JSON-RPC error that is not a rate limit is thrown, not retried", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0xdead" } } }));
  try {
    const g = new RpcGate([{ url: "https://n", label: "n", caps: ["state"] }], { spacingMs: 0, retries: 5 });
    await assert.rejects(() => g.request("eth_call", [{}]), /execution reverted/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test("the in-flight cap holds", async () => {
  let concurrent = 0, peak = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    concurrent++; peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 15));
    concurrent--;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }), { status: 200 });
  }) as typeof fetch;
  try {
    const g = new RpcGate([{ url: "https://n", label: "n", caps: ["state"] }], { maxInFlight: 2, spacingMs: 0 });
    await Promise.all(Array.from({ length: 8 }, () => g.request("eth_blockNumber")));
    assert.ok(peak <= 2, `peak ${peak}`);
  } finally { globalThis.fetch = real; }
});
