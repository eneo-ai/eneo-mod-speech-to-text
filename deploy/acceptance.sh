#!/usr/bin/env bash
# The production image's acceptance: build the image, start the stack of deploy/acceptance/compose.yml (the image, the
# stub as its Eneo, a Traefik in front), run the 16 checks of deploy/acceptance/checks.py, and remove what this started and nothing else.
#
#   deploy/acceptance.sh                   or, from frontend/, npm run test:image
#   deploy/acceptance.sh --only 4,5,9      the checks named
#   ACCEPT_IMAGE=stt-before ACCEPT_SKIP_BUILD=1 deploy/acceptance.sh --only 1,2,4   an image that exists already, to see which checks can fail
#
# Ports (127.0.0.1 only): ACCEPT_TRAEFIK_PORT 8480 (the module as a browser reaches it), ACCEPT_ENEO_PORT 8481, ACCEPT_DIRECT_PORT 8482.
# Check 6 runs Playwright from frontend/, which needs `npm ci` there; check 12 needs the second image this builds (with
# ACCEPT_SKIP_BUILD=1 both images must exist: ACCEPT_IMAGE, and ACCEPT_REVIEW_IMAGE, built with SPEAKER_REVIEW_ENABLED=true).
set -euo pipefail
cd "$(dirname "$0")/.."

export ACCEPT_TRAEFIK_PORT="${ACCEPT_TRAEFIK_PORT:-8480}" ACCEPT_ENEO_PORT="${ACCEPT_ENEO_PORT:-8481}" ACCEPT_DIRECT_PORT="${ACCEPT_DIRECT_PORT:-8482}"
export ACCEPT_IMAGE="${ACCEPT_IMAGE:-eneo-mod-speech-to-text:acceptance}"
export ACCEPT_REVIEW_IMAGE="${ACCEPT_REVIEW_IMAGE:-eneo-mod-speech-to-text:acceptance-review}"
export ACCEPT_MODULE_URL="http://127.0.0.1:${ACCEPT_TRAEFIK_PORT}" ACCEPT_ENEO_URL="http://127.0.0.1:${ACCEPT_ENEO_PORT}" ACCEPT_DIRECT_URL="http://127.0.0.1:${ACCEPT_DIRECT_PORT}"
# The module is told where the browser reaches it and Eneo (acceptance.env has the default ports).
export MODULE_PUBLIC_URL="$ACCEPT_MODULE_URL" ENEO_PUBLIC_URL="$ACCEPT_ENEO_URL"

compose=(docker compose --env-file deploy/acceptance/acceptance.env -f docker-compose.yml -f deploy/acceptance/compose.yml -p stt-acceptance)
trap '"${compose[@]}" down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true' EXIT

if [ "${ACCEPT_SKIP_BUILD:-}" != 1 ]; then
  docker build -t "$ACCEPT_IMAGE" .
  docker build --build-arg SPEAKER_REVIEW_ENABLED=true -t "$ACCEPT_REVIEW_IMAGE" .
fi
"${compose[@]}" up -d --wait
python3 deploy/acceptance/checks.py "$@"
