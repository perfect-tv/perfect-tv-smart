import { Names } from './names';
import { EpgChannelRaw } from './xmltv';

/**
 * Сопоставление каналов плейлиста с каналами XMLTV одного источника:
 * tvg-id == id (и без учёта регистра) → tvg-name / имя == display-name (короткое имя с транслитом).
 */
export class EpgMatcher {
  private ids: { [id: string]: true } = {};
  private idsLower: { [id: string]: string } = {};
  private byName: { [k: string]: string } = {};
  size = 0;

  addChannel(c: EpgChannelRaw) {
    if (!this.ids[c.id]) { this.ids[c.id] = true; this.size++; }
    const low = c.id.toLowerCase();
    if (this.idsLower[low] === undefined) this.idsLower[low] = c.id;
    for (let i = 0; i < c.names.length; i++) {
      const k = Names.matchKey(c.names[i]);
      if (k && this.byName[k] === undefined) this.byName[k] = c.id;
    }
  }

  /** xml_id канала или null */
  match(tvgId: string, tvgName: string, name: string): string | null {
    if (tvgId) {
      if (this.ids[tvgId]) return tvgId;
      const l = this.idsLower[tvgId.toLowerCase()];
      if (l !== undefined) return l;
    }
    if (tvgName) {
      const v = this.byName[Names.matchKey(tvgName)];
      if (v !== undefined) return v;
    }
    const v = this.byName[Names.matchKey(name)];
    return v !== undefined ? v : null;
  }
}
