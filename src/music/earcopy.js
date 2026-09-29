// 耳コピ: 曲の音からコード進行を推定する(計算はすべて端末の中。音はどこにも送らない)
// ① 11025Hz のモノラル音 → ② 短時間フーリエ変換 → ③ 時間方向のメディアンで打楽器の音を弱める
// ④ 12音の強さ(クロマ)と低音のクロマ → ⑤ 音の立ち上がりからテンポと拍の位置(動的計画法)
// ⑥ 拍ごとにコードの型と照合(低音が根音なら加点) → ⑦ キーを推定して、キーに合うコードを少し優先
// ⑧ 拍の流れをビタビ法でなめらかに(小節の頭・半分で変わりやすく) → ⑨ 小節ごとの譜面テキスト
import { noteName, keyPrefersFlat } from './chord.js';

export const SR = 11025;
const mod12 = (n) => ((n % 12) + 12) % 12;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- FFT(基数2)

function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // x の start から n 個に窓をかけて変換し、振幅を out(n/2+1)へ
  return function spectrum(x, start, out) {
    for (let i = 0; i < n; i++) {
      re[rev[i]] = (x[start + i] || 0) * win[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  };
}

// ---------------------------------------------------------------- 拍(テンポと拍の位置)

const OH = 128; // 立ち上がりを見る間隔(約11.6ミリ秒)
const ON = 1024;

async function onsetEnvelope(x, progress) {
  const fft = makeFFT(ON);
  const frames = Math.max(0, Math.floor((x.length - ON) / OH) + 1);
  const env = new Float32Array(frames);
  const mag = new Float32Array(ON / 2 + 1);
  let prev = new Float32Array(ON / 2 + 1);
  let cur = new Float32Array(ON / 2 + 1);
  for (let t = 0; t < frames; t++) {
    fft(x, t * OH, mag);
    let s = 0;
    for (let k = 1; k <= ON / 2; k++) {
      cur[k] = Math.log1p(10 * mag[k]);
      const d = cur[k] - prev[k];
      if (d > 0 && t) s += d;
    }
    env[t] = s;
    [prev, cur] = [cur, prev];
    if (t % 2000 === 0) {
      progress(t / frames);
      await tick();
    }
  }
  // 1秒ほどの移動平均を引いて、正の部分だけ残す
  const w = Math.round(SR / OH);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let t = 0; t < frames; t++) {
    acc += env[t];
    if (t >= w) acc -= env[t - w];
    const mean = acc / Math.min(t + 1, w);
    out[t] = Math.max(0, env[t] - mean);
  }
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / Math.max(1, frames)) || 1;
  for (let t = 0; t < frames; t++) out[t] /= sd;
  return out;
}

function estimateTempo(env) {
  const fps = SR / OH;
  const lo = Math.floor((60 / 200) * fps);
  const hi = Math.ceil((60 / 55) * fps);
  const ac = new Float64Array(hi + 2);
  for (let L = lo - 1; L <= hi + 1; L++) {
    let s = 0;
    for (let t = 0; t + L < env.length; t++) s += env[t] * env[t + L];
    ac[L] = s / Math.max(1, env.length - L);
  }
  let best = lo;
  let bestV = -Infinity;
  for (let L = lo; L <= hi; L++) {
    const bpm = (60 * fps) / L;
    // 105 前後をやや優先(16分のノリで倍のテンポに取りやすいのを防ぐ)
    const w = Math.exp(-0.5 * (Math.log2(bpm / 105) / 0.8) ** 2);
    const v = ac[L] * w;
    if (v > bestV) {
      bestV = v;
      best = L;
    }
  }
  // 放物線で補間して、1フレームより細かく
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const den = a - 2 * b + c;
  const period = den ? best + (0.5 * (a - c)) / den : best;
  return { period, bpm: (60 * fps) / period };
}

