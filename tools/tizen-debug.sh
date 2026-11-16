#!/bin/bash
# Tizen: поставить out/PerfectTV-<версия>.wgt на эмулятор или ТВ, запустить с отладкой и пробросить
# DevTools на 127.0.0.1:9224 (дальше — CDP_PORT=9224 node tools/emu-cdp.js …).
#   tools/tizen-debug.sh [цель, по умолчанию ptv-tv10]
set -e
cd "$(dirname "$0")/.."
TARGET=${1:-ptv-tv10}
TS=${TIZEN_STUDIO:-$HOME/tizen-studio}
V=$(node -p "require('./appinfo.json').version")
"$TS/tools/ide/bin/tizen" install -n "PerfectTV-$V.wgt" -t "$TARGET" -- "$PWD/out" | grep -i "completed\|fail\|error" || true
SDB="$TS/tools/sdb"
"$SDB" shell 0 kill PrfTVrootu >/dev/null 2>&1 || true
sleep 1
PORT=$("$SDB" shell 0 debug PrfTVrootu.PerfectTV | grep -o 'port: *[0-9]*' | grep -o '[0-9]*')
[ -n "$PORT" ] || { echo "отладка не запустилась" >&2; exit 1; }
"$SDB" forward tcp:9224 tcp:"$PORT"
echo "DevTools: http://127.0.0.1:9224 (CDP_PORT=9224 node tools/emu-cdp.js logs)"
