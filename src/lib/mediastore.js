// 端末に置いている大きい音(自分の音源・自分の歌の録音)の一覧・削除・自動の片づけ。
// 自分の音源は「その時だけ使う」ことが多いので、置きっぱなしで容量がふくらまないよう、
// 使わなくなって決めた日数(prefs.mediaKeepDays。標準30日)がたったら、この端末とクラウドから自動で消す。元のファイルは消えない
import { lib, media, local } from './store.js';
import { api } from './api.js';
import { getPrefs } from './prefs.js';
import { AUDIO_FN_URL } from '../config.js';

const DAY = 864e5;

// [{ key, kind: 'own'(自分の音源) | 'rec'(自分の歌の録音), songId, title, artist, name, size, local, cloud, usedAt, orphan, isVideo }]
// orphan: ほかの端末で外した・入れ替えたので、もう使われていない手元の残り
export async function listStored() {
  const rows = await media.all();
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    const id = String(r.id);
    if (id.startsWith('src:')) {
      const songId = id.slice(4);
      const s = lib.get(songId);
      const own = s?.settings?.own;
      seen.add(songId);
      items.push({
        key: id,
        kind: 'own',
        songId,
        title: s?.title || r.name || '音源',
        artist: s?.artist || '',
        name: r.name || '',
        size: r.size || r.blob?.size || 0,
        local: true,
        cloud: !!(own?.path && own.fp === r.fp),
        usedAt: r.usedAt || r.savedAt || 0,
        orphan: !own || own.fp !== r.fp,
      });
    } else {
      const s = lib.get(id);
      items.push({ key: id, kind: 'rec', songId: id, title: s?.title || r.name || '録音', artist: s?.artist || '', name: r.name || '', size: r.size || r.blob?.size || 0, local: true, cloud: false, usedAt: r.usedAt || r.savedAt || 0, orphan: !s || s.deleted, isVideo: !!r.isVideo });
    }
  }
  // ほかの端末で入れて、この端末にはまだ取ってきていない(クラウドにだけある)音源
  for (const s of lib.all()) {
    const own = s.settings?.own;
    if (own?.path && !seen.has(s.id)) items.push({ key: 'cloud:' + s.id, kind: 'own', songId: s.id, title: s.title, artist: s.artist || '', name: own.name || '', size: own.size || 0, local: false, cloud: true, usedAt: own.usedAt || own.at || 0, orphan: false });
  }
  return items.sort((a, b) => b.size - a.size);
}

// 消す。自分の音源はこの端末・クラウド・曲の設定から(ほかの端末でも消える)。録音はこの端末から
export async function removeStored(it) {
  if (it.kind === 'own') {
    if (it.local) await media.del('src:' + it.songId);
    if (it.orphan) return;
    const own = lib.get(it.songId)?.settings?.own;
    if (own?.path) await api('del', { paths: [own.path] }, { url: AUDIO_FN_URL }).catch(() => {});
    if (own) await lib.patchSettings(it.songId, { own: null, musicSrc: null });
    return;
  }
  await media.del(it.songId);
  local.set('voice:' + it.songId, null);
  local.set('fit:' + it.songId, null);
  if (lib.get(it.songId)?.settings?.recOn) await lib.patchSettings(it.songId, { recOn: false });
}

// 使った印(自動の片づけで、使っているものを消さないように)
export async function markUsed(key) {
  const r = await media.get(key);
  if (!r || (r.usedAt && Date.now() - r.usedAt < DAY / 4)) return;
  await media.put(key, { ...r, usedAt: Date.now() }).catch(() => {});
}

// アプリを開いたときに(半日に1回)。使わなくなった音を片づける。消した数を返す
export async function autoClean({ force = false } = {}) {
  const days = getPrefs().mediaKeepDays ?? 30;
  const last = await local.get('cleanAt');
  if (!force && last && Date.now() - last < DAY / 2) return 0;
  local.set('cleanAt', Date.now());
  let n = 0;
  for (const it of await listStored()) {
    const old = days > 0 && it.usedAt && Date.now() - it.usedAt > days * DAY;
    if (!it.orphan && !old) continue;
    await removeStored(it).catch(() => {});
    n++;
  }
  return n;
}

export const mbText = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`);