// Ellis(2007)の動的計画法: 立ち上がりの強いところを、だいたい一定の間隔でたどる
function trackBeats(env, period) {
  const n = env.length;
  const score = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const tight = 100;
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const v = score[tau] - tight * Math.log((t - tau) / period) ** 2;
      if (arg < 0 || v > best) {
        best = v;
        arg = tau;
      }
    }
    score[t] = env[t] + (arg >= 0 ? best : 0);
    from[t] = arg;
  }
  let t = n - 1;
  let bestEnd = -Infinity;
  for (let k = Math.max(0, n - Math.round(period)); k < n; k++) {
    if (score[k] > bestEnd) {
      bestEnd = score[k];
      t = k;
    }
  }
  const beats = [];
  while (t >= 0) {
    beats.push(t);
    t = from[t];
  }
  beats.reverse();
  // 秒に直す(窓の中心)
  return beats.map((f) => (f * OH + ON / 2) / SR);
}

// ---------------------------------------------------------------- クロマ(12音の強さ)

const CN = 4096;
const CH = 512;

async function chromaFrames(x, progress) {
  const fft = makeFFT(CN);
  const frames = Math.max(0, Math.floor((x.length - CN) / CH) + 1);
  const kLo = Math.floor((55 * CN) / SR);
  const kHi = Math.ceil((1760 * CN) / SR);
  const nb = kHi - kLo + 1;
  const mag = new Float32Array(CN / 2 + 1);
  const M = new Float32Array(frames * nb);
  for (let t = 0; t < frames; t++) {
    fft(x, t * CH, mag);
    for (let k = 0; k < nb; k++) M[t * nb + k] = mag[kLo + k];
    if (t % 300 === 0) {
      progress((0.6 * t) / frames);
      await tick();
    }
  }
  // 打楽器の音(時間方向に一瞬だけ強い音)を弱める: 前後9フレームのメディアン
  const H = new Float32Array(frames * nb);
  const win = new Float32Array(9);
  for (let k = 0; k < nb; k++) {
    for (let t = 0; t < frames; t++) {
      let m = 0;
      for (let d = -4; d <= 4; d++) {
        const tt = Math.min(frames - 1, Math.max(0, t + d));
        const v = M[tt * nb + k];
        let j = m++;
        while (j > 0 && win[j - 1] > v) {
          win[j] = win[j - 1];
          j--;
        }
        win[j] = v;
      }
      H[t * nb + k] = win[4];
    }
    if (k % 60 === 0) {
      progress(0.6 + (0.3 * k) / nb);
      await tick();
    }
  }
  // 周波数の箱 → 半音ごとの帯。低い音ほど帯に入る箱が少なく、高い音ほど多いので、
  // 帯の中で一番強い値をその半音の強さにする(箱の数の差で特定の音に偏らないように)
  const S_LO = 33;
  const S_HI = 90;
  const bands = [];
  for (let s = S_LO; s <= S_HI; s++) {
    const f = 440 * 2 ** ((s - 69) / 12);
    const a = Math.max(0, Math.floor((f * 2 ** (-0.5 / 12) * CN) / SR) - kLo);
    const b = Math.min(nb - 1, Math.ceil((f * 2 ** (0.5 / 12) * CN) / SR) - kLo);
    bands.push([a, Math.max(a, b)]);
  }
  const E = new Float32Array(bands.length);
  const tmp = [];
  const median = (arr, from, to) => {
    tmp.length = 0;
    for (let i = from; i <= to; i++) tmp.push(arr[i]);
    tmp.sort((x, y) => x - y);
    return tmp[tmp.length >> 1] || 1e-9;
  };
  const treble = new Float32Array(frames * 12);
  const bass = new Float32Array(frames * 12);
  const energy = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let e = 0;
    for (let i = 0; i < bands.length; i++) {
      let m = 0;
      for (let k = bands[i][0]; k <= bands[i][1]; k++) m = Math.max(m, H[t * nb + k]);
      E[i] = m;
      e += m;
    }
    energy[t] = e;
    // 周りの雑音(その帯域の中央値)よりどれだけ目立つか、だけを数える
    const mt = median(E, 45 - S_LO, S_HI - S_LO) + 1e-9;
    const mb = median(E, 0, 56 - S_LO) + 1e-9;
    for (let i = 0; i < bands.length; i++) {
      const s = S_LO + i;
      if (s >= 45 && s <= 86) treble[t * 12 + mod12(s)] += Math.max(0, Math.log(E[i] / mt));
      if (s <= 52) bass[t * 12 + mod12(s)] += Math.max(0, Math.log(E[i] / mb));
    }
  }
  progress(1);
  return { frames, treble, bass, energy, time: (t) => (t * CH + CN / 2) / SR };
}

