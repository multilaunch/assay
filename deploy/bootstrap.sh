#!/usr/bin/env bash
# Take a fresh Ubuntu 24.04 box to a running assay deployment.
#
#   sudo BOARD_DOMAIN=board.example.com ACME_EMAIL=you@example.com ./deploy/bootstrap.sh
#
# Idempotent: run it again after a config change, a new release, or a half-finished first run.
# Non-interactive: it never prompts. Everything it needs comes from the environment below.
#
# Environment:
#   BOARD_DOMAIN   required   the hostname the certificate is for. DNS must already point here.
#   ACME_EMAIL     required   where Let's Encrypt sends expiry warnings.
#   MODE           docker     "docker" (compose + Caddy in containers) or "systemd" (node + Caddy
#                             as host services, no Docker).
#   ADMIN_IPS      ""         optional. When set, the proxy additionally pins control actions to
#                             these source addresses. The password gate is in the application and
#                             applies either way; this only ever narrows further.
#   APP_DIR        /opt/assay/app
#   REPO           ""         git URL to clone if this script is not already inside a checkout.
#   REF            ""         branch/tag/commit to check out. Empty = leave the checkout alone.
#   SKIP_FIREWALL  ""         set to 1 to leave ufw alone (e.g. the provider firewalls for you).
#   SKIP_START     ""         set to 1 to configure everything but not start the stack.
#
# What it does NOT do: fund a wallet, write PRIVATE_KEY, or start a live session. It leaves the
# board in dry run. Editing /etc/assay/env.prod is a decision, and it is yours.

set -euo pipefail

# ---- configuration ---------------------------------------------------------------------------
BOARD_DOMAIN="${BOARD_DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
MODE="${MODE:-docker}"
APP_DIR="${APP_DIR:-/opt/assay/app}"
ETC_DIR="${ETC_DIR:-/etc/assay}"
DATA_DIR="${DATA_DIR:-/var/lib/assay}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/assay}"
SERVICE_USER="${SERVICE_USER:-assay}"
REPO="${REPO:-}"
REF="${REF:-}"
SKIP_FIREWALL="${SKIP_FIREWALL:-}"
SKIP_START="${SKIP_START:-}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.10-alpine}"

# The directory this script lives in, and the checkout above it (if any).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

step()  { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
skip()  { printf '    \033[2m· %s\033[0m\n' "$*"; }
die()   { printf '\n\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

# ---- preflight -------------------------------------------------------------------------------
step "preflight"

[ "$(id -u)" -eq 0 ] || die "run this as root: sudo BOARD_DOMAIN=… ACME_EMAIL=… $0"
[ -n "$BOARD_DOMAIN" ] || die "BOARD_DOMAIN is required (the hostname the certificate is for)"
[ -n "$ACME_EMAIL" ] || die "ACME_EMAIL is required (Let's Encrypt expiry notices)"
case "$MODE" in
  docker|systemd) ;;
  *) die "MODE must be 'docker' or 'systemd', got '${MODE}'" ;;
esac

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "os            ${PRETTY_NAME:-unknown}"
  [ "${ID:-}" = "ubuntu" ] || info "note: written for Ubuntu 24.04; continuing anyway"
fi
info "mode          ${MODE}"
info "domain        ${BOARD_DOMAIN}"
info "app dir       ${APP_DIR}"

# An optional second fence in front of the writes. The first one is the board's own password.
ADMIN_IPS="${ADMIN_IPS:-}"
if [ -n "$ADMIN_IPS" ]; then
  info "admin ips     ${ADMIN_IPS} (control actions also pinned to these)"
else
  info "admin ips     not pinned; the board password is the gate"
fi

# DNS is not fatal — it is common to bootstrap while the record propagates — but say so loudly,
# because a wrong record is the single most common reason the certificate never arrives.
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent ahostsv4 "$BOARD_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')" || true
  public_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "${resolved:-}" ] && [ -n "${public_ip:-}" ] && [ "$resolved" != "$public_ip" ]; then
    info "WARNING: ${BOARD_DOMAIN} resolves to ${resolved}, this box looks like ${public_ip}."
    info "         Let's Encrypt will fail until the A record points here."
  elif [ -z "${resolved:-}" ]; then
    info "WARNING: ${BOARD_DOMAIN} does not resolve yet. The certificate will fail until it does."
  else
    info "dns           ${BOARD_DOMAIN} -> ${resolved}"
  fi
