#!/usr/bin/env bash
# Tests apt-retry.sh with stand-ins for sudo, timeout, apt-get, npx, dpkg, pkill and pgrep and an /etc/apt of its own.
# The stand-in timeout signals only its direct child, after one second, and SIGKILLs it a second later; the stand-in
# apt-get that hangs ignores SIGTERM and records itself as the dpkg lock's holder, and every apt-get refuses to run while
# that holder lives, as apt does. Run: bash .github/apt-retry.test.sh
set -u
script=$(cd "$(dirname "$0")" && pwd)/apt-retry.sh
fail=0
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

check() {
  if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi
}

# setup <wired|unwired>: a fresh directory with the stand-ins and the runner's apt settings.
setup() {
  T=$(mktemp -d "$root/XXXXXX")
  mkdir -p "$T/bin" "$T/etc/apt.conf.d" "$T/etc/sources.list.d"
  printf 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n' >"$T/etc/apt-mirrors.txt"
  uri=http://azure.archive.ubuntu.com/ubuntu/
  [ "$1" = wired ] && uri=mirror+file:$T/etc/apt-mirrors.txt
  printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates\n\nTypes: deb\nURIs: %s\nSuites: noble-security\n' "$uri" "$uri" \
    >"$T/etc/sources.list.d/ubuntu.sources"
  cat >"$T/bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
  cat >"$T/bin/timeout" <<'EOF'
#!/usr/bin/env bash
shift 2
secs=$1
shift
echo "timeout $secs $*" >>"$T/log"
"$@" &
child=$!
(sleep 1; kill -TERM "$child"; sleep 1; kill -KILL "$child") 2>/dev/null &
watch=$!
wait "$child"
code=$?
kill "$watch" 2>/dev/null
[ "$code" -gt 128 ] && exit 124
exit "$code"
EOF
  cat >"$T/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
sources=$T/etc/sources.list.d/ubuntu.sources
if grep -q mirror+file: "$sources"; then mirror=$(head -1 "$T/etc/apt-mirrors.txt" | cut -f1)
else mirror=$(sed -n 's/^URIs: //p' "$sources" | head -1); fi
echo "apt-get $1 @ $mirror" >>"$T/log"
if [ -s "$T/lock" ] && kill -0 "$(cat "$T/lock")" 2>/dev/null; then
  echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process $(cat "$T/lock") (apt-get)"
  exit 100
fi
[ "$1" = update ] && exit 0
n=$(($(cat "$T/installs" 2>/dev/null || echo 0) + 1))
echo "$n" >"$T/installs"
set -- $STUB_INSTALLS
case ${!n} in
  ok) exit 0 ;;
  fail) exit 100 ;;
  hang) trap '' TERM; echo $$ >"$T/lock"; exec sleep 30 ;;
esac
EOF
  cat >"$T/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npx $*" >>"$T/log"
