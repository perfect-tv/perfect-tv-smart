/**
 * Скачанный с сайта код на Tizen (обновление без переустановки): IndexedDB «ptv-code» (своего
 * сервиса нет), метка запуска и сбойные версии — localStorage. Читает загрузчик (loader.ts),
 * пишет проверка обновлений (core/codeupdate.ts → PlatformApi.code.install).
 */
import { CODE_FILES, CodeManifest, CodeRecord } from '../../core/codever';
import { sha256 } from '../../core/sha256';
import type { CodeStore } from '../../loader/run';

const DB = 'ptv-code', STORE = 'code', KEY = 'current';
const BOOT = 'ptv:code-boot', BAD = 'ptv:code-bad';

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* */ } }
function badList(): string[] { try { const v = JSON.parse(lsGet(BAD) || '[]'); return v instanceof Array ? v : []; } catch (e) { return []; } }

function openDb(): Promise<IDBDatabase> {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
  });
}

function get(): Promise<CodeRecord | null> {
  return openDb().then(function (db) {
    return new Promise<CodeRecord | null>(function (resolve, reject) {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
  });
}

function put(rec: CodeRecord | null): Promise<void> {
  return openDb().then(function (db) {
    return new Promise<void>(function (resolve, reject) {
      const tx = db.transaction(STORE, 'readwrite');
      if (rec) tx.objectStore(STORE).put(rec, KEY); else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB write failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
    });
  });
}

export const TizenCodeStore: CodeStore = {
  meta: function () {
    return get().then(null, function () { return null; }).then(function (rec) {
      return { rec: rec, boot: lsGet(BOOT) || '', bad: badList() };
    });
  },
  files: function (rec) { return Promise.resolve(rec.files); },
  state: function (boot, bad) {
    if (boot !== null) lsSet(BOOT, boot || null);
    if (bad !== null) { const b = badList(); if (b.indexOf(bad) < 0) b.push(bad); lsSet(BAD, JSON.stringify(b.slice(-10))); }
    return Promise.resolve();
  },
};

function getText(url: string): Promise<string> {
  return new Promise(function (resolve, reject) {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 60000;
    x.onload = function () { if (x.status === 200) resolve(x.responseText); else reject(new Error('HTTP ' + x.status + ' ' + url)); };
    x.onerror = function () { reject(new Error('network ' + url)); };
    x.ontimeout = function () { reject(new Error('timeout ' + url)); };
    x.send();
  });
}

/** Скачать версию с сайта, сверить sha256 и сохранить (применится при следующем запуске) */
export function installTizenCode(base: string, m: CodeManifest): Promise<void> {
  const files: { [name: string]: string } = {};
  let i = 0;
  function next(): Promise<void> {
    if (i >= CODE_FILES.length) {
      return put({ version: m.version, shell: m.shell | 0, service: m.service | 0, files: files, saved: Date.now() });
    }
    const name = CODE_FILES[i++];
    const want = m.files[name];
    if (!want) return Promise.reject(new Error('no ' + name + ' in version.json'));
    return getText(base + name + '?v=' + encodeURIComponent(m.version)).then(function (t) {
      if (sha256(t) !== want.sha256) throw new Error('sha256 mismatch ' + name);
      files[name] = t;
      return next();
    });
  }
  return next();
}

export function clearTizenCode(): Promise<void> { return put(null); }