// ---------------------------------------------------------------- コード

const TYPES = [
  { suf: '', iv: [0, 4, 7], w: [1, 1, 0.8], prior: 0 },
  { suf: 'm', iv: [0, 3, 7], w: [1, 1, 0.8], prior: 0 },
  // 4和音は、歌のメロディが7度に来ただけで選ばれやすいので控えめに(はっきり鳴っているときだけ)
  { suf: '7', iv: [0, 4, 7, 10], w: [1, 1, 0.8, 0.75], prior: -0.055 },
  { suf: 'm7', iv: [0, 3, 7, 10], w: [1, 1, 0.8, 0.75], prior: -0.06 },
  { suf: 'M7', iv: [0, 4, 7, 11], w: [1, 1, 0.8, 0.6], prior: -0.11 },
  { suf: 'sus4', iv: [0, 5, 7], w: [1, 1, 0.8], prior: -0.07 },
];
const TEMPLATES = [];
for (let r = 0; r < 12; r++) {
  for (let ti = 0; ti < TYPES.length; ti++) {
    const T = TYPES[ti];
    const v = new Float32Array(12);
    T.iv.forEach((iv, i) => (v[mod12(r + iv)] = T.w[i]));
    const n = Math.hypot(...v);
    for (let i = 0; i < 12; i++) v[i] /= n;
    TEMPLATES.push({ root: r, type: ti, v });
  }
}

const DIATONIC = { 0: [0, 4, 2], 2: [1, 3], 4: [1, 3], 5: [0, 4], 7: [0, 2], 9: [1, 3], 11: [] }; // 長調の度数 → 合う型
// 長調の主音 T から見た、そのコードの自然さ
function keyPrior(root, type, T) {
  if (T == null) return 0;
  const d = mod12(root - T);
  const ok = DIATONIC[d];
  if (ok && ok.includes(type)) return 0.05;
  if ((d === 2 || d === 4 || d === 9) && (type === 0 || type === 2)) return 0.015; // 副属和音
  if ((d === 10 || d === 8) && type === 0) return 0.01; // ♭VII ♭VI
  if (d === 5 && type === 1) return 0.005; // IVm
  if (d === 11 && type === 1) return 0.0; // viiø の代わりに m で出たとき
  return -0.035;
}

function beatFeatures(ch, beats) {
  const nB = beats.length - 1;
  const feats = [];
  let j = 0;
  for (let i = 0; i < nB; i++) {
    const t0 = beats[i];
    const t1 = beats[i + 1];
    const tr = new Float32Array(12);
    const bs = new Float32Array(12);
    let e = 0;
    let n = 0;
    while (j < ch.frames && ch.time(j) < t0) j++;
    for (let k = j; k < ch.frames && ch.time(k) < t1; k++) {
      for (let c = 0; c < 12; c++) {
        tr[c] += ch.treble[k * 12 + c];
        bs[c] += ch.bass[k * 12 + c];
      }
      e += ch.energy[k];
      n++;
    }
    // 12音のうち一番弱い音を引いて(ざわざわした音を除く)、長さ1にそろえる
    const mn = Math.min(...tr);
    for (let c = 0; c < 12; c++) tr[c] = Math.max(0, tr[c] - mn);
    const norm = Math.hypot(...tr) || 1;
    for (let c = 0; c < 12; c++) tr[c] /= norm;
    const bmx = Math.max(...bs) || 1;
    const bmn = Math.min(...bs);
    for (let c = 0; c < 12; c++) bs[c] = (bs[c] - bmn) / (bmx - bmn || 1);
    feats.push({ tr, bs, e: n ? e / n : 0 });
  }
  return feats;
}

