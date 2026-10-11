// 自分の歌(アカペラの動画・録音)を聴き取って、譜面の行を歌声に合わせる。
// 1) 録音から「歌っている区間」を取り出す(音の大きさだけを見る。アカペラなら、歌っていない間は静か)
// 2) 譜面の行の「歌う時刻の見本」(原曲の歌詞の時刻。無ければ小節数からの見積もり)と、歌っている区間の並びを、
//    伸び縮みを許して重ねる。前奏・間奏は好きなだけ縮められる(アカペラでは、待たずに次を歌い出すため)
// 3) 「いまここを歌っている」の目印(1回タップ)は、「その時刻には、その行を歌っている」という条件として効く。
//    押すのが少し早い・遅い、行のどこを押したか、は気にしなくてよい(細かい位置は歌声の切れ目から決める)
import { makeWeights } from './lyricsfit.js';

const weightsOf = makeWeights(null);
const SUNG = /[ぁ-ゖァ-ヺー一-鿿々〆ヶA-Za-z0-9]/;
const lineText = (l) => (l.segs || []).map((s) => s.t).join('');
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- 動画の中の音だけを取り出す
// iPhone の動画は数百MBあるので、丸ごと読み込むと端末のメモリが足りなくなる。
// 動画(MP4・MOV)の目次を読んで、音(AAC)の部分だけを拾い集める(数MB)

const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

