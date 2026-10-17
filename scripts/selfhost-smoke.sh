#!/usr/bin/env bash
# Smoke test of the self-hosted image (docs/self-host.md): build it, run it with a temp data folder
# and no network, check /healthz and /api/identity from inside the container, check that a clean
# `docker stop` closes the database, and that a second start applies no migrations. Exit non-zero on
# any failure. Usage (from the repo root):
#
#   scripts/selfhost-smoke.sh                 # native platform (fast; arm64 on an Apple Mac)
#   PLATFORM=linux/amd64 scripts/selfhost-smoke.sh   # the homelab's platform (slow under emulation)
#   IMAGE=maktab:local SKIP_BUILD=1 scripts/selfhost-smoke.sh   # an image built already
set -euo pipefail

IMAGE=${IMAGE:-maktab:smoke}
NAME=maktab-smoke-$$
DATA=$(mktemp -d "${TMPDIR:-/tmp}/maktab-smoke.XXXXXX")
PLATFORM_ARGS=()
if [ -n "${PLATFORM:-}" ]; then PLATFORM_ARGS=(--platform "$PLATFORM"); fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files in DATA belong to the container's uid; remove them from inside a throwaway container.
  docker run --rm ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --network none -v "$DATA:/data" --user 0 --entrypoint sh "$IMAGE" \
    -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true' >/dev/null 2>&1 || true
  rmdir "$DATA" 2>/dev/null || rm -rf "$DATA" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -40 >&2 || true
  exit 1
}

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "== build $IMAGE ${PLATFORM:-(native)}"
  docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -t "$IMAGE" --build-arg MAKTAB_VERSION=smoke .
fi

# The image runs as uid 1000; a fresh temp dir is the caller's, so open it up for the test only.
chmod 0777 "$DATA"

run() {
  docker run -d ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --name "$NAME" --network none -v "$DATA:/data" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -e SESSION_SECRET="smoke-session-secret-0123456789abcdef0123456789" \
    -e PARENT_LINK_SECRET="smoke-parent-secret-0123456789abcdef0123456789" \
    -e APP_ORIGIN="https://maktab.example" \
    -e OWNER_EMAIL="owner@example.com" \
    "$IMAGE" >/dev/null
}

inside() { # path -> "<status> <body>" fetched from inside the container (no network: loopback only)
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:8787$1').then(async r=>{console.log(r.status+' '+(await r.text()))}).catch(e=>{console.log('000 '+e.message);process.exit(1)})"
}

wait_healthy() {
  for _ in $(seq 1 30); do
    if out=$(inside /healthz 2>/dev/null) && [ "${out%% *}" = 200 ]; then echo "$out"; return 0; fi
    sleep 1
  done
  return 1
}

echo "== first start"
run
health=$(wait_healthy) || fail "/healthz never answered 200"
echo "/healthz -> $health"
case "$health" in *'"db":"ok"'*'"version":'*|*'"version":'*'"db":"ok"'*) ;; *) fail "unexpected /healthz body: $health" ;; esac

identity=$(inside /api/identity) || fail "/api/identity request failed"
echo "/api/identity -> $identity"
[ "${identity%% *}" = 200 ] || fail "/api/identity status ${identity%% *}"

index=$(inside /) || fail "/ request failed"
[ "${index%% *}" = 200 ] || fail "/ status ${index%% *}"
case "$index" in *'<div id="root">'*) ;; *) fail "/ is not the SPA" ;; esac

sched=$(inside /__scheduled) || true
[ "${sched%% *}" = 404 ] || fail "/__scheduled answered ${sched%% *}, expected 404"

docker logs "$NAME" 2>&1 | grep -q 'database ok: 2[0-9] migration(s) applied now' || fail "migrations were not applied on first start"
if docker logs "$NAME" 2>&1 | grep -E 'SESSION_SECRET=|PARENT_LINK_SECRET=|smoke-session-secret|smoke-parent-secret'; then
  fail "a secret appeared in the logs"
fi

echo "== docker stop (SIGTERM via tini)"
docker stop -t 20 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] || fail "exit code $code after docker stop"
docker logs "$NAME" 2>&1 | grep -q 'SIGTERM: shutting down' || fail "no clean shutdown in the logs"
docker rm "$NAME" >/dev/null

echo "== second start (same data)"
run
wait_healthy >/dev/null || fail "/healthz never answered 200 on the second start"
docker logs "$NAME" 2>&1 | grep -q 'database ok: 0 migration(s) applied now' || fail "second start re-applied migrations"

echo "== refuses DEMO_MODE"
docker rm -f "$NAME" >/dev/null
if docker run --rm ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --network none -v "$DATA:/data" -e DEMO_MODE=1 \
  -e SESSION_SECRET="smoke-session-secret-0123456789abcdef0123456789" -e APP_ORIGIN="https://maktab.example" \
  "$IMAGE" >/dev/null 2>&1; then
  fail "started with DEMO_MODE=1"
fi

echo "OK: self-hosted image smoke passed ($IMAGE ${PLATFORM:-native})"
