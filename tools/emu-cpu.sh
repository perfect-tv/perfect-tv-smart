#!/bin/sh
# Загрузка процессора по процессам в эмуляторе webOS (в % одного ядра) за N секунд:
#   cat tools/emu-cpu.sh | ssh … "cat > /tmp/pcpu.sh"; ssh … "sh /tmp/pcpu.sh 10"
# (ssh — как в README, «Эмуляторы webOS TV 3 и 4»). Видно surface-manager (сборка экрана), WebAppMgr (приложение), starfish-media (видео).
N=$1
snap() { for d in /proc/[0-9]*; do [ -r $d/stat ] || continue; read -r line < $d/stat 2>/dev/null || continue; p=${d#/proc/}; c=$(echo "$line" | sed 's/^[0-9]* (\(.*\)) .*/\1/' | tr ' ' '_'); rest=$(echo "$line" | sed 's/^.*) //'); set -- $rest; echo "$p $c $(( ${12} + ${13} ))"; done; }
snap > /tmp/s1; sleep $N; snap > /tmp/s2
HZ=100
awk -v n=$N -v hz=$HZ 'NR==FNR{a[$1]=$3; c[$1]=$2; next} ($1 in a){d=$3-a[$1]; if(d>0) s[$2]+=d} END{for(k in s) printf "%s %.0f\n", k, 100*s[k]/(n*hz)}' /tmp/s1 /tmp/s2 | sort -k2 -nr | head -12
