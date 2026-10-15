// キーを変える: 曲の速さはそのままで、音の高さだけを半音いくつぶん上げ下げする。
// ・フェーズボコーダで曲を r 倍の長さに伸ばし(r = 2^(半音/12))、それを r 倍の速さで読み直す → 長さは元どおり、高さだけ r 倍
// ・倍音の山ごとに、そのまわりの位相を山といっしょに回す(identity phase locking)。声や和音が「ぼわっ」としにくい
// ・左右は、左右を足した音で位相の進みを決めて、両方に同じ回転をかける(左右の広がりが崩れない)
// 流しながら少しずつ渡せる(process)。遅れはいつも latency サンプル(キーで少しだけ変わる)
// 使うところ: 試聴30秒をそのキーで聴く(この端末の中でまとめて計算) / パソコンで YouTube の原曲をそのキーで流す(AudioWorklet)

const TWO_PI = Math.PI * 2;
const CEIL = 0.98; // 音割れ止めの上限
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);

// 4点のエルミート補間(読み直しのときの、サンプルのあいだの値)
function herm(xm1, x0, x1, x2, t) {
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return ((a * t - b) * t + c) * t + x0;
}

export class KeyShifter {
  constructor(sampleRate, { block = 128 } = {}) {
    // 窓は約85ミリ秒(低い音の倍音まで分けられる長さ)。重ねは8つ
    const N = sampleRate >= 32000 ? 4096 : 2048;
    const half = N >> 1;
    this.N = N;
    this.half = half;
    this.Ha = N >> 3;
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    // FFT の表
    this.cs = new Float64Array(half);
    this.sn = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cs[i] = Math.cos((TWO_PI * i) / N);
      this.sn[i] = -Math.sin((TWO_PI * i) / N);
    }
    const bits = Math.log2(N);
    this.rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    const B = half + 1;
    this.lr = new Float64Array(B);
    this.li = new Float64Array(B);
    this.rr = new Float64Array(B);
    this.ri = new Float64Array(B);
    this.mr = new Float64Array(B); // 左右を足した音(位相を決める)
    this.mi = new Float64Array(B);
    this.pmr = new Float64Array(B); // ひとつ前のこま
    this.pmi = new Float64Array(B);
    this.m2 = new Float64Array(B);
    this.th = new Float64Array(B); // 位相の回転(このこま)
    this.pth = new Float64Array(B); // 位相の回転(ひとつ前のこま)
    this.peaks = new Int32Array(B);
    this.pc = new Float64Array(B);
    this.ps = new Float64Array(B);
    this.pkTh = new Float64Array(B);
    this.first = true;
    // 入ってきた音(最後の N サンプル)
    this.inL = new Float32Array(N);
    this.inR = new Float32Array(N);
    this.fill = 0;
    // 重ね足し
    this.accL = new Float32Array(N);
    this.accR = new Float32Array(N);
    // 伸ばした音(読み直し待ち)。先頭の1つは補間用の前の値
    this.sL = new Float32Array(N * 2 + 8);
    this.sR = new Float32Array(N * 2 + 8);
    this.sLen = 1;
    this.pos = 1;
    // できあがった音(輪)。こまの合間に足りなくならないよう、少しだけ先に無音を入れておく
    const cap = 1 << 15;
    this.oL = new Float32Array(cap);
    this.oR = new Float32Array(cap);
    this.mask = cap - 1;
    this.margin = Math.max(0, this.Ha - block) + 32;
    this.oRd = 0;
    this.oW = this.margin;
    this.sr = sampleRate;
    // 音割れ止め: 先読み約6ミリ秒、戻すのは約40ミリ秒かけて
    const la = Math.round(sampleRate * 0.006);
    this.lim = {
      la,
      cap: la + 2,
      qv: new Float64Array(la + 2),
      qn: new Float64Array(la + 2),
      qHead: 0,
      qLen: 0,
      n: 0,
      h: 1,
      rel: 1 - Math.exp(-1 / (sampleRate * 0.04)),
      hs: new Float64Array(la).fill(1),
      hi: 0,
      sum: la,
      dl: new Float32Array(la),
      dr: new Float32Array(la),
      di: 0,
    };
    this.yl = 0;
    this.yr = 0;
    this.setSemitones(0);
  }

  // 半音いくつぶん上げ下げするか(流しながら変えてよい)
  setSemitones(s) {
    s = Math.max(-12, Math.min(12, Number(s) || 0));
    const back = this.semis !== 0 && s === 0;
    this.semis = s;
    this.Hs = Math.max(1, Math.round(this.Ha * Math.pow(2, s / 12)));
    this.r = this.Hs / this.Ha;
    // 原曲のキーに戻したら、位相も元の音どおりに(回転なし)
    if (back) this.first = true;
  }

  // 入ってから出てくるまでのサンプル数(音の重心で見たもの)
  get latency() {
    return Math.round(this.N / 2 + this.N / (2 * this.r) - this.Ha + this.margin + this.lim.la);
  }

  // 中に残っている音を捨てて、はじめの状態に戻す(曲の別の場所へ飛ぶとき。前の場所の音が少し遅れて聞こえないように)
  reset() {
    this.inL.fill(0);
    this.inR.fill(0);
    this.fill = 0;
    this.accL.fill(0);
    this.accR.fill(0);
    this.sL.fill(0);
    this.sR.fill(0);
    this.sLen = 1;
    this.pos = 1;
    this.oL.fill(0, 0, this.margin);
    this.oR.fill(0, 0, this.margin);
    this.oRd = 0;
    this.oW = this.margin;
    this.pmr.fill(0);
    this.pmi.fill(0);
    this.pth.fill(0);
    this.first = true;
    const L = this.lim;
    Object.assign(L, { qHead: 0, qLen: 0, n: 0, h: 1, hi: 0, sum: L.la, di: 0 });
    L.hs.fill(1);
    L.dl.fill(0);
    L.dr.fill(0);
  }

  // inL・inR の音を入れて、同じ数だけ outL・outR に出す(inR が無ければ inL を両方に)
  process(inL, inR, outL, outR) {
    const n = outL.length;
    const { N, Ha } = this;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, Ha - this.fill);
      const base = N - Ha + this.fill;
      if (inL) {
        const R = inR || inL;
        for (let j = 0; j < take; j++) {
          this.inL[base + j] = inL[i + j];
          this.inR[base + j] = R[i + j];
        }
      } else {
        this.inL.fill(0, base, base + take);
        this.inR.fill(0, base, base + take);
      }
      this.fill += take;
      i += take;
      if (this.fill === Ha) {
        this.frame();
        this.inL.copyWithin(0, Ha);
        this.inR.copyWithin(0, Ha);
        this.fill = 0;
      }
    }
    const { oL, oR, mask } = this;
    let rd = this.oRd;
    const w = this.oW;
    for (let j = 0; j < n; j++) {
      let xl = 0;
      let xr = 0;
      if (rd < w) {
        const k = rd & mask;
        xl = oL[k];
        xr = oR[k];
        rd++;
      }
      this.limit(xl, xr);
      outL[j] = this.yl;
      if (outR) outR[j] = this.yr;
    }
    this.oRd = rd;
  }

  // 音割れ止め(先読みリミッター)。位相を動かすと、音量は同じでも瞬間の山が元より高くなる(マスタリングで抑えてあった山が戻る)ので、
  // 山のところだけ少し前からなめらかに下げる。結果は this.yl・this.yr(LIM サンプル遅れて出る)
  limit(xl, xr) {
    const L = this.lim;
    const la = L.la;
    const a = Math.max(Math.abs(xl), Math.abs(xr));
    const t = a > CEIL ? CEIL / a : 1;
    // 直近 la+1 サンプルのいちばん小さい許容量(単調な列で持つ)
    const { qv, qn, cap } = L;
    const n = L.n++;
    while (L.qLen && qv[(L.qHead + L.qLen - 1) % cap] >= t) L.qLen--;
    const at = (L.qHead + L.qLen) % cap;
    qv[at] = t;
    qn[at] = n;
    L.qLen++;
    if (qn[L.qHead] < n - la) {
      L.qHead = (L.qHead + 1) % cap;
      L.qLen--;
    }
    const m = qv[L.qHead];
    // 下げるのはすぐ、戻すのはゆっくり
    L.h = m < L.h ? m : Math.min(m, L.h + (1 - L.h) * L.rel);
    // 直近 la サンプルの平均で、なめらかに
    L.sum += L.h - L.hs[L.hi];
    L.hs[L.hi] = L.h;
    if (++L.hi === la) {
      L.hi = 0;
      let s = 0;
      for (let i = 0; i < la; i++) s += L.hs[i];
      L.sum = s;
    }
    const g = L.sum / la;
    const d = L.di;
    this.yl = L.dl[d] * g;
    this.yr = L.dr[d] * g;
    L.dl[d] = xl;
    L.dr[d] = xr;
    L.di = d + 1 === la ? 0 : d + 1;
  }

  fft(re, im) {
    const { N, rev, cs, sn } = this;
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const hs = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < hs; j++, k += step) {
          const a = i + j;
          const b = a + hs;
          const c = cs[k];
          const s = sn[k];
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  frame() {
    const { N, half, Ha, Hs, r, win, re, im, lr, li, rr, ri, mr, mi, m2, peaks, pkTh, pc, ps } = this;
    // 左を実部・右を虚部にして、1回の FFT で両方
    for (let i = 0; i < N; i++) {
      re[i] = this.inL[i] * win[i];
      im[i] = this.inR[i] * win[i];
    }
    this.fft(re, im);
    for (let k = 0; k <= half; k++) {
      const nk = k === 0 ? 0 : N - k;
      const zr = re[k];
      const zi = im[k];
      const cr = re[nk];
      const ci = -im[nk];
      lr[k] = 0.5 * (zr + cr);
      li[k] = 0.5 * (zi + ci);
      rr[k] = 0.5 * (zi - ci);
      ri[k] = -0.5 * (zr - cr);
      mr[k] = lr[k] + rr[k];
      mi[k] = li[k] + ri[k];
      m2[k] = mr[k] * mr[k] + mi[k] * mi[k];
    }
    // 倍音の山(まわり2つずつより大きいところ)
    let np = 0;
    for (let k = 0; k <= half; k++) {
      const v = m2[k];
      if (v <= 1e-18) continue;
      if (k > 0 && v <= m2[k - 1]) continue;
      if (k > 1 && v <= m2[k - 2]) continue;
      if (k < half && v < m2[k + 1]) continue;
      if (k < half - 1 && v < m2[k + 2]) continue;
      peaks[np++] = k;
    }
    // 山ごとの回転: 本当の周波数(前のこまからの位相の進み)で、伸ばしたぶんだけ位相を進める
    const th = this.th;
    const pth = this.pth;
    const per = (TWO_PI * Ha) / N;
    for (let q = 0; q < np; q++) {
      const k = peaks[q];
      let t = 0;
      if (!this.first) {
        const phi = Math.atan2(mi[k], mr[k]);
        const prev = Math.atan2(this.pmi[k], this.pmr[k]);
        const exp = per * k;
        const dev = wrap(phi - prev - exp);
        t = wrap(pth[k] + prev + (exp + dev) * r - phi);
      }
      pkTh[q] = t;
      pc[q] = Math.cos(t);
      ps[q] = Math.sin(t);
    }
    // それぞれの箱は、いちばん近い山と同じだけ回す。左右に同じ回転をかけて、逆 FFT 用に並べる(共役にしておく)
    let q = 0;
    for (let k = 0; k <= half; k++) {
      let c = 1;
      let s = 0;
      let t = 0;
      if (np) {
        while (q < np - 1 && k > (peaks[q] + peaks[q + 1]) * 0.5) q++;
        if (k !== 0 && k !== half) {
          c = pc[q];
          s = ps[q];
          t = pkTh[q];
        }
      }
      th[k] = t;
      const ylr = lr[k] * c - li[k] * s;
      const yli = lr[k] * s + li[k] * c;
      const yrr = rr[k] * c - ri[k] * s;
      const yri = rr[k] * s + ri[k] * c;
      re[k] = ylr - yri;
      im[k] = -(yli + yrr);
      if (k !== 0 && k !== half) {
        re[N - k] = ylr + yri;
        im[N - k] = yli - yrr;
      }
    }
    this.fft(re, im);
    // 重ね足し(窓を2回かけたぶんの大きさをそろえる)
    const { accL, accR } = this;
    const g = Hs / (0.375 * N) / N;
    for (let i = 0; i < N; i++) {
      const w = win[i] * g;
      accL[i] += re[i] * w;
      accR[i] -= im[i] * w;
    }
    // 前のこまとして覚える
    this.pmr.set(mr);
    this.pmi.set(mi);
    this.th = pth;
    this.pth = th;
    this.first = false;
    // できた Hs サンプルを、伸ばした音の列へ
    const len = this.sLen;
    this.sL.set(accL.subarray(0, Hs), len);
    this.sR.set(accR.subarray(0, Hs), len);
    this.sLen = len + Hs;
    accL.copyWithin(0, Hs);
    accR.copyWithin(0, Hs);
    accL.fill(0, N - Hs);
    accR.fill(0, N - Hs);
    this.resample();
  }

  // 伸ばした音を r 倍の速さで読み直す
  resample() {
    const { sL, sR, r, oL, oR, mask } = this;
    const len = this.sLen;
    let pos = this.pos;
    let w = this.oW;
    for (;;) {
      const i = Math.floor(pos);
      if (i + 2 >= len) break;
      const f = pos - i;
      const k = w & mask;
      oL[k] = herm(sL[i - 1], sL[i], sL[i + 1], sL[i + 2], f);
      oR[k] = herm(sR[i - 1], sR[i], sR[i + 1], sR[i + 2], f);
      w++;
      pos += r;
    }
    this.oW = w;
    const drop = Math.floor(pos) - 1;
    if (drop > 0) {
      sL.copyWithin(0, drop, len);
      sR.copyWithin(0, drop, len);
      this.sLen = len - drop;
      pos -= drop;
    }
    this.pos = pos;
  }
}

