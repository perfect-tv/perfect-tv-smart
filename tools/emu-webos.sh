#!/bin/bash
# Эмулятор webOS TV 3.x / 4.x (образ LG из Emulator_tv_linux_vN.0.0.zip) — в QEMU/KVM без окна.
# VirtualBox не запускается, пока KVM занят (например, эмулятором Android): VERR_VMX_IN_VMX_ROOT_MODE.
# Под QEMU веб-слой на экран машины не выводится — экран снимать через DevTools (tools/emu-cdp.js shot).
#   tools/emu-webos.sh 4          запустить webOS 4 (образ в ~/webos-emulator/v4.0.0, или EMU=папка с .vmdk)
#   tools/emu-webos.sh 3          запустить webOS 3
#   tools/emu-webos.sh stop       остановить
# Порты на 127.0.0.1: 6622 — SSH (ares-install -d emulator), 9998 — DevTools, 19001 — пульт.
# Одновременно — один эмулятор (порты общие). Диск — snapshot: после остановки всё поставленное
# пропадает. Машина хозяина изнутри — 10.0.2.2.
set -e
SOCK=/tmp/webos-emu-mon.sock
if [ "$1" = stop ]; then
  python3 -c "import socket,time;s=socket.socket(socket.AF_UNIX);s.connect('$SOCK');time.sleep(0.3);s.send(b'quit\n');time.sleep(1)" 2>/dev/null || pkill -f "qemu-system-x86_64 -name webos-emu"
  exit 0
fi
V=${1:-4}
EMU=${EMU:-$HOME/webos-emulator/v$V.0.0/Emulator/v$V.0.0}
exec qemu-system-x86_64 -name webos-emu -enable-kvm -M pc -cpu host -smp 3 -m 1024 \
  -drive file="$EMU/LG_webOS_TV_Emulator.vmdk",format=vmdk,if=ide,snapshot=on \
  -nic user,model=pcnet,hostfwd=tcp:127.0.0.1:6622-:22,hostfwd=tcp:127.0.0.1:9998-:9998,hostfwd=tcp:127.0.0.1:19001-:19001 \
  -usb -device usb-tablet -vga std -display none -monitor unix:$SOCK,server,nowait -daemonize
