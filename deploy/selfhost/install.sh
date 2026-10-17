#!/usr/bin/env bash
# Installs or upgrades one self-hosted Maktab school on this server (docs/self-host.md).
# Run it as the homelab user (uid 1000, in the `docker` group); no sudo needed. Idempotent: safe to
# re-run after `git pull` (it rebuilds and restarts; data and .env are kept).
#
#   deploy/selfhost/install.sh [instance]        # default instance: gsap
#
# Environment: STACK_DIR (default /srv/homelab/maktab), NO_START=1 (prepare folders only),
# ALLOW_ANY_UID=1 (tests on a machine whose user is not uid 1000).
#
# What it does:
#   1. copies deploy/selfhost/docker-compose.yml to $STACK_DIR (a changed one is backed up first);
#   2. creates $STACK_DIR/<instance>/ (0700) and <instance>/data/ (0700), owned by uid 1000, the
#      image's user;
#   3. first run only: creates <instance>/.env (0600) from .env.example with fresh random
#      SESSION_SECRET and PARENT_LINK_SECRET (never printed or passed as arguments) and
#      TRUST_PROXY_FROM = the `homelab` network's subnet, then stops so you can fill it in;
#      an existing .env is never touched;
#   4. records where the source is (MAKTAB_SRC in $STACK_DIR/.env) unless it is $STACK_DIR/src;
#   5. tags the running image maktab-<instance>:previous (the rollback, docs/self-host.md §6), then
#      docker compose build + up -d, and prints /healthz from inside the container.
set -euo pipefail

INSTANCE=${1:-${INSTANCE:-gsap}}
STACK_DIR=${STACK_DIR:-/srv/homelab/maktab}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)

die() { echo "install.sh: $*" >&2; exit 1; }

case "$INSTANCE" in
  *[!a-z0-9-]* | '' | -*) die "instance must be lower-case letters, digits and '-': $INSTANCE" ;;
esac
for c in docker openssl; do command -v "$c" >/dev/null || die "$c is not installed"; done
if [ "$(id -u)" != 1000 ] && [ "$(id -u)" != 0 ] && [ -z "${ALLOW_ANY_UID:-}" ]; then
  die "run this as the homelab user (uid 1000; the container's user), not uid $(id -u)"
fi
docker info >/dev/null 2>&1 || die "cannot reach Docker: add this user to the docker group (then log in again)"
docker network inspect homelab >/dev/null 2>&1 ||
  die "the external Docker network 'homelab' does not exist (docker network create homelab)"

mkdir -p "$STACK_DIR"
if [ -f "$STACK_DIR/docker-compose.yml" ] && ! cmp -s "$HERE/docker-compose.yml" "$STACK_DIR/docker-compose.yml"; then
  cp "$STACK_DIR/docker-compose.yml" "$STACK_DIR/docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
  echo "updated docker-compose.yml (previous copy kept as .bak)"
fi
cp "$HERE/docker-compose.yml" "$STACK_DIR/docker-compose.yml"

# Where the image is built from. $STACK_DIR/src (a clone there) needs no setting.
if [ "$(cd "$STACK_DIR" && pwd)/src" != "$SRC" ]; then
  touch "$STACK_DIR/.env"
  grep -v '^MAKTAB_SRC=' "$STACK_DIR/.env" > "$STACK_DIR/.env.tmp" || true
  printf 'MAKTAB_SRC=%s\n' "$SRC" >> "$STACK_DIR/.env.tmp"
  mv "$STACK_DIR/.env.tmp" "$STACK_DIR/.env"
fi

INST="$STACK_DIR/$INSTANCE"
mkdir -p "$INST/data"
chmod 0700 "$INST" "$INST/data"

if [ ! -f "$INST/.env" ]; then
  umask 077
  secret() { openssl rand -base64 64 | tr -d '\n/+=' | cut -c1-48; }
  session=$(secret)
  parent=$(secret)
  [ "${#session}" -ge 32 ] && [ "${#parent}" -ge 32 ] || die "could not generate secrets (openssl rand)"
  subnets=$(docker network inspect homelab -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | xargs | tr ' ' ',')
  # printf is a shell builtin: the secrets never appear on a command line (ps) or in sed scripts.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      SESSION_SECRET=*) printf 'SESSION_SECRET=%s\n' "$session" ;;
      PARENT_LINK_SECRET=*) printf 'PARENT_LINK_SECRET=%s\n' "$parent" ;;
      TRUST_PROXY_FROM=*) printf 'TRUST_PROXY_FROM=%s\n' "$subnets" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$HERE/.env.example" > "$INST/.env"
  unset session parent
  chmod 0600 "$INST/.env"
  echo "created $INST/.env (new random secrets; TRUST_PROXY_FROM=$subnets)."
  echo "Fill in APP_ORIGIN, OWNER_EMAIL, GOOGLE_CLIENT_ID/SECRET and AGE_RECIPIENT, then run this again."
  [ "$(id -u)" = 0 ] && chown -R 1000:1000 "$STACK_DIR"
  exit 0
fi

# The server refuses to start without these; say so here instead of in a restart loop.
grep -Eq '^AGE_RECIPIENT=age1' "$INST/.env" || grep -Eq '^ALLOW_UNENCRYPTED_BACKUPS=1$' "$INST/.env" ||
  die "set AGE_RECIPIENT (the backup public key, age1...) in $INST/.env first"

# Everything in the stack belongs to the homelab user (uid 1000), which is also the container's.
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$STACK_DIR"; else
  owner=$(stat -c %u "$INST/data" 2>/dev/null || stat -f %u "$INST/data")
  [ "$owner" = "$(id -u)" ] || echo "warning: $INST/data is owned by uid $owner; fix with: sudo chown -R 1000:1000 $STACK_DIR" >&2
fi

if [ -n "${NO_START:-}" ]; then echo "prepared $INST (NO_START set)"; exit 0; fi

VERSION=$(git -C "$SRC" describe --always --dirty 2>/dev/null || echo dev)
IMAGE="maktab-$INSTANCE:local"
# The image running now becomes :previous, the one-command rollback (docs/self-host.md §6).
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker image tag "$IMAGE" "maktab-$INSTANCE:previous"
  echo "tagged the current image as maktab-$INSTANCE:previous"
fi
cd "$STACK_DIR"
export INSTANCE MAKTAB_VERSION="$VERSION"
docker compose build
docker compose up -d
NAME="maktab-$INSTANCE"
for _ in $(seq 1 30); do
  if out=$(docker exec "$NAME" node -e "fetch('http://127.0.0.1:8787/healthz').then(async r=>{console.log(r.status+' '+(await r.text()));process.exit(r.ok?0:1)},()=>process.exit(1))" 2>/dev/null); then
    echo "healthz: $out"
    exit 0
  fi
  sleep 2
done
echo "healthz did not answer 200; recent logs:" >&2
docker logs --tail 40 "$NAME" >&2 || true
exit 1
