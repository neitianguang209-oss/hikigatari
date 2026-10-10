// 「コード進行メモ倉庫」(music-chord.com)の曲データ → 譜面テキスト([C]歌詞 の形)
// 曲データは、行ごとの歌詞と、コード(キーからの度数: 4 / 5# / 6b、種類: m / 7 / M7 …)と、その鳴る時刻(YouTube の動画の時刻)。
// ・小節線: 行の長さを BPM の1小節で割った数だけ入れる(自動スクロールが曲と同じ速さで進む)
// ・行の中のコードの位置: 歌詞の1文字ずつの時刻(KRC)があれば、動画の時刻に合わせてから、コードが鳴る瞬間に歌っている文字に置く。
//   無ければ、行の長さを歌う長さ(文字の重み)で割り振った見積もり
import { noteName, keyPrefersFlat } from './chord.js';
import { makeWordPos, makePosOf, makeWeights } from './lyricsfit.js';

const SCALE = [0, 2, 4, 5, 7, 9, 11];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const mod12 = (n) => ((n % 12) + 12) % 12;
// コードの種類の書き方(このサイト独自のものだけ直す。ほかはそのまま)
const QUAL = { '-5': '(b5)' };

export const toSec = (s) => {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(s) || 0;
};

function keyPc(k) {
  const m = /^([A-G])([#♯b♭]?)/.exec(String(k || ''));
  if (!m) return null;
  return mod12(LETTER[m[1]] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0));
}

// 度数(「4」「5#」「6b」) → 音(0〜11)
function degPc(d, kp) {
  const m = /^([1-7])([#♯b♭]?)$/.exec(String(d ?? '').trim());
  if (!m) return null;
  return mod12(kp + SCALE[Number(m[1]) - 1] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0));
}

export function mcChord(p, kp, flat) {
  if (String(p.base) === 'NC') return 'N.C.';
  const r = degPc(p.base, kp);
  if (r == null) return null;
  const q = p.quality ? QUAL[p.quality] ?? p.quality : '';
  let s = noteName(r, flat) + q;
  if (p.tension) s += `(${p.tension})`;
  if (p.onBase) {
    const b = degPc(p.onBase, kp);
    if (b != null && b !== r) s += '/' + noteName(b, flat);
  }
  return s;
}

// ---------------------------------------------------------------- 歌詞の1文字ずつの時刻(KRC)を、この曲データの時刻に合わせる

const keep = (c) => /[ぁ-ゖァ-ヺー一-鿿々〆ヶA-Za-z0-9]/.test(c);
const N = (c) => c.normalize('NFKC').toLowerCase();

// 2つの文字の並びの対応(最長共通部分列)。a[i] に対応する b の番号(無ければ -1)
export function lcsMap(a, b) {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const map = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return map;
}

const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  return a.length ? a[a.length >> 1] : null;
};

const pct = (xs, f) => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : null;
};

// 歌詞の文字を対応させて、行ごとの「ずれ(動画の時刻 − 歌詞の時刻)」を出す: 行の頭のコードの時刻と、その行で最初に歌う文字の時刻の差
function matchKrc(secs, krc) {
  const A = [];
  secs.forEach((s, i) => Array.from((s.lyric || '').trim()).forEach((ch, p) => keep(ch) && A.push({ i, p, ch: N(ch) })));
  const B = [];
  for (const l of krc || [])
    for (const w of l.words || []) {
      let first = true;
      for (const ch of Array.from(w.s)) {
        if (!keep(ch)) continue;
        B.push({ ch: N(ch), t: w.t, e: w.t + (w.d || 0), first });
        first = false;
      }
    }
  if (A.length < 20 || B.length < 20) return null;
  const map = lcsMap(
    A.map((x) => x.ch),
    B.map((x) => x.ch),
  );
  const hit = [...map].filter((j) => j >= 0).length;
  if (hit < A.length * 0.6) return null; // 歌詞が違いすぎる(別の曲・別の版)
  const firstOf = new Map();
  A.forEach((a, k) => {
    if (map[k] >= 0 && !firstOf.has(a.i)) firstOf.set(a.i, B[map[k]]);
  });
  const rows = [...firstOf.keys()].sort((x, y) => x - y).map((i) => ({ i, d: secs[i].t - firstOf.get(i).t }));
  return rows.length ? { A, B, map, rows, hit: hit / A.length } : null;
}

