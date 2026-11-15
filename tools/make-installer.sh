#!/bin/bash
# Установщик на ТВ для раздачи: out/PerfectTV-Installer-<версия>.zip — PerfectTV-Installer.exe (Windows),
# свежий .ipk и инструкция. Нужен Go 1.21+ (зависимость golang.org/x/crypto — в go.sum).
set -e
cd "$(dirname "$0")/.."
VER=$(node -p "require('./appinfo.json').version")
IPK=out/top.rootu.perfecttv_${VER}_all.ipk
[ -f "$IPK" ] || npm run -s package
cd tools/tv-installer
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ../../out/PerfectTV-Installer.exe .
go build -trimpath -ldflags "-s -w" -o ../../out/perfecttv-installer-linux .
cd ../..
rm -rf out/installer && mkdir -p out/installer
cp out/PerfectTV-Installer.exe "$IPK" out/installer/
sed 's/$/\r/' tools/tv-installer/README.txt > "out/installer/Как установить.txt"
rm -f "out/PerfectTV-Installer-${VER}.zip"
(cd out/installer && zip -q -r "../PerfectTV-Installer-${VER}.zip" .)
ls -la "out/PerfectTV-Installer-${VER}.zip"