function scoreBeats(feats, T) {
  const med = [...feats.map((f) => f.e)].sort((a, b) => a - b)[feats.length >> 1] || 1;
  return feats.map((f) => {
    const quiet = f.e < med * 0.25;
    const s = new Float32Array(TEMPLATES.length + 1);
    // いちばん強い低音
    let top = 0;
    for (let c = 1; c < 12; c++) if (f.bs[c] > f.bs[top]) top = c;
    for (let i = 0; i < TEMPLATES.length; i++) {
      const tp = TEMPLATES[i];
      const iv = TYPES[tp.type].iv;
      let d = 0;
      for (let c = 0; c < 12; c++) d += f.tr[c] * tp.v[c];
      // 低音(ベース)はコードの根音を決める手がかり。根音なら大きく、3度・5度(転回形)なら少し加点
      d += 0.2 * f.bs[tp.root] + 0.06 * Math.max(f.bs[mod12(tp.root + iv[1])], f.bs[mod12(tp.root + iv[2])]);
      // いちばん強い低音がコードの音に入っていなければ減点
      if (!iv.some((x) => mod12(tp.root + x) === top)) d -= 0.05;
      d += TYPES[tp.type].prior + keyPrior(tp.root, tp.type, T);
      s[i] = d;
    }
    s[TEMPLATES.length] = quiet ? 2 : 0.35; // 音がほとんど無い拍 = コードなし
    return s;
  });
}

// ビタビ法: 拍ごとの点数の合計 − コードを変える罰点 が最大になる並び
function viterbi(scores, changeCost) {
  const S = scores[0]?.length || 0;
  const n = scores.length;
  if (!n) return [];
  let dp = Float64Array.from(scores[0]);
  const back = [];
  for (let i = 1; i < n; i++) {
    let bi = 0;
    for (let s = 1; s < S; s++) if (dp[s] > dp[bi]) bi = s;
    const pen = changeCost(i);
    const nd = new Float64Array(S);
    const bk = new Int16Array(S);
    for (let s = 0; s < S; s++) {
      const stay = dp[s];
      const move = dp[bi] - pen;
      if (stay >= move) {
        nd[s] = stay + scores[i][s];
        bk[s] = s;
      } else {
        nd[s] = move + scores[i][s];
        bk[s] = bi;
      }
    }
    back.push(bk);
    dp = nd;
  }
  const path = new Array(n);
  let s = 0;
  for (let k = 1; k < S; k++) if (dp[k] > dp[s]) s = k;
  path[n - 1] = s;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]];
  return path;
}

// 曲全体の12音の分布と、長調・短調の典型的な分布(クルムハンスルの調性プロファイル)との相関
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / 12;
  const mb = b.reduce((s, x) => s + x, 0) / 12;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
}
function profileKeyScores(feats) {
  const sum = new Array(12).fill(0);
  for (const f of feats) for (let c = 0; c < 12; c++) sum[c] += f.tr[c] + 0.5 * f.bs[c];
  // 長調の主音 T ごとに、長調(T)と平行短調(T+9)の相関の大きいほう
  return Array.from({ length: 12 }, (_, T) => {
    const maj = corr(sum, KK_MAJ.map((_, i) => KK_MAJ[mod12(i - T)]));
    const min = corr(sum, KK_MIN.map((_, i) => KK_MIN[mod12(i - T - 9)]));
    return Math.max(maj, min);
  });
}

// キー(長調の主音)を決める: 長く鳴っているコードが自然に収まる調 + 12音の分布が合う調
function keyFromPath(path, feats, pw = 0.15) {
  const prof = profileKeyScores(feats);
  const n = path.filter((s) => s < TEMPLATES.length).length || 1;
  let best = 0;
  let bestV = -Infinity;
  for (let T = 0; T < 12; T++) {
    let v = 0;
    for (const s of path) {
      if (s >= TEMPLATES.length) continue;
      const tp = TEMPLATES[s];
      const d = mod12(tp.root - T);
      const ok = DIATONIC[d];
      v += ok && ok.includes(tp.type) ? 1 : (d === 2 || d === 4 || d === 9) && tp.type === 0 ? 0.3 : 0;
    }
    v = v / n + pw * prof[T];
    if (v > bestV) {
      bestV = v;
      best = T;
    }
  }
  // 長調か短調か: I と vi のどちらが多く、曲の終わりに来るか
  let I = 0;
  let vi = 0;
  path.forEach((s, i) => {
    if (s >= TEMPLATES.length) return;
    const tp = TEMPLATES[s];
    const w = i > path.length * 0.85 ? 2 : 1;
    if (tp.root === best && tp.type !== 1) I += w;
    if (tp.root === mod12(best + 9) && (tp.type === 1 || tp.type === 3)) vi += w;
  });
  return vi > I * 1.3 ? { pc: mod12(best + 9), minor: true, T: best } : { pc: best, minor: false, T: best };
}

