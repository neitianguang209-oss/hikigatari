// 音の高さを測る(チューナー用)。YIN法で大まかな周期を見つけ、元の細かさの波形で周期を仕上げる
// x: 時間波形(Float32Array)、sr: サンプリング周波数。戻り値 { freq, clarity, rms } か null

const A4 = 440;
export const freqOf = (m) => A4 * 2 ** ((m - 69) / 12);
export const midiOf = (f) => 69 + 12 * Math.log2(f / A4);

// 2次の低域フィルタ(RBJ)。周期は変わらないので、位相のずれは気にしなくてよい
function lowpass(x, fc, sr) {
  const w = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const cw = Math.cos(w);
  const a0 = 1 + al;
  const b0 = (1 - cw) / 2 / a0;
  const b1 = (1 - cw) / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

export function rmsOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

// gate: これより小さい音は測らない(まわりの雑音の大きさから決める)
export function detectPitch(x, sr, { minF = 60, maxF = 1100, gate = 0.0015 } = {}) {
  const rms = rmsOf(x);
  if (!(rms >= gate)) return null;
  // 計算を軽くするため、24kHz 前後まで間引く(マイクの経路で 1.5kHz より上は落としてある)
  const D = sr >= 30000 ? 2 : 1;
  const n = Math.floor(x.length / D);
  const y = D === 1 ? x : new Float32Array(n);
  if (D > 1) for (let i = 0; i < n; i++) y[i] = (x[2 * i] + x[2 * i + 1]) * 0.5;
  const fs = sr / D;
  const minLag = Math.max(2, Math.floor(fs / maxF));
  const maxLag = Math.min(Math.ceil(fs / minF), n >> 1);
  if (maxLag <= minLag + 2) return null;
  const W = n - maxLag;
  // 差分関数と、累積平均で正規化した差分(YIN)
  const c = new Float32Array(maxLag + 1);
  c[0] = 1;
  let run = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const d = y[i] - y[i + lag];
      s += d * d;
    }
    run += s;
    c[lag] = run ? (s * lag) / run : 1;
  }
  let lag = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (c[t] < 0.12) {
      while (t + 1 <= maxLag && c[t + 1] < c[t]) t++;
      lag = t;
      break;
    }
  }
  if (lag < 0) {
    // はっきりした谷が無いとき: いちばん深い谷(ただし浅すぎるときは音程の無い音とみなす)
    let best = minLag;
    for (let t = minLag; t <= maxLag; t++) if (c[t] < c[best]) best = t;
    if (c[best] > 0.4) return null;
    lag = best;
  }
  const clarity = 1 - c[lag];
  // 仕上げ: 元の細かさで、周期のまわりだけ差分を計算し、放物線で谷の底を求める(1セント未満の細かさ)。
  // 弦の高い倍音は少し高めにずれる(弦の硬さ)ので、基音の2.2倍より上を落とした波形で測る
  const t0 = lag * D;
  const lo = Math.max(2, t0 - D - 1);
  const hi = t0 + D + 1;
  const z = lowpass(lowpass(x, (2.2 * sr) / t0, sr), (2.2 * sr) / t0, sr);
  const skip = Math.min(hi, Math.floor(x.length / 8)); // フィルタの立ち上がりは使わない
  const Wf = x.length - skip - hi - 2;
  if (Wf < hi) return { freq: fs / lag, clarity, rms };
  const dd = [];
  for (let tau = lo - 1; tau <= hi + 1; tau++) {
    let s = 0;
    for (let i = skip; i < skip + Wf; i++) {
      const d = z[i] - z[i + tau];
      s += d * d;
    }
    dd.push(s);
  }
  let k = 1;
  for (let j = 1; j < dd.length - 1; j++) if (dd[j] < dd[k]) k = j;
  let exact = lo - 1 + k;
  if (k > 0 && k < dd.length - 1) {
    const a = dd[k - 1];
    const b = dd[k];
    const e = dd[k + 1];
    const den = a + e - 2 * b;
    if (den > 0) exact += (a - e) / (2 * den);
  }
  return { freq: sr / exact, clarity, rms };
}
