// 耳コピの下書きに当てはめる歌詞を探す
// 1) LRCLIB(時刻つき歌詞の公開データベース。ブラウザから直接読める) 2) 歌ネット(Edge Function 経由・時刻なし)
import { api } from './api.js';
import { norm, baseTitle, sameArtist } from './util.js';
import { parseLRC } from '../music/lyricsfit.js';

async function lrclib(params) {
  const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(params));
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

// 戻り値: { synced: [{t, text}] | null, plain: [行](空行は段落の切れ目) , source } | null
export async function findLyrics({ title, artist, durationMs }) {
  const t = baseTitle(title || '').trim();
  if (!t) return null;
  const dur = durationMs ? durationMs / 1000 : null;
  try {
    let list = await lrclib(artist ? { track_name: t, artist_name: artist } : { track_name: t });
    if (!list.length) list = await lrclib({ q: `${t} ${artist || ''}`.trim() });
    const cands = list.filter(
      (x) => !x.instrumental && (x.syncedLyrics || x.plainLyrics) && norm(baseTitle(x.trackName)) === norm(t) && (!artist || sameArtist(x.artistName, artist)),
    );
    // 時刻つきを優先し、Apple Music の曲の長さに近いもの(別の版・ライブ版を避ける)
    const score = (x) => (x.syncedLyrics ? 0 : 100) + (dur && x.duration ? Math.min(60, Math.abs(x.duration - dur)) : 5);
    const best = cands.sort((a, b) => score(a) - score(b))[0];
    if (best) {
      const synced = best.syncedLyrics ? parseLRC(best.syncedLyrics) : null;
      const plain = synced ? synced.map((l) => l.text) : String(best.plainLyrics).replace(/\r/g, '').split('\n').map((l) => l.trim());
      if ((synced && synced.some((l) => l.text)) || plain.some(Boolean)) return { synced: synced && synced.some((l) => l.text) ? synced : null, plain: tidy(plain), source: 'LRCLIB' };
    }
  } catch {}
  try {
    const r = await api('lyrics', { title: t, artist: artist || '' });
    if (r?.lines?.some(Boolean)) return { synced: null, plain: tidy(r.lines), source: '歌ネット' };
  } catch {}
  return null;
}

// 前後の空行を落とし、空行の連続は1つに
function tidy(lines) {
  const out = [];
  for (const l of lines) if (l || (out.length && out[out.length - 1])) out.push(l);
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}