// ---------------------------------------------------------------- 全体

// samples: 11025Hz のモノラル音。progress(0〜1, 今している作業)
export async function analyzeAudio(samples, { progress = () => {}, keyWeight = 0.15 } = {}) {
  // 音量をそろえる
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const x = new Float32Array(samples.length);
  const g = peak ? 0.9 / peak : 1;
  for (let i = 0; i < samples.length; i++) x[i] = samples[i] * g;

  progress(0, '拍を探しています');
  const env = await onsetEnvelope(x, (p) => progress(p * 0.3, '拍を探しています'));
  const { period, bpm } = estimateTempo(env);
  let beats = trackBeats(env, period);
  if (beats.length < 8) throw new Error('曲が短すぎるか、音が小さすぎて拍が見つかりませんでした');

  progress(0.3, '音の高さを調べています');
  const ch = await chromaFrames(x, (p) => progress(0.3 + p * 0.6, '音の高さを調べています'));
  // 拍の直前にも少し余白を持たせる(最後の拍の後ろも1拍ぶん)
  beats = [...beats, beats[beats.length - 1] + 60 / bpm];
  const feats = beatFeatures(ch, beats);

  progress(0.92, 'コードを決めています');
  await tick();
  // 1回目: キーを気にせず並べる → キーを決める → 2回目: 小節の頭を探す → 3回目: 仕上げ
  const flat = (cost) => () => cost;
  const p1 = viterbi(scoreBeats(feats, null), flat(0.12));
  const key = keyFromPath(p1, feats, keyWeight);
  const sc = scoreBeats(feats, key.T);
  const p2 = viterbi(sc, flat(0.12));
  // コードの変わり目が一番そろう位置を「小節の頭」とする(4拍子)
  const hits = [0, 0, 0, 0];
  for (let i = 1; i < p2.length; i++) if (p2[i] !== p2[i - 1]) hits[i % 4]++;
  const phase = hits.indexOf(Math.max(...hits));
  const mult = [0.55, 1.6, 1.0, 1.6];
  const path = viterbi(sc, (i) => 0.13 * mult[(((i - phase) % 4) + 4) % 4]);

  const flatNames = keyPrefersFlat(key);
  const nameOf = (s) => (s >= TEMPLATES.length ? 'N.C.' : noteName(TEMPLATES[s].root, flatNames) + TYPES[TEMPLATES[s].type].suf);

  // 小節にまとめる(前半・後半で別のコードなら2つ)
  const bars = [];
  const majority = (a, b) => (a === b ? a : a);
  for (let s = phase; s + 3 < path.length; s += 4) {
    const h1 = majority(path[s], path[s + 1]);
    const h2 = path[s + 2] === path[s + 3] ? path[s + 2] : path[s + 2];
    const chords = h1 === h2 ? [nameOf(h1)] : [nameOf(h1), nameOf(h2)];
    bars.push({ t0: beats[s], t1: beats[Math.min(s + 4, beats.length - 1)], chords });
  }
  // 自信度: 選んだコードの点数が、2番目の候補よりどれだけ高いか
  let margin = 0;
  let cnt = 0;
  path.forEach((s, i) => {
    if (s >= TEMPLATES.length) return;
    const row = sc[i];
    let second = -Infinity;
    for (let k = 0; k < TEMPLATES.length; k++) if (k !== s && row[k] > second && TEMPLATES[k].root !== TEMPLATES[s].root) second = row[k];
    margin += row[s] - second;
    cnt++;
  });
  const confidence = cnt ? margin / cnt : 0;
  progress(1, 'できました');
  return { key, bpm: Math.round(bpm), beats, bars, confidence };
}

