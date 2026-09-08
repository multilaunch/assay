#!/usr/bin/env bash
# Update a running deployment to a new version, and put the old one back if it does not come up.
#
#   sudo ./deploy/update.sh              update to the tip of the current branch
#   sudo ./deploy/update.sh v0.2.0       update to a tag, branch or commit
#   sudo ./deploy/update.sh --rollback   go back to the previous image / commit
#
# The safety here is mostly the Dockerfile's: the image runs `npm run typecheck` and the whole
# test suite at build time, so a broken tree fails during the build, while the old container is
# still serving. This script adds the two things the build cannot do — take a backup first, and
# check that the new container actually answers before declaring victory.

set -euo pipefail

MODE="${MODE:-auto}"
APP_DIR="${APP_DIR:-/opt/hoodterm/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/compose.prod.yaml}"
STATE_FILE="${STATE_FILE:-/var/lib/hoodterm/.last-good}"
HEALTH_TRIES="${HEALTH_TRIES:-40}"

step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

target="${1:-}"
rollback=""
[ "$target" = "--rollback" ] && { rollback=1; target=""; }

if [ "$MODE" = auto ]; then
  if command -v docker >/dev/null 2>&1 && docker compose -f "$COMPOSE_FILE" ps -q >/dev/null 2>&1; then
    MODE=docker
  else
    MODE=systemd
  fi
fi
info "mode ${MODE}"

dc() { docker compose -f "$COMPOSE_FILE" --project-directory "$APP_DIR" "$@"; }

wait_healthy() {
  local i state
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if [ "$MODE" = docker ]; then
      state="$(docker inspect -f '{{.State.Health.Status}}' hoodterm-board 2>/dev/null || echo missing)"
    else
      state="$(curl -fsS -o /dev/null -w ok http://127.0.0.1:4663/state 2>/dev/null || echo unhealthy)"
      [ "$state" = ok ] && state=healthy
    fi
    [ "$state" = healthy ] && { info "healthy after ${i} check(s)"; return 0; }
    sleep 3
  done
  info "still ${state:-unknown} after $((HEALTH_TRIES * 3))s"
  return 1
}

# ---- rollback -------------------------------------------------------------------------------------
if [ -n "$rollback" ]; then
  step "rollback"
  [ -f "$STATE_FILE" ] || die "no ${STATE_FILE}: nothing recorded to roll back to"
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  info "previous commit ${LAST_GOOD_COMMIT:-unknown}"
  if [ "$MODE" = docker ]; then
    docker image inspect hoodterm:prev >/dev/null 2>&1 || die "no hoodterm:prev image to roll back to"
    docker tag hoodterm:prev hoodterm:prod
    dc up -d --no-build board
  else
    [ -n "${LAST_GOOD_COMMIT:-}" ] || die "no commit recorded"
    git -C "$APP_DIR" checkout --force "$LAST_GOOD_COMMIT"
    ( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev )
    systemctl restart hoodterm
  fi
  wait_healthy || die "rollback did not come up either — read the logs"
  step "rolled back"
  exit 0
fi

# ---- back up first --------------------------------------------------------------------------------
step "backup"
if [ -x "${APP_DIR}/deploy/backup.sh" ]; then
  "${APP_DIR}/deploy/backup.sh" --quiet && info "ledger and config archived"
else
  info "deploy/backup.sh not found — continuing without a backup"
fi

# ---- record where we are ---------------------------------------------------------------------------
current_commit=""
[ -d "${APP_DIR}/.git" ] && current_commit="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ "$MODE" = docker ] && docker image inspect hoodterm:prod >/dev/null 2>&1; then
  docker tag hoodterm:prod hoodterm:prev
  info "tagged the running image hoodterm:prev"
fi
install -d -m 0750 "$(dirname "$STATE_FILE")"
printf 'LAST_GOOD_COMMIT=%s\n' "${current_commit:-}" > "$STATE_FILE"
chmod 0640 "$STATE_FILE"
info "recorded ${current_commit:-no git checkout}"

# ---- fetch ------------------------------------------------------------------------------------------
step "fetch"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "$APP_DIR" fetch --all --tags --prune
  if [ -n "$target" ]; then
    git -C "$APP_DIR" checkout --force "$target"
    git -C "$APP_DIR" reset --hard "$target"
  else
    branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
    git -C "$APP_DIR" reset --hard "origin/${branch}"
  fi
  info "now at $(git -C "$APP_DIR" rev-parse --short HEAD) $(git -C "$APP_DIR" log -1 --format=%s)"
else
  info "no git checkout at ${APP_DIR}; rebuilding whatever is on disk"
fi

# ---- build and swap ------------------------------------------------------------------------------
step "build and restart"
if [ "$MODE" = docker ]; then
  # the typecheck and the 45 tests run inside this build. If they fail, nothing has been swapped.
  dc build board || die "build failed — the running container was not touched"
  dc up -d board
  dc up -d caddy
else
  ( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run build && npm prune --omit=dev ) \
    || die "build or tests failed — the running service was not restarted"
  chown -R root:root "$APP_DIR"
  systemctl restart hoodterm
fi

step "verify"
if wait_healthy; then
  step "updated"
  info "if the page misbehaves anyway: sudo ${APP_DIR}/deploy/update.sh --rollback"
else
  printf '\n\033[31mthe new version is not healthy — rolling back\033[0m\n'
  exec "$0" --rollback
fi
