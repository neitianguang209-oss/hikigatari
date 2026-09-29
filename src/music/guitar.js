// ギター: 押さえ方(ボイシング)の算出・難しさの点数・カポ位置の最適化・かんたんコード化
import { parseChord, chordIntervals, chordName, noteName, keyPrefersFlat, shiftKey } from './chord.js';

const TUNING = [40, 45, 50, 55, 59, 64]; // 6弦 → 1弦 (E A D G B E)
const mod12 = (n) => ((n % 12) + 12) % 12;

// よく使う形は、教本どおりの押さえ方を優先する [名前, フレット(6弦→1弦), 指番号(T=親指)]
// 同じコードが複数あるときは、先に書いたものが「標準の形」(通常モードで出す形)。
// 後ろの形(省略形など)は、かんたんモードで押さえやすさを比べる候補になる
const CURATED = [
  // 標準の形(バレーコードは教本どおりのセーハ)
  ['Bm7', 'x24232', 'x13121'],
  ['Gm', '355333', '134111'],
  ['Cm', 'x35543', 'x13421'],
  ['Gm7', '353333', '131111'],
  ['Cm7', 'x35343', 'x13141'],
  ['Fm7', '131111', '131111'],
  ['Bbm', 'x13321', 'x13421'],
  ['Ebm', 'x68876', 'x13421'],
  ['Eb', 'x68886', 'x13331'],
  ['Ab', '466544', '134211'],
  ['Db', 'x46664', 'x13331'],
  ['F#', '244322', '134211'],
  ['F#7', '242322', '131211'],
  ['C#7', 'x46464', 'x13141'],
  ['Bb7', 'x13131', 'x13141'],
  ['BM7', 'x24342', 'x13241'],
  ['F#m7-5', '2x221x', '2x341x'],
  ['Dm7-5', 'xx0111', 'xx0111'],
  ['Gsus4', '330013', '230014'],
  ['Csus4', 'x33011', 'x34011'],
  ['C/E', '032010', '032010'],
  ['D/A', 'x00232', 'x00132'],
  ['G6', '320000', '210000'],
  ['C6', 'x32210', 'x42310'],
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
  ['E/G#', '4x2100', '4x2100'],
  // 省略形(セーハを減らした形)。かんたんモードの候補
  ['F', 'xx3211', 'xx3211'],
  ['Fm', 'xx3111', 'xx3111'],
  ['F7', 'xx1211', 'xx1211'],
  ['Fm7', 'xx1111', 'xx1111'],
  ['Bm', 'xx4432', 'xx3421'],
  ['B', 'xx4442', 'xx2341'],
  ['Bb', 'xx3331', 'xx2341'],
  ['Bbm', 'xx3321', 'xx3421'],
  ['F#m', 'xx4222', 'xx3111'],
  ['F#m7', 'xx2222', 'xx1111'],
  ['F#', 'xx4322', 'xx3211'],
  ['C#m', 'xx2120', 'xx2130'],
  ['C#m7', 'x42100', 'x32100'],
  ['Db', 'xx3121', 'xx3121'],
  ['Eb', 'xx1343', 'xx1243'],
  ['Ab', 'xx6544', 'xx3211'],
  ['G#m', 'xx6444', 'xx3111'],
  ['Gm', 'xx5333', 'xx3111'],
  ['Gm7', 'xx3333', 'xx1111'],
  ['Cm', 'xx5543', 'xx3421'],
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
  // 一部の弦だけのセーハ(小さい F の1・2弦など)も、はじめのうちはかなり難しい
  const barre = v.barre ? (v.barre.full ? 2.2 : 1.3) : 0;
  let d = 0.5 * v.nFingers + barre + 0.35 * v.span + 1.2 * v.innerMutes + (v.minF >= 5 ? 0.3 + 0.08 * (v.minF - 5) : 0);
  d += 0.15 * v.leadMutes + 0.9 * v.trailMutes + (v.sounding < 4 ? 1.5 : v.sounding === 4 ? 0.3 : 0);
  if (v.fingers.includes('T')) d += 0.8;
  // 同じフレットのとなり合う3本の弦を、別々の指で押さえる形(小さい B など)は窮屈
  let run = 1;
  for (let i = 1; i < 6; i++) {
    const f = v.frets[i];
    if (f > 0 && f === v.frets[i - 1] && v.fingers[i] !== v.fingers[i - 1]) {
      if (++run === 3) d += 0.6;
    } else run = 1;
  }
  return d;
}

// 教本に載っていないコードの「標準の形」の選び方: セーハは減点しない。
// 6弦・5弦から全部の弦を鳴らす、低いフレットの形を選ぶ(ふつうに習う押さえ方)
function standardScore(v) {
  return (
    1.5 * v.innerMutes + 1.0 * v.trailMutes + 0.15 * v.leadMutes - 0.35 * v.sounding + 0.25 * v.minF + 0.3 * v.span +
    (v.fingers.includes('T') ? 0.6 : 0) + (v.nFingers > 4 ? 5 : 0)
  );
}

