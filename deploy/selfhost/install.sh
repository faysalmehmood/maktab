#!/usr/bin/env bash
# Installs or upgrades one self-hosted Maktab school on this server (docs/self-host.md).
# Idempotent: safe to re-run after `git pull` (it rebuilds and restarts; data and .env are kept).
#
#   deploy/selfhost/install.sh [instance]        # default instance: gsap
#
# Environment: STACK_DIR (default /srv/homelab/maktab), NO_START=1 (prepare folders only).
#
# What it does:
#   1. copies deploy/selfhost/docker-compose.yml to $STACK_DIR (a changed one is backed up first);
#   2. creates $STACK_DIR/<instance>/ (0700) and <instance>/data/ owned by uid 1000 (the image's user);
#   3. creates <instance>/.env (0600) from .env.example if missing, with fresh random
#      SESSION_SECRET and PARENT_LINK_SECRET (never printed); an existing .env is never touched;
#   4. records where the source is (MAKTAB_SRC in $STACK_DIR/.env) unless it is $STACK_DIR/src;
#   5. docker compose build + up -d, then prints /healthz from inside the container.
set -euo pipefail

INSTANCE=${1:-${INSTANCE:-gsap}}
STACK_DIR=${STACK_DIR:-/srv/homelab/maktab}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)

case "$INSTANCE" in
  *[!a-z0-9-]* | '' | -*) echo "instance must be lower-case letters, digits and '-': $INSTANCE" >&2; exit 2 ;;
esac

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker network inspect homelab >/dev/null 2>&1 || {
  echo "the external Docker network 'homelab' does not exist (docker network create homelab)" >&2
  exit 1
}

mkdir -p "$STACK_DIR"
if [ -f "$STACK_DIR/docker-compose.yml" ] && ! cmp -s "$HERE/docker-compose.yml" "$STACK_DIR/docker-compose.yml"; then
  cp "$STACK_DIR/docker-compose.yml" "$STACK_DIR/docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
  echo "updated docker-compose.yml (previous copy kept as .bak)"
fi
cp "$HERE/docker-compose.yml" "$STACK_DIR/docker-compose.yml"

# Where the image is built from. $STACK_DIR/src (a clone there) needs no setting.
if [ "$(cd "$STACK_DIR" && pwd)/src" != "$SRC" ]; then
  touch "$STACK_DIR/.env"
  if grep -q '^MAKTAB_SRC=' "$STACK_DIR/.env"; then
    sed -i.bak "s|^MAKTAB_SRC=.*|MAKTAB_SRC=$SRC|" "$STACK_DIR/.env" && rm -f "$STACK_DIR/.env.bak"
  else
    echo "MAKTAB_SRC=$SRC" >> "$STACK_DIR/.env"
  fi
fi

INST="$STACK_DIR/$INSTANCE"
mkdir -p "$INST/data"
chmod 0700 "$INST"
if [ ! -f "$INST/.env" ]; then
  umask 077
  secret() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(secret)|" \
      -e "s|^PARENT_LINK_SECRET=.*|PARENT_LINK_SECRET=$(secret)|" \
      "$HERE/.env.example" > "$INST/.env"
  chmod 0600 "$INST/.env"
  echo "created $INST/.env with new random secrets: fill APP_ORIGIN, OWNER_EMAIL, GOOGLE_CLIENT_ID/SECRET, AGE_RECIPIENT"
fi
# The container runs as uid 1000 (the image's `node` user).
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$INST/data"; else
  [ "$(stat -c %u "$INST/data" 2>/dev/null || stat -f %u "$INST/data")" = 1000 ] ||
    echo "warning: $INST/data is not owned by uid 1000; run: sudo chown -R 1000:1000 $INST/data" >&2
fi
chmod 0700 "$INST/data"

if [ -n "${NO_START:-}" ]; then echo "prepared $INST (NO_START set)"; exit 0; fi

VERSION=$(git -C "$SRC" describe --always --dirty 2>/dev/null || echo dev)
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
