// 曲(YouTube の動画)と譜面を結びつける: 譜面の行・文字・コード ↔ 曲の時刻
// 時刻の出どころは3つ(上ほど正確):
//   コード進行メモ倉庫の曲データ … 行とコードの時刻が、その曲の YouTube の動画の時刻で入っている(base: 'yt')
//   文字ごとの時刻つき歌詞(KRC) … 原曲の音源の時刻(base: 'album')
//   行ごとの時刻つき歌詞(LRC)   … 同上
// 行ごとの結果: { t: 行の頭の時刻, end?: 行の終わり, marks: [{ p: 文字の位置, t }], chords: [{ k: 何番目のかたまり(seg), t }] | null }
import { lcsMap } from './mcsheet.js';
import { makeWeights } from './lyricsfit.js';
import { moraCount } from './sheet.js';

const keep = (c) => /[ぁ-ゖァ-ヺー一-鿿々〆ヶA-Za-z0-9]/.test(c);
// 比べるときは全角半角・大文字小文字・カタカナひらがなの違いを無視する
const N = (c) => {
  const x = c.normalize('NFKC').toLowerCase()[0] || c;
  return /[ァ-ヶ]/.test(x) ? String.fromCharCode(x.charCodeAt(0) - 0x60) : x;
};
const strip = (s) => String(s || '').replace(/[\s　]/g, '');
const weightsOf = makeWeights(null);
// コード進行メモ倉庫の行に合わせた歌詞の文字の時刻は、少しだけ早めに出る(歌は行の頭の少し後から始まることが多いぶん)。
// 「マリーゴールド」で動画の字幕の時刻と比べると、まん中で0.34秒早かった(字幕は歌い出しより0.2秒ほど遅れて出る)。そのぶんを戻す
const MARK_SHIFT = 0.15;

export const lineText = (l) => (l.segs || []).map((s) => s.t).join('');
// k 番目のかたまり(seg)が始まる文字の位置
export function segStart(line, k) {
  let p = 0;
  for (let j = 0; j < k && j < line.segs.length; j++) p += Array.from(line.segs[j].t).length;
  return p;
}

// 時刻が戻らないものだけ残す(文字の位置の順に並んでいること)
function monotonic(marks) {
  const out = [];
  for (const m of marks) {
    if (!Number.isFinite(m.t)) continue;
    const last = out[out.length - 1];
    if (last && (m.p <= last.p || m.t < last.t)) continue;
    out.push(m);
  }
  return out;
}

// 文字ごとの時刻つき歌詞(krcToSynced の形)の1行 → 文字の位置ごとの印
function wordMarks(words) {
  const marks = [];
  let p = 0;
  for (const w of words || []) {
    const chars = Array.from(w.s);
    const k = chars.findIndex((c) => c.trim());
    if (w.t != null && k >= 0) marks.push(w.d > 0 ? { p: p + k, t: w.t, d: w.d } : { p: p + k, t: w.t });
    p += chars.length;
  }
  return marks;
}

// 時刻つき歌詞(LRC・KRC) → 合わせるための行 [{ t, text, marks }]
export function syncedLines(synced) {
  return (synced || []).filter((l) => l.text).map((l) => ({ t: l.t, text: l.text, marks: l.words ? wordMarks(l.words) : null }));
}

// コード進行メモ倉庫の行(mcToSheet の rows) → 合わせるための行(歌詞のある行だけ)
export function mcSyncedLines(rows) {
  return (rows || []).filter((r) => r.lyric).map((r) => ({ t: r.t, text: r.lyric, marks: r.marks ? r.marks.map((m) => ({ p: m.p, t: m.t + MARK_SHIFT })) : null }));
}

// ---------------------------------------------------------------- 譜面の行に時刻を割り当てる