// かんたんモードで並べる順(小さいほど先)。教本・定番の省略形を優先し、見慣れない形は後ろへ。
// 見慣れない形 = 押さえた弦(3フレット以上)ではさまれた開放弦がある・4フレットより上の形に開放弦がまざる
export function easeRank(v) {
  let r = voicingDifficulty(v);
  if (v.curated) return r - 0.8;
  const fr = v.frets;
  for (let i = 1; i < 5; i++) {
    if (fr[i] !== 0) continue;
    let l = -1;
    let rr = -1;
    for (let k = i - 1; k >= 0; k--) if (fr[k] > 0) { l = fr[k]; break; }
    for (let k = i + 1; k < 6; k++) if (fr[k] > 0) { rr = fr[k]; break; }
    if (l > 0 && rr > 0 && Math.max(l, rr) >= 3) r += 0.5;
  }
  if (v.opens && v.minF >= 4) r += 0.6;
  r += 0.4 * v.trailMutes; // 1弦側を鳴らさない形は、ストロークでつい鳴らしてしまう
  return r;
}

const voicingCache = new Map();

// そのコードの押さえ方の候補(弾きやすい順)。標準の形には standard: true が付く
export function guitarVoicings(name) {
  if (voicingCache.has(name)) return voicingCache.get(name);
  const ch = parseChord(name);
  let list = [];
  if (ch && !ch.special && !ch.bassOnly) {
    const cur = curated().get(signature(ch)) || [];
    const gen = searchVoicings(ch).slice(0, 16);
    const seen = new Set();
    for (const v of [...cur.map((x) => ({ ...x, curated: true })), ...gen]) {
      const k = v.frets.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ ...v });
    }
    // 標準の形: 教本の形があればその先頭、無ければ standardScore が一番小さい形
    const std = list.find((v) => v.curated) || [...list].sort((a, b) => standardScore(a) - standardScore(b))[0];
    if (std) std.standard = true;
    // やさしい順。教本の形は少しだけ優先する(見慣れた形のほうが覚えやすい)。
    // 教本の形・標準の形(Bm のセーハなど)は難しくても必ず候補に残す
    list = list.sort((a, b) => easeRank(a) - easeRank(b)).filter((v, i) => i < 8 || v.curated || v.standard);
  }
  voicingCache.set(name, list);
  return list;
}

// 通常モードで出す形(教本どおり。F や B はセーハ)
export function standardVoicing(name) {
  const vs = guitarVoicings(name);
  return vs.find((v) => v.standard) || vs[0] || null;
}

const diffCache = new Map();
// いちばんやさしい形の難しさ(かんたんモードの比較に使う)
export function chordDifficulty(name) {
  if (diffCache.has(name)) return diffCache.get(name);
  const vs = guitarVoicings(name);
  const d = vs.length ? voicingDifficulty(vs[0]) : 9;
  diffCache.set(name, d);
  return d;
}

