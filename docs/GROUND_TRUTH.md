# Ground truth read from Robinhood Chain

Everything the tool assumes about the protocol was read from the chain, not from documentation.
`hoodterm doctor` repeats these reads on every start and refuses to run the engine when they disagree.

## Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — 2026-09-07, block 57 488 214

| Read | Value | Note |
|---|---|---|
| `snipeTaxStartBps()` | 9 900 | 99 % on a buy at t = 0 |
| `snipeTaxSeconds()` | 3 | source default is 15; owner set it to 3 |
| `launchFee()` | 500 000 000 000 000 wei | 0.0005 ETH |
| `maxCreatorTaxBps()` | 1 000 | 10 % |
| `launchEnabled()` | true | |
| `launchConfigCount()` | 1 | |
| `memeHook()` | `0xE5e7…e044` | matches docs |
| `feeEscrow()` | `0xd3AF…Ac9e` | matches docs |
| `launchForwarder()` | `0xe33E…2948` | this *is* the Launch & Buy router |
| `locker()` | `0x2674…4952` | matches docs |

Multicall3 at the canonical `0xcA11…CA11` has 3 808 bytes of code; `aggregate3` answers.

## A fresh curve `0xa27A553713E5799606e27A98f21cDc30f625cCFD`, launched block 57 488 159

| Read | Value | Note |
|---|---|---|
| `currentSnipeTaxBps(dead)` | 0 | window already over at read time |
| `launchedAt()` | 1 788 850 101 | **exists on the deployed curve**, absent from public source |
| `snipeTaxExempt(dead)` | false | **exists on the deployed curve** |
| `getReserves()` | (3 954 651 205, 818 276 968 859 587 817 802 860 132) | quote has 6 decimals: this pair is a stable, not ETH |
| `realQuoteReserve()` | 718 651 205 | |
| `phantomQuote()` | 3 236 000 000 | |
| `sellableTokens()` | 532 562 683 145 302 103 517 145 847 | |
| `reservedTokens()` | 285 714 285 714 285 714 285 714 285 | 28.571 % of 1 B, reserved for the pool |
| `graduationThreshold()` | 8 090 000 000 | 8 090 quote units |
| `feeBps()` | 100 | 1 % base fee |
| `creatorTaxBps()` | 200 | this creator chose 2 % |

Consequences baked into the code:

- Pair decimals are read for every launch. ETH is 18, stables are 6, stock tokens vary.
- `snipeTaxSeconds` is read at start; the wait loop never assumes a number.
- Reserved share is read per curve, never assumed to be 28.57 %.
- Tempo at read time: 35 launches in 3 000 blocks (~5 min).