// コード進行メモ倉庫の譜面そのまま(編集していない)のとき: 譜面の行と曲データの行は同じ順に並んでいるので、順番どおりに対応させる。
// コードの時刻もそのまま使えるので、コードを押したときにそのコードが鳴る瞬間から流せる。
// 行の数や歌詞が食い違ったら null(歌詞の文字で合わせる alignLines に回す)
export function mcDirect(rows, lines) {
  const body = [];
  lines.forEach((l, i) => (l.type === 'lyric' || l.type === 'chords') && body.push(i));
  if (!rows?.length || body.length !== rows.length) return null;
  const out = lines.map(() => null);
  for (let n = 0; n < rows.length; n++) {
    const r = rows[n];
    const l = lines[body[n]];
    if (r.lyric ? l.type !== 'lyric' || strip(lineText(l)) !== strip(r.lyric) : l.type !== 'chords') return null;
    const cs = [];
    l.segs.forEach((s, k) => s.c && cs.push(k));
    // 行の終わりに書き足した「|[C]」(小節の数をそろえるための同じコード)がある行は、コードが1つ多い
    let chords = null;
    if (cs.length === r.chords.length || cs.length === r.chords.length + 1) chords = r.chords.map((t, q) => ({ k: cs[q], t }));
    else if (l.type === 'chords' && cs.length) chords = cs.map((k, q) => ({ k, t: r.t + ((r.end - r.t) * q) / cs.length }));
    let marks = [];
    if (r.lyric) {
      if (r.marks?.length) {
        // 歌詞の文字の位置は「空白を除いて何文字目か」で譜面の文字に合わせ直す(譜面にするとき空白が落ちることがある)
        const src = Array.from(r.lyric);
        const dst = Array.from(lineText(l));
        const ord = [];
        dst.forEach((ch, p) => ch.trim() && ord.push(p));
        let seen = 0;
        const at = src.map((ch) => (ch.trim() ? seen++ : -1));
        for (const m of r.marks) {
          const o = at[m.p];
          if (o >= 0 && ord[o] != null) marks.push({ p: ord[o], t: m.t + MARK_SHIFT });
        }
      } else if (chords) marks = chords.filter((c) => c.k != null).map((c) => ({ p: segStart(l, c.k), t: c.t }));
      marks = monotonic(marks.sort((a, b) => a.p - b.p));
    }
    out[body[n]] = { t: r.t, end: r.end, marks, chords };
  }
  return out;
}

// 歌詞の文字を手がかりに、譜面の行と時刻つきの行を対応させる(サイトごとに行の切り方が違っても合う)
// synced: [{ t, text, marks?: [{ p, t }] }]。戻り値: { lines: 行ごとの時刻(合わなかった行は null), hit: 合った文字の割合 } | null
export function alignLines(lines, synced) {
  const A = [];
  const kept = lines.map(() => 0);
  lines.forEach((l, i) => {
    if (l.type !== 'lyric') return;
    Array.from(lineText(l)).forEach((ch, p) => {
      if (!keep(ch)) return;
      A.push({ i, p, n: kept[i]++, ch: N(ch) });
    });
  });
  const B = [];
  (synced || []).forEach((l, j) => {
    const chars = Array.from(l.text || '');
    const at = new Map((l.marks || []).map((m) => [m.p, m]));
    const len = chars.filter(keep).length;
    let q = 0;
    chars.forEach((ch, p) => {
      if (!keep(ch)) return;
      B.push({ j, q, len, ch: N(ch), t: at.has(p) ? at.get(p).t : q === 0 ? l.t : null, d: at.get(p)?.d });
      q++;
    });
  });
  if (A.length < 12 || B.length < 12 || A.length > 6000 || B.length > 6000) return null;
  const map = lcsMap(
    A.map((x) => x.ch),
    B.map((x) => x.ch),
  );
  let hits = 0;
  for (const j of map) if (j >= 0) hits++;
  const hit = hits / A.length;
  if (hit < 0.5) return null; // 歌詞が違いすぎる(別の曲・別の版)
  // 時刻つきの行 j の長さ(次の行の頭まで。間奏をはさむときは文字数からの見積もり)
  const spanOf = (j, len) => {
    const next = synced.slice(j + 1).find((x) => x.t > synced[j].t);
    const guess = len * 0.3 + 0.6;
    return next ? Math.min(next.t - synced[j].t, guess * 1.6) : guess;
  };
  const out = lines.map(() => null);
  let lastT = -Infinity;
  for (let a = 0; a < A.length; ) {
    const i = A[a].i;
    let b = a;
    while (b < A.length && A[b].i === i) b++;
    let marks = [];
    let got = 0;
    for (let k = a; k < b; k++) {
      if (map[k] < 0) continue;
      const x = B[map[k]];
      got++;
      // 時刻の分かる文字(単語の頭・行の頭)はそのまま。行の途中から始まる譜面の行は、その行の中の位置から見積もる
      if (x.t != null) marks.push(x.d > 0 ? { p: A[k].p, t: x.t, d: x.d } : { p: A[k].p, t: x.t });
      else if (!marks.length && got === 1) marks.push({ p: A[k].p, t: synced[x.j].t + (x.q / Math.max(1, x.len)) * spanOf(x.j, x.len) * 0.9, approx: true });
    }
    const size = b - a;
    a = b;
    if (got < Math.max(1, size * 0.4)) continue;
    marks = monotonic(marks).filter((m) => m.t > lastT - 0.05);
    if (!marks.length) continue;
    // 行の頭の時刻: 最初の印が行の頭ならそれ。少し後ろの文字なら、その手前の文字のぶんだけ戻す
    const first = marks[0];
    const before = A.find((x) => x.i === i && x.p === first.p)?.n || 0;
    const t = Math.max(lastT + 0.05, first.t - before * 0.2);
    out[i] = { t, marks, chords: null };
    lastT = marks[marks.length - 1].t;
  }
  return { lines: out, hit };
}