const stdDiffCache = new Map();
// 標準の形の難しさ(通常モードでカポ位置を比べるのに使う)
export function standardDifficulty(name) {
  if (stdDiffCache.has(name)) return stdDiffCache.get(name);
  const v = standardVoicing(name);
  const d = v ? voicingDifficulty(v) : 9;
  stdDiffCache.set(name, d);
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

// かんたんモード: 押さえにくいコードを、響きの近い押さえやすいコードに置き換える。
// 候補は「分数コードの下の音をやめる」「テンションを外す」「3和音にする」「F→FM7・Bm→Bm7 のように7th系にする」。
// 置き換えるたびに少しずつ減点し、それでもはっきり押さえやすくなるときだけ置き換える。
// shapeKey(カポをつけて弾く形のキー)は、M7 と 7 のどちらに寄せるかの判断に使う
export function easyName(name, shapeKey = null) {
  const ch = parseChord(name);
  if (!ch || ch.special || ch.bassOnly) return name;
  // もともと押さえやすいコード(開放弦の C・G・A など)は、響きを変えないようにそのまま
  if (chordDifficulty(name) < 2.9) return name;
  const root = ch.rootName;
  const tri = triadSuffix(ch);
  const cands = [[name, 0]];
  const add = (n, pen) => {
    if (parseChord(n) && !cands.some((c) => c[0] === n)) cands.push([n, pen]);
  };
  add(root + ch.suffix, 0.25);
  add(root + seventhSuffix(ch), 0.3);
  add(root + tri, 0.45);
  // I・IV(短調なら III・VI)は M7 に、それ以外(属和音やその仲間)は 7 に寄せると響きが崩れにくい
  const deg = shapeKey ? mod12(ch.root - shapeKey.pc) : null;
  const restful = deg == null ? true : shapeKey.minor ? deg === 3 || deg === 8 : deg === 0 || deg === 5;
  if (tri === '' && !ch.st.seventh) {
    add(root + 'M7', restful ? 0.5 : 1.0);
    add(root + '7', restful ? 2.5 : 0.6);
  }
  if (tri === 'm' && !ch.st.seventh) add(root + 'm7', 0.4);
  let best = cands[0];
  let bestCost = chordDifficulty(best[0]);
  for (const [n, pen] of cands.slice(1)) {
    const cost = chordDifficulty(n) + pen;
    if (cost < bestCost - 0.45) {
      best = [n, pen];
      bestCost = cost;
    }
  }
  return best[0];
}

// ---------------------------------------------------------------- 曲を通して押さえ方を選ぶ

// ある形から次の形へ持ちかえる大変さ(フレットの移動・押さえ直す指の数・セーハの付け外し)
function moveCost(a, b) {
  const pos = (v) => {
    const f = v.frets.filter((x) => x > 0);
    return f.length ? f.reduce((s, x) => s + x, 0) / f.length : 0;
  };
  const spots = (v) => new Set(v.frets.map((f, i) => (f > 0 ? `${i}:${f}` : null)).filter(Boolean));
  const pa = spots(a);
  const pb = spots(b);
  let placed = 0;
  let kept = 0;
  for (const p of pb) pa.has(p) ? kept++ : placed++;
  let c = Math.abs(pos(a) - pos(b)) * 0.35 + placed * 0.3 - kept * 0.15;
  const bw = (v) => (v.barre ? (v.barre.full ? 0.6 : 0.25) : 0);
  if (!!a.barre !== !!b.barre) c += Math.max(bw(a), bw(b));
  else if (a.barre && b.barre && a.barre.fret !== b.barre.fret) c += 0.3;
  return Math.max(0, c);
}

// 曲に出てくる順のコード名から、コードごとに見せる押さえ方(フレットを","でつないだ文字列)を決める。
// 通常モード: 教本どおりの標準の形。
// かんたんモード: 押さえやすさと、前後のコードへの持ちかえやすさの合計が小さくなる組み合わせを選ぶ
export function planVoicings(seq, easy) {
  const names = [...new Set(seq)].filter((n) => guitarVoicings(n).length);
  const plan = new Map();
  if (!easy) {
    for (const n of names) plan.set(n, standardVoicing(n).frets.join(','));
    return plan;
  }
  const count = new Map();
  const pair = new Map(); // "A|B" → 回数(並び順は問わない)
  for (let i = 0; i < seq.length; i++) {
    count.set(seq[i], (count.get(seq[i]) || 0) + 1);
    const a = seq[i];
    const b = seq[i + 1];
    if (b == null || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    pair.set(k, (pair.get(k) || 0) + 1);
  }
  const nbrs = new Map(names.map((n) => [n, []]));
  for (const [k, c] of pair) {
    const [a, b] = k.split('|');
    if (nbrs.has(a) && nbrs.has(b)) {
      nbrs.get(a).push([b, c]);
      nbrs.get(b).push([a, c]);
    }
  }
  // 候補は「いちばん押さえやすい形から大きく離れない形」だけ(つながりのためだけに見慣れない形を選ばない)
  const cands = new Map(
    names.map((n) => {
      const vs = guitarVoicings(n);
      const lim = easeRank(vs[0]) + 1.0;
      return [n, vs.filter((v) => easeRank(v) <= lim).slice(0, 5)];
    }),
  );
  const pick = new Map(names.map((n) => [n, cands.get(n)[0]]));
  const costOf = (n, v) => {
    let c = (count.get(n) || 1) * easeRank(v);
    for (const [m, times] of nbrs.get(n)) c += times * moveCost(v, pick.get(m));
    return c;
  };
  // 1つずつ「ほかを固定して一番よい形」に選び直すのを、変わらなくなるまで繰り返す
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const n of names) {
      let best = pick.get(n);
      let bestCost = costOf(n, best);
      for (const v of cands.get(n)) {
        const c = costOf(n, v);
        if (c < bestCost - 1e-6) {
          best = v;
          bestCost = c;
        }
      }
      if (best !== pick.get(n)) {
        pick.set(n, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [n, v] of pick) plan.set(n, v.frets.join(','));
  return plan;
}

// ---------------------------------------------------------------- カポ

// 実際に鳴るコード名 → カポをつけたときに押さえる形の名前(かんたんモードなら置き換え後)
export function shapeName(name, capo, shapeKey, easy) {
  const ch = parseChord(name);
  if (!ch) return name;
  const flat = shapeKey ? keyPrefersFlat(shapeKey) : false;
  const shaped = chordName(ch, -capo, flat);
  return easy ? easyName(shaped, shapeKey) : shaped;
}

// カポ 0〜maxCapo それぞれの弾きやすさを採点する。
// 通常モードは標準の形(セーハ込み)、かんたんモードは置き換え後のいちばんやさしい形で比べる
export function rankCapos(counts, soundingKey, { easy = false, maxCapo = 7 } = {}) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    const sk = shiftKey(soundingKey, -capo);
    let sum = 0;
    let hard = 0;
    const shapes = new Map();
    for (const [name, n] of counts) {
      const sh = shapeName(name, capo, sk, easy);
      const d = easy ? chordDifficulty(sh) : standardDifficulty(sh);
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