// ずれの見積もり = 行ごとのずれの、まん中の値。
// (歌は行の頭の少し後から始まることが多いので、行の終わりの側からも幅をしぼって真ん中を取る見積もりも試した。
//  動画の字幕の時刻には近づくが、コードを置く文字は ChordWiki の正解9曲で ぴったり 74%→59% と悪くなったので、やめた)
const offsetOf = (rows) => median(rows.map((r) => r.d));

// 文字ごとの時刻つき歌詞の候補のうち、この曲データ(動画の時刻)にいちばん合うもの。
// 同じ曲でも音源の版ごとに時刻の違う歌詞があり、動画と速さの違うものだと、ずれが曲の中で大きく変わる
// (ずれのばらつきがいちばん小さいものを選ぶ)
export function pickKrc(secs, list) {
  let best = null;
  let bestSpread = Infinity;
  for (const krc of list || []) {
    const m = matchKrc(secs, krc);
    if (!m || m.rows.length < 6) continue;
    const d = m.rows.map((r) => r.d);
    const spread = pct(d, 0.8) - pct(d, 0.2) - m.hit; // 同じくらいなら、歌詞がよく合うほう
    if (spread < bestSpread) {
      bestSpread = spread;
      best = krc;
    }
  }
  return best;
}

// secs: 行(t, lyric, progressions)。krc: krcToSynced の行 [{ t, text, words }]
// 戻り値: 行ごとの文字の印 [{ p, t, e }](動画の時刻)。合わせられなければ null
export function alignKrc(secs, krc) {
  const m = matchKrc(secs, krc);
  if (!m) return null;
  const { A, B, map, rows } = m;
  // (コードの鳴る時刻を文字の歌い始めにそろえる細かい合わせ込みも試したが、8分音符ずつずれた位置にそろってしまい、かえって悪くなった)
  const off = offsetOf(rows);
  if (off == null) return null;
  // ずれは曲全体でほぼ同じことが多いが、動画と音源で前奏・間奏の長さが違う曲や、速さの違う版の歌詞では、場所によって変わる。
  // 行ごとに前後5行で見積もり、全体の値から0.5秒以上離れているところだけ、その場所の値を使う
  const offOf = new Map();
  rows.forEach((r, k) => {
    const near = offsetOf(rows.slice(Math.max(0, k - 5), k + 6));
    offOf.set(r.i, Math.abs(near - off) >= 0.5 ? near : off);
  });
  const out = secs.map(() => []);
  A.forEach((a, k) => {
    const b = map[k] >= 0 ? B[map[k]] : null;
    const o = offOf.get(a.i) ?? off;
    if (b && b.first) out[a.i].push({ p: a.p, t: b.t + o, e: b.e + o });
  });
  return out.map((x) => (x.length >= 2 ? x : null));
}

// ---------------------------------------------------------------- 譜面テキストにする