// ---------------------------------------------------------------- 原曲で歌っている区間

// 原曲の「歌っている区間」[[始まり, 終わり] か [始まり, 終わり, ここまでは歌っているかもしれない], …]。
// 自分の歌の録音を譜面に合わせるときの見本にする(music/voice.js)。
// 譜面に書かれていない くり返し なども入っているよう、譜面の行からではなく、時刻つきの歌詞そのものから作る
const cs = (x) => Math.round(x * 100) / 100;
function spans(add) {
  const out = [];
  add((s, e, u = null) => {
    const last = out[out.length - 1];
    if (last && last.length === 2 && u == null && s - last[1] < 0.22) last[1] = Math.max(last[1], e);
    else if (e > s) out.push(u != null && u > e ? [s, e, u] : [s, e]);
  });
  return out.map((v) => v.map(cs));
}
// 行の時刻しか分からない歌詞は、行の終わりが分からない。文字の数から「ここまでは確かに歌っている」と
// 「ここまでは歌っているかもしれない」を見積もる(1音にかける長さは、行と行の間隔から曲ごとに測る)
function guessEnds(ls, textOf) {
  const per = [];
  ls.forEach((l, k) => {
    const m = moraCount(textOf(l));
    const gap = ls[k + 1] ? ls[k + 1].t - l.t : 0;
    if (m >= 4 && gap > 1 && gap < 15) per.push(gap / m);
  });
  per.sort((a, b) => a - b);
  // 間隔には息つぎや休みも入っているので、短いほうから3割のところを「1音の長さ」とする
  const rate = per.length >= 4 ? Math.max(0.12, Math.min(0.5, per[Math.floor(per.length * 0.3)] * 0.9)) : 0.24;
  return (l, from, next) => {
    const est = moraCount(textOf(l)) * rate + 0.3;
    const sure = Math.max(from + 0.4, Math.min(next - 0.3, from + est * 0.6));
    return [sure, Math.max(sure, Math.min(next - 0.2, from + est * 2 + 1))];
  };
}
// 時刻つき歌詞(LRC・KRC)から。文字ごとの長さがあればそのまま
export function vocalSpans(synced) {
  const ls = (synced || []).filter((l) => l.text);
  const ends = guessEnds(ls, (l) => l.text);
  return spans((put) =>
    ls.forEach((l, k) => {
      const next = ls[k + 1] ? ls[k + 1].t : Infinity;
      const ws = (l.words || []).filter((w) => w.t != null && w.d > 0 && w.s.trim());
      // 行の最後の音をどこまで伸ばすかは、歌う人しだい。最後の文字の頭(0.25秒)までを「確かに歌っている」とする
      if (ws.length)
        ws.forEach((w, q) => {
          if (q < ws.length - 1 || w.d <= 0.4) put(w.t, w.t + w.d);
          else put(w.t, w.t + 0.25, Math.min(w.t + w.d, next - 0.05));
        });
      else put(l.t, ...ends(l, l.t, next));
    }),
  );
}
// コード進行メモ倉庫の行(mcToSheet の rows)から。最後に時刻の分かる文字までは確かに歌っている
export function mcSpans(rows) {
  const ls = (rows || []).filter((r) => r.lyric);
  const ends = guessEnds(ls, (r) => r.lyric);
  return spans((put) =>
    ls.forEach((r, k) => {
      const next = Math.min(ls[k + 1] ? ls[k + 1].t : Infinity, r.end > r.t ? r.end + 0.2 : Infinity);
      const z = r.marks?.length ? r.marks[r.marks.length - 1] : null;
      const [sure, maybe] = ends(r, r.t, next);
      const known = z ? Math.min(next - 0.3, z.t + MARK_SHIFT + 0.2) : 0;
      put(r.t, Math.max(sure, known), Math.max(maybe, known));
    }),
  );
}

