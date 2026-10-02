#!/usr/bin/env bash
# The production image's acceptance (Plan B, Task B4.2): build the image, start the stack of deploy/acceptance/compose.yml (the image, the
# stub as its Eneo, a Traefik in front), run the 16 checks of deploy/acceptance/checks.py, and remove what this started and nothing else.
#
#   deploy/acceptance.sh                   or, from frontend/, npm run test:image
#   deploy/acceptance.sh --only 4,5,9      the checks named
#   ACCEPT_IMAGE=stt-before ACCEPT_SKIP_BUILD=1 deploy/acceptance.sh --only 1,2,4   an image that exists (the baseline's, to see which checks can fail)
#
# Ports (127.0.0.1 only): ACCEPT_TRAEFIK_PORT 8480 (the module as a browser reaches it), ACCEPT_ENEO_PORT 8481, ACCEPT_DIRECT_PORT 8482.
# Check 6 runs Playwright from frontend/, which needs `npm ci` there; check 12 needs the second image this builds.
set -euo pipefail
cd "$(dirname "$0")/.."

export ACCEPT_TRAEFIK_PORT="${ACCEPT_TRAEFIK_PORT:-8480}" ACCEPT_ENEO_PORT="${ACCEPT_ENEO_PORT:-8481}" ACCEPT_DIRECT_PORT="${ACCEPT_DIRECT_PORT:-8482}"
export ACCEPT_IMAGE="${ACCEPT_IMAGE:-eneo-mod-speech-to-text:acceptance}"
export ACCEPT_REVIEW_IMAGE="${ACCEPT_REVIEW_IMAGE:-${ACCEPT_IMAGE}-review}"
export ACCEPT_MODULE_URL="http://127.0.0.1:${ACCEPT_TRAEFIK_PORT}" ACCEPT_ENEO_URL="http://127.0.0.1:${ACCEPT_ENEO_PORT}" ACCEPT_DIRECT_URL="http://127.0.0.1:${ACCEPT_DIRECT_PORT}"

compose=(docker compose -f deploy/acceptance/compose.yml -p stt-acceptance)
trap '"${compose[@]}" down --remove-orphans --timeout 10 >/dev/null 2>&1 || true' EXIT

if [ "${ACCEPT_SKIP_BUILD:-}" != 1 ]; then
  docker build -t "$ACCEPT_IMAGE" .
  docker build --build-arg SPEAKER_REVIEW_ENABLED=true -t "$ACCEPT_REVIEW_IMAGE" .
fi
"${compose[@]}" up -d
python3 deploy/acceptance/checks.py "$@"