// 小節の並び → 譜面テキスト(4小節で1行。自動スクロールが曲の長さどおりに進むよう、くり返しもそのまま書く)
export function barsToSheet({ key, bpm, bars }, { note = '' } = {}) {
  const keyName = noteName(key.pc, keyPrefersFlat(key)) + (key.minor ? 'm' : '');
  const lines = [`{key:${keyName}}`, `{tempo:${bpm}}`];
  if (note) lines.push(`{c:${note}}`);
  const rows = [];
  for (let i = 0; i < bars.length; i += 4) {
    const seg = bars.slice(i, i + 4);
    rows.push('|' + seg.map((b) => b.chords.map((c) => `[${c}]`).join(' ') + ' ').join('|') + '|');
  }
  const out = rows;
  // 16小節ごとに空行を入れて読みやすく
  const body = [];
  let n = 0;
  for (const l of out) {
    body.push(l);
    if (!l.startsWith('{') && ++n % 4 === 0) body.push('');
  }
  return [...lines, '', ...body].join('\n').trim();
}

// ---------------------------------------------------------------- 音の読み込み・マイク

// AudioBuffer(何Hzでも・ステレオでも) → 11025Hz のモノラル
export function toMono(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
  }
  return resample(mono, buffer.sampleRate);
}

// ブラウザの高品質な変換で 11025Hz のモノラルにする(使えないときは toMono)
export async function toMonoHQ(buffer) {
  try {
    const len = Math.ceil(buffer.duration * SR);
    const off = new OfflineAudioContext(1, len, SR);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0);
  } catch {
    return toMono(buffer);
  }
}

// 区間の平均をとって間引く(簡単な低域フィルタを兼ねる)
export function resample(x, from) {
  if (from === SR) return x;
  const ratio = from / SR;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b && k < x.length; k++) s += x[k];
    out[i] = s / (b - a);
  }
  return out;
}

// マイクで聴いている今のコード(画面に大きく出す用)。db: AnalyserNode の周波数データ(dB)
export function liveChord(db, sampleRate, fftSize) {
  const E = [];
  for (let s = 33; s <= 86; s++) {
    const f = 440 * 2 ** ((s - 69) / 12);
    const a = Math.floor((f * 2 ** (-0.5 / 12) * fftSize) / sampleRate);
    const b = Math.max(a, Math.ceil((f * 2 ** (0.5 / 12) * fftSize) / sampleRate));
    let m = 0;
    for (let k = a; k <= b && k < db.length; k++) m = Math.max(m, 10 ** (db[k] / 20));
    E.push(m);
  }
  const med = (from, to) => [...E.slice(from, to + 1)].sort((x, y) => x - y)[(to - from + 1) >> 1] + 1e-9;
  const mt = med(45 - 33, 86 - 33);
  const mb = med(0, 56 - 33);
  const tr = new Float32Array(12);
  const bs = new Float32Array(12);
  E.forEach((v, i) => {
    const s = 33 + i;
    if (s >= 45) tr[mod12(s)] += Math.max(0, Math.log(v / mt));
    if (s <= 52) bs[mod12(s)] += Math.max(0, Math.log(v / mb));
  });
  const total = tr.reduce((x, y) => x + y, 0);
  if (total < 4) return null; // ほとんど音が無い(雑音だけのとき)
  const n = Math.hypot(...tr) || 1;
  for (let c = 0; c < 12; c++) tr[c] /= n;
  const bm = Math.max(...bs) || 1;
  for (let c = 0; c < 12; c++) bs[c] /= bm;
  let best = -Infinity;
  let second = -Infinity;
  let arg = 0;
  TEMPLATES.forEach((tp, i) => {
    let d = 0;
    for (let c = 0; c < 12; c++) d += tr[c] * tp.v[c];
    d += 0.2 * bs[tp.root] + TYPES[tp.type].prior;
    if (d > best) {
      second = best;
      best = d;
      arg = i;
    } else if (d > second) second = d;
  });
  const tp = TEMPLATES[arg];
  return { name: noteName(tp.root, false) + TYPES[tp.type].suf, sure: best - second };
}
