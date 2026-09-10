# Deploying assay to a VPS

Everything here assumes one plain Ubuntu 24.04 box you rent, one DNS name, and Caddy in front for
TLS. There is no cluster, no orchestrator and no CI: this is one process behind one proxy, and the
whole point of the document is that you should be able to hold all of it in your head.

Two paths, both supported:

| | Docker | systemd |
|---|---|---|
| what runs | `compose.prod.yaml`: the board and Caddy as containers | `node` and `caddy` as host services |
| build safety | the image runs `typecheck` + the whole test suite before it exists | `bootstrap.sh` runs them before it installs |
| live sessions | yes — `docker attach` to type `arm` | no, see [Going live](#going-live) |
| rollback | retag the previous image, one command | rebuild the previous commit |

Take Docker unless you have a reason not to. The rollback story is better and the build cannot
half-succeed.

---

## Before you start

**A box.** 1 vCPU / 1 GB is enough for the board; 2 GB makes the Docker build comfortable
(`tsc` plus the test run is the peak). 10 GB disk. Ubuntu 24.04.

**A name.** An `A` record for `board.example.com` pointing at the box's IPv4 address, and an
`AAAA` record if the box has IPv6. Create these *first* and let them propagate. Caddy asks
Let's Encrypt for a certificate the moment it starts, and a failed challenge puts it into a
backoff that gets longer each time.

```sh
dig +short board.example.com          # must return the box's IP
curl -s https://api.ipify.org         # run this on the box: must be the same
```

**Ports.** 22, 80 and 443 inbound. Nothing else — in particular not 4663. The bootstrap script
sets `ufw` up this way; if your provider has its own firewall in front of the box, mirror it there.

**SSH.** Key auth. This document does not cover hardening `sshd`, but note that on this box SSH is
also the fallback route to the board's controls, so it carries more than usual.

---

## The fast path

From a checkout on your laptop, copy the repository up and run one script:

```sh
rsync -a --exclude node_modules --exclude dist --exclude data ./ root@board.example.com:/opt/assay/app/
ssh root@board.example.com
cd /opt/assay/app
BOARD_DOMAIN=board.example.com ACME_EMAIL=you@example.com ./deploy/bootstrap.sh
```

Or, if the repository is reachable from the box, clone it there and run the same script from
inside the checkout. `bootstrap.sh` is idempotent — run it again after any change and it will
reassert what it can and leave your secrets alone.

It will:

1. install `ca-certificates curl gnupg git ufw unattended-upgrades rsync jq`
2. turn on unattended **security** upgrades, with automatic reboot **off** (a reboot mid-session
   abandons open positions; `/var/run/reboot-required` tells you when one is pending)
3. enable `ufw` — 22, 80, 443 in, everything else denied, SSH allowed *before* the enable
4. create the system user `assay` and the directories
   `/opt/assay/app`, `/etc/assay` (0750), `/var/lib/assay` (0750), `/var/backups/assay` (0700)
5. install Docker (or Node 22 + Caddy, with `MODE=systemd`)
6. write `/etc/assay/env.prod` **0600** from the example, with `PRIVATE_KEY` empty
7. generate a 32-character board password, hash it with `caddy hash-password`, write
   `/etc/assay/caddy.env` **0600**, and print the password once
8. build and start the stack, then wait for the board's healthcheck

At the end it prints the URL, the credentials and the SSH-tunnel command. **Write the password
down.** It is also in `/etc/assay/board-credentials` (0600, root). Rotating it means deleting
`/etc/assay/caddy.env` and running the script again.

Useful knobs: `MODE=systemd`, `ADMIN_IPS="203.0.113.7 198.51.100.0/24"`, `SKIP_FIREWALL=1`,
`SKIP_START=1`, `REPO=` / `REF=` to clone instead of copy.

---

## The manual path, Docker

If you would rather see every step:

```sh
# 1. the config files
cp deploy/env.prod.example  deploy/env.prod   && chmod 600 deploy/env.prod
cp deploy/caddy.env.example deploy/caddy.env  && chmod 600 deploy/caddy.env

# 2. the board password. Reads the password on stdin so it stays out of shell history, and
#    prints only the scrypt hash. Paste that into BOARD_ADMIN_PASSWORD_HASH in deploy/env.prod.
printf 'a long random string' | docker compose -f compose.prod.yaml run --rm --no-deps -T board password

# 3. edit deploy/caddy.env: BOARD_DOMAIN, ACME_EMAIL. Leave BOARD_UPSTREAM at board:4663 and
#    BOARD_ADMIN_IPS empty unless you want the writes pinned to a fixed address as well.

# 4. edit deploy/env.prod: BOARD_HOSTS must be the same hostname. This one is not optional —
#    see the note below.

# 5. check it parses before you start anything
docker compose -f compose.prod.yaml config -q

# 6. build (this runs the typecheck and the test suite) and start
docker compose -f compose.prod.yaml up -d --build

# 7. watch the certificate arrive
docker compose -f compose.prod.yaml logs -f caddy
```

What the production compose file does differently from `compose.yaml`:

- the board is **not** published on `0.0.0.0`. It is published on `127.0.0.1:4663` — for the SSH
  tunnel — and Caddy reaches it over the compose network as `board:4663`.
- `json-file` logging capped at `max-size: 10m`, `max-file: 5`, so each container tops out at
  50 MB of logs. Without this the board's feed fills the disk and takes the box down with it, and
  that is a slow enough failure that you will have forgotten about this file by the time it bites.
- 512 MB / 1 CPU for the board, 256 MB / 0.5 CPU for Caddy; `restart: unless-stopped`; a
  healthcheck on `/state`; `read_only: true` with a 64 MB tmpfs for `/tmp`; `cap_drop: ALL`;
  `no-new-privileges`.
- **`BOARD_HOSTS` in `deploy/env.prod` must name the public hostname.** The board refuses any
  request whose `Host` header it does not recognise — that is its DNS-rebinding fence, and out of
  the box it knows only `127.0.0.1`, `localhost`, `::1` and `0.0.0.0`. Caddy passes the client's
  `Host` through unchanged, which is correct and which means a request to `board.example.com`
  arrives at the board under that name and is refused until you list it. `bootstrap.sh` sets this
  from `BOARD_DOMAIN`; if you are doing it by hand, do not forget it.
- `env_file` uses `format: raw`. This matters: without it Docker Compose interpolates the file, so
  a bcrypt hash like `$2a$14$YoBi…` is read as a reference to an unset variable `$YoBi…` and gets
  blanked. Caddy is then handed a mangled hash and nobody can log in, with no error anywhere. This
  was hit and fixed, not theorised.

---

## The manual path, systemd

For a box without Docker. `MODE=systemd ./deploy/bootstrap.sh` does all of this:

```sh
# node 22 and caddy from their own repositories, then:
cd /opt/assay/app
npm ci && npm run typecheck && npm test && npm run build && npm prune --omit=dev

install -o root -g root -m 0644 deploy/assay.service /etc/systemd/system/assay.service
install -o root -g root -m 0644 deploy/assay-index.service /etc/systemd/system/assay-index.service
install -o root -g root -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/assay/caddy.env\n' > /etc/systemd/system/caddy.service.d/10-assay.conf

systemctl daemon-reload
systemctl enable --now assay assay-index
systemctl restart caddy
```

Set `BOARD_UPSTREAM=127.0.0.1:4663` in `/etc/assay/caddy.env` for this path — Caddy is on the
host, not on a container network.

The unit runs as `assay`, `NoNewPrivileges`, `ProtectSystem=strict` with `/var/lib/assay` as
the only writable path, `PrivateTmp`, an empty capability bounding set, `SystemCallFilter=@system-service`,
`Restart=on-failure`, and journald for logs. One knob is deliberately **not** set:
`MemoryDenyWriteExecute`, because V8 writes and then executes its own JIT pages and node will not
start with it on.

---

## The index

`assay-index` (the `index` container, or the `assay-index` unit) follows the chain and writes
`index.sqlite` next to `positions.json` in the same data directory. The board opens it read-only.

It is a cache of public data and nothing depends on it. Stop it, delete the file, mount the volume
somewhere else: the board reads its logs from RPC again, slower and just as correct. That is
deliberate — the moment a derived copy becomes load-bearing it can be wrong in a way nobody
notices, and the numbers on this page are the whole product.

```sh
docker compose -f compose.prod.yaml exec index assay index stats   # what it holds
docker compose -f compose.prod.yaml stop index                     # the board keeps working
```

Size to expect: about **45 MB per 400 000 blocks**, which is roughly half a day of this chain —
three gigabytes a month if nothing stops it. So both the container and the unit pass
`--keep 4000000`: anything more than four million blocks behind the head is dropped as it goes,
which settles at around 450 MB and is still ten times the window the board reads. Raise it if you
want more history for `rules`; set it to `0` to keep everything and watch the disk.
Holders are not in it — a chain-wide transfer log is seventeen events a block, about seven million
rows for that same window, which is not worth half a gigabyte to speed up a panel that is opened
for a handful of tokens.

---

## Access control

**The decision: the page is public to read, the four verbs that move money are behind a password
the application itself checks, and an SSH tunnel is the always-available way in.**

On a laptop the board's protection is that it binds loopback. On a VPS that is gone, and what is
left is a page that can pause the engine, resume it, close a position and edit a rule — the last
three of which have money on the other end.

An earlier version of this put HTTP basic auth at the proxy over everything. That was the wrong
shape twice over. It made the whole board private, including the launch feed and the track record,
which are the parts worth showing anyone. And it put the gate somewhere that cannot tell who is
behind it, so the operator's positions and P&L went to whoever had the shared password.

The gate is now in the application, where it can distinguish the two:

- **Anyone** may read the feed, the ribbon, the track record and `/healthz`.
- **Only a signed-in operator** sees positions, spend, the editable rules and the activity log, and
  only they may pause, resume, close or edit. The live event stream withholds those frames from
  everyone else rather than relying on the page not to render them.

The password is stored as a **scrypt** hash in `BOARD_ADMIN_PASSWORD_HASH` (N=32768, r=8, p=1, a
random 16-byte salt), generated by `assay password`, which reads the password on stdin so it never
enters shell history or the process list. A correct password mints a random 32-byte session token
held in memory and returned as an `HttpOnly; SameSite=Strict; Path=/` cookie, `Secure` whenever the
request arrived over https. Failed attempts back off per source address, doubling to a five-minute
cap, and a wrong password and an unconfigured one give the same answer — which of the two it is
tells an attacker something and tells you nothing you cannot read in your own logs. Sessions live
in memory only, so a restart signs everyone out.

**Its limits, plainly:** it is still one credential for one operator, so there is no audit trail
and nobody to revoke individually; a leaked password is full control of the board; sessions vanish
on restart, which is a feature until it is a nuisance; and none of it protects you from anyone with
root on the box, who has `PRIVATE_KEY` and does not need the board at all.

`BOARD_ADMIN_IPS` still exists and is now **empty by default**. Set it to pin the writes to a
static address as well as to the password; it only ever narrows. If your address is not static,
leave it empty and rely on the password, or use the tunnel, which does not pass through Caddy:

```sh
ssh -N -L 4663:127.0.0.1:4663 root@board.example.com
# then open http://127.0.0.1:4663 — full control, no proxy, no password
```

That tunnel is also the answer to "the strictest option". If you never want the board on the
public internet at all, delete the `caddy` service from `compose.prod.yaml`, close 80 and 443,
and use only the tunnel. You lose the certificate and the phone-friendly URL and you keep
everything else.

---

## PRIVATE_KEY on a machine you rent

`/etc/assay/env.prod` holds `PRIVATE_KEY` and it is a bearer token for money. On a VPS it sits
on a disk you do not own, in a hypervisor you do not control, on hardware you share with strangers.
Anyone with root on the box has it. So does anyone who can take a snapshot of the volume, anyone
with your provider's console, and your provider. `chmod 600` stops the other unprivileged processes
on the box and nothing else, and there is no configuration in this repository that changes any of
that.

The mitigation is the balance, not the file mode: **use a wallet created for this deployment and
funded with `SESSION_BUDGET_ETH` and nothing more.** The engine's four walls — the arm prompt, the
entry size, the position cap, the session budget — cap what a *bug* can lose. Only the wallet
balance caps what a *compromise* can lose, and it is the only one of the five that an attacker
cannot edit. Top it up deliberately; do not standing-order it. Treat the key as burned the day you
decommission the box, and never reuse a wallet that holds anything else.

Deploy with `PRIVATE_KEY=` empty first. Everything except live trading works without it, and a
week of watching the feed on a public box before there is anything to steal is a cheap week.

---

## Going live

`board --live` prints the signer, its balance and every limit, then waits for you to type `arm` on
stdin. That is a deliberate wall and it means a live board cannot be a fire-and-forget daemon.

Under Docker, `compose.prod.yaml` holds stdin open (`stdin_open: true`, `tty: true`), so:

```sh
# put the key in /etc/assay/env.prod first, then change the command to include --live:
#   command: ["board", "--live", "--port", "4663", "--host", "0.0.0.0"]
docker compose -f compose.prod.yaml up -d
docker attach assay-board          # read what it prints, then type: arm
# detach with ctrl-p ctrl-q — ctrl-c would stop the container
```

Under systemd there is no stdin, so a `--live` unit would read EOF, abort, and exit 0 looking like
a clean shutdown. `assay.service` therefore runs dry. If you want live on a Docker-less box,
run it by hand in `tmux`.

One thing to know either way: the session budget is per process. A container that crash-loops
resets it. That is one more reason the wallet balance is the real limit.

---

## Verify it is working

```sh
# 1. the certificate and the proxy, no credentials needed
curl -sI https://board.example.com/healthz | head -1        # HTTP/2 200
curl -s  https://board.example.com/healthz                  # ok

# 2. the page is not public
curl -so /dev/null -w '%{http_code}\n' https://board.example.com/    # 401

# 3. the page is yours
curl -so /dev/null -w '%{http_code}\n' -u ops:PASSWORD https://board.example.com/    # 200

# 4. the engine is actually reading the chain
curl -s -u ops:PASSWORD https://board.example.com/state | jq '{live, paused, rules}'

# 5. the control surface refuses from the wrong address.
#    Content-Type is required: the board rejects a write that is not JSON, which is how a
#    cross-site form is stopped before the Origin check even runs.
curl -s -X POST -u ops:PASSWORD -H 'Content-Type: application/json' -d '{}' \
  https://board.example.com/pause
# 403 control actions are restricted to BOARD_ADMIN_IPS ...   (unless you are on the allowlist)
# {"paused":true}                                             (if you are)

# 6. redirect and HSTS
curl -sI http://board.example.com/healthz | head -3          # 308 to https://
```

### Proving the SSE stream survives the proxy

This is the check worth doing properly, because a buffered stream does not look broken — it looks
like a chain with nothing happening on it, and you will blame the RPC.

```sh
curl -N --no-buffer -u ops:PASSWORD https://board.example.com/events \
  | while IFS= read -r line; do
      [ -n "$line" ] && printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$(printf '%s' "$line" | cut -c1-100)"
    done
```

Let it run for **thirty seconds**. What you should see:

```
21:25:01  data: {"kind":"hello","at":1788902701305,"live":false,"paused":true}
21:25:04  data: {"kind":"launch","at":1788902702777,"fire":false,"why":["pair is NVDA, not ETH", …
21:25:06  data: {"kind":"pulse","at":1788902706559,"paused":true,"spent":"0","open":0}
21:25:07  data: {"kind":"launch","at":1788902706257, …
21:25:16  data: {"kind":"pulse","at":1788902716562,"paused":true,"spent":"0","open":0}
```

Three things in that output are the proof, and all three have to hold:

1. **`hello` appears immediately**, not after a delay. The board writes it the moment the
   connection opens; if it is buffered you will not see it until something else forces a flush.
2. **the `pulse` lines are exactly 10 s apart on the wall clock in the left column.** The board
   emits a pulse every 10 s. Two pulses with a 10 s gap between their *arrival* times means each
   one was written straight through. Two pulses that arrive together — or a screen that stays
   blank and then dumps everything at once when you ctrl-c — is buffering.
3. **it is still open at 30 s.** A stream that dies at a round number (30 s, 60 s) and reconnects
   is a write or idle timeout somewhere, not the chain.

And the headers:

```sh
curl -sD- -o /dev/null --max-time 3 -u ops:PASSWORD -H 'Accept-Encoding: gzip' \
  https://board.example.com/events
```

- `content-type: text/event-stream` ✓
- `x-accel-buffering: no` ✓
- **no `content-encoding` header** ✓ — if you see `content-encoding: gzip` here, something is
  compressing the stream and it will arrive in clumps. The `encode` directive is deliberately
  absent from the `/events` route and `compression off` is set on that reverse_proxy transport.

Compare with the page, which *should* be compressed:

```sh
curl -sD- -o /dev/null -H 'Accept-Encoding: gzip' -u ops:PASSWORD https://board.example.com/ \
  | grep -i content-encoding      # content-encoding: gzip
```

---

## Logs

```sh
# docker
docker compose -f compose.prod.yaml logs -f board
docker compose -f compose.prod.yaml logs -f caddy
docker compose -f compose.prod.yaml logs --since 1h --tail 200 board

# caddy's access log is JSON on stdout
docker compose -f compose.prod.yaml logs caddy | grep '^{' | jq -c 'select(.status >= 400) | {ts, status, uri: .request.uri, ip: .request.remote_ip}'

# systemd
journalctl -u assay -f
journalctl -u caddy -f
journalctl -u assay --since '1 hour ago'
```

Both are capped: `json-file` at 10 MB × 5 per container, journald by `SystemMaxUse` in
`/etc/systemd/journald.conf`. Neither will fill the disk.

---

## Update

```sh
sudo /opt/assay/app/deploy/update.sh              # tip of the current branch
sudo /opt/assay/app/deploy/update.sh v0.2.0       # a tag, branch or commit
sudo /opt/assay/app/deploy/update.sh --rollback
```

What it does, in order: takes a backup; tags the running image `assay:prev` and records the
current commit in `/var/lib/assay/.last-good`; fetches; builds — which runs the typecheck and
the whole test suite, so a broken tree fails here while the old container is still serving; swaps; waits
for the healthcheck; and if the new one does not come up healthy within two minutes, rolls itself
back.

By hand, if you prefer:

```sh
cd /opt/assay/app
git fetch --all --tags && git reset --hard origin/master
docker compose -f compose.prod.yaml build board     # fails here if the tests fail
docker compose -f compose.prod.yaml up -d board
```

A restart drops the SSE connections; the page reconnects on its own. It also resets the session
budget counter, and — if you were live — you will have to `docker attach` and type `arm` again.
**Do not update while a position is open.**

---

## Backup

The only state that cannot be rebuilt from the repository is `positions.json` — the ledger. Losing
it does not lose the tokens, which are on chain and still yours; it loses the bookkeeping, so the
engine no longer knows it is holding them and will not manage or exit them.

```sh
sudo /opt/assay/app/deploy/backup.sh
# -> /var/backups/assay/assay-20260909T001500Z.tar.gz  (0600 root)
```

The archive holds `positions.json`, `env.prod`, `caddy.env`, the git commit and a manifest. It is
`0600` and it contains your private key, so if you copy it off the box, encrypt it.

Hourly, from cron:

```sh
echo '17 * * * * root /opt/assay/app/deploy/backup.sh --quiet' > /etc/cron.d/assay-backup
```

Thirty days are kept (`KEEP=30`). Restoring:

```sh
sudo /opt/assay/app/deploy/backup.sh --restore /var/backups/assay/assay-20260909T001500Z.tar.gz
```

That stops the board, puts the file back, and starts it again. Check the positions panel after.

Not backed up: Caddy's certificate store. Let's Encrypt will simply issue again on a new box. Copy
the `caddy_data` volume as well if you rebuild often enough to approach the rate limit — 50
certificates per registered domain per week.

---

## Roll back

```sh
sudo /opt/assay/app/deploy/update.sh --rollback
```

Under Docker this retags `assay:prev` back to `assay:prod` and restarts the container, which
takes about five seconds and does not need a rebuild. Under systemd it checks out the commit
recorded in `/var/lib/assay/.last-good` and rebuilds, which takes a couple of minutes.

To go back further than one version, check out the tag you want and run `update.sh` normally —
the version you are leaving becomes the new `prev`.

---

## What can go wrong

**The certificate never arrives; Caddy logs `could not get certificate from issuer`.**
Nine times in ten the `A` record does not point at this box, or something else already holds port
80 so the HTTP challenge cannot be answered. Check `dig +short board.example.com` against
`curl -s https://api.ipify.org` run on the box, and `ss -lntp | grep ':80'`. Let's Encrypt's
failure backoff lengthens with each attempt, so fix DNS *first* and then restart Caddy, rather
than restarting it in a loop while you debug. If you have burned the rate limit, point
`BOARD_DOMAIN` at a `.staging` subdomain to test and switch back.

**The page loads but the feed never moves.** Nothing arrives and the chain looks dead. Check the
board directly, past the proxy: `curl -sN --max-time 12 http://127.0.0.1:4663/events` on the box.
If events flow there and not through Caddy, it is the proxy: something is buffering or timing out.
Confirm no `content-encoding` on `/events`, confirm `flush_interval -1`, and confirm nothing else
is in front of Caddy — a CDN with the proxy switch on will buffer this stream even though Caddy
does not. If events do not flow on loopback either, it is the RPC; read the board's own logs.

**The feed dies at exactly 30 or 60 seconds, over and over.** A write or idle timeout. In this
Caddyfile both are 0 in the global `servers { timeouts { … } }` block. If you edited that block,
or you put nginx or a load balancer in front, that is where it is: nginx needs
`proxy_buffering off; proxy_read_timeout 1h;` and a cloud load balancer needs its idle timeout
raised well past 10 seconds.

**Signing in always says "wrong password" and the password is definitely right.** Check what the
board actually received: `docker compose -f compose.prod.yaml exec board printenv
BOARD_ADMIN_PASSWORD_HASH` — it must start with `scrypt$32768$8$1$` and have six `$`-separated
fields. If the `$…` sections are missing, `format: raw` has been removed from the `env_file` entry
in `compose.prod.yaml`, or the hash was pasted into a compose `environment:` block, where every `$`
must be doubled to `$$`. An empty value means no password is configured at all: the page will not
offer a sign-in and every control POST answers 401.

**Sign-in says "too many attempts".** The backoff doubles per failure per source address, to a
five-minute cap. Wait it out, or restart the board — the counters and the sessions are in memory.

**You were signed in and now you are not.** The board restarted. Sessions are deliberately not
persisted: a process that came back up after a crash should not have anyone still logged in.

**Every request through the proxy is `403 {"error":"unrecognised Host"}`, but the board answers
fine on `127.0.0.1:4663`.** `BOARD_HOSTS` does not include the public hostname. The board checks
the `Host` header on every request to stop DNS rebinding, and Caddy — correctly — forwards the
client's `Host` rather than rewriting it to `board:4663`. Add the name to `BOARD_HOSTS` in
`/etc/assay/env.prod` (comma-separated for several) and restart the board. Do not "fix" this at
the proxy with `header_up Host {upstream_hostport}`: that would make the board answer to any
hostname pointed at it, which is the thing the check exists to prevent.

**A control POST returns `403 {"error":"writes must be application/json"}`.** You sent it without
a content type — `curl -X POST` alone does that. Add `-H 'Content-Type: application/json' -d '{}'`.
The page itself always sets it.

**Every control click gives 403.** You are not in `BOARD_ADMIN_IPS`, which is exactly what it is
for. Check what Caddy sees as your address — `docker compose -f compose.prod.yaml logs caddy |
grep '"POST"' | tail -1 | jq .request.remote_ip` — and either add it, or use the SSH tunnel.
Remember a residential IP usually moves.

**The board container restarts every minute.** Read `docker compose -f compose.prod.yaml logs
board`. Two common causes: `/state` is not answering because the RPC is refusing every endpoint
(the healthcheck fails and `restart: unless-stopped` keeps trying), or the container is being
OOM-killed — `docker inspect assay-board --format '{{.State.OOMKilled}}'`. The 512 MB limit is
comfortable for the board; if it is genuinely hitting it, the deployer index has grown and the
limit in `compose.prod.yaml` needs raising, not removing.

**`docker compose up` says `deploy/env.prod` is required and missing.** `required: true` is
deliberate: starting without the env file would silently give you all defaults and no key. Copy
the example.

**Disk full.** Check `docker system df` before anything else — old images from repeated builds are
usually the culprit, not logs, because the logs are capped. `docker image prune -a --filter
'until=168h'`. Do not prune while `assay:prev` is the only rollback you have.

**A live session stopped firing and the logs say nothing.** The session budget is spent. It is per
process; a restart resets the counter and a crash-loop resets it repeatedly. Check
`curl -s -u ops:PASSWORD https://board.example.com/state | jq .spent`.

**You rebooted and the board came back paused.** It always does — the engine starts paused by
design and fires nothing until someone presses start. If you were live, it also lost the `arm`,
because `arm` is a decision, not a setting.