fi

export DEBIAN_FRONTEND=noninteractive

# ---- base packages ---------------------------------------------------------------------------
step "base packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git ufw unattended-upgrades apt-listchanges rsync jq tzdata
info "installed: ca-certificates curl gnupg git ufw unattended-upgrades rsync jq"

# ---- unattended security upgrades --------------------------------------------------------------
step "unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/51assay-unattended <<'EOF'
// Security updates only, applied automatically. Reboots are NOT automatic: a reboot in the
// middle of a live session would abandon open positions, so that stays a decision you make.
// /var/run/reboot-required tells you when one is pending.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
info "security updates on, automatic reboot off (see /var/run/reboot-required)"

# ---- firewall ------------------------------------------------------------------------------------
step "firewall"
if [ -n "$SKIP_FIREWALL" ]; then
  skip "SKIP_FIREWALL set, leaving ufw alone"
else
  # Allow SSH before enabling. Getting this order wrong locks you out of your own box.
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw allow 443/udp  >/dev/null
  ufw default deny incoming  >/dev/null
  ufw default allow outgoing >/dev/null
  if ufw status | head -1 | grep -q inactive; then
    ufw --force enable >/dev/null
    info "ufw enabled: 22, 80, 443 in; everything else denied"
  else
    info "ufw already active; rules reasserted (22, 80, 443)"
  fi
  # Docker publishes ports by writing its own iptables rules, which sit in front of ufw. The only
  # host-published board port in compose.prod.yaml is 127.0.0.1-bound, so nothing leaks past ufw
  # here — but if you ever change that publish to 0.0.0.0, ufw will not save you.
fi

# ---- user and directories --------------------------------------------------------------------
step "user and directories"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  skip "user ${SERVICE_USER} already exists"
else
  useradd --system --shell /usr/sbin/nologin --home-dir "$DATA_DIR" --create-home "$SERVICE_USER"
  info "created system user ${SERVICE_USER}"
fi

install -d -o root -g root            -m 0755 "$(dirname "$APP_DIR")"
install -d -o root -g "$SERVICE_USER" -m 0750 "$ETC_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
install -d -o root -g root            -m 0700 "$BACKUP_DIR"
info "app ${APP_DIR}   config ${ETC_DIR}   data ${DATA_DIR}   backups ${BACKUP_DIR}"

# ---- source --------------------------------------------------------------------------------------
step "source"
if [ "$(readlink -f "$SRC_DIR")" = "$(readlink -f "$APP_DIR")" ]; then
  skip "already running from ${APP_DIR}"
elif [ -d "${APP_DIR}/.git" ]; then
  info "existing checkout at ${APP_DIR}"
  if [ -n "$REF" ]; then
    git -C "$APP_DIR" fetch --all --tags --prune
    git -C "$APP_DIR" checkout --force "$REF"
    git -C "$APP_DIR" reset --hard "$REF"
    info "checked out ${REF}"
  fi
elif [ -d "${SRC_DIR}/.git" ] || [ -f "${SRC_DIR}/compose.prod.yaml" ]; then
  install -d -o root -g root -m 0755 "$APP_DIR"
  rsync -a --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
    --exclude 'data/' --exclude '.env' --exclude 'deploy/env.prod' --exclude 'deploy/caddy.env' \
    "${SRC_DIR}/" "${APP_DIR}/"
  info "copied the checkout at ${SRC_DIR} into ${APP_DIR}"
elif [ -n "$REPO" ]; then
  clone_args=(--depth 1)
  [ -n "$REF" ] && clone_args+=(--branch "$REF")
  git clone "${clone_args[@]}" "$REPO" "$APP_DIR"
  info "cloned ${REPO} into ${APP_DIR}"
else
  die "no source: run this from inside a assay checkout, or set REPO=<git url>"
