// ギター: 押さえ方(ボイシング)の算出・難しさの点数・カポ位置の最適化・かんたんコード化
import { parseChord, chordIntervals, chordName, noteName, keyPrefersFlat, shiftKey } from './chord.js';

const TUNING = [40, 45, 50, 55, 59, 64]; // 6弦 → 1弦 (E A D G B E)
const mod12 = (n) => ((n % 12) + 12) % 12;

// よく使う形は、教本どおりの押さえ方を優先する [名前, フレット(6弦→1弦), 指番号(T=親指)]
const CURATED = [
  ['C', 'x32010', 'x32010'],
  ['Cadd9', 'x32030', 'x21030'],
  ['CM7', 'x32000', 'x32000'],
  ['C7', 'x32310', 'x32410'],
  ['C/G', '332010', '342010'],
  ['D', 'xx0232', 'xx0132'],
  ['Dm', 'xx0231', 'xx0231'],
  ['D7', 'xx0212', 'xx0213'],
  ['DM7', 'xx0222', 'xx0111'],
  ['Dm7', 'xx0211', 'xx0211'],
  ['Dsus4', 'xx0233', 'xx0134'],
  ['Dsus2', 'xx0230', 'xx0130'],
  ['D/F#', '2x0232', 'Tx0132'],
  ['E', '022100', '023100'],
  ['Em', '022000', '023000'],
  ['E7', '020100', '020100'],
  ['Em7', '020000', '010000'],
  ['Em7', '022030', '012030'],
  ['EM7', '021100', '031200'],
  ['Esus4', '022200', '023400'],
  ['E7sus4', '020200', '010300'],
  ['F', '133211', '134211'],
  ['FM7', 'xx3210', 'xx3210'],
  ['Fm', '133111', '134111'],
  ['F7', '131211', '131211'],
  ['G', '320003', '210003'],
  ['G7', '320001', '320001'],
  ['GM7', '320002', '320001'],
  ['G/B', 'x20003', 'x10003'],
  ['A', 'x02220', 'x01230'],
  ['Am', 'x02210', 'x02310'],
  ['A7', 'x02020', 'x01020'],
  ['AM7', 'x02120', 'x02130'],
  ['Am7', 'x02010', 'x02010'],
  ['Asus4', 'x02230', 'x01240'],
  ['Asus2', 'x02200', 'x01200'],
  ['A7sus4', 'x02030', 'x01040'],
  ['Am/G', '3x2210', '4x2310'],
  ['B7', 'x21202', 'x21304'],
  ['Bm', 'x24432', 'x13421'],
  ['Bm7', 'x20202', 'x10203'],
  ['B', 'x24442', 'x12341'],
  ['Bb', 'x13331', 'x12341'],
  ['F#m', '244222', '134111'],
  ['F#m7', '242222', '131111'],
  ['C#m', 'x46654', 'x13421'],
  ['C#m7', 'x46454', 'x13121'],
  ['G#m', '466444', '134111'],
  ['Bm7-5', 'x2323x', 'x1324x'],
];

// 同じ構成音なら表記が違っても同じ形を使えるよう、構成音で引く
function signature(ch) {
  const ivs = chordIntervals(ch).map((x) => mod12(x.semi)).sort((a, b) => a - b).join(',');
  return `${mod12(ch.root)}|${ch.bass == null ? '-' : mod12(ch.bass)}|${ivs}`;
}

let curatedMap = null;
function curated() {
  if (curatedMap) return curatedMap;
  curatedMap = new Map();
  for (const [name, frets, fingers] of CURATED) {
    const ch = parseChord(name);
    const sig = signature(ch);
    const v = makeVoicing(
      [...frets].map((c) => (c === 'x' ? -1 : Number(c))),
      [...fingers].map((c) => (c === 'x' || c === '0' ? 0 : c === 'T' ? 'T' : Number(c))),
    );
    if (!curatedMap.has(sig)) curatedMap.set(sig, []);
    curatedMap.get(sig).push(v);
  }
  return curatedMap;
}

