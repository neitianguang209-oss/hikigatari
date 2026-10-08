// 各サイトから取り込んだ譜面を、アプリの譜面テキスト([C]歌詞 の形・実際に鳴る音)にそろえる
//   U-FRET・ChordWiki・歌ネット: そのまま
//   コード進行メモ倉庫(mcmemo): 曲データ(度数とコードの鳴る時刻) → mcToSheet。歌詞の1文字ずつの時刻があれば、コードを文字の上に正確に置く
//   リンネ(rinne): [C]歌詞 の形だが、カポをつけた形で書かれている → カポの数だけ上げる
//   J-Total(jtotal): 「コードの行 + 歌詞の行」の形 → [C]歌詞 に直し、カポの数だけ上げる
import { parseChord, chordName, detectKey, parseKey, shiftKey, keyPrefersFlat, keyName } from './chord.js';
import { normalizePasted, isChordLine } from './sheet.js';
import { mcToSheet } from './mcsheet.js';

// [C] の中のコードを n 半音ずらす({key:} もいっしょに)。♯/♭ はずらした後のキーに合わせる
export function transposeText(text, n) {
  if (!n) return text;
  const chords = [...String(text).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const flat = keyPrefersFlat(shiftKey(detectKey(chords), n));
  return String(text)
    .replace(/\[([^\]]+)\]/g, (all, c) => {
      const ch = parseChord(c);
      return ch && !ch.special ? `[${chordName(ch, n, flat)}]` : all;
    })
    .replace(/\{key:\s*([^}]*)\}/gi, (all, k) => {
      const pk = parseKey(k);
      return pk ? `{key:${keyName(pk, n).replace(/♯/g, '#').replace(/♭/g, 'b')}}` : all;
    });
}

// J-Total: 「C / C / C /」のような、/ で小節を区切ったコードだけの行 → |[C] |[C] |[C] |
function slashBars(line) {
  if (!/\s\/(\s|$)/.test(line) || !isChordLine(line)) return null;
  const bars = line.split('/').map((b) => b.trim());
  if (bars[bars.length - 1] === '') bars.pop();
  if (!bars.length) return null;
  return '|' + bars.map((b) => b.split(/[\s　]+/).filter(Boolean).map((c) => `[${c}]`).join(' ') + ' ').join('|') + '|';
}

export function jtotalText(raw) {
  const lines = String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => slashBars(l) ?? l);
  // 歌詞の行の頭の全角空白(位置合わせ用)は落とす:「[D]　風の」→「[D]風の」
  return normalizePasted(lines.join('\n'))
    .split('\n')
    .map((l) => l.replace(/^((?:\[[^\]]+\])*)　+/, '$1'))
    .join('\n');
}

// r: Edge Function の sheet の結果。krc(): 歌詞の1文字ずつの時刻を取ってくる関数(コード進行メモ倉庫のときだけ使う)
// 戻り値: { text, key, bpm }
export async function sheetFromFetched(r, { krc = null } = {}) {
  if (r.mc) {
    let lines = null;
    try {
      lines = krc ? await krc() : null;
    } catch {}
    const out = mcToSheet(r.mc, { krc: lines?.length ? lines : null });
    return { text: out.text, key: out.key, bpm: out.bpm || r.bpm || null, aligned: out.aligned };
  }
  let text = String(r.text || '');
  if (r.format === 'plain') text = jtotalText(text);
  if (r.capo) text = transposeText(text, r.capo);
  // 元のキーが分かっていれば書いておく(J-Total の「Original Key」)
  if (r.key && !/\{key:/i.test(text)) text = `{key:${r.key}}\n` + text;
  return { text, key: r.key || null, bpm: r.bpm || null };
}
