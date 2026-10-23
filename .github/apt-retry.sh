#!/usr/bin/env bash
# Installs system packages with apt in CI, in up to three tries:
#
#   run: ${{ github.workspace }}/.github/apt-retry.sh pulseaudio
#   run: ${{ github.workspace }}/.github/apt-retry.sh --playwright chromium webkit firefox
#
# --playwright installs the system libraries the browsers of the locked Playwright need: the packages
# `npx playwright install-deps --dry-run <browsers>` lists as missing, so it runs where that Playwright is installed.
#
# Each try runs apt-get update (one minute) and apt-get install (three minutes; the 119 MB of all three browsers' libraries
# take under a minute from a healthy mirror) as `sudo timeout`, so apt-get itself is what a timeout stops: SIGTERM to
# apt-get and the dpkg it started, SIGKILL 20 s later. Try 1 uses the runner's mirror list, /etc/apt/apt-mirrors.txt, which
# ubuntu.sources reads through mirror+file:. Tries 2 and 3 replace it with archive.ubuntu.com and then
# mirrors.edge.kernel.org (or, without that wiring, set ubuntu.sources' URIs to them): a mirror that sends a few kB/s
# finishes no try. Before the next try no apt-get or dpkg is left running and dpkg finishes what it had begun; what was
# downloaded stays in apt's cache. apt.conf, put in apt's settings first, gives up a download that stalls.
# APT_ETC (default /etc/apt) is for apt-retry.test.sh.
set -u
etc=${APT_ETC:-/etc/apt}
sources=$etc/sources.list.d/ubuntu.sources
mirrors=("" http://archive.ubuntu.com/ubuntu http://mirrors.edge.kernel.org/ubuntu)
sudo cp "$(dirname "$0")/apt.conf" "$etc/apt.conf.d/99-ci"

use_mirror() {
  if grep -qF "mirror+file:$etc/apt-mirrors.txt" "$sources"; then
    printf '%s\tpriority:1\n' "$1" | sudo tee "$etc/apt-mirrors.txt" >/dev/null
  else
    sed "s#^URIs: .*#URIs: $1#" "$sources" | sudo tee "$sources.new" >/dev/null && sudo mv "$sources.new" "$sources"
  fi
}

try_install() {
  sudo timeout -k 20 60 apt-get update || return 1
  local packages=("$@") report
  if [ "$1" = --playwright ]; then
    # Playwright 1.63 prints "Missing system dependencies (N):" and then one package a line, indented by two spaces, and
    # exits 1; or "All system dependencies are installed." and exits 0.
    report=$(npx playwright install-deps --dry-run "${@:2}")
    grep -qx 'All system dependencies are installed.' <<<"$report" && return 0
    read -ra packages <<<"$(sed -n 's/^  \([^ ][^ ]*\)$/\1/p' <<<"$report" | tr '\n' ' ')"
    [ "${#packages[@]}" -gt 0 ] || { echo "$report"; return 1; }
  fi
  sudo timeout -k 20 180 apt-get install -y --no-install-recommends "${packages[@]}"
}

for try in 1 2 3; do
  if [ "$try" -gt 1 ]; then
    sudo pkill -KILL -x 'apt-get|dpkg'
    while pgrep -x 'apt-get|dpkg' >/dev/null; do sleep 1; done
    sudo dpkg --configure -a
    use_mirror "${mirrors[try - 1]}"
  fi
  try_install "$@" && exit 0
  echo "::warning::apt-retry.sh $*: try $try of 3 failed or ran out of time"
done
exit 1
