// 「譜面が出たら知らせる」: 耳コピの下書きしか無い曲を、ときどき検索し直す
// (アプリを開いたとき、12時間以上たった曲だけ・1回に3曲まで)
import { lib } from './store.js';
import { api } from './api.js';
import { norm, baseTitle, sameArtist } from './util.js';

const EVERY = 12 * 3600e3;
let running = false;

export async function checkWatched() {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const now = Date.now();
    const due = lib
      .all()
      .filter((s) => s.watch && !s.watchFound && now - (s.watchCheckedAt || 0) > EVERY)
      .slice(0, 3);
    for (const s of due) {
      let r;
      try {
        r = await api('search', { q: `${baseTitle(s.title)} ${s.artist || ''}`.trim() });
      } catch {
        break; // つながらないときは、次に開いたときにまた調べる
      }
      const hit = (r.groups || []).find(
        (g) => g.sources.length && norm(baseTitle(g.title)) === norm(baseTitle(s.title)) && (!s.artist || sameArtist(g.artist, s.artist)),
      );
      await lib.patch(s.id, hit ? { watchCheckedAt: now, watchFound: now, sources: hit.sources } : { watchCheckedAt: now });
    }
  } finally {
    running = false;
  }
}
