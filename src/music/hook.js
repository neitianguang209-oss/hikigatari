// サビの場所を音で探す: Apple の試聴30秒(たいていサビのあたり)が、自分の音源のどこにあたるかを、
// 0.1秒ごとの「12音の響き(クロマ)」と「音の大きさの動き」で照らし合わせて見つける。
// サビは何回も出てくるので、いちばんよく合う場所とほぼ同じくらい合う場所があれば、いちばん早いもの(1回目のサビ)を選ぶ
import { KeyShifter } from './keyshift.js';

const SR = 11025;
const HOP = Math.round(SR * 0.1);

// 何Hzでも → 11025Hz のモノラル(4つ・2つ…ごとの平均で十分。響きを見るだけ)
function toMono(buf) {
  const n = buf.length;
  const ch = buf.numberOfChannels;
  const step = buf.sampleRate / SR;
  const m = Math.floor(n / step);
  const out = new Float32Array(m);
  const datas = [];
  for (let c = 0; c < ch; c++) datas.push(buf.getChannelData(c));
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(n, Math.floor((i + 1) * step));
    let s = 0;
    for (let c = 0; c < ch; c++) for (let j = a; j < b; j++) s += datas[c][j];
    out[i] = s / Math.max(1, (b - a) * ch);
  }
  return out;
}

// 0.1秒ごとの [クロマ(12、長さ1にそろえる), 音の大きさ(対数)]
async function features(x) {
  const ks = new KeyShifter(SR); // FFT と窓だけ借りる(2048点)
  const N = ks.N;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const bins = [];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f < 80 || f > 4000) continue;
    bins.push([k, (((Math.round(12 * Math.log2(f / 440) + 69)) % 12) + 12) % 12]);
  }
  const chroma = [];
  const loud = [];
  let t0 = performance.now();
  for (let s = 0; s + N <= x.length; s += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = x[s + i];
      re[i] = v * ks.win[i];
      im[i] = 0;
      e += v * v;
    }
    ks.fft(re, im);
    const c = new Float64Array(12);
    for (const [k, p] of bins) c[p] += Math.hypot(re[k], im[k]);
    const nrm = Math.hypot(...c) || 1;
    for (let p = 0; p < 12; p++) c[p] /= nrm;
    chroma.push(c);
    loud.push(Math.log10(e / N + 1e-9));
    // 画面が止まらないよう、ときどき休む
    if (performance.now() - t0 > 40) {
      await new Promise((r) => setTimeout(r, 0));
      t0 = performance.now();
    }
  }
  return { chroma, loud };
}

// full(自分の音源)の中で clip(試聴)が始まる時刻(秒)。合わなければ null
export async function findClipIn(fullBuf, clipBuf) {
  const F = await features(toMono(fullBuf));
  const C = await features(toMono(clipBuf));
  // 試聴のはじめと終わりは音を小さくしてある(フェード)ので、真ん中だけで比べる
  const a = Math.min(15, Math.floor(C.chroma.length * 0.05));
  const b = C.chroma.length - a;
  const L = b - a;
  if (L < 80 || F.chroma.length < L) return null;
  // 大きさの動きは、それぞれ平均を引いて比べる
  const cl = C.loud.slice(a, b);
  const cm = cl.reduce((s, v) => s + v, 0) / L;
  const cd = cl.map((v) => v - cm);
  const cn = Math.hypot(...cd) || 1;
  const scores = [];
  for (let off = 0; off + L <= F.chroma.length; off++) {
    let s = 0;
    for (let j = 0; j < L; j++) {
      const x = F.chroma[off + j];
      const y = C.chroma[a + j];
      let d = 0;
      for (let p = 0; p < 12; p++) d += x[p] * y[p];
      s += d;
    }
    let fm = 0;
    for (let j = 0; j < L; j++) fm += F.loud[off + j];
    fm /= L;
    let dot = 0;
    let fn = 0;
    for (let j = 0; j < L; j++) {
      const v = F.loud[off + j] - fm;
      dot += v * cd[j];
      fn += v * v;
    }
    const lc = dot / ((Math.sqrt(fn) || 1) * cn);
    scores.push(0.75 * (s / L) + 0.25 * lc);
    if (off % 400 === 399) await new Promise((r) => setTimeout(r, 0));
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  // ほかの場所より、はっきりよく合っていること(そうでなければ当てにしない)
  const sorted = [...scores].sort((p, q) => p - q);
  const med = sorted[Math.floor(sorted.length / 2)];
  if (scores[best] < 0.8 || scores[best] - med < 0.08) return null;
  // ほぼ同じくらい合う場所(くり返しのサビ)のうち、いちばん早いもの
  const near = scores[best] - (scores[best] - med) * 0.12;
  let pick = best;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] >= near) {
      // その近く(±1秒)のいちばん高いところ
      let k = i;
      for (let j = i; j < Math.min(scores.length, i + 10); j++) if (scores[j] > scores[k]) k = j;
      pick = k;
      break;
    }
  }
  return { t: Math.round(((pick - a) * HOP) / SR * 10) / 10, score: Math.round(scores[pick] * 1000) / 1000, best: Math.round(((best - a) * HOP) / SR * 10) / 10 };
}
