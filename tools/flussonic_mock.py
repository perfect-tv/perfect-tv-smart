"""
Поддельный Flussonic для проверки архива: эфир /test/index.m3u8, архив
/test/archive-FROM-DUR.m3u8[?event=true] и /test/archive-FROM-now.m3u8.
Сегменты по 6 с генерирует ffmpeg; в кадре — время сегмента (UTC и местное).
"""
import os, sys, time, subprocess, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

SEG = 6
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.flussonic_cache')
os.makedirs(CACHE, exist_ok=True)
TZ = sys.argv[2] if len(sys.argv) > 2 else 'Europe/Moscow'
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
locks = {}


def seg_file(t):
    path = os.path.join(CACHE, '%d.ts' % t)
    lock = locks.setdefault(t, threading.Lock())
    with lock:
        if not os.path.exists(path):
            vf = ("drawtext=fontfile=%s:fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40:"
                  "text='%%{pts\\:localtime\\:%d\\:%%H\\\\\\:%%M\\\\\\:%%S}'" % (FONT, t))
            env = dict(os.environ, TZ=TZ)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
                            '-t', str(SEG), '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
                            '-output_ts_offset', str(t % 86400), '-f', 'mpegts', path + '.tmp'], env=env, check=True)
            os.rename(path + '.tmp', path)
    return path


def playlist(first, last, kind, pdt=True):
    """Сегменты с началом в [first, last) (выровнены по SEG); kind: live | event | vod"""
    t0 = first - first % SEG
    out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:%d' % SEG, '#EXT-X-MEDIA-SEQUENCE:%d' % (t0 // SEG)]
    if kind == 'event': out.append('#EXT-X-PLAYLIST-TYPE:EVENT')
    if kind == 'vod': out.append('#EXT-X-PLAYLIST-TYPE:VOD')
    if pdt: out.append('#EXT-X-PROGRAM-DATE-TIME:' + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t0)))
    t = t0
    while t + SEG <= last:
        out += ['#EXTINF:%d.000,' % SEG, '/seg/%d.ts' % t]
        t += SEG
    if kind == 'vod': out.append('#EXT-X-ENDLIST')
    return '\n'.join(out) + '\n'


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))
        sys.stderr.flush()

    def send(self, body, ctype):
        if isinstance(body, str): body = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        now = int(time.time())
        p = u.path
        if p == '/list.m3u':
            host = self.headers.get('Host')
            return self.send('#EXTM3U\n#EXTINF:-1 catchup="flussonic" catchup-days="1",Mock Flussonic\n'
                             'http://%s/test/index.m3u8?token=1\n#EXTINF:-1 catchup="flussonic" catchup-days="1",Mock no PDT\nhttp://%s/nopdt/index.m3u8\n' % (host, host), 'audio/x-mpegurl')
        if p.startswith('/seg/'):
            with open(seg_file(int(p[5:-3])), 'rb') as f:
                return self.send(f.read(), 'video/mp2t')
        pdt = not p.startswith('/nopdt/')
        if p.startswith('/nopdt/'): p = '/test/' + p[len('/nopdt/'):]
        if p == '/test/index.m3u8':
            return self.send(playlist(now - 5 * SEG, now, 'live'), 'application/vnd.apple.mpegurl')
        name = p.rsplit('/', 1)[-1][:-len('.m3u8')]
        parts = name.split('-')
        if len(parts) == 3 and parts[0] in ('archive', 'index', 'mono', 'video'):
            start = int(parts[1])
            if parts[2] == 'now':
                return self.send(playlist(start, now, 'event', pdt), 'application/vnd.apple.mpegurl')
            end = start + int(parts[2])
            if end > now and q.get('event') == ['true']:
                return self.send(playlist(start, now, 'event', pdt), 'application/vnd.apple.mpegurl')
            return self.send(playlist(start, min(end, now), 'vod', pdt), 'application/vnd.apple.mpegurl')
        self.send_response(404)
        self.end_headers()


ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8090), H).serve_forever()