fi
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# ---- secrets ---------------------------------------------------------------------------------
step "secrets"
if [ -f "${ETC_DIR}/env.prod" ]; then
  skip "${ETC_DIR}/env.prod exists, not touching it"
else
  install -o root -g "$SERVICE_USER" -m 0600 "${APP_DIR}/deploy/env.prod.example" "${ETC_DIR}/env.prod"
  info "wrote ${ETC_DIR}/env.prod from the example (PRIVATE_KEY empty: dry run)"
fi

# The board refuses any Host it does not recognise, and Caddy passes the client's Host through
# unchanged, so the public name has to be listed or every proxied request is a 403. Kept current
# on every run, because it is the one line in env.prod that depends on BOARD_DOMAIN.
if grep -q '^BOARD_HOSTS=' "${ETC_DIR}/env.prod"; then
  sed -i "s|^BOARD_HOSTS=.*|BOARD_HOSTS=${BOARD_DOMAIN}|" "${ETC_DIR}/env.prod"
else
  printf 'BOARD_HOSTS=%s\n' "$BOARD_DOMAIN" >> "${ETC_DIR}/env.prod"
fi
info "BOARD_HOSTS=${BOARD_DOMAIN}"

# The password hash needs a caddy binary, which does not exist yet on a first run. So this step
# only keeps the non-secret fields current; the password itself is done after the runtime install.
if [ -f "${ETC_DIR}/caddy.env" ] && ! grep -q 'REPLACE_ME' "${ETC_DIR}/caddy.env"; then
  sed -i "s|^BOARD_DOMAIN=.*|BOARD_DOMAIN=${BOARD_DOMAIN}|" "${ETC_DIR}/caddy.env"
  sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" "${ETC_DIR}/caddy.env"
  sed -i "s|^BOARD_ADMIN_IPS=.*|BOARD_ADMIN_IPS=${ADMIN_IPS}|" "${ETC_DIR}/caddy.env"
  info "refreshed domain, email and allowlist in ${ETC_DIR}/caddy.env"
else
  skip "no usable ${ETC_DIR}/caddy.env yet; one will be generated below"
fi

# ---- runtime: docker or node -------------------------------------------------------------------
if [ "$MODE" = "docker" ]; then
  step "docker engine"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    skip "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') with compose already installed"
  else
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.asc ]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    fi
    codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}}")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    info "installed docker $(docker version --format '{{.Server.Version}}')"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
else
  step "node 22"
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
    skip "node $(node -v) already installed"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs
    info "installed node $(node -v)"
  fi

  step "caddy (host package)"
  if command -v caddy >/dev/null 2>&1; then
    skip "caddy $(caddy version | head -1) already installed"
  else
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy
    info "installed caddy $(caddy version | head -1)"
  fi
fi