if [ "$STUB_DRY_RUN" = none ]; then echo "All system dependencies are installed."; exit 0; fi
printf 'Missing system dependencies (3):\n  libavif16\n  libgtk-4-1\n  xvfb\n'
exit 1
EOF
  printf '#!/usr/bin/env bash\necho "$(basename "$0") $*" >>"$T/log"\n' >"$T/bin/dpkg"
  cp "$T/bin/dpkg" "$T/bin/pkill"
  printf '#!/usr/bin/env bash\n[ "$STUB_ICU" = missing ] && exit 1\necho "install ok installed"\n' >"$T/bin/dpkg-query"
  printf '#!/usr/bin/env bash\nexit 1\n' >"$T/bin/pgrep"
  chmod +x "$T"/bin/*
  : >"$T/log"
  export T
}

# run <installs> <dry-run> <args...>: apt-retry.sh's exit code in $code, its seconds in $took.
run() {
  local start=$SECONDS
  STUB_INSTALLS=$1 STUB_DRY_RUN=$2 STUB_ICU=${STUB_ICU:-} APT_ETC=$T/etc PATH="$T/bin:$PATH" bash "$script" "${@:3}" >"$T/out" 2>&1
  code=$?
  took=$((SECONDS - start))
}

echo "# try 1 hangs on the runner's mirror, try 2 runs on archive.ubuntu.com"
setup wired
run "hang ok" missing --playwright chromium webkit firefox
check "exits 0" '[ "$code" = 0 ]'
check "the dry run is asked for the browsers" 'grep -qx "npx playwright install-deps --dry-run chromium webkit firefox" "$T/log"'
check "apt-get is timeout's direct child, with the dry run's packages" \
  '[ "$(grep -c "^timeout 180 apt-get install -y --no-install-recommends libavif16 libgtk-4-1 xvfb$" "$T/log")" = 2 ]'
check "the apt-get that hung is gone: no lock holder" '! kill -0 "$(cat "$T/lock")" 2>/dev/null'
check "try 2 runs on archive.ubuntu.com after apt-get update, once apt and dpkg are cleared" \
  '[ "$(grep -v "^timeout\|^npx" "$T/log" | tr "\n" "|")" = "apt-get update @ http://azure.archive.ubuntu.com/ubuntu/|apt-get install @ http://azure.archive.ubuntu.com/ubuntu/|pkill -KILL -x apt-get|dpkg|dpkg --configure -a|apt-get update @ http://archive.ubuntu.com/ubuntu|apt-get install @ http://archive.ubuntu.com/ubuntu|" ]'
check "the mirror list names archive.ubuntu.com alone" '[ "$(cat "$T/etc/apt-mirrors.txt")" = "$(printf "http://archive.ubuntu.com/ubuntu\tpriority:1")" ]'
check "a warning for try 1" 'grep -q "::warning::apt-retry.sh --playwright chromium webkit firefox: try 1 of 3" "$T/out"'
check "apt.conf is in apt's settings" 'cmp -s "$T/etc/apt.conf.d/99-ci" "$(dirname "$script")/apt.conf"'

echo "# a healthy first try"
setup wired
run "ok" missing pulseaudio
check "exits 0" '[ "$code" = 0 ]'
check "at once" '[ "$took" -le 1 ]'
check "one update and one install, of the package named" \
  '[ "$(tr "\n" "|" <"$T/log")" = "timeout 60 apt-get update|apt-get update @ http://azure.archive.ubuntu.com/ubuntu/|timeout 180 apt-get install -y --no-install-recommends pulseaudio|apt-get install @ http://azure.archive.ubuntu.com/ubuntu/|" ]'
check "the runner's mirror list is left as it was" 'grep -q "^https://archive.ubuntu.com/ubuntu/" "$T/etc/apt-mirrors.txt"'
check "no warning" '! grep -q "::warning::" "$T/out"'

echo "# three failed tries, without mirror+file: in ubuntu.sources"
setup unwired
run "fail fail fail" missing pulseaudio
check "exits 1" '[ "$code" = 1 ]'
check "the tries run on the runner's mirror, archive.ubuntu.com and mirrors.edge.kernel.org" \
  '[ "$(grep "^apt-get install" "$T/log" | tr "\n" "|")" = "apt-get install @ http://azure.archive.ubuntu.com/ubuntu/|apt-get install @ http://archive.ubuntu.com/ubuntu|apt-get install @ http://mirrors.edge.kernel.org/ubuntu|" ]'
check "every URIs line in ubuntu.sources names the last mirror" \
  '[ "$(grep -c "^URIs: http://mirrors.edge.kernel.org/ubuntu$" "$T/etc/sources.list.d/ubuntu.sources")" = 2 ]'
check "three warnings" '[ "$(grep -c "::warning::" "$T/out")" = 3 ]'

echo "# Playwright counts WebKit's ICU as the image's, and this image has none"
setup wired
STUB_ICU=missing run "ok" none --playwright webkit
check "exits 0" '[ "$code" = 0 ]'
check "installs libicu74 although the dry run found nothing missing" \
  'grep -qx "timeout 180 apt-get install -y --no-install-recommends libicu74" "$T/log"'

echo "# Playwright's libraries already installed"
setup wired
run "fail" none --playwright chromium
check "exits 0" '[ "$code" = 0 ]'
check "installs nothing" '! grep -q "^apt-get install" "$T/log"'

exit "$fail"