// 指の数・セーハ・フレットの幅などを数える
// fingers(指番号)が分かっていればそれでセーハを判定し、無ければ「指が5本以上要るときだけセーハ」とみなす
function analyze(frets, fingers) {
  const sounding = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
  const fretted = frets.filter((f) => f > 0);
  const minF = fretted.length ? Math.min(...fretted) : 0;
  const maxF = fretted.length ? Math.max(...fretted) : 0;
  const first = sounding[0];
  const last = sounding[sounding.length - 1];
  let innerMutes = 0;
  for (let i = first; i <= last; i++) if (frets[i] < 0) innerMutes++;
  const atMin = frets.map((f, i) => (f === minF && minF > 0 ? i : -1)).filter((i) => i >= 0);
  let barre = null;
  let nFingers = fretted.length;
  if (fingers) {
    const ones = fingers.map((f, i) => (f === 1 ? i : -1)).filter((i) => i >= 0);
    if (ones.length >= 2) barre = { fret: frets[ones[0]], from: ones[0], to: ones[ones.length - 1] };
    nFingers = new Set(fingers.filter((f) => f && f !== 'T')).size + (fingers.includes('T') ? 1 : 0);
  } else if (fretted.length > 4 && atMin.length >= 2) {
    // 人差し指1本で、一番低いフレットの弦をまとめて押さえる(間の弦もそれ以上のフレットであること)
    const a = atMin[0];
    const b = atMin[atMin.length - 1];
    let ok = true;
    for (let i = a; i <= b; i++) if (frets[i] >= 0 && frets[i] < minF) ok = false;
    if (ok) {
      barre = { fret: minF, from: a, to: b };
      nFingers = 1 + fretted.filter((f) => f > minF).length;
    }
  }
  if (barre) barre.full = barre.to - barre.from >= 3;
  // 低音側・高音側でミュートする弦の数(高音側のミュートはストロークで鳴らしてしまいやすい)
  let leadMutes = 0;
  while (leadMutes < 6 && frets[leadMutes] < 0) leadMutes++;
  let trailMutes = 0;
  while (trailMutes < 6 && frets[5 - trailMutes] < 0) trailMutes++;
  return {
    sounding: sounding.length, innerMutes, leadMutes, trailMutes, minF, maxF,
    span: fretted.length ? maxF - minF : 0, barre, nFingers, opens: frets.filter((f) => f === 0).length,
  };
}

function makeVoicing(frets, fingers) {
  const a = analyze(frets, fingers);
  return { ...a, frets, fingers: fingers || assignFingers(frets, a) };
}

// 指番号を機械的に割り当てる(セーハは人差し指、残りはフレット順・弦順)
function assignFingers(frets, a) {
  const out = frets.map(() => 0);
  let next = 1;
  if (a.barre) {
    for (let i = 0; i < 6; i++) if (frets[i] === a.minF) out[i] = 1;
    next = 2;
  }
  const rest = frets
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f > 0 && out[i] === 0)
    .sort((x, y) => x.f - y.f || x.i - y.i);
  for (const { i } of rest) out[i] = Math.min(4, next++);
  return out;
}

// 構成音から押さえ方を探す(4フレット幅の窓を1つずつずらして全探索)
function searchVoicings(ch) {
  const ivs = chordIntervals(ch);
  const pcs = new Set(ivs.map((x) => mod12(ch.root + x.semi)));
  const bass = ch.bass != null ? ch.bass : ch.root;
  pcs.add(bass);
  // 省略してよいのは完全5度だけ。テンションが多いときは先頭2つまで必須
  const essential = new Set([mod12(ch.root)]);
  let tensions = 0;
  for (const x of ivs) {
    if (x.semi === 0 || x.semi === 7) continue;
    if (x.semi > 11) {
      if (tensions >= 1) continue;
      tensions++;
    }
    essential.add(mod12(ch.root + x.semi));
  }
  essential.add(bass);
  const found = new Map();
  for (let base = 0; base <= 11; base++) {
    const lo = Math.max(1, base);
    const hi = lo + 3;
    const opts = TUNING.map((open) => {
      const o = [-1];
      if (base <= 4 && pcs.has(mod12(open))) o.push(0);
      for (let f = lo; f <= hi; f++) if (pcs.has(mod12(open + f))) o.push(f);
      return o;
    });
    const cur = [];
    const rec = (s, started) => {
      if (s === 6) {
        evaluate(cur.slice());
        return;
      }
      for (const f of opts[s]) {
        if (!started && f >= 0 && mod12(TUNING[s] + f) !== bass) continue; // 一番低い音はベース音
        cur[s] = f;
        rec(s + 1, started || f >= 0);
      }
    };
    const evaluate = (frets) => {
      const key = frets.join(',');
      if (found.has(key)) return;
      const a = analyze(frets);
      if (a.sounding < Math.min(4, pcs.size + 1) || a.sounding < 3) return;
      if (a.innerMutes > 1 || a.span > 3 || a.nFingers > 4) return;
      const have = new Set(frets.map((f, i) => (f >= 0 ? mod12(TUNING[i] + f) : -1)).filter((x) => x >= 0));
      for (const e of essential) if (!have.has(e)) return;
      const v = { ...a, frets, fingers: assignFingers(frets, a) };
      v.score = voicingScore(v, have.has(mod12(ch.root + 7)) || !pcs.has(mod12(ch.root + 7)));
      found.set(key, v);
    };
    rec(0, false);
  }
  return [...found.values()].sort((x, y) => x.score - y.score);
}

function voicingScore(v, hasFifth) {
  let s = 0;
  s += v.minF * 0.35;
  s += v.nFingers * 0.6;
  s += v.barre ? (v.barre.full ? 1.6 : 0.7) : 0;
  s += v.span * 0.5;
  s += v.innerMutes * 2.5;
  s -= v.sounding * 0.5;
  s -= v.opens * 0.15;
  if (!hasFifth) s += 0.3;
  s += v.leadMutes * 0.2 + v.trailMutes * 1.2 + (v.sounding < 4 ? 2 : 0);
  return s;
}

