// コード名の読み取り・移調・構成音・キー判定

export const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const mod12 = (n) => ((n % 12) + 12) % 12;

export function noteName(pc, flat) {
  return (flat ? FLAT : SHARP)[mod12(pc)];
}

function letterPc(letter, acc) {
  return mod12(LETTER[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0));
}

// 表記ゆれをそろえる(全角・♯♭・△・maj・on表記など)
export function cleanChordText(raw) {
  let s = String(raw || '')
    .normalize('NFKC')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/[−–—‐]/g, '-')
    .replace(/[△Δ]/g, 'M')
    .replace(/maj/gi, 'M')
    .replace(/ø/g, 'm7-5')
    .replace(/°/g, 'dim')
    .replace(/\s+/g, '');
  // 分数コード: AonC# / A(onC#) / A/C#
  s = s.replace(/\(?on([A-G][#b]?)\)?$/, '/$1');
  return s;
}

// サフィックス(C の後ろ)を構成音の情報に分解する。読めなければ null
function parseSuffix(sfx) {
  const st = { third: 4, fifth: 7, seventh: null, six: false, ext: new Set() };
  if (sfx === '5') return { ...st, third: null, power: true };
  let s = sfx;
  let i = 0;
  let paren = false;
  const rest = () => s.slice(i);
  const eat = (re) => {
    const m = rest().match(re);
    if (m) i += m[0].length;
    return m;
  };
  const tension = (n) => {
    if (n === '9' || n === '2') st.ext.add(2);
    else if (n === '11' || n === '4') st.ext.add(5);
    else if (n === '13' || n === '6') st.ext.add(9);
  };
  let m;
  // 先頭の種類(マイナー系・dim・aug)
  if ((m = eat(/^(mM|m\(M\)|minM|-M)(7|9|11|13)?/))) {
    st.third = 3;
    st.seventh = 11;
    if (m[2] && m[2] !== '7') tension(m[2]);
  } else if (eat(/^(dim7|o7)/)) {
    st.third = 3;
    st.fifth = 6;
    st.seventh = 9;
  } else if (eat(/^(dim|o)(?![a-z])/)) {
    st.third = 3;
    st.fifth = 6;
  } else if (eat(/^(aug|\+)(?![59]|11)/)) {
    st.fifth = 8;
  } else if (eat(/^(min|m|-)(?!aj)/)) {
    st.third = 3;
  }
  while (i < s.length) {
    if (eat(/^\(/)) { paren = true; continue; }
    if (eat(/^\)/)) { paren = false; continue; }
    if (paren && eat(/^[,/]/)) continue;
    if ((m = eat(/^M(7|9|11|13)/))) { st.seventh = 11; if (m[1] !== '7') tension(m[1]); continue; }
    if (eat(/^M/)) continue;
    if (eat(/^(sus4|sus(?!2))/)) { st.third = 'sus4'; continue; }
    if (eat(/^sus2/)) { st.third = 'sus2'; continue; }
    if ((m = eat(/^add(9|2|11|4|13|6)/))) { tension(m[1]); continue; }
    if (eat(/^(omit|no)3/)) { st.third = null; continue; }
    if (eat(/^(omit|no)5/)) { st.fifth = null; continue; }
    if (eat(/^(b|-)5/)) { st.fifth = 6; continue; }
    if (eat(/^(#|\+)5/)) { st.fifth = 8; continue; }
    if (eat(/^(b|-)9/)) { st.ext.add(1); continue; }
    if (eat(/^(#|\+)9/)) { st.ext.add(3); continue; }
    if (eat(/^(#|\+)11/)) { st.ext.add(6); continue; }
    if (eat(/^(b|-)13/)) { st.ext.add(8); continue; }
    if (eat(/^alt/)) { st.ext.add(1); st.ext.add(3); continue; }
    if (eat(/^aug/)) { st.fifth = 8; continue; }
    if (eat(/^dim/)) { st.fifth = 6; continue; }
    if ((m = eat(/^(69|6\/9)/))) { st.six = true; st.ext.add(2); continue; }
    if ((m = eat(/^(13|11|9|7|6|2|4)/))) {
      const n = m[1];
      if (paren) { tension(n); continue; }
      if (n === '7') { if (st.seventh == null) st.seventh = 10; continue; }
      if (n === '6') { st.six = true; continue; }
      if (n === '2') { st.ext.add(2); continue; }
      if (n === '4') { st.third = 'sus4'; continue; }
      if (st.seventh == null) st.seventh = 10;
      if (n === '9') st.ext.add(2);
      if (n === '11') { st.ext.add(2); st.ext.add(5); }
      if (n === '13') { st.ext.add(2); st.ext.add(9); }
      continue;
    }
    return null; // 知らない書き方
  }
  return st;
}

const parseCache = new Map();

// "D/F#" → { root:2, rootName:'D', suffix:'', bass:6, bassName:'F#', st:{...} }
export function parseChord(raw) {
  if (raw == null) return null;
  const key = String(raw);
  if (parseCache.has(key)) return parseCache.get(key);
  const res = parseChordUncached(key);
  parseCache.set(key, res);
  return res;
}

function parseChordUncached(raw) {
  const s = cleanChordText(raw);
  if (!s) return null;
  if (/^N\.?C\.?$/i.test(s)) return { special: 'N.C.' };
  // "/G#" だけ = ベース音だけ変える指示
  let m = s.match(/^\/([A-G])([#b]?)$/);
  if (m) {
    const pc = letterPc(m[1], m[2]);
    return { bassOnly: true, root: pc, rootName: m[1] + m[2], suffix: '', bass: pc, bassName: m[1] + m[2], st: { third: null, fifth: null, seventh: null, six: false, ext: new Set() } };
  }
  m = s.match(/^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/);
  if (!m) return null;
  const st = parseSuffix(m[3]);
  if (!st) return null;
  const root = letterPc(m[1], m[2]);
  const bass = m[4] ? letterPc(m[4], m[5]) : null;
  return {
    root,
    rootName: m[1] + m[2],
    suffix: m[3],
    bass: bass === root ? null : bass,
    bassName: m[4] ? m[4] + m[5] : null,
    st,
    flatHint: m[2] === 'b' || m[5] === 'b',
  };
}

export function isChord(raw) {
  return !!parseChord(raw);
}

// 構成音(ルートからの半音数)を低い順に。ピアノの積み方に使う
export function chordIntervals(ch) {
  if (!ch || ch.special) return [];
  if (ch.bassOnly) return [{ semi: 0, label: 'R' }];
  const { st } = ch;
  const out = [{ semi: 0, label: 'R' }];
  if (st.third === 4) out.push({ semi: 4, label: '3' });
  else if (st.third === 3) out.push({ semi: 3, label: 'm3' });
  else if (st.third === 'sus4') out.push({ semi: 5, label: '4' });
  else if (st.third === 'sus2') out.push({ semi: 2, label: '2' });
  if (st.fifth === 7) out.push({ semi: 7, label: '5' });
  else if (st.fifth === 6) out.push({ semi: 6, label: '♭5' });
  else if (st.fifth === 8) out.push({ semi: 8, label: '♯5' });
  if (st.six) out.push({ semi: 9, label: '6' });
  if (st.seventh === 10) out.push({ semi: 10, label: '♭7' });
  else if (st.seventh === 11) out.push({ semi: 11, label: 'M7' });
  else if (st.seventh === 9) out.push({ semi: 9, label: '°7' });
  const T = { 1: ['♭9', 13], 2: ['9', 14], 3: ['♯9', 15], 5: ['11', 17], 6: ['♯11', 18], 8: ['♭13', 20], 9: ['13', 21] };
  for (const e of [...st.ext].sort((a, b) => a - b)) {
    if (st.six && e === 9) continue;
    // add9 系で7度が無いときは、9度を近くに置く(ピアノで押さえやすい)
    const [label, semi] = T[e];
    out.push({ semi, label });
  }
  return out;
}

export function chordPcs(ch) {
  const set = new Set(chordIntervals(ch).map((x) => mod12(ch.root + x.semi)));
  if (ch.bass != null) set.add(ch.bass);
  return set;
}

// 表示名を組み立てる(移調つき)
export function chordName(ch, shift = 0, flat = false) {
  if (!ch) return '';
  if (ch.special) return ch.special;
  if (ch.bassOnly) return '/' + noteName(ch.bass + shift, flat);
  const r = noteName(ch.root + shift, flat);
  const b = ch.bass != null ? '/' + noteName(ch.bass + shift, flat) : '';
  return r + ch.suffix + b;
}

export function transposeName(raw, shift, flat) {
  const ch = parseChord(raw);
  if (!ch) return raw;
  return chordName(ch, shift, flat);
}

// 画面用: # → ♯、b → ♭
export function pretty(name) {
  if (!name) return '';
  return String(name)
    .replace(/^([A-G])#/, '$1♯')
    .replace(/^([A-G])b/, '$1♭')
    .replace(/\/([A-G])#/, '/$1♯')
    .replace(/\/([A-G])b/, '/$1♭')
    .replace(/(^|[^A-Za-z])b(?=\d)/g, '$1♭')
    .replace(/#(?=\d)/g, '♯')
    .replace(/-(?=5)/g, '♭');
}

// ---------------------------------------------------------------- キー

// 調号で♭を使うキー
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

export function keyPrefersFlat(key) {
  if (!key) return false;
  return key.minor ? FLAT_MINOR.has(mod12(key.pc)) : FLAT_MAJOR.has(mod12(key.pc));
}

export function parseKey(text) {
  if (!text) return null;
  const s = cleanChordText(text).replace(/major|メジャー|長調/gi, '').replace(/minor|マイナー|短調/gi, 'm');
  const m = s.match(/^([A-G])([#b]?)(m?)/);
  if (!m) return null;
  return { pc: letterPc(m[1], m[2]), minor: m[3] === 'm' };
}

export function keyName(key, shift = 0) {
  if (!key) return '';
  const k = { pc: mod12(key.pc + shift), minor: key.minor };
  return pretty(noteName(k.pc, keyPrefersFlat(k)) + (k.minor ? 'm' : ''));
}

export function shiftKey(key, shift) {
  return key ? { pc: mod12(key.pc + shift), minor: key.minor } : null;
}

function quality(ch) {
  const t = ch.st.third;
  if (t === 3 && ch.st.fifth === 6) return 'd';
  if (t === 3) return 'm';
  if (t === 4) return 'M';
  return 'o';
}

// 使われているコードから調を推定する(譜面にキーが書かれていないとき用)
export function detectKey(chordList) {
  const list = chordList.map(parseChord).filter((c) => c && !c.special && !c.bassOnly);
  if (!list.length) return { pc: 0, minor: false };
  const DEG = { 0: 'M', 2: 'm', 4: 'm', 5: 'M', 7: 'M', 9: 'm', 11: 'd' };
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    let s = 0;
    list.forEach((ch, idx) => {
      const rel = mod12(ch.root - tonic);
      const q = quality(ch);
      const w = idx === 0 || idx === list.length - 1 ? 2.5 : 1;
      if (rel in DEG) s += w * (DEG[rel] === q || (q === 'o' && DEG[rel] !== 'd') ? 2 : 1);
      else s -= w * 1.5;
      if (rel === 0 && q === 'M') s += w * 0.8;
      if (rel === 7 && ch.st.seventh === 10) s += 0.6;
    });
    if (!best || s > best.s) best = { s, tonic };
  }
  // 平行短調かどうか: 始まりと終わりが vi(マイナー)なら短調とみなす
  const first = list[0];
  const last = list[list.length - 1];
  const rel6 = mod12(best.tonic + 9);
  const isVi = (c) => c.root === rel6 && quality(c) === 'm';
  const isI = (c) => c.root === best.tonic && quality(c) === 'M';
  if ((isVi(first) && !isI(last)) || (isVi(last) && isVi(first))) return { pc: rel6, minor: true };
  return { pc: best.tonic, minor: false };
}

// ---------------------------------------------------------------- 音名

const SOLFEGE = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const SOLFEGE_FLAT = ['ド', 'レ♭', 'レ', 'ミ♭', 'ミ', 'ファ', 'ソ♭', 'ソ', 'ラ♭', 'ラ', 'シ♭', 'シ'];

export function solfege(pc, flat) {
  return (flat ? SOLFEGE_FLAT : SOLFEGE)[mod12(pc)];
}