// c: 曲データ(chordsJson)。krc: 歌詞の1文字ずつの時刻(krcToSynced の形、無ければ null)。
// krcs: その候補がいくつかあるとき(この曲データにいちばん合うものを選んで使う)。ruby: ふりがなの辞書
export function mcToSheet(c, { krc = null, krcs = null, ruby = null } = {}) {
  const secs = (c.sections || []).map((s) => ({ ...s, t: toSec(s.time) })).sort((a, b) => a.t - b.t);
  const bpm = Number(c.bpm) > 0 ? Number(c.bpm) : null;
  const barLen = bpm ? 240 / bpm : null; // 4拍子
  if (krcs?.length) krc = pickKrc(secs, krcs) || krc;
  const marksOf = krc ? alignKrc(secs, krc) : null;
  const wOf = makeWeights(ruby);
  let kp = keyPc(secs.find((s) => s.key)?.key) ?? 0;
  // ♯・♭ はサイトのキーの書き方(Gb なら ♭)に合わせる。書いていなければ調号どおり
  const flatOf = (k, pc) => (/^[A-G](b|♭)/.test(k || '') ? true : /^[A-G](#|♯)/.test(k || '') ? false : keyPrefersFlat({ pc, minor: false }));
  let kFlat = flatOf(secs.find((s) => s.key)?.key, kp);
  const keyText = (pc, flat) => noteName(pc, flat);
  const firstKey = keyText(kp, kFlat);
  const out = [`{key:${firstKey}}`];
  if (bpm) out.push(`{tempo:${bpm}}`);
  out.push('');
  // 譜面に出した行(歌詞・コードの行)ごとの時刻。曲(動画)と合わせて流すときに使う
  const rows = [];
  let lastKey = kp;
  secs.forEach((s, i) => {
    const k = keyPc(s.key);
    if (k != null) {
      kFlat = flatOf(s.key, k);
      if (k !== lastKey) out.push(`{key:${keyText(k, kFlat)}}`); // 転調
      kp = lastKey = k;
    }
    const flat = kFlat;
    if (s.sectionName) {
      if (out[out.length - 1] !== '') out.push('');
      out.push(`{c:${s.sectionName}}`);
    }
    const start = s.t;
    const next = secs[i + 1];
    const chords = (s.progressions || [])
      .map((p) => ({ t: Number.isFinite(p.time) ? Math.max(start, p.time) : start, c: mcChord(p, kp, flat) }))
      .filter((x) => x.c)
      .sort((a, b) => a.t - b.t);
    const lastT = chords.length ? chords[chords.length - 1].t : start;
    const end = next && next.t > start ? next.t : Math.max(lastT, start) + (barLen || 2);
    const nb = barLen ? Math.max(1, Math.round((end - start) / barLen)) : null;
    const lyric = (s.lyric || '').trim();
    if (!chords.length && !lyric) return;
    out.push(lyric ? lyricRow(lyric, chords, start, end, nb, marksOf?.[i] || null, wOf) : chordRow(chords, start, end, nb));
    rows.push({ t: start, end, lyric, chords: chords.map((x) => x.t), marks: marksOf?.[i] || null });
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return { text: out.join('\n'), bpm, key: firstKey, aligned: !!marksOf?.some(Boolean), rows };
}

// 小節の境目の時刻(行の長さを小節の数で等分)。コードが境目の少し前(0.06秒以内)なら境目に寄せる
function barTimes(start, end, nb) {
  const bl = (end - start) / nb;
  return Array.from({ length: nb }, (_, k) => start + k * bl);
}
function snap(t, bars) {
  for (const b of bars) if (Math.abs(t - b) < 0.06) return b;
  return t;
}

// コードだけの行(前奏・間奏など): |[C] [G] |[Am] |
function chordRow(chords, start, end, nb) {
  if (!nb) return chords.map((x) => `[${x.c}]`).join(' ');
  const bars = barTimes(start, end, nb);
  const bl = (end - start) / nb;
  const bins = bars.map(() => []);
  for (const x of chords) {
    const k = Math.min(nb - 1, Math.max(0, Math.floor((snap(x.t, bars) - start) / bl + 1e-6)));
    bins[k].push(x.c);
  }
  return '|' + bins.map((b) => b.map((c) => `[${c}]`).join(' ') + ' ').join('|') + '|';
}

// 歌詞の行: |[C]風の強さが[G/B]ちょっと |[Am]心を…
function lyricRow(lyric, chords, start, end, nb, marks, wOf) {
  const chars = Array.from(lyric);
  const n = chars.length;
  const timed = !!marks;
  // 見積もりのときは、行の長さの9割で歌い終わるとみなす(行の終わりは次の行への息つぎ)
  const posOf = timed ? makeWordPos(marks, n) : makePosOf(wOf(chars), start, start + (end - start) * 0.9);
  const bars = nb ? barTimes(start, end, nb) : [];
  const toks = [...bars.map((t) => ({ type: 'bar', t })), ...chords.map((x) => ({ type: 'chord', t: snap(x.t, bars), c: x.c }))];
  toks.sort((a, b) => a.t - b.t || (a.type === 'bar' ? -1 : 1));
  for (const tk of toks) tk.pos = posOf(tk.t);
  // 小節の頭で変わるコードは、小節線と同じ位置に
  for (let k = 1; k < toks.length; k++) if (toks[k].type === 'chord' && toks[k - 1].type === 'bar' && Math.abs(toks[k].t - toks[k - 1].t) < 1e-6) toks[k - 1].pos = toks[k].pos;
  // 見積もりのときは、行の最初の小節線は行の頭に
  if (!timed && toks[0]?.type === 'bar') toks[0].pos = 0;
  let p = 0;
  for (const tk of toks) p = tk.pos = Math.max(p, Math.min(n, tk.pos));
  let s = '';
  let k = 0;
  let last = null;
  for (let ci = 0; ci <= n; ci++) {
    while (k < toks.length && toks[k].pos <= ci) {
      const tk = toks[k++];
      if (tk.type === 'bar') s += '|';
      else {
        s += `[${tk.c}]`;
        last = tk.c;
      }
    }
    if (ci < n) s += chars[ci];
  }
  // 譜面を読んだときの小節の数を、行の小節の数とぴったり同じにする(lyricsfit と同じ決まり)
  if (nb) {
    if (s.endsWith('|') && last) s += `[${last}]`;
    if (nb === 1) s += '|';
  }
  return s;
}