// 弾きにくさ(大きいほど難しい)。カポ位置の比較と「かんたんコード」の判断に使う
export function voicingDifficulty(v) {
  if (!v) return 9;
  const barre = v.barre ? (v.barre.full ? 2.2 : 0.9) : 0;
  let d = 0.5 * v.nFingers + barre + 0.35 * v.span + 1.2 * v.innerMutes + (v.minF >= 5 ? 0.3 : 0);
  d += 0.15 * v.leadMutes + 0.9 * v.trailMutes + (v.sounding < 4 ? 1.5 : v.sounding === 4 ? 0.3 : 0);
  if (v.fingers.includes('T')) d += 0.8;
  return d;
}

const voicingCache = new Map();

// そのコードの押さえ方の候補(弾きやすい順)
export function guitarVoicings(name) {
  if (voicingCache.has(name)) return voicingCache.get(name);
  const ch = parseChord(name);
  let list = [];
  if (ch && !ch.special && !ch.bassOnly) {
    const cur = curated().get(signature(ch)) || [];
    const gen = searchVoicings(ch).slice(0, 12);
    const seen = new Set();
    for (const v of [...cur.map((x) => ({ ...x, curated: true })), ...gen]) {
      const k = v.frets.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(v);
    }
    // やさしい順。教本の形は少しだけ優先する(見慣れた形のほうが覚えやすい)
    const rank = (v) => voicingDifficulty(v) - (v.curated ? 0.5 : 0);
    list = list.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  }
  voicingCache.set(name, list);
  return list;
}

const diffCache = new Map();
export function chordDifficulty(name) {
  if (diffCache.has(name)) return diffCache.get(name);
  const vs = guitarVoicings(name);
  // 図で最初に見せる形(=一番やさしい形)の難しさ
  const d = vs.length ? voicingDifficulty(vs[0]) : 9;
  diffCache.set(name, d);
  return d;
}

// ---------------------------------------------------------------- かんたんコード

function triadSuffix(ch) {
  const t = ch.st.third;
  if (t === 'sus4') return 'sus4';
  if (t === 3 && ch.st.fifth === 6) return ch.st.seventh === 10 ? 'm7-5' : 'dim';
  if (ch.st.fifth === 8 && t === 4) return 'aug';
  if (t === 3) return 'm';
  return '';
}

function seventhSuffix(ch) {
  const tri = triadSuffix(ch);
  const sev = ch.st.seventh;
  if (tri === 'm7-5') return 'm7-5';
  if (tri === 'dim') return sev === 9 ? 'dim7' : 'dim';
  if (ch.st.six && !sev) return tri === 'm' ? 'm6' : tri === '' ? '6' : tri;
  if (sev === 10) return tri === 'm' ? 'm7' : tri === 'sus4' ? '7sus4' : tri === 'aug' ? 'aug7' : '7';
  if (sev === 11) return tri === 'm' ? 'mM7' : tri === '' ? 'M7' : tri;
  if (ch.st.third === 'sus2') return 'sus2';
  return tri;
}

// 響きをなるべく残したまま、押さえやすい形に置き換える
export function simplifyForGuitar(name) {
  const ch = parseChord(name);
  if (!ch || ch.special || ch.bassOnly) return name;
  const root = ch.rootName;
  const triad = root + triadSuffix(ch);
  const cands = [name, root + ch.suffix, root + seventhSuffix(ch), triad];
  const base = chordDifficulty(triad);
  for (const c of cands) {
    if (!parseChord(c)) continue;
    if (chordDifficulty(c) <= base + 0.4) return c;
  }
  return triad;
}

// ---------------------------------------------------------------- カポ

// 実際に鳴るコード名 → カポをつけたときに押さえる形の名前
export function shapeName(name, capo, shapeKey, simple) {
  const ch = parseChord(name);
  if (!ch) return name;
  const flat = shapeKey ? keyPrefersFlat(shapeKey) : false;
  const shaped = chordName(ch, -capo, flat);
  return simple ? simplifyForGuitar(shaped) : shaped;
}

// カポ 0〜maxCapo それぞれの弾きやすさを採点する
export function rankCapos(counts, soundingKey, { simple = true, maxCapo = 7 } = {}) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    const sk = shiftKey(soundingKey, -capo);
    let sum = 0;
    let hard = 0;
    const shapes = new Map();
    for (const [name, n] of counts) {
      const sh = shapeName(name, capo, sk, simple);
      const d = chordDifficulty(sh);
      sum += d * n;
      if (d >= 4) hard += n;
      shapes.set(name, sh);
    }
    const avg = sum / total;
    rows.push({ capo, avg, score: avg + capo * 0.06 + (capo > 5 ? 0.25 : 0), hardRatio: hard / total, shapes, shapeKey: sk });
  }
  const best = rows.reduce((a, b) => (b.score < a.score - 0.05 ? b : a), rows[0]);
  return { rows, best: best.capo };
}

export { noteName };
