# Working rules

## Read before starting anything

1. `PROJECT.md` — what this is, what "done" means, where things live.
2. `DECISIONS.md` — what was already decided and why. Do not re-open a decision without
   saying which line you are contradicting.
3. The state file of the task you are about to touch, in `work/tasks/`.
4. Only then the code.

`docs/GROUND_TRUTH.md` before touching anything that talks to the chain — every protocol
number in it was read from the chain, not from documentation, and the code assumes them.
`DESIGN.md` before touching anything visual.

## While working

- Update the current task's state file after any meaningful step: what was done, what was
  checked and how, what is still unknown, what the next step is.
- **Never write into another task's state file.** If a second task turns out to be needed,
  open its own file.
- Change `PROJECT.md` / `DECISIONS.md` only when a *shared* fact changes — a new decision, a
  new deliverable, a moved file. Task-local progress belongs in the task file.
- Keep verbose output in `work/logs/` and reference it from the state file by filename.
  Documents carry conclusions and the numbers behind them, not transcripts.
- Mark what is measured and what is assumed. "Faster" is not a result; "10–12s → 2–4s,
  measured on five launches" is.

## Verification — required, not optional

Nothing is "done" on the strength of reading the diff.

```sh
npm run typecheck && npm test && npm run build
```

Beyond that, by what changed:

| changed | must also be |
| --- | --- |
| anything the page renders | screenshotted at a wide viewport and at 375px, and measured — see the gates in `DESIGN.md` |
| anything that prices or encodes a trade | checked against the chain: simulate the bytes, or reproduce a real event from the log |
| anything that reads the chain | run against the live chain, not only unit-tested |
| anything in `deploy/` or the compose files | `docker compose -f compose.prod.yaml config` at minimum |

State the numbers you got. If a check was skipped, say which and why.

## Things that have bitten and must not recur

- **The author's home path must never appear anywhere in the repository or its history.**
- Commits are authored as `multilaunch <multilaunch@users.noreply.github.com>`. No other
  name or address goes into history.
- No secrets in the repo or in any document. `.env` is ignored and stays ignored; if a key
  is ever printed, say so and treat it as burned.
- A scripted edit must assert every replacement it makes. An edit that silently matched
  nothing has been reported as done here before.
- Do not report a measurement without checking the measurement. A contrast audit that
  parsed `rgb()` against `oklch()` values produced 1097 fictional failures.

## Before the session ends

Write the result and the continuation point into the task's state file: what a reader
picking this up tomorrow needs, in order to not repeat the last hour.
