#!/bin/bash
# Пакет Samsung Tizen (.wgt) из dist-tizen/ — нужен Tizen Studio (CLI `tizen`) и профиль сертификатов
# (Certificate Manager: автор + Samsung distributor; для своего ТВ — с DUID телевизора).
#   npm run package:tizen                    профиль сертификатов по умолчанию (активный)
#   TIZEN_PROFILE=имя npm run package:tizen
# Установка на ТВ в режиме разработчика: sdb connect <IP>; tizen install -n out/PerfectTV-<версия>.wgt -t <ТВ>
set -e
cd "$(dirname "$0")/.."
TIZEN=${TIZEN:-$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")}
if [ ! -x "$TIZEN" ]; then
  echo "Нет Tizen Studio CLI (tizen). Поставьте Tizen Studio с TV Extensions или укажите TIZEN=/путь/к/tizen" >&2
  exit 1
fi
mkdir -p out
rm -f dist-tizen/epg-worker.js.map
V=$(node -p "require('./appinfo.json').version")
rm -f "out/Perfect TV.wgt"
"$TIZEN" package -t wgt ${TIZEN_PROFILE:+-s "$TIZEN_PROFILE"} -o "$PWD/out" -- "$PWD/dist-tizen"
mv "out/Perfect TV.wgt" "out/PerfectTV-$V.wgt"
ls -la "out/PerfectTV-$V.wgt"
