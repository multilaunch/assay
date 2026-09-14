# 001 — baseline, before any limit

Local board, `node dist/cli/main.js board --port 4664`, index warm and at head.
Attacker and victim on the same machine, so network latency is not in these numbers.

Two runs. The first used random 40-hex addresses and proved only that the cheap path is
cheap: `getLaunchedToken` says the token does not exist and the route answers 404 without
touching a log range. `/state` stayed at 1 ms throughout — it is served from memory.

The second used **real token addresses**, taken from the board's own index (86k of them,
and they are public on the chain anyway).

| | |
|---|---|
| reader's `/candles`, board idle | **1 179 ms** |
| reader's `/candles`, 40 distinct `/holders` in flight | **61 573 ms** |
| the flood itself | 133 s to drain, slowest single response 134 621 ms |
| status codes | all 200 — nothing refused, everything queued |

40 requests. One HTTP call each, no cleverness, addresses that are public. The board stays
up and keeps answering — it just answers 52× slower, for everyone, for over two minutes.

The mechanism is the RPC gate doing its job: 3 requests in flight, 400 ms spacing on log
calls. Every `/holders` miss is roughly twenty `getLogs`, so forty of them is ~800 log
calls queued ahead of whatever a real reader asks for next.

Conclusion: the caches bound repeat cost for the same token and do nothing here. The limit
has to be per caller, and it has to sit in front of the work rather than in front of the
request — a cache hit costs nothing and should not consume anyone's budget.

---

# After: per-caller limit, then a board-wide ceiling

Same harness, index at head, distinct `X-Forwarded-For` per caller so attacker and victim
are not one address (locally they would be; Caddy separates them in production).

| reader's chart | before | per-caller only | + board ceiling |
|---|---|---|---|
| board idle | 1 179 ms | 511 ms | 3 037 ms |
| 40 requests, **one** caller | 61 573 ms | 6 893 ms | — |
| 40 requests, **40** callers | — | 71 872 ms | **7 883 ms** |

The idle row moves around between 0.5 s and 3 s across runs. That is the public RPC's own
latency; the limiter does nothing at all on an idle board, and reading those three numbers
as a trend would be reading noise.

What each bound actually bought:

- **Per caller** killed the single-source flood: 36 of 40 refused, 61 s → 6.9 s.
- **Per caller did nothing** against forty callers asking once each — 71.9 s with not one
  request refused. Forty addresses cost an attacker nothing, so this was the real case.
- **The board ceiling** is what fixed that: 71.9 s → 7.9 s, 28 of 40 given a fast 429 with
  a retry-after instead of everyone queueing behind them.

A first attempt at this had the attacker and the victim sharing 127.0.0.1, which showed the
victim being refused by their own limit and proved nothing. Recorded because the number
looked like a result.