function* boxes(dv, from, to) {
  let o = from;
  while (o + 8 <= to) {
    let size = dv.getUint32(o);
    let head = 8;
    if (size === 1) {
      if (o + 16 > to) return;
      size = Number(dv.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) return;
    yield { type: fourcc(dv, o + 4), start: o + head, end: o + size };
    o += size;
  }
}

// ファイルのいちばん外側から moov(目次)を探す。iPhone の動画は目次が最後にある
async function findMoov(blob) {
  let o = 0;
  for (let guard = 0; guard < 400 && o + 8 <= blob.size; guard++) {
    const dv = new DataView(await blob.slice(o, o + 16).arrayBuffer());
    if (dv.byteLength < 8) return null;
    let size = dv.getUint32(0);
    const type = fourcc(dv, 4);
    if (size === 1) {
      if (dv.byteLength < 16) return null;
      size = Number(dv.getBigUint64(8));
    } else if (size === 0) size = blob.size - o;
    if (size < 8) return null;
    if (type === 'moov') return size <= 96e6 ? { start: o, size } : null;
    o += size;
  }
  return null;
}

function trakInfo(dv, from, to) {
  const t = {};
  const walk = (a, b, parent) => {
    for (const x of boxes(dv, a, b)) {
      if (x.type === 'mdia' || x.type === 'minf' || x.type === 'stbl') walk(x.start, x.end, x.type);
      else if (x.type === 'hdlr' && parent === 'mdia') t.handler = fourcc(dv, x.start + 8);
      else if (parent === 'stbl') t[x.type] = x;
    }
  };
  walk(from, to, 'trak');
  return t;
}

// 音の種類の説明(stsd の中の esds)から、AAC の設定を読む。AAC(LC)でなければ null
function aacConfig(dv, stsd) {
  if (fourcc(dv, stsd.start + 12) !== 'mp4a') return null;
  let p = -1;
  for (let o = stsd.start + 16; o + 4 <= stsd.end; o++)
    if (dv.getUint32(o) === 0x65736473) {
      p = o + 8;
      break;
    }
  if (p < 0) return null;
  const len = () => {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const b = dv.getUint8(p++);
      n = (n << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return n;
  };
  if (dv.getUint8(p++) !== 0x03) return null;
  len();
  p += 2;
  const flags = dv.getUint8(p++);
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + dv.getUint8(p);
  if (flags & 0x20) p += 2;
  if (dv.getUint8(p++) !== 0x04) return null;
  len();
  const kind = dv.getUint8(p);
  p += 13;
  if (kind !== 0x40 && kind !== 0x67) return null;
  if (dv.getUint8(p++) !== 0x05) return null;
  if (len() < 2) return null;
  const b0 = dv.getUint8(p);
  const b1 = dv.getUint8(p + 1);
  const aot = b0 >> 3;
  const freq = ((b0 & 7) << 1) | (b1 >> 7);
  const chan = (b1 >> 3) & 15;
  if (aot < 1 || aot > 4 || freq > 12 || chan < 1 || chan > 7) return null;
  return { profile: aot - 1, freq, chan };
}

// 動画・音声ファイル(MP4・MOV・M4A)の音を、AAC のまま取り出す(ADTS の並び)。取り出せない形なら null
export async function aacFromMp4(blob) {
  const at = await findMoov(blob);
  if (!at) return null;
  const dv = new DataView(await blob.slice(at.start, at.start + at.size).arrayBuffer());
  let pick = null;
  for (const x of boxes(dv, 8, dv.byteLength)) {
    if (x.type !== 'trak') continue;
    const t = trakInfo(dv, x.start, x.end);
    if (t.handler !== 'soun' || !t.stsd || !t.stsz || !t.stsc || !(t.stco || t.co64)) continue;
    const cfg = aacConfig(dv, t.stsd);
    if (cfg) {
      pick = { t, cfg };
      break;
    }
  }
  if (!pick) return null;
  const { t, cfg } = pick;
  const fixed = dv.getUint32(t.stsz.start + 4);
  const count = dv.getUint32(t.stsz.start + 8);
  const sizeOf = (k) => fixed || dv.getUint32(t.stsz.start + 12 + k * 4);
  const nsc = dv.getUint32(t.stsc.start + 4);
  const co = t.stco || t.co64;
  const nco = dv.getUint32(co.start + 4);
  const offOf = (c) => (t.stco ? dv.getUint32(co.start + 8 + c * 4) : Number(dv.getBigUint64(co.start + 8 + c * 8)));
  // かたまり(chunk)ごとに、ファイルの中の場所と、中に入っている音のひとこま(sample)の大きさ
  const chunks = [];
  let total = 0;
  let s = 0;
  let e = 0;
  for (let c = 0; c < nco && s < count; c++) {
    while (e + 1 < nsc && dv.getUint32(t.stsc.start + 8 + (e + 1) * 12) <= c + 1) e++;
    const per = dv.getUint32(t.stsc.start + 8 + e * 12 + 4);
    const sizes = [];
    let sum = 0;
    for (let k = 0; k < per && s < count; k++, s++) {
      const z = sizeOf(s);
      if (z + 7 > 8191) return null;
      sizes.push(z);
      sum += z;
    }
    chunks.push({ off: offOf(c), sizes, sum });
    total += sum + sizes.length * 7;
  }
  if (!total || total > 120e6 || s < count * 0.9) return null;
  const out = new Uint8Array(total);
  let w = 0;
  const place = chunks.map((c) => {
    const at0 = w;
    w += c.sum + c.sizes.length * 7;
    return at0;
  });
  const put = (c, at0, raw) => {
    let r = 0;
    let q = at0;
    for (const z of c.sizes) {
      const n = z + 7;
      out[q] = 0xff;
      out[q + 1] = 0xf1;
      out[q + 2] = (cfg.profile << 6) | (cfg.freq << 2) | (cfg.chan >> 2);
      out[q + 3] = ((cfg.chan & 3) << 6) | (n >> 11);
      out[q + 4] = (n >> 3) & 0xff;
      out[q + 5] = ((n & 7) << 5) | 0x1f;
      out[q + 6] = 0xfc;
      out.set(raw.subarray(r, r + z), q + 7);
      r += z;
      q += n;
    }
  };
  const BATCH = 24;
  for (let k = 0; k < chunks.length; k += BATCH) {
    const part = chunks.slice(k, k + BATCH);
    const bufs = await Promise.all(part.map((c) => blob.slice(c.off, c.off + c.sum).arrayBuffer()));
    for (let q = 0; q < part.length; q++) {
      if (bufs[q].byteLength !== part[q].sum) return null;
      put(part[q], place[k + q], new Uint8Array(bufs[q]));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 歌っている区間を取り出す

// 音を読み込む。区間を見るだけなので、低い細かさ(16kHz)で読んでメモリを節約する
async function decodeLow(arrayBuffer) {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  for (const rate of [16000, 44100]) {
    try {
      const off = new Off(1, 1, rate);
      return await new Promise((resolve, reject) => off.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
    } catch {}
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
  } finally {
    ctx.close?.().catch?.(() => {});
  }
}

// AudioBuffer → { dur, segs: [[始まり, 終わり], …](秒), range: 歌声と静かなところの差(dB), frac: 歌っている割合 }
export function voiceSegments(buffer) {
  const sr = buffer.sampleRate;
  const hop = Math.max(1, Math.round(sr * 0.01));
  const n = Math.floor(buffer.length / hop);
  const dur = buffer.length / sr;
  if (n < 50) return { dur, segs: [], range: 0, frac: 0 };
  const a = buffer.getChannelData(0);
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  // 低い音(机の振動・風・空調)は外して、10ミリ秒ごとの大きさを測る
  const R = 1 - (2 * Math.PI * 120) / sr;
  const raw = new Float32Array(n);
  let x1 = 0;
  let y1 = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    const end = (f + 1) * hop;
    for (let k = f * hop; k < end; k++) {
      const x = b ? (a[k] + b[k]) / 2 : a[k];
      const y = x - x1 + R * y1;
      x1 = x;
      y1 = y;
      e += y * y;
    }
    raw[f] = 10 * Math.log10(e / hop + 1e-10);
  }
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) db[f] = (raw[Math.max(0, f - 1)] + raw[f] + raw[Math.min(n - 1, f + 1)]) / 3;
  const sorted = Float32Array.from(db).sort();
  const peak = sorted[Math.floor(n * 0.95)];
  // まったくの無音(編集で入った無音など)に引っぱられないよう、静かさの基準は歌声の60dB下まで
  const floor = Math.max(sorted[Math.floor(n * 0.1)], peak - 60);
  const range = peak - floor;
  const on = floor + Math.max(6, Math.min(18, range * 0.4));
  const off = on - 3;
  const runs = [];
  let open = -1;
  for (let f = 0; f < n; f++) {
    if (open < 0 && db[f] > on) open = f;
    else if (open >= 0 && db[f] < off) {
      runs.push([open, f]);
      open = -1;
    }
  }
  if (open >= 0) runs.push([open, n]);
  // 0.22秒より短い切れ目(「っ」や子音)はつなぎ、0.15秒より短い音(物音・口の音)は捨てる
  const join = (xs, gap) => {
    const out = [];
    for (const r of xs) {
      const last = out[out.length - 1];
      if (last && r[0] - last[1] < gap) last[1] = r[1];
      else out.push([r[0], r[1]]);
    }
    return out;
  };
  const segs = join(
    join(runs, 22).filter((r) => r[1] - r[0] >= 15),
    22,
  ).map((r) => [r2(r[0] * 0.01), r2(r[1] * 0.01)]);
  const sung = segs.reduce((t, r) => t + r[1] - r[0], 0);
  return { dur: r2(dur), segs, range: Math.round(range * 10) / 10, frac: r2(sung / dur) };
}

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 録音(動画・音声のファイル) → 歌っている区間。読めなかったら { failed: 理由 }
export async function listenVoice(blob) {
  let buf = null;
  try {
    const aac = await aacFromMp4(blob);
    if (aac) buf = await decodeLow(aac.buffer);
  } catch {}
  if (!buf) {
    // 音だけ取り出せない形のファイルは丸ごと読む(大きすぎるものは、メモリが足りなくなるのでやめておく)
    if (blob.size > (IOS ? 150e6 : 400e6)) return { v: 1, failed: 'big' };
    try {
      buf = await decodeLow(await blob.arrayBuffer());
    } catch {
      return { v: 1, failed: 'decode' };
    }
  }
  if (buf.duration > 20 * 60) return { v: 1, failed: 'long' };
  return { v: 1, ...voiceSegments(buf) };
}

// アカペラとして聴き取れたか(伴奏つき・ずっと音が鳴っている録音は、歌の切れ目が分からない)
export const voiceUsable = (v) => !!v?.segs && v.segs.length >= 2 && v.range >= 12 && v.frac >= 0.06 && v.frac <= 0.92;

// ---------------------------------------------------------------- 譜面の行の「歌う時刻の見本」

function interp(xs, ys, x, slope) {
  const n = xs.length;
  if (!n) return x * slope;
  if (x <= xs[0]) return ys[0] + (x - xs[0]) * slope;
  for (let k = 0; k < n - 1; k++) if (x <= xs[k + 1]) return xs[k + 1] > xs[k] ? ys[k] + ((x - xs[k]) / (xs[k + 1] - xs[k])) * (ys[k + 1] - ys[k]) : ys[k];
  return ys[n - 1] + (x - xs[n - 1]) * slope;
}

// lines: 譜面の行。starts・durs: 行の頭の拍と長さ(拍)。bps: 1秒あたりの拍。
// timing: 行ごとの原曲の時刻(music/timing.js の形。曲と合わせるのと同じもの)。無ければ小節数から見積もる。
// 戻り値: { rows: [{ i: 行, t: 歌い出し, end: 歌い終わり, lyric: 歌う行か, iv: 歌っている区間 }], exact: 原曲の時刻を使えたか }
export function refLines({ lines, starts, durs, bps, timing = null, act = null }) {
  const idx = [];
  lines.forEach((l, i) => durs[i] > 0 && idx.push(i));
  const sung = (i) => lines[i].type === 'lyric' && SUNG.test(lineText(lines[i]));
  const timed = (i) => !!timing?.[i] && Number.isFinite(timing[i].t);
  const lyr = idx.filter(sung);
  const got = lyr.filter(timed);
  const exact = got.length >= 4 && got.length >= lyr.length * 0.5;
  const xs = got.map((i) => starts[i]);
  const ys = got.map((i) => timing[i].t);
  const rows = idx.map((i) => ({ i, lyric: sung(i), t: !exact ? starts[i] / bps : sung(i) && timed(i) ? timing[i].t : interp(xs, ys, starts[i], 1 / bps) }));
  for (let k = 1; k < rows.length; k++) if (rows[k].t < rows[k - 1].t + 0.05) rows[k].t = rows[k - 1].t + 0.05;
  rows.forEach((r, k) => {
    const next = rows[k + 1] ? rows[k + 1].t : r.t + durs[r.i] / bps;
    r.iv = null;
    if (!r.lyric) r.end = next;
    else if (exact) {
      const L = timing[r.i];
      const n = Array.from(lineText(lines[r.i])).length;
      const marks = (L?.marks || []).filter((m) => m.t >= r.t - 0.01);
      const z = marks[marks.length - 1];
      let end;
      if (z?.d > 0) {
        // 文字ごとの長さまで分かる歌詞: 文字と文字のあいだの休み(となり合う文字のあいだが0.35秒以上あく)も見本に入れる
        const iv = [[r.t, r.t]];
        marks.forEach((m, q) => {
          if (!(m.d > 0)) return;
          const last = iv[iv.length - 1];
          const prev = marks[q - 1];
          if (m.t - last[1] >= 0.35 && prev && m.p - prev.p <= 2 && last[1] > last[0]) iv.push([m.t, m.t + m.d]);
          else last[1] = Math.max(last[1], m.t + m.d);
        });
        end = iv[iv.length - 1][1];
        r.iv = iv;
      } else if (z) end = z.t + Math.max(0, n - z.p) * 0.2 + 0.35; // 最後に時刻の分かる文字から先は、1文字0.2秒の見積もり
      else end = r.t + (lines[r.i].mora || n) * 0.24 + 0.4;
      if (L?.end > r.t) end = Math.min(end, L.end);
      r.end = Math.max(r.t + 0.5, Math.min(end, next - 0.12));
      if (r.iv) {
        r.iv = r.iv.map(([s, e]) => [s, Math.min(e, r.end)]).filter(([s, e]) => e > s);
        if (r.iv.length) r.iv[r.iv.length - 1][1] = r.end;
        else r.iv = null;
      }
    } else r.end = r.t + Math.max(0.5, (next - r.t) * 0.85);
    if (r.lyric && !r.iv) r.iv = [[r.t, r.end]];
  });
  // 歌っている区間の見本: 原曲の歌詞ぜんぶの区間(譜面に書かれていない くり返し なども入っている)があればそれ。無ければ譜面の行から
  const own = [];
  for (const r of rows) if (r.lyric) for (const v of r.iv) own.push(v);
  return { rows, exact, act: exact && act?.length >= 4 ? act : own };
}

// ---------------------------------------------------------------- 歌声と見本を重ねる

// こま(H 秒ごと)に、区間 [s, e] が占める割合を足す
function cover(arr, s, e, H) {
  const a = Math.max(0, Math.floor(s / H));
  const b = Math.min(arr.length - 1, Math.floor(e / H));
  for (let j = a; j <= b; j++) {
    const v = (Math.min(e, (j + 1) * H) - Math.max(s, j * H)) / H;
    if (v > 0) arr[j] = Math.min(1, arr[j] + v);
  }
}

// 録音のこま i と見本のこま j を、時間の順を保ったまま対応させる(動的計画法)。
// ・どちらも歌っている/どちらも静か = 合っている。片方だけ歌っている = 合っていない(1こまごとに罰点)
// ・伸び縮み(片方だけ進む)には罰点。歌っているところは大きめ、短い息つぎは小さめ、
//   間奏(見本の長い休み。el)はただ(アカペラでは、間奏を待たずに次を歌い出す)
// ・見本の行の歌い出しと、録音の歌い出しが重なると、少しごほうび
// wins: 録音のこま → その時刻に通ってよい見本のこまの範囲(1回タップの目印)
// path = false なら、罰点の合計だけ返す(歌う速さを探すとき)
function dtw(a, b, el, unk, refOn, recOn, wins, start, P, path = true) {
  const N = b.length;
  const M = a.length;
  const bp = path ? new Uint8Array(N * M) : null;
  let prev = new Float32Array(M);
  let cur = new Float32Array(M);
  const INF = 1e30;
  const { mSV, mRV, lamV, lamS, eps, beta } = P;
  for (let i = 0; i < N; i++) {
    const bi = b[i];
    const bv = bi > 0.5;
    const on = recOn[i];
    const win = wins.get(i);
    const row = i * M;
    for (let j = 0; j < M; j++) {
      if (win && (j < win[0] || j > win[1])) {
        cur[j] = INF;
        if (bp) bp[row + j] = 3;
        continue;
      }
      const aj = a[j];
      const d = aj - bi;
      const c = unk[j] ? 0 : d > 0 ? d * mSV : -d * mRV;
      const e = el[j];
      const step = bv || aj > 0.5 ? lamV : e ? eps : lamS;
      let best;
      let from;
      if (i === 0) {
        best = start[j] + c;
        from = 3;
      } else {
        best = prev[j] + step + c;
        from = 1;
        if (j > 0) {
          const x = prev[j - 1] + c - (on && refOn[j] ? beta : 0);
          if (x <= best) {
            best = x;
            from = 0;
          }
        }
      }
      if (j > 0) {
        // 間奏は、録音がどこにいても、ただで飛ばせる
        const x = cur[j - 1] + (e ? eps : step + c);
        if (x < best) {
          best = x;
          from = 2;
        }
      }
      cur[j] = best;
      if (bp) bp[row + j] = from;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  // 録音の終わりは、見本のどこで終わってもよい(1番だけ歌った録音など)
  let j = 0;
  for (let q = 1; q < M; q++) if (prev[q] < prev[j]) j = q;
  if (prev[j] >= INF) return null;
  if (!bp) return { cost: prev[j] };
  const cost = prev[j];
  const first = new Int32Array(M).fill(-1); // 見本のこま j に、録音が最初に着いたこま
  const last = new Int32Array(M).fill(-1); // 最後にいたこま
  let i = N - 1;
  for (;;) {
    first[j] = i;
    if (last[j] < 0) last[j] = i;
    const f = bp[i * M + j];
    if (f === 3) break;
    if (f === 0) {
      i--;
      j--;
    } else if (f === 1) i--;
    else j--;
  }
  return { cost, first, last };
}

// 重ねるときの罰点(0.1秒のこまあたり)。行の終わりは当てにできない(最後の音をどこまで伸ばすかは人しだい)ので、
// 歌い出しがそろうこと(beta)と、行と行の間隔が保たれること(lamS)を重く見る
const PARAM = { mRV: 1, mSV: 0.7, lamV: 0.5, lamS: 0.3, eps: 0.001, beta: 3 };
const GAP = 2.5; // これより長い休みは間奏(好きなだけ縮めてよい)
// 歌った1秒あたりの罰点がこれ以下なら、自動でうまく合ったとみなす
// (「にせの歌」10曲で、合っているときは -0.3〜0.4、別の曲を重ねると 0.6〜2.3)
const GOOD = 0.45;

// rows・act: refLines の結果。voice: voiceSegments の結果。pins: [{ line, t }](その時刻に、その行を歌っている)
// 戻り値: { got: Map(行 → { t: 歌い出し, end: 歌い終わり }), rate: 原曲に対する歌の遅さ, cost: 1秒あたりの罰点, matched, total } | null
export function alignVoice({ rows, act, voice, pins = [], opt = null }) {
  const lyr = rows.filter((r) => r.lyric);
  if (!lyr.length || !voice?.segs?.length) return null;
  const ivs = act;
  if (!ivs?.length) return null;
  const P = { ...PARAM, ...opt };
  const segs = voice.segs;
  const sungSec = segs.reduce((t, s) => t + s[1] - s[0], 0);
  const setup = (rate, H0) => {
    const tail = ivs[ivs.length - 1];
    const refDur = Math.max(rows[rows.length - 1].end, tail[2] ?? tail[1]) * rate + 1;
    let H = H0;
    while ((voice.dur / H) * (refDur / H) > 12e6) H += 0.05;
    const k = H / 0.1;
    const Q = { mRV: P.mRV * k, mSV: P.mSV * k, lamV: P.lamV * k, lamS: P.lamS * k, eps: P.eps * k, beta: P.beta };
    const N = Math.max(2, Math.ceil(voice.dur / H));
    const M = Math.max(2, Math.ceil(refDur / H));
    const a = new Float32Array(M);
    const b = new Float32Array(N);
    const el = new Uint8Array(M).fill(1);
    const unk = new Uint8Array(M); // 歌っているかどうか分からないこま(行の時刻しか無い歌詞の、行の終わりのほう)。どちらでも罰点なし
    const refOn = new Uint8Array(M);
    const recOn = new Uint8Array(N);
    ivs.forEach((v, q) => {
      const before = q ? ivs[q - 1][2] ?? ivs[q - 1][1] : -Infinity;
      const until = v[2] ?? v[1];
      cover(a, v[0] * rate, v[1] * rate, H);
      const gap = v[0] - before;
      if (gap >= 0.25 || (q && ivs[q - 1].length === 3)) refOn[Math.min(M - 1, Math.floor((v[0] * rate) / H))] = 1;
      // 歌っているところと、短い休みは、縮めにくい
      const from = gap < GAP ? before : v[0];
      for (let j = Math.max(0, Math.floor((from * rate) / H)); j <= Math.min(M - 1, Math.floor((until * rate) / H)); j++) el[j] = 0;
      for (let j = Math.floor((v[1] * rate) / H) + 1; j <= Math.min(M - 1, Math.floor((until * rate) / H)); j++) unk[j] = 1;
    });
    for (let j = 0; j < M; j++) if (a[j] > 0.5) unk[j] = 0;
    for (const s of segs) {
      cover(b, s[0], s[1], H);
      recOn[Math.min(N - 1, Math.floor(s[0] / H))] = 1;
    }
    // 録音は、曲の頭からとは限らない(サビからの録音など)。途中から始めるのは少しだけ罰点(同じ形なら早いほうを選ぶ)
    const j0 = Math.floor((ivs[0][0] * rate) / H);
    const start = new Float32Array(M);
    for (let j = j0 + 1; j < M; j++) start[j] = 4 + 0.02 * k * (j - j0);
    const wins = new Map();
    for (const p of pins) {
      const at = rows.findIndex((x) => x.i === p.line);
      const r = rows[at];
      if (!r || !(p.t >= 0)) continue;
      const i = Math.max(0, Math.min(N - 1, Math.round(p.t / H)));
      if (wins.has(i)) continue;
      // その行を歌っている間(次の行が始まるまで)のどこか。押すのが少し早い・遅いぶんの余裕をつける
      const until = Math.max(r.end, rows[at + 1] ? rows[at + 1].t : 0);
      wins.set(i, [Math.max(0, Math.floor((r.t * rate - 0.4) / H)), Math.min(M - 1, Math.ceil((until * rate + 0.4) / H))]);
    }
    return { H, N, M, a, b, el, unk, refOn, recOn, wins, start, Q };
  };
  const costAt = (rate) => {
    const s = setup(rate, 0.25);
    const r = dtw(s.a, s.b, s.el, s.unk, s.refOn, s.recOn, s.wins, s.start, s.Q, false);
    return r ? r.cost : Infinity;
  };
  // 歌う速さ(原曲の何倍の時間をかけて歌っているか)を探す: 粗いこまで試して、罰点のいちばん少ない速さ
  const grid = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25];
  let rate = 1;
  let low = Infinity;
  const tryRate = (g) => {
    const c = costAt(g) + Math.abs(Math.log(g)) * 2; // 同じくらいなら、原曲に近い速さ
    if (c < low) {
      low = c;
      rate = g;
    }
  };
  grid.forEach(tryRate);
  [rate * 0.975, rate * 1.025].forEach(tryRate);
  const s = setup(rate, 0.1);
  const { H, M } = s;
  const path = dtw(s.a, s.b, s.el, s.unk, s.refOn, s.recOn, s.wins, s.start, s.Q, true);
  if (!path) return null;
  const got = new Map();
  let lastT = -1;
  for (const r of lyr) {
    const jOn = Math.min(M - 1, Math.floor((r.t * rate) / H));
    const jEnd = Math.min(M - 1, Math.max(jOn, Math.floor((r.end * rate) / H) - 1));
    const i0 = path.first[jOn];
    const i1 = path.last[jEnd];
    if (i0 < 0 || i1 < 0) continue;
    // この行のあいだに、実際に歌っていた長さ。ほとんど歌っていなければ、歌わなかった行(飛ばした行)
    let sung = 0;
    for (let i = i0; i <= i1; i++) sung += s.b[i] * H;
    if (sung < Math.min(0.4, (r.end - r.t) * rate * 0.3)) continue;
    let t = i0 * H + ((r.t * rate) % H);
    let end = (i1 + 1) * H;
    // 歌い出しは、近くの「歌声の始まり」にそろえる(0.1秒きざみより細かく)
    if (s.refOn[jOn] || s.refOn[jOn - 1] || s.refOn[jOn + 1]) {
      let best = null;
      for (const g of segs) if (Math.abs(g[0] - t) <= 0.3 && (best == null || Math.abs(g[0] - t) < Math.abs(best - t))) best = g[0];
      if (best != null) t = best;
    }
    for (const g of segs)
      if (g[0] <= end + 0.3 && g[1] >= end - 0.3) {
        end = g[1];
        break;
      }
    if (t < lastT + 0.1) continue;
    got.set(r.i, { t: r2(t), end: r2(Math.max(end, t + 0.3)) });
    lastT = t;
  }
  if (!got.size) return null;
  return { got, rate, cost: path.cost / Math.max(1, sungSec), matched: got.size, total: lyr.length };
}

function toAnchors(rows, got) {
  const out = [];
  rows.forEach((r, k) => {
    const g = got.get(r.i);
    if (r.lyric) {
      if (g) out.push({ line: r.i, t: g.t });
      return;
    }
    // 歌のない行(間奏など): 前の行を歌い終えたところから始まり、次に歌い出すまでのあいだに収める
    const p = rows[k - 1];
    const pg = p?.lyric ? got.get(p.i) : null;
    if (!pg) return;
    let nextT = Infinity;
    for (let q = k + 1; q < rows.length; q++) {
      const ng = rows[q].lyric ? got.get(rows[q].i) : null;
      if (ng) {
        nextT = ng.t;
        break;
      }
    }
    const t = Math.min(pg.end + 0.15, nextT - 0.3);
    if (t > pg.t + 0.3) out.push({ line: r.i, t: r2(t) });
  });
  const clean = [];
  for (const a of out) if (!clean.length || a.t >= clean[clean.length - 1].t + 0.08) clean.push(a);
  return clean;
}

// 目印を押した場所の、見本の時刻(行の中の文字の位置から)
function pinRef(pin, rows, lines) {
  const r = rows.find((x) => x.i === pin.line);
  if (!r) return null;
  let f = 0;
  if (r.lyric && pin.pos > 0) {
    const w = weightsOf(Array.from(lineText(lines[r.i])));
    const total = w.reduce((x, y) => x + y, 0) || 1;
    let before = 0;
    for (let p = 0; p < Math.min(w.length, pin.pos); p++) before += w[p];
    f = Math.min(0.95, before / total);
  }
  return r.t + f * (r.end - r.t);
}

// 録音に譜面を合わせる。
// 戻り値: { mode, anchors: [{ line, t }](行の頭がその時刻), good: そのまま使えそうか, matched, total }
//   mode: 'voice' = 歌声と原曲の歌詞の時刻を重ねた / 'pins' = 押した目印に合わせた / 'start' = 最初の歌い出しだけ合わせた / 'none'
export function alignRecording({ lines, rows, exact, act, voice, pins = [], opt = null }) {
  const ok = pins.filter((p) => rows.some((r) => r.i === p.line) && p.t >= 0).sort((x, y) => x.t - y.t);
  const usable = voiceUsable(voice);
  if (usable && exact) {
    const res = alignVoice({ rows, act, voice, pins: ok, opt });
    if (res) {
      const good = res.cost <= GOOD && res.matched >= Math.min(4, res.total);
      return { mode: 'voice', anchors: toAnchors(rows, res.got), good, matched: res.matched, total: res.total, cost: res.cost, rate: res.rate };
    }
  }
  // 原曲の歌詞の時刻が無い曲・歌の切れ目が分からない録音(伴奏つきなど):
  // 見本の時刻(原曲の時刻か、テンポどおり)を、目印のところのずれぶんだけ動かす
  const pts = [];
  for (const p of ok) {
    const r = pinRef(p, rows, lines);
    if (r != null && (!pts.length || r > pts[pts.length - 1].r + 0.5)) pts.push({ r, off: p.t - r });
  }
  // 目印が無くても、歌声が聴き取れていれば、最初の歌い出しを、最初の歌の行に合わせておく
  const first = rows.find((r) => r.lyric);
  const byStart = !pts.length && usable && !!first;
  if (byStart) pts.push({ r: first.t, off: voice.segs[0][0] - first.t });
  if (!pts.length) return { mode: 'none', anchors: [], good: false, matched: 0, total: 0 };
  // 間奏(歌のない行・長い休み)。目印と目印のあいだで譜面が早まるぶんは、間奏を縮めたものとして、間奏のところに割り振る
  const gaps = [];
  let last = null;
  let between = false;
  for (const r of rows) {
    if (!r.lyric) {
      between = true;
      continue;
    }
    if (last && (between || r.t - last.end >= GAP) && r.t > last.end) gaps.push([last.end, r.t]);
    last = r;
    between = false;
  }
  const gapBefore = (x) => gaps.reduce((t, g) => t + Math.max(0, Math.min(g[1], x) - g[0]), 0);
  const offAt = (r) => {
    if (r <= pts[0].r) return pts[0].off;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (r > b.r) continue;
      const w = gapBefore(b.r) - gapBefore(a.r);
      const f = b.off < a.off - 0.5 && w > 0.5 ? (gapBefore(r) - gapBefore(a.r)) / w : (r - a.r) / (b.r - a.r);
      return a.off + f * (b.off - a.off);
    }
    return pts[pts.length - 1].off;
  };
  const anchors = [];
  for (const r of rows) {
    const t = r2(r.t + offAt(r.t));
    if (!anchors.length || t >= anchors[anchors.length - 1].t + 0.08) anchors.push({ line: r.i, t });
  }
  return { mode: byStart ? 'start' : 'pins', anchors, good: !byStart, matched: anchors.length, total: rows.length };
}
