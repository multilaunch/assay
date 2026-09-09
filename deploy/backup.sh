#!/usr/bin/env bash
# Back up the only state that cannot be rebuilt from the repository.
#
#   sudo ./deploy/backup.sh                    one backup, into /var/backups/assay
#   sudo ./deploy/backup.sh --restore <file>   put a positions.json back
#
# Runs from cron safely (it is quiet unless something is wrong):
#   echo '17 * * * * root /opt/assay/app/deploy/backup.sh --quiet' > /etc/cron.d/assay-backup
#
# What is backed up:
#   positions.json   the ledger. Losing it means the engine forgets what it is holding, so on the
#                    next start it will not manage or exit those positions. The tokens are still
#                    yours on chain; the bookkeeping is what is gone.
#   env.prod         holds PRIVATE_KEY. Encrypted at rest is your problem, not this script's —
#                    the archive is 0600 root and that is all it claims.
#   caddy.env        the password hash and the allowlist.
#
# NOT backed up: the Caddy certificate store. Let's Encrypt will simply issue again on a new box.
# Copy the caddy_data volume too if you are rebuilding often enough to hit the rate limit
# (50 certificates per registered domain per week).

set -euo pipefail

MODE="${MODE:-auto}"
APP_DIR="${APP_DIR:-/opt/assay/app}"
ETC_DIR="${ETC_DIR:-/etc/assay}"
DATA_DIR="${DATA_DIR:-/var/lib/assay}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/assay}"
KEEP="${KEEP:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/compose.prod.yaml}"
VOLUME="${VOLUME:-assay_positions}"

quiet=""
restore=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet)   quiet=1 ;;
    --restore) restore="${2:-}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say() { [ -n "$quiet" ] || printf '%s\n' "$*"; }
die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

# Which install is this? Docker if the compose stack has a board container.
if [ "$MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1 && docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    MODE=docker
  else
    MODE=systemd
  fi
fi

# ---- restore ------------------------------------------------------------------------------------
if [ -n "$restore" ]; then
  [ -f "$restore" ] || die "no such file: ${restore}"
  say "restoring positions.json from ${restore}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if [ "${restore##*.}" = "gz" ] || [ "${restore##*.}" = "tgz" ]; then
    tar -xzf "$restore" -C "$tmp"
    src="$(find "$tmp" -name positions.json -print -quit)"
  else
    src="$restore"
  fi
  [ -n "${src:-}" ] && [ -f "$src" ] || die "no positions.json inside ${restore}"

  if [ "$MODE" = docker ]; then
    docker compose -f "$COMPOSE_FILE" --project-directory "$APP_DIR" stop board
    docker run --rm -v "${VOLUME}:/data" -v "$(dirname "$src"):/in:ro" alpine:3 \
      sh -c 'cp /in/positions.json /data/positions.json && chown 1000:1000 /data/positions.json'
    docker compose -f "$COMPOSE_FILE" --project-directory "$APP_DIR" start board
  else
    systemctl stop assay
    install -o assay -g assay -m 0640 "$src" "${DATA_DIR}/positions.json"
    systemctl start assay
  fi
  say "restored. The engine re-reads the ledger on start; check the board's positions panel."
  exit 0
fi

# ---- back up ------------------------------------------------------------------------------------
install -d -o root -g root -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
install -d -m 0700 "${work}/assay-${stamp}"
out="${work}/assay-${stamp}"

if [ "$MODE" = docker ]; then
  # Read the ledger out of the named volume without stopping the board. positions.json is
  # rewritten whole, so the worst case is catching the previous version, never a torn file.
  docker run --rm -v "${VOLUME}:/data:ro" -v "${out}:/out" alpine:3 \
    sh -c 'cp -a /data/positions.json /out/ 2>/dev/null || echo "no positions.json yet" >&2' || true
else
  [ -f "${DATA_DIR}/positions.json" ] && cp -a "${DATA_DIR}/positions.json" "${out}/" || true
fi

for f in env.prod caddy.env; do
  [ -f "${ETC_DIR}/${f}" ] && cp -a "${ETC_DIR}/${f}" "${out}/" || true
done

if [ -d "${APP_DIR}/.git" ]; then
  git -C "$APP_DIR" rev-parse HEAD > "${out}/GIT_COMMIT" 2>/dev/null || true
fi
printf 'mode=%s\nhost=%s\nat=%s\n' "$MODE" "$(hostname)" "$stamp" > "${out}/MANIFEST"

archive="${BACKUP_DIR}/assay-${stamp}.tar.gz"
tar -czf "$archive" -C "$work" "assay-${stamp}"
chmod 0600 "$archive"
say "wrote ${archive} ($(du -h "$archive" | cut -f1))"

# ---- prune --------------------------------------------------------------------------------------
# -mtime is days; KEEP is the number of days to hold.
find "$BACKUP_DIR" -maxdepth 1 -name 'assay-*.tar.gz' -mtime "+${KEEP}" -print -delete \
  | while read -r old; do say "pruned ${old}"; done
