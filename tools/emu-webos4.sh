#!/bin/bash
# Эмулятор webOS TV 4.x (образ LG из Emulator_tv_linux_v4.0.0.zip) — в QEMU/KVM без окна.
# VirtualBox не запускается, пока KVM занят (например, эмулятором Android): VERR_VMX_IN_VMX_ROOT_MODE.
# Под QEMU веб-слой на экран машины не выводится — экран снимать через DevTools (tools/emu-cdp.js shot).
#   EMU=~/webos-emulator/v4.0.0/Emulator/v4.0.0 tools/emu-webos4.sh        запустить
#   tools/emu-webos4.sh stop                                                остановить
# Порты на 127.0.0.1: 6622 — SSH (ares-install -d emulator), 9998 — DevTools, 19001 — пульт.
# Диск — snapshot: после остановки всё, что поставили, пропадает. Машина хозяина изнутри — 10.0.2.2.
set -e
SOCK=/tmp/webos4-mon.sock
if [ "$1" = stop ]; then echo quit | socat - UNIX-CONNECT:$SOCK 2>/dev/null || pkill -f "qemu-system-x86_64 -name webos4"; exit 0; fi
EMU=${EMU:-$HOME/webos-emulator/v4.0.0/Emulator/v4.0.0}
exec qemu-system-x86_64 -name webos4 -enable-kvm -M pc -cpu host -smp 3 -m 1024 \
  -drive file="$EMU/LG_webOS_TV_Emulator.vmdk",format=vmdk,if=ide,snapshot=on \
  -nic user,model=pcnet,hostfwd=tcp:127.0.0.1:6622-:22,hostfwd=tcp:127.0.0.1:9998-:9998,hostfwd=tcp:127.0.0.1:19001-:19001 \
  -usb -device usb-tablet -vga std -display none -monitor unix:$SOCK,server,nowait -daemonize