# ---- finish the caddy env now that a hashing tool exists ---------------------------------------
step "proxy config"
if [ "$MODE" = "docker" ]; then upstream="board:4663"; else upstream="127.0.0.1:4663"; fi
umask 077
cat > "${ETC_DIR}/caddy.env" <<EOF
BOARD_DOMAIN=${BOARD_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
BOARD_ADMIN_IPS=${ADMIN_IPS}
BOARD_UPSTREAM=${upstream}
EOF
chown root:root "${ETC_DIR}/caddy.env"
chmod 0600 "${ETC_DIR}/caddy.env"
info "domain ${BOARD_DOMAIN}, upstream ${upstream}"

step "board password"
# The page is public to read. This is the password for the controls, and it gates a process that
# can hold a private key, so it is hashed with scrypt by the application itself and the plaintext
# is written once to a root-only file.
if grep -q '^BOARD_ADMIN_PASSWORD_HASH=.\+' "${ETC_DIR}/env.prod" 2>/dev/null; then
  skip "already set — to rotate it, clear BOARD_ADMIN_PASSWORD_HASH in ${ETC_DIR}/env.prod and run this again"
else
  board_password="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  if [ "$MODE" = "docker" ]; then
    pw_hash="$(printf '%s' "$board_password" | docker run --rm -i --entrypoint node "$(docker compose -f "${APP_DIR}/compose.prod.yaml" --project-directory "$APP_DIR" config --images | head -1)" dist/cli/main.js password 2>/dev/null)"
  else
    pw_hash="$(printf '%s' "$board_password" | node "${APP_DIR}/dist/cli/main.js" password 2>/dev/null)"
  fi
  [ -n "$pw_hash" ] || die "could not hash the password; is the image built? re-run after the stack starts"

  if grep -q '^BOARD_ADMIN_PASSWORD_HASH=' "${ETC_DIR}/env.prod"; then
    sed -i "s|^BOARD_ADMIN_PASSWORD_HASH=.*|BOARD_ADMIN_PASSWORD_HASH=${pw_hash}|" "${ETC_DIR}/env.prod"
  else
    printf 'BOARD_ADMIN_PASSWORD_HASH=%s\n' "$pw_hash" >> "${ETC_DIR}/env.prod"
  fi

  printf 'board password: %s\n' "$board_password" > "${ETC_DIR}/board-credentials"
  chown root:root "${ETC_DIR}/board-credentials"
  chmod 0600 "${ETC_DIR}/board-credentials"

  info "generated a 32-character password"
  info "password  ${board_password}"
  info "also in   ${ETC_DIR}/board-credentials (0600 root)"
  info "the page itself is public; this only unlocks the controls"
fi

# ---- wire the config files the runtime expects -------------------------------------------------
step "config links"
ln -sfn "${ETC_DIR}/env.prod"  "${APP_DIR}/deploy/env.prod"
ln -sfn "${ETC_DIR}/caddy.env" "${APP_DIR}/deploy/caddy.env"
info "${APP_DIR}/deploy/{env.prod,caddy.env} -> ${ETC_DIR}/"
ls -l "${ETC_DIR}" | sed 's/^/    /'

# ---- start ------------------------------------------------------------------------------------
if [ -n "$SKIP_START" ]; then
  step "not starting (SKIP_START set)"
elif [ "$MODE" = "docker" ]; then
  step "build and start the stack"
  # the build runs the typecheck and the test suite; a broken tree stops here, not at 3am
  docker compose -f "${APP_DIR}/compose.prod.yaml" --project-directory "$APP_DIR" up -d --build
  info "waiting for the board to report healthy"
  for _ in $(seq 1 40); do
    state="$(docker inspect -f '{{.State.Health.Status}}' assay-board 2>/dev/null || echo starting)"
    [ "$state" = "healthy" ] && break
    sleep 3
  done
  info "board health: ${state:-unknown}"
  docker compose -f "${APP_DIR}/compose.prod.yaml" --project-directory "$APP_DIR" ps
else
  step "build and start the service"
  # dev deps for the typecheck, the tests and tsc; pruned back to runtime deps afterwards, so
  # what ends up on the box is the same three packages the Docker image ships.
  (
    cd "$APP_DIR"
    npm ci --no-audit --no-fund
    npm run typecheck
    npm test
    npm run build
    npm prune --omit=dev
  )
  chown -R root:root "$APP_DIR"
  install -o root -g root -m 0644 "${APP_DIR}/deploy/assay.service" /etc/systemd/system/assay.service
  install -o root -g root -m 0644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
  # caddy.service on Ubuntu does not read an env file by default
  install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/10-assay.conf <<EOF
[Service]
EnvironmentFile=${ETC_DIR}/caddy.env
EOF
  systemctl daemon-reload
  systemctl enable --now assay
  systemctl restart caddy
  systemctl --no-pager --lines=0 status assay caddy || true
fi

# ---- done ---------------------------------------------------------------------------------------
step "done"
cat <<EOF
    board      https://${BOARD_DOMAIN}/           (public to read)
    health     https://${BOARD_DOMAIN}/healthz    (public, says only "ok")
    controls   sign in on the page with the password above${ADMIN_IPS:+, and only from ${ADMIN_IPS}}
    tunnel     ssh -N -L 4663:127.0.0.1:4663 root@${BOARD_DOMAIN}  then http://127.0.0.1:4663

    The board is in DRY RUN. It has no key and will not sign anything.
    To go live, read docs/DEPLOY.md first, then put a key in ${ETC_DIR}/env.prod — a wallet
    funded with SESSION_BUDGET_ETH and nothing else.
EOF
