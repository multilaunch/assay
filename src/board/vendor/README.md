# vendor

Third-party code, kept in the repository rather than pulled at run time.

## lightweight-charts.js

TradingView Lightweight Charts 5.2.1, the standalone production build, unmodified.
Apache-2.0 — the licence text is in `LICENSE-lightweight-charts.txt`.

It is here rather than on a CDN for the same reason token images are proxied: a page that
loads a script from someone else's host tells that host who is reading the board, and every
reader would be announcing themselves to a third party seconds before they trade. The board
serves everything it needs.

The chart carries TradingView's own attribution mark, which is the library's default. The
licence does not compel it — Apache-2.0 asks only that the notice above travel with the code —
but the authors ask for it, and 193 KB of their work is worth a line of credit.

To update: `npm pack lightweight-charts@<version>`, then copy `dist/lightweight-charts.standalone.production.js`
and `LICENSE` out of the tarball. There is no build step to run.
