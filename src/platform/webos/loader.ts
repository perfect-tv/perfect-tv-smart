// Загрузчик пакета webOS (index.html → loader.js): скачанный код — файлы сервиса (service/codestore.js)
import { CODE_FILES, CodeRecord } from '../../core/codever';
import { CodeStore, runLoader } from '../../loader/run';
import { Luna } from './luna';

function call(method: string, params: any, ms: number): Promise<any> {
  return Luna.requestService(method, params, ms).then(function (r: any) {
    if (!r || !r.returnValue) throw new Error(method + ': ' + (r && (r.errorText || r.error) || 'failed'));
    return r;
  });
}

/** Файл кусками (ответ Luna — не больше ~128 К символов) */
function readFile(name: string, version: string): Promise<string> {
  const parts: string[] = [];
  let off = 0;
  function next(): Promise<string> {
    return call('codeRead', { name: name, offset: off }, 8000).then(function (r: any) {
      if (r.version !== version) throw new Error('code changed while reading');
      parts.push(r.text || '');
      off += (r.text || '').length;
      if (r.done) return parts.join('');
      if (!r.text) throw new Error('empty chunk');
      return next();
    });
  }
  return next();
}

const store: CodeStore = {
  meta: function () {
    // в браузере (разработка) сервиса нет — встроенный код
    if (!Luna.isWebOS) return Promise.resolve({ rec: null, boot: '', bad: [] });
    // сразу подписываемся на сервис (keepAlive + порт :47380), чтобы он не уснул за время чтения кода
    Luna.startService();
    // первый вызов и запускает сервис: ждём дольше
    return call('codeMeta', {}, 6000).then(function (r: any) {
      const m = r.meta;
      const rec: CodeRecord | null = m && m.version ? { version: m.version, shell: m.shell | 0, service: m.service | 0, files: m.files || {}, saved: m.saved || 0 } : null;
      return { rec: rec, boot: r.boot || '', bad: r.bad || [] };
    });
  },
  files: function (rec) {
    const out: { [name: string]: string } = {};
    let i = 0;
    function next(): Promise<{ [name: string]: string }> {
      if (i >= CODE_FILES.length) return Promise.resolve(out);
      const name = CODE_FILES[i++];
      return readFile(name, rec.version).then(function (t) { out[name] = t; return next(); });
    }
    return next();
  },
  state: function (boot, bad) {
    const q: any = {};
    if (boot !== null) q.boot = boot;
    if (bad !== null) q.bad = bad;
    return call('codeState', q, 3000).then(function () { /* */ });
  },
};

runLoader(store);
