#!/usr/bin/env bash
# Runs a command that installs system packages with apt (npx playwright install-deps, install --with-deps, apt-get install)
# in up to three tries of three minutes each; the browsers' system libraries take about 30 s. apt's own timeouts
# (apt.conf, put in apt's settings first) cut a download that stalls, but not a mirror that trickles: one sent about
# 40 kB/s and held a gate job until the step's timeout. A try that is cut off can leave dpkg half done, which is finished
# before the next; what was downloaded stays in apt's cache.
#
#   run: ${{ github.workspace }}/.github/apt-retry.sh npx playwright install-deps chromium
set -u
sudo cp "$(dirname "$0")/apt.conf" /etc/apt/apt.conf.d/99-ci
for try in 1 2 3; do
  # SIGTERM, which sudo passes on to apt; SIGKILL 20 s later if it is still running.
  timeout --kill-after=20 180 "$@" && exit 0
  echo "::warning::$*: try $try of 3 failed or ran out of time"
  sudo dpkg --configure -a
done
exit 1
