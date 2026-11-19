#!/bin/sh
# Run selected plugin checks with the mock model.
#   unit     npm run test:all (only with --only unit)
#   build    client.js matches src/client (build-client.mjs --check)
#   lint     npm run lint (warnings do not fail)
#   smoke    a fresh smoke bench and dev/smoke.mjs
#   web      a fresh Web bench and dev/ui-shots.mjs (sidebar, private chat, group, settings)
# Every process it starts is stopped at the end, also on failure or Ctrl-C.
#
#   dev/check.sh [--skip step,step] [--only step,step] [--out <dir>]
#
# Screenshots and logs go to --out (default: shots/check-<YYYYMMDD-HHMM> beside ds-bot/ in
# the main worktree).
# Ports follow SLOT=n (0-9): Web 31n0/88n0, smoke 31n1/88n1.
# Web screenshots need Chrome or Chromium (CHROME_BIN, see ui-shots.mjs).
set -u
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$PLUGIN")"
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/$(git -C "$ROOT" rev-parse --show-prefix)"
MAIN="${MAIN%/}"
SLOT=${SLOT:-0}
case "$SLOT" in [0-9]) ;; *) echo "SLOT must be one digit" >&2; exit 2 ;; esac
STEPS="unit build lint smoke web"
SKIP=""
ONLY=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip) SKIP=$(echo "$2" | tr ',' ' '); shift 2 ;;
    --only) ONLY=$(echo "$2" | tr ',' ' '); shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,/^set -u/{/^set -u/!p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
if [ -z "$ONLY" ] && [ -z "$SKIP" ]; then
  echo "Choose checks with --only (steps: $STEPS)." >&2
  exit 2
fi
for step in $SKIP $ONLY; do
  case " $STEPS " in *" $step "*) ;; *) echo "unknown step $step; steps: $STEPS" >&2; exit 2 ;; esac
done
OUT=${OUT:-"$MAIN/shots/check-$(date +%Y%m%d-%H%M)"}
mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"

WEB_HARNESS=${DSH_HARNESS:-"$ROOT/deepseek-harness"}
if [ -z "${DSH_HARNESS:-}" ] && [ ! -d "$WEB_HARNESS" ]; then
  WEB_HARNESS="$MAIN/deepseek-harness"
  [ -d "$WEB_HARNESS" ] || WEB_HARNESS="$(dirname "$MAIN")/deepseek-harness"
fi
WEB_PORT=31${SLOT}0 WEB_MOCK=88${SLOT}0 SMOKE_PORT=31${SLOT}1 SMOKE_MOCK=88${SLOT}1

smoke_name="check-smoke-$SLOT"
web_name="check-web-$SLOT"
started_smoke=0
started_web=0

cleanup() {
  if [ "$started_smoke" = 1 ]; then "$PLUGIN/dev/bench.sh" "$smoke_name" "$SMOKE_PORT" "$SMOKE_MOCK" stop >/dev/null 2>&1; fi
  if [ "$started_web" = 1 ]; then "$PLUGIN/dev/bench.sh" "$web_name" "$WEB_PORT" "$WEB_MOCK" stop >/dev/null 2>&1; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wanted() {
  if [ "$1" = unit ] && [ -z "$ONLY" ]; then return 1; fi
  if [ -n "$ONLY" ]; then case " $ONLY " in *" $1 "*) ;; *) return 1 ;; esac; fi
  case " $SKIP " in *" $1 "*) return 1 ;; esac
  return 0
}

port_free() { ! node -e "const s=require('net').connect($1,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"; }
# One retry: on this shared server a bench's dsh web once exited at start with an empty log
# while other sessions used the same dsh checkout, and the next start worked.
bench_reset() {
  DSH_HARNESS="$WEB_HARNESS" dev/bench.sh "$@" reset && return 0
  echo "bench $1 did not start; retrying once"
  DSH_HARNESS="$WEB_HARNESS" dev/bench.sh "$@" reset
}
need_ports() {
  for port in "$@"; do
    port_free "$port" || { echo "port $port is in use; stop what holds it or pick another SLOT" >&2; return 1; }
  done
}

step_unit() { cd "$PLUGIN" && npm run test:all; }
step_build() { cd "$PLUGIN" && node scripts/build-client.mjs --check; }
step_lint() { cd "$PLUGIN" && npm run lint; }
step_smoke() {
  cd "$PLUGIN" || return 1
  need_ports "$SMOKE_PORT" "$SMOKE_MOCK" || return 1
  export CONTEXT_WINDOW=100000 CHECK_RATIO=0.45
  started_smoke=1
  bench_reset "$smoke_name" "$SMOKE_PORT" "$SMOKE_MOCK" || return 1
  node dev/smoke.mjs "$smoke_name" "$SMOKE_PORT"
  status=$?
  dev/bench.sh "$smoke_name" "$SMOKE_PORT" "$SMOKE_MOCK" stop
  started_smoke=0
  return $status
}
step_web() {
  cd "$PLUGIN" || return 1
  need_ports "$WEB_PORT" "$WEB_MOCK" || return 1
  started_web=1
  bench_reset "$web_name" "$WEB_PORT" "$WEB_MOCK" || return 1
  node dev/ui-shots.mjs web "$WEB_HARNESS" "$OUT" "$web_name" "$WEB_PORT"
  status=$?
  dev/bench.sh "$web_name" "$WEB_PORT" "$WEB_MOCK" stop
  started_web=0
  return $status
}
SUMMARY=""
FAILED=""
TOTAL_START=$(date +%s)
for step in $STEPS; do
  if ! wanted "$step"; then
    SUMMARY="$SUMMARY$(printf '%-8s skipped' "$step")
"
    continue
  fi
  log="$OUT/logs/$step.log"
  printf '== %-8s ' "$step"
  start=$(date +%s)
  # Keep login URLs out of the logs.
  "step_$step" >"$log.raw" 2>&1 </dev/null
  status=$?
  grep -v 'token=' "$log.raw" >"$log"
  rm -f "$log.raw"
  elapsed=$(( $(date +%s) - start ))
  if [ $status -eq 0 ]; then result=ok; else result=FAILED; FAILED="$FAILED $step"; fi
  echo "$result (${elapsed} s)"
  if [ $status -ne 0 ]; then
    echo "   log: $log"
    tail -15 "$log" | sed 's/^/   | /'
  fi
  SUMMARY="$SUMMARY$(printf '%-8s %-7s %4s s  %s' "$step" "$result" "$elapsed" "$log")
"
done

echo
printf '%s' "$SUMMARY"
echo "total $(( $(date +%s) - TOTAL_START )) s; screenshots: $OUT"
if [ -n "$FAILED" ]; then
  echo "check failed:$FAILED"
  exit 1
fi
echo "check passed"
