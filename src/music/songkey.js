// 曲の原曲キー。優先順: 自分で直した値 → サイトや入力欄のキー → 譜面の {key:} → コードからの推定
// 空欄の曲には推定した値を sheet.key に書き込む(sheet.keyAuto = true。一覧の絞り込み用。曲画面では毎回推定し直す)
import { parseKey, detectKey, noteName, keyPrefersFlat, keyName } from './chord.js';
import { parseSheet } from './sheet.js';
import { lib } from '../lib/store.js';

const chordsOf = (lines) => {
  const seq = [];
  for (const l of lines) if (l.segs) for (const s of l.segs) if (s.c) seq.push(s.c);
  return seq;
};

// { key, guessed }
export function songOrigKey(song, parsed) {
  const k = parseKey(song.settings?.origKey) || (song.sheet?.keyAuto ? null : parseKey(song.sheet?.key)) || parseKey(parsed.meta?.key);
  return k ? { key: k, guessed: false } : { key: detectKey(chordsOf(parsed.lines)), guessed: true };
}

export const keyCode = (k) => noteName(k.pc, keyPrefersFlat(k)) + (k.minor ? 'm' : '');

// 取り込んだ譜面に保存するキー。サイトに書いていなければコードから推定して入れる
export function sheetKey(parsed, siteKey) {
  const written = siteKey || parsed.meta.key;
  if (written) return { key: written, keyAuto: false };
  const seq = chordsOf(parsed.lines);
  return seq.length ? { key: keyCode(detectKey(seq)), keyAuto: true } : { key: null, keyAuto: false };
}

// 一覧の絞り込みに使う名前(例: G、F♯m)。譜面がまだ無い曲は ''
export function listKey(song) {
  return keyName(parseKey(song.settings?.origKey) || parseKey(song.sheet?.key));
}

// キーが空欄の曲に、推定した値を入れる。入れた数を返す
let filling = false;
export async function fillKeys() {
  if (filling) return 0;
  filling = true;
  let n = 0;
  try {
    for (const song of lib.all()) {
      if (!song.sheet?.text || song.sheet.key) continue;
      const patch = sheetKey(parseSheet(song.sheet.text), null);
      if (!patch.key) continue;
      await lib.patch(song.id, (cur) => ({ sheet: { ...cur.sheet, ...patch } }));
      n++;
    }
  } finally {
    filling = false;
  }
  return n;
}
