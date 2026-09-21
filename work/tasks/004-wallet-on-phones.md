# 004 — a way to a wallet from a phone browser

status: **built; link behaviour on a real phone untested** · opened 2026-09-21

## Goal

A visitor on Safari or Chrome for phones, where no wallet is injected, can get to a page that can
sign — in one tap, without installing an extension and without a new dependency.

## Why

Reproduced in task 003: every phone screenshot says "no wallet". The page looks only at
`window.ethereum`, which mobile browsers do not provide. Wallet apps do — their own in-app browser
injects it. So the way in is to hand the visitor to that browser.

## Chosen: deep links into three wallets' in-app browsers, plus EIP-6963 discovery

Options and why not the others are in `DECISIONS.md` (WalletConnect is a proposal, not taken).

### Link formats — checked against the wallets' own documentation, not memory

| wallet | format | source |
|---|---|---|
| MetaMask | `https://link.metamask.io/dapp/<host+path>` — **no scheme** | docs.metamask.io/sdk/guides/use-deeplinks (via search result); the old `metamask.app.link` I first named from memory is not what current docs show |
| Coinbase Wallet | `https://go.cb-w.com/dapp?cb_url=<percent-encoded url>` | docs.cdp.coinbase.com mobile-dapp-integration |
| Trust Wallet | `https://link.trustwallet.com/open_url?coin_id=60&url=<url>` | developer.trustwallet.com deeplinking |

Rabby has no deeplink I could find documented. **Left out rather than guessed.**

## Constraints

- No new dependency, nothing loaded from another host — CSP is `connect-src 'self'`, scripts `'self'`.
- Desktop unchanged: no wallet there still means "no wallet".
- The buy box must never offer a live-looking control that does nothing.

## Unknown — to be stated honestly at the end

- Whether a link actually opens the wallet on a real phone. Cannot be tested without one.
- Whether Trust Wallet supports `wallet_addEthereumChain` for chain 4663, or whether the visitor has
  to add Robinhood Chain by hand there. `coin_id=60` is Ethereum's slip44 and says nothing about it.
- Whether the page's context (which launch was selected) survives the hop. It will not: the wallet
  opens the page fresh.

## Built

- **EIP-6963 discovery.** The page listens for `eip6963:announceProvider` and asks for announcements
  once, from `walletBoot`, after the page is fully initialised — a wallet may answer synchronously and
  the handler repaints things that must already exist. `window.ethereum` still wins when present.
- **"open in wallet"** replaces the dead "no wallet" control on a touch device with no provider —
  the masthead and the trade panel's main button. It opens a picker with the three links above.
  Detected by `(pointer: coarse)`, not by width: a narrow desktop window has no wallet to hop to.
- **Desktop unchanged**: "no wallet", disabled, no picker.
- The picker dismisses by ×, Escape and the veil, and sits above the trade sheet.

## Checked — emulated 375 px, touch

| | result |
|---|---|
| masthead, no provider | "open in wallet", enabled |
| picker | three links, 52 px tall each; hrefs exactly as documented |
| trade sheet button | "open in wallet", opens the same picker, which is layered above the sheet |
| close / Escape / veil | all three close it and clear the veil |
| desktop, no provider | "no wallet", disabled, click opens nothing, trade panel disabled |
| Russian | masthead, title, lede, note, close all translated |
| sideways scroll at 375 | none |

**A stub wallet, announced through EIP-6963, end to end:** masthead flips to "connect" → connect →
quote → "sign and send". The wallet received an object **byte-identical** to the one the server
returned, including `chainId: 0x1237`; RPC calls were `eth_chainId`, `eth_requestAccounts`,
`eth_chainId`, `eth_sendTransaction`. This is the first time the client-side wallet path has been
exercised at all — with a stub, not a real wallet.

## Not verified

- **That any of the three links opens the wallet on a real phone.** Formats are from the wallets'
  documentation; behaviour is not seen. A visitor without the app installed lands on the wallet's
  store page or a web fallback — not tested.
- **Whether Trust Wallet can add or switch to chain 4663.** `coin_id=60` is Ethereum's slip44.
- **The hop loses context**: the selected launch is not carried across. Said in the picker.
- A wallet's **real** `wallet_addEthereumChain` / `switchEthereumChain` responses.

## Corrected

I first named MetaMask's link as `metamask.app.link/dapp/…` from memory. Its current documentation
shows `link.metamask.io/dapp/…`, which is what is built.

## Verified on production — `5f0ab07`

375 px, touch, no provider: masthead "open in wallet", picker opens, links are

- `https://link.metamask.io/dapp/assay.mlaunch.xyz/`
- `https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fassay.mlaunch.xyz%2F`
- `https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fassay.mlaunch.xyz%2F`

No sideways scroll.

## Continuation point

Nothing to build. What is left is a person with a phone: ask the tester which wallet they use, have
them tap the matching link with the app installed, and report what opens — and, in Trust Wallet, whether
Robinhood Chain has to be added by hand. If a link is dead, replace it from that wallet's documentation.
