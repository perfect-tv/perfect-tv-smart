import { Clock } from '../core/clock';
import { SocketDb } from './socketdb';
import { SourceMeta, WantedSet } from './loaders';

/** Only progress and metadata travel over WebSocket; XMLTV bytes stay in Node. */
export const EpgService = {
  load(url: string, wanted: WantedSet[], maxArchiveDays: number, langs: string[], force: boolean,
    onProgress: (read: number, total: number, n: number) => void, onPack: () => void): Promise<SourceMeta | null> {
    return SocketDb.epgStart({ url: url, wanted: wanted, maxArchiveDays: maxArchiveDays,
      langs: langs, force: force, now: Clock.now() }).then(function (started) {
      const jobId: number = started.jobId;
      let revision = started.revision || 0;
      console.log('epg service start', url, jobId);
      return new Promise<SourceMeta | null>(function (resolve, reject) {
        function poll() {
          SocketDb.epgStatus(jobId).then(function (state) {
            if (state.revision > revision) { revision = state.revision; onPack(); }
            onProgress(state.read || 0, state.total || 0, state.programmes || 0);
            if (state.done) {
              if (state.error) console.warn('epg service error', state.error);
              console.log('epg service complete', url, state.programmes || 0);
              resolve(state.meta || null);
              return;
            }
            setTimeout(poll, 1000);
          }, reject);
        }
        poll();
      });
    });
  },
};