// 入ってから聞こえるまでの遅れ(秒)。KeyShifter の latency と同じ計算(流している位置を、耳に聞こえている位置に直すのに使う)
export function shifterLatency(sampleRate, semis) {
  const N = sampleRate >= 32000 ? 4096 : 2048;
  const Ha = N >> 3;
  const s = Math.max(-12, Math.min(12, Number(semis) || 0));
  const r = Math.max(1, Math.round(Ha * Math.pow(2, s / 12))) / Ha;
  const margin = Math.max(0, Ha - 128) + 32;
  const la = Math.round(sampleRate * 0.006);
  return Math.round(N / 2 + N / (2 * r) - Ha + margin + la) / sampleRate;
}

// 音のかたまり(左・右)をまとめてキーを変える。出てくる音は元と同じ長さ・同じ時刻にそろえる。
// 画面が止まらないよう、少しずつ計算して合間に休む。onProgress(0〜1)。cancelled() が true になったらやめる(null を返す)
export async function shiftChannels(L, R, sampleRate, semis, { onProgress = null, cancelled = null } = {}) {
  const ks = new KeyShifter(sampleRate);
  ks.setSemitones(semis);
  const lat = ks.latency;
  const n = L.length;
  const total = n + lat;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const B = 128;
  const bl = new Float32Array(B);
  const br = new Float32Array(B);
  const zl = new Float32Array(B);
  const zr = new Float32Array(B);
  let t0 = performance.now();
  for (let i = 0; i < total; i += B) {
    let inL = null;
    let inR = null;
    if (i < n) {
      if (i + B <= n) {
        inL = L.subarray(i, i + B);
        inR = R ? R.subarray(i, i + B) : null;
      } else {
        zl.fill(0);
        zr.fill(0);
        zl.set(L.subarray(i));
        if (R) zr.set(R.subarray(i));
        inL = zl;
        inR = R ? zr : null;
      }
    }
    ks.process(inL, inR, bl, br);
    // 遅れのぶんを捨てて、元の時刻にそろえる
    const o = i - lat;
    for (let j = 0; j < B; j++) {
      const p = o + j;
      if (p >= 0 && p < n) {
        outL[p] = bl[j];
        outR[p] = br[j];
      }
    }
    if (performance.now() - t0 > 40) {
      onProgress?.(i / total);
      await new Promise((res) => setTimeout(res, 0));
      if (cancelled?.()) return null;
      t0 = performance.now();
    }
  }
  onProgress?.(1);
  return { L: outL, R: outR };
}