// ---------------------------------------------------------------- 押したところ → 曲の時刻

// L: その行の時刻。hit: { k: 押したかたまり, pos: 行の中の文字の位置, onChord: コードを押した }。nextT: 次に時刻の分かる行の頭
// 戻り値: 秒(分からなければ null → 拍から見積もる)
export function tapTime(L, line, hit, nextT = null) {
  if (!L) return null;
  const end = L.end ?? nextT;
  if (hit.onChord || line.type === 'chords') {
    const c = L.chords?.find((x) => x.k === hit.k);
    if (c) return c.t;
  }
  if (line.type === 'chords') {
    const n = Math.max(1, line.segs.length);
    return end != null && end > L.t ? L.t + (Math.min(hit.k, n - 1) / n) * (end - L.t) : L.t;
  }
  const chars = Array.from(lineText(line));
  const n = chars.length;
  const w = weightsOf(chars);
  const cum = [0];
  for (const x of w) cum.push(cum[cum.length - 1] + x);
  const total = cum[n] || 1;
  const pos = Math.max(0, Math.min(n, hit.pos || 0));
  // 文字の重み(歌う長さ) → 時刻 の折れ線
  const pts = (L.marks || []).map((m) => [cum[Math.min(n, m.p)], m.t]);
  if (!pts.length) {
    if (pos === 0) return L.t;
    pts.push([0, L.t]);
  }
  // 1文字ぶん(重み1)を歌う秒数。印が2つ以上あればその間から、無ければふつうの速さ
  const rate = (() => {
    const a = pts[0];
    const z = pts[pts.length - 1];
    const r = z[0] > a[0] ? (z[1] - a[1]) / (z[0] - a[0]) : 0.24;
    return Math.max(0.08, Math.min(0.45, r));
  })();
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1] - pts[0][0] * rate]);
  const z = pts[pts.length - 1];
  if (z[0] < total) {
    const guess = z[1] + (total - z[0]) * rate;
    pts.push([total, end != null && end > z[1] ? Math.min(end, guess) : guess]);
  }
  const x = cum[pos];
  for (let q = 0; q < pts.length - 1; q++) {
    if (x <= pts[q + 1][0]) {
      const [x0, t0] = pts[q];
      const [x1, t1] = pts[q + 1];
      return x1 > x0 ? t0 + ((x - x0) / (x1 - x0)) * (t1 - t0) : t0;
    }
  }
  return pts[pts.length - 1][1];
}

// 押したところが、その行の何小節目か(0〜)。小節線のある行は小節線を数え、無い行は文字の位置から見積もる
export function tapBar(line, hit, nBars) {
  const n = Math.max(1, Math.round(nBars));
  if (n <= 1 || !line.segs) return 0;
  const k = Math.max(0, Math.min(line.segs.length - 1, hit.k || 0));
  if (line.bars) {
    let m = 0;
    let lead = false; // 最初の小節線より前にコードがある(それで1小節)
    line.segs.forEach((s, j) => {
      if (j <= k && s.bar) m++;
    });
    for (const s of line.segs) {
      if (s.bar) break;
      if (s.c) lead = true;
    }
    return Math.max(0, Math.min(n - 1, m === 0 ? 0 : m - 1 + (lead ? 1 : 0)));
  }
  let frac;
  if (line.type === 'chords') frac = k / line.segs.length;
  else {
    const chars = Array.from(lineText(line));
    const w = weightsOf(chars);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    let before = 0;
    for (let p = 0; p < Math.min(chars.length, hit.pos || 0); p++) before += w[p];
    // 行の終わりは息つぎなので、歌うのは行の9割ほど
    frac = (before / total) * 0.9;
  }
  return Math.max(0, Math.min(n - 1, Math.floor(frac * n + 0.3)));
}

