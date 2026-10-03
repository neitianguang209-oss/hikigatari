// 耳コピの下書きに当てはめる歌詞を探す
// 1) LRCLIB(時刻つき歌詞の公開データベース。ブラウザから直接読める)
// 2) UtaTen(漢字にふりがな付き。時刻は無い)・歌ネット(時刻なし)は Edge Function 経由
// ふりがなは「その文字を何拍で歌うか」を数えるのに使う(コードを置く文字の位置が正確になる)
import { api } from './api.js';
import { norm, baseTitle, sameArtist } from './util.js';
import { parseLRC } from '../music/lyricsfit.js';

async function lrclib(params) {
  const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(params));
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

// サーバーの行([{t, r?}] か 文字列) → 文字列
const lineText = (l) => (typeof l === 'string' ? l : (l || []).map((s) => s.t).join('')).trim();

// ふりがなの辞書(漢字 → 読み)
export function rubyOf(lines) {
  const m = new Map();
  for (const l of lines || []) if (Array.isArray(l)) for (const s of l) if (s.r && /[一-鿿々〆ヶ]/.test(s.t)) m.set(s.t, s.r);
  return m;
}

// 文字ごとの時刻つき歌詞(Kugou の KRC。サーバー経由) → synced の形 [{ t, text, words: [{ t, d, s }] }]
// 行と行のあいだが4秒以上あいたところ(間奏など)には、段落の切れ目(text='')を入れる
export function krcToSynced(lines) {
  const out = [];
  for (const l of lines || []) {
    const words = (l.w || []).map(([t, d, s]) => ({ t, d, s: String(s) }));
    // 行の前後の空白は落とす(文字の位置がずれないよう、words の文字列もいっしょに)
    while (words.length && !words[0].s.trim()) words.shift();
    while (words.length && !words[words.length - 1].s.trim()) words.pop();
    if (!words.length) continue;
    words[0].s = words[0].s.replace(/^\s+/, '');
    words[words.length - 1].s = words[words.length - 1].s.replace(/\s+$/, '');
    const text = words.map((w) => w.s).join('');
    const prev = out[out.length - 1];
    if (prev?.words) {
      const pw = prev.words[prev.words.length - 1];
      if (words[0].t - (pw.t + pw.d) >= 4) out.push({ t: pw.t + pw.d + 0.3, text: '' });
    }
    out.push({ t: words[0].t, text, words });
  }
  return out;
}

const KANA = /[ぁ-ゖァ-ヺ]/g;
const kanaRate = (s) => ((s || '').match(KANA) || []).length / Math.max(1, (s || '').replace(/\s/g, '').length);

// 戻り値: { synced: [{t, text, words?}] | null, plain: [行](空行は段落の切れ目), source, ruby: Map, wordTimed } | null
// 探す順: 文字ごとの時刻つき(Kugou) → 行ごとの時刻つき(LRCLIB) → 時刻なし(UtaTen・歌ネット)
export async function findLyrics({ title, artist, durationMs }) {
  const t = baseTitle(title || '').trim();
  if (!t) return null;
  const dur = durationMs ? durationMs / 1000 : null;
  const utaten = api('lyrics_utaten', { title: t, artist: artist || '' }).catch(() => null);
  const krc = api('lyrics_krc', { title: t, artist: artist || '', durationMs: durationMs || 0 }).catch(() => null);
  let found = null;
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
      if ((synced && synced.some((l) => l.text)) || plain.some(Boolean))
        found = { synced: synced && synced.some((l) => l.text) ? synced : null, plain: tidy(plain), source: 'LRCLIB' };
    }
  } catch {}
  const ut = await utaten;
  const ruby = rubyOf(ut?.lines);
  // 文字ごとの時刻つきがあれば、それを使う(ただし日本語の曲なのに、かなの無い歌詞(訳詞など)なら使わない)
  const k = await krc;
  if (k?.lines?.length >= 3) {
    const synced = krcToSynced(k.lines);
    const kText = synced.map((l) => l.text).join('');
    const ref = found ? found.plain.join('') : ut?.lines ? ut.lines.map(lineText).join('') : '';
    if (synced.some((l) => l.text) && !(kanaRate(ref) > 0.15 && kanaRate(kText) < 0.03)) {
      return { synced, plain: tidy(synced.map((l) => l.text)), source: 'Kugou', ruby, wordTimed: true };
    }
  }
  if (found) return { ...found, ruby };
  if (ut?.lines?.some((l) => lineText(l))) return { synced: null, plain: tidy(ut.lines.map(lineText)), source: 'UtaTen', ruby };
  try {
    const r = await api('lyrics', { title: t, artist: artist || '' });
    if (r?.lines?.some((l) => lineText(l))) return { synced: null, plain: tidy(r.lines.map(lineText)), source: '歌ネット', ruby };
  } catch {}
  return ruby.size ? { synced: null, plain: [], source: '', ruby } : null;
}

// 貼り付けられたもの: 歌詞ページの URL か、歌詞そのもの
export async function lyricsFromInput(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('URL か歌詞を入れてください');
  if (/^https?:\/\/\S+$/i.test(s)) {
    const r = await api('lyrics_url', { url: s });
    const plain = tidy((r.lines || []).map(lineText));
    if (!plain.some(Boolean)) throw new Error('このページから歌詞を読み取れませんでした');
    return { synced: null, plain, source: r.source || 'リンク', ruby: rubyOf(r.lines) };
  }
  const plain = tidy(s.replace(/\r/g, '').split('\n').map((l) => l.trim()));
  if (plain.filter(Boolean).length < 2) throw new Error('歌詞が短すぎます（2行以上を貼り付けてください）');
  return { synced: null, plain, source: '貼り付け', ruby: new Map() };
}

// 前後の空行を落とし、空行の連続は1つに
function tidy(lines) {
  const out = [];
  for (const l of lines) if (l || (out.length && out[out.length - 1])) out.push(l);
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}
