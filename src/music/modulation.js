// 転調の見つけ方
// 行ごとに「どの調(長調の主音)なら、その行のコードが素直に説明できるか」を採点し、
// 調を切り替えるたびに罰点をつけた最短経路(ビタビ法)で、曲全体の調の流れを決める。
// 短い寄り道(2〜3行だけ別の調っぽい)は転調とみなさない
import { parseChord, parseKey } from './chord.js';

const mod12 = (n) => ((n % 12) + 12) % 12;
const SWITCH = 5; // 調を切り替える罰点(コード5つぶんの「合わなさ」)
const MIN_LINES = 4; // 転調とみなす最短の長さ(コードのある行)
const MIN_CHORDS = 12;

function quality(ch) {
  const st = ch.st;
  if (st.third === 'sus4' || st.third === 'sus2' || st.power || st.third == null) return 'sus';
  if (st.third === 3) return st.fifth === 6 ? 'dim' : 'min';
  if (st.fifth === 8) return 'aug';
  return st.seventh === 10 ? 'dom' : 'maj';
}

const DIATONIC = { 0: 'maj', 2: 'min', 4: 'min', 5: 'maj', 7: 'maj', 9: 'min', 11: 'dim' };

// 長調の主音 t から見た、コードの合い具合(0〜1)
function fit(ch, t) {
  const d = mod12(ch.root - t);
  const q = quality(ch);
  const want = DIATONIC[d];
  if (want) {
    if (q === want || q === 'sus' || (d === 7 && q === 'dom')) return 1;
    if ((d === 2 || d === 4 || d === 9 || d === 0) && (q === 'maj' || q === 'dom')) return 0.6; // 副属和音(E7 → Am など)
    if (d === 5 && q === 'min') return 0.5; // IVm(借用和音)
    return 0.3;
  }
  if ((d === 10 || d === 8 || d === 3) && (q === 'maj' || q === 'dom')) return 0.5; // ♭VII ♭VI ♭III(借用和音)
  return 0;
}

const signedShift = (s) => (s > 6 ? s - 12 : s);

// lines: parseSheet の行 / baseKey: 原曲キー({ pc, minor }) / keyChanges: 譜面に書かれた途中の {key:}
// 返り値: { shifts: 行ごとの半音のずれ(0〜11), marks: [{ at: 印を出す行, shift: -5〜+6, from: 前のずれ }] }
export function detectModulation(lines, baseKey, keyChanges = []) {
  const n = lines.length;
  const shifts = new Array(n).fill(0);
  if (!baseKey || !n) return { shifts, marks: [] };
  const T = baseKey.minor ? mod12(baseKey.pc + 3) : baseKey.pc;
  const chordsOf = (l) => (l.segs ? l.segs.map((s) => s.c && parseChord(s.c)).filter((c) => c && !c.special && !c.bassOnly) : []);

  if (keyChanges.length) {
    // 譜面に書かれている転調をそのまま使う
    let cur = 0;
    const at = new Map();
    for (const kc of keyChanges) {
      const k = parseKey(kc.key);
      if (k) at.set(kc.at, mod12((k.minor ? k.pc + 3 : k.pc) - T));
    }
    for (let i = 0; i < n; i++) {
      if (at.has(i)) cur = at.get(i);
      shifts[i] = cur;
    }
  } else {
    const idx = [];
    const cost = [];
    for (let i = 0; i < n; i++) {
      const cs = chordsOf(lines[i]);
      if (!cs.length) continue;
      idx.push(i);
      cost.push(Array.from({ length: 12 }, (_, k) => cs.reduce((s, c) => s + (1 - fit(c, mod12(T + k))), 0)));
    }
    if (idx.length < MIN_LINES * 2) return { shifts, marks: [] };
    // ビタビ法: dp[k] = 行 j までを調 k で終える最小の罰点
    let dp = Array.from({ length: 12 }, (_, k) => cost[0][k] + (k ? SWITCH : 0));
    const back = [];
    for (let j = 1; j < idx.length; j++) {
      const best = Math.min(...dp);
      const arg = dp.indexOf(best);
      const nd = [];
      const bk = [];
      for (let k = 0; k < 12; k++) {
        const stay = dp[k];
        const move = best + SWITCH;
        nd.push(cost[j][k] + Math.min(stay, move));
        bk.push(stay <= move ? k : arg);
      }
      back.push(bk);
      dp = nd;
    }
    const path = new Array(idx.length);
    path[idx.length - 1] = dp.indexOf(Math.min(...dp));
    for (let j = idx.length - 1; j > 0; j--) path[j - 1] = back[j - 1][path[j]];
    // 短い寄り道は前の調にまとめる。まとめたら、つながった同じ調もまとめ直す
    const runs = [];
    for (let j = 0; j < idx.length; j++) {
      const last = runs[runs.length - 1];
      if (last && last.k === path[j]) last.to = j;
      else runs.push({ k: path[j], from: j, to: j });
    }
    const chordCount = (r) => {
      let c = 0;
      for (let j = r.from; j <= r.to; j++) c += chordsOf(lines[idx[j]]).length;
      return c;
    };
    const merged = [];
    for (const r of runs) {
      const long = r.to - r.from + 1 >= MIN_LINES && chordCount(r) >= MIN_CHORDS;
      const prev = merged[merged.length - 1];
      if (prev && (!long || prev.k === r.k)) prev.to = r.to;
      else merged.push({ ...r });
    }
    // 出だしの短いところ(イントロなど)は、続く調にまとめる
    if (merged.length > 1) {
      const first = merged[0];
      if (first.to - first.from + 1 < MIN_LINES || chordCount(first) < MIN_CHORDS) {
        merged[1].from = first.from;
        merged.shift();
      }
    }
    // 出だしの調を基準(ずれ 0)にする(原曲キーの表記がずれていても、転調の幅は変わらない)
    const k0 = merged.length ? merged[0].k : 0;
    for (const r of merged) for (let j = r.from; j <= r.to; j++) shifts[idx[j]] = mod12(r.k - k0);
    // コードの無い行(見出し・空行)は、直前のコードのある行に合わせる
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (chordsOf(lines[i]).length) cur = shifts[i];
      else shifts[i] = cur;
    }
  }

  // 転調の印: ずれが変わる最初のコード行。直前の見出し(「ラスサビ」など)の上に出す
  const marks = [];
  let prevShift = shifts[0];
  for (let i = 1; i < n; i++) {
    if (shifts[i] === prevShift) continue;
    let at = i;
    while (at > 0 && (lines[at - 1].type === 'label' || lines[at - 1].type === 'comment')) {
      at--;
      shifts[at] = shifts[i];
    }
    marks.push({ at, shift: signedShift(mod12(shifts[i] - prevShift)), total: signedShift(shifts[i]), from: prevShift, to: shifts[i] });
    prevShift = shifts[i];
  }
  return { shifts, marks };
}
