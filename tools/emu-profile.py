# Разбор JS-профиля из tools/emu-cdp.js profile: python3 tools/emu-profile.py [строк self] [строк incl]
# self — своё время функции, incl — с вызванными; проценты — от занятого (без простоя) времени.
import json, collections, sys, os, tempfile
p=json.load(open(os.environ.get('EMU_OUT', tempfile.gettempdir() + '/') + 'profile.json'))
nodes={}
def walk(n, parent=None):
    n['_p']=parent; nodes[n['id']]=n
    for c in n.get('children',[]): walk(c, n)
walk(p['head'])
cnt=collections.Counter(p['samples']); total=sum(cnt.values())
idle=sum(c for nid,c in cnt.items() if nodes[nid]['functionName'] in ('(idle)',))
busy=total-idle
selfc=collections.Counter(); incl=collections.Counter()
def name(n): return '%s:%s'%(n['functionName'] or '(anon)', n['columnNumber'])
for nid,c in cnt.items():
    n=nodes[nid]
    if n['functionName'] in ('(idle)','(program)','(root)'): continue
    selfc[name(n)]+=c
    seen=set(); x=n
    while x is not None:
        k=name(x)
        if k not in seen: incl[k]+=c; seen.add(k)
        x=x['_p']
print('busy %.1f%% of %d samples'%(100*busy/total,total))
for k,c in selfc.most_common(int(sys.argv[1]) if len(sys.argv)>1 else 12): print('self %5.1f%% %s'%(100*c/busy,k))
for k,c in incl.most_common(int(sys.argv[2]) if len(sys.argv)>2 else 16): print('incl %5.1f%% %s'%(100*c/busy,k))