// ---------------------------------------------------------------- 動画を選ぶ

// 原曲そのものではなさそうな動画(カバー・ライブ・カラオケ・解説・歌詞を付けただけの転載 など)
const BAD =
  /\b(cover|karaoke|off ?vocal|instrumental|inst|remix|mashup|live|tour|first take|acoustic|reaction|lesson|tutorial|guitar|piano|8d|nightcore|sped ?up|slowed|lyrics|teaser|trailer|making|behind|short ver|tv ?size|stage ?mix)\b|カバー|歌ってみた|弾いてみた|叩いてみた|演奏してみた|弾き語り|カラオケ|インスト|オルゴール|リミックス|マッシュアップ|ライブ|ライヴ|ツアー|フェス|武道館|budokan|路上|アコースティック|교차편집|가사|リアクション|解説|講座|レッスン|tab譜|コード譜|楽譜|ギター|ピアノ|ドラム|耐久|メドレー|歌詞付き|歌詞つき|歌詞動画|フル歌詞|ティザー|予告|メイキング|ショート|切り抜き|練習用|原曲キー|キー[上下]げ|男性キー|女性キー/i;
const OFFICIAL = /official|公式|オフィシャル|music ?video|\bmv\b|vevo/i;

const fold = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・,.、。!?'"’“”\-‐―–~〜_()[\]【】「」『』/:;&+*×|｜]/g, '');

// items: [{ id, title, channel, dur }](YouTube の検索の並び)。durSec: 原曲の長さ(分かれば)
// exact: 歌詞の時刻が原曲の音源に合わせてあるとき true(長さが同じ=同じ音源の動画を強く優先する)
export function rankVideos(items, { title, artist, durSec = null, exact = false } = {}) {
  const t = fold(title);
  const a = fold(artist);
  return (items || [])
    .map((v, idx) => {
      const vt = fold(v.title);
      const vc = fold(v.channel).replace(/topic$/, '');
      let s = -idx * 1.5;
      const hasTitle = !!t && vt.includes(t);
      const byArtist = !!a && !!vc && (vc === a || vc.includes(a) || a.includes(vc));
      if (hasTitle) s += 40;
      if (a && (vt.includes(a) || byArtist)) s += 25;
      // 本人のチャンネル(公式・Topic)を、ほかの人の転載より上に
      s += byArtist ? 35 : -25;
      // 題名に曲名が無いものは別の曲。ただし本人のチャンネルで長さがぴったり同じなら、英語の題名で出ている同じ音源(「Marigold」など)
      const same = !!durSec && !!v.dur && Math.abs(v.dur - durSec) <= 1.5;
      if (!hasTitle && !(byArtist && same)) s -= 80;
      // 曲名・アーティスト名そのものに含まれる言葉(「ライブ」という曲名など)は数えない
      const rest = [title, artist].reduce((x, w) => (w ? x.split(w).join(' ') : x), String(v.title || '').normalize('NFKC'));
      if (BAD.test(rest) || (!byArtist && BAD.test(v.channel || ''))) s -= 60;
      if (OFFICIAL.test(v.title) || OFFICIAL.test(v.channel)) s += 8;
      if (durSec && v.dur) {
        const d = Math.abs(v.dur - durSec);
        s += d <= 1.5 ? (exact ? 90 : 30) : d <= 6 ? 18 : d <= 20 ? 5 : d > 60 ? -25 : 0;
      }
      return { ...v, score: s };
    })
    .sort((x, y) => y.score - x.score);
}

// YouTube のリンク(または動画の番号そのもの) → 動画の番号
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:/i.test(s) ? s : 'https://' + s);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return /^\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      return /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] || null;
    }
  } catch {}
  return null;
}
