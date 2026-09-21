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

## Evidence from a real phone — two screenshots, 2026-09-22, 00:15 and 00:19

Observed in the images (not inferred):

- production `https://assay.mlaunch.xyz/`, a wallet **connected** (address shown, button "disconnect");
- at 00:15 the masthead offers **"wrong chain, switch"**; at 00:19 the same masthead shows only
  "disconnect" — the chain warning is gone;
- at 00:19 a **real quote** is on screen: 0.01 ETH → 5 756 800 of a token, minimum 5 584 096 at 3 %,
  fee 1 %, creator tax 1 %, opening tax 0 %, "19 s left", and a lit **"sign and send"** button;
- the status bar reads "◀ Chrome".

Inferred, and worth saying so:

- "◀ Chrome" is what iOS shows when one app was opened from another, so this looks like **the deep link
  working**: Chrome → a wallet app's in-app browser. Which wallet is not identifiable from the image.
- The chain warning disappearing between the two shots suggests **switching or adding the chain worked**
  in that wallet, which was one of the open unknowns. It does not say whether the button was pressed.

So, for the first time: the client wallet path has run against a **real** wallet on a **real** phone up to
a priced, signable quote. **Not yet seen:** a signature, a transaction hash, or a receipt.

Visible in the same images, not yet acted on:

1. **Chrome above the feed.** With a wallet connected the masthead is three rows, and the first launch
   row starts about **60 % of the way down** the visible screen. The track-record strip also spends a
   whole second line on its "why this means something" link.
2. **The confirm button is below the fold of the sheet.** The sheet is 88 % of the viewport and the
   quote block sits under the amount fields, so after pricing the reader has to scroll inside the sheet
   to reach "sign and send".
3. A **20 s** quote on a phone is tight if signing means switching apps.

## Still unknown

Which wallet; whether the switch was pressed; what happens on sign. If it is signed, that is the first
real trade this board has ever made — ask for the transaction hash and record the outcome here.

## Continuation point

Ask the owner which wallet, and whether they pressed "switch". Offered, not done: compact the phone
masthead, scroll the sheet to the quote when it arrives.
