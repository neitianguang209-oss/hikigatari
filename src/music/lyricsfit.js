// 耳コピの下書きに歌詞を当てはめる
// 歌詞の行の時刻(時刻つき歌詞 LRC か、聴きながらタップした時刻)と、聴き取った小節・コードから
// 「|[C]過ぎてゆ|[G]くんだ今日も」の形の譜面を作る。小節線を入れるので、自動スクロールも曲と同じ速さで進む
// 行の中の位置は、文字ごとの「歌う長さ」(ふりがながあれば拍の数)で割り振った見積もり。
// 耳で確かめて直した位置(place)があれば、そちらを使う
import { noteName, keyPrefersFlat } from './chord.js';
import { moraCount } from './sheet.js';

// LRC → [{ t: 秒, text }]。空の行(間奏の印)も text='' で残す。単語ごとの時刻 <00:12.34> は外す
export function parseLRC(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw
      .replace(/\[[^\]]*\]/g, '')
      .replace(/<\d+:\d+(?:\.\d+)?>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// 1文字の「歌う長さ」の重み(かな1・漢字1.7・小さいかな0.3・英字0.35・空白は息つぎ)
function charWeight(c) {
  if (/[ゃゅょャュョぁぃぅぇぉァィゥェォ]/.test(c)) return 0.3;
  if (/[っッ]/.test(c)) return 0.5;
  if (/[ぁ-ゖァ-ヺー]/.test(c)) return 1;
  if (/[一-鿿々〆ヶ]/.test(c)) return 1.7;
  if (/[A-Za-z]/.test(c)) return 0.35;
  if (/[0-9０-９]/.test(c)) return 0.6;
  if (/[\s　]/.test(c)) return 0.5;
  return 0.2;
}

const KANJI_RUN = /[一-鿿々〆ヶ]+/g;

// ふりがなの辞書(漢字 → 読み)から、行の文字ごとの重みを作る。漢字は読みの拍の数を文字数で分ける
// 辞書に無い漢字は、辞書の言葉で長いものから区切ってみて、それでも無ければ1文字1.7
export function makeWeights(ruby) {
  const keys = ruby ? [...ruby.keys()].sort((a, b) => b.length - a.length) : [];
  return (chars) => {
    const w = chars.map(charWeight);
    if (!keys.length) return w;
    const text = chars.join('');
    for (const m of text.matchAll(KANJI_RUN)) {
      const start = Array.from(text.slice(0, m.index)).length; // index は UTF-16 単位なので、文字の位置に直す
      const run = m[0];
      let k = 0;
      while (k < run.length) {
        const key = keys.find((x) => run.startsWith(x, k));
        if (!key) {
          k++;
          continue;
        }
        const mora = Math.max(0.5, moraCount(ruby.get(key)));
        for (let j = 0; j < key.length; j++) w[start + k + j] = mora / key.length;
        k += key.length;
      }
    }
    return w;
  };
}

// 時刻 → 行の中の文字の位置(歌い始め s 〜 歌い終わり e の間を、文字の重みの割合で割り振る)
function makePosOf(weights, s, e) {
  const cum = [0];
  for (const x of weights) cum.push(cum[cum.length - 1] + x);
  const n = weights.length;
  const total = cum[n] || 1;
  return (t) => {
    if (t <= s + 0.05) return 0;
    if (t >= e) return n;
    const w = ((t - s) / (e - s)) * total;
    let i = 0;
    while (i < n && cum[i + 1] <= w) i++;
    // 文字の途中なら近いほうの境目へ
    return w - cum[i] > (cum[i + 1] - cum[i]) / 2 ? i + 1 : i;
  };
}

const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};

// r: analyzeAudio の結果 { key, bpm, bars: [{ t0, t1, chords }] }
// lines: [{ t, text }](録音の時刻・秒)。text='' は歌の切れ目
// weights: 文字の重みを返す関数(makeWeights)。place: 耳で直した位置 { 'i:時刻': 文字の位置 }
// 戻り値: { text: 譜面, rows: 譜面の1行ずつ, used: 当てはめた行の数 }
//   rows[k] = { kind: blank|label|chords|lyric, src, t0, t1, line? }
//   line = { i, chars, weights, s, e, toks: [{ type: bar|chord, t, c?, pos, auto?, key? }] }(歌詞の行だけ)
export function fitLyrics(r, lines, { note = '', weights = null, place = null } = {}) {
  const wOf = weights || ((chars) => chars.map(charWeight));
  const bars = r.bars;
  const nb = bars.length;
  const flat = keyPrefersFlat(r.key);
  const keyName = noteName(r.key.pc, flat) + (r.key.minor ? 'm' : '');
  const head = [`{key:${keyName}}`, `{tempo:${r.bpm}}`];
  if (note) head.push(`{c:${note}}`);
  const rows = [];
  const done = (used) => {
    while (rows.length && rows[rows.length - 1].kind === 'blank') rows.pop();
    return { text: [...head, '', ...rows.map((x) => x.src)].join('\n'), rows, used };
  };
  if (!nb) return done(0);

  // コードの切り替わり(小節の頭と、小節の後半)
  const events = [];
  for (const b of bars) {
    events.push({ t: b.t0, c: b.chords[0] });
    if (b.chords[1]) events.push({ t: (b.t0 + b.t1) / 2, c: b.chords[1] });
  }
  const barLen = median(bars.map((b) => b.t1 - b.t0)) || 2;
  const end = bars[nb - 1].t1;
  // 時刻が入る小節(小節線の少し前=1拍ほどの食い込みは、次の小節の頭とみなす)
  const barAt = (t) => {
    let best = 0;
    for (let i = 0; i < nb; i++) if (bars[i].t0 <= t + barLen * 0.3) best = i;
    return best;
  };

  // 録音の範囲に入る行だけ。同じ小節から始まる短い行は1行にまとめる
  const sung = [];
  const breaks = new Set(); // この行の前に段落の切れ目
  let pendingBreak = false;
  for (const l of lines) {
    if (l.t < bars[0].t0 - barLen || l.t > end - 0.5) continue;
    if (!l.text) {
      pendingBreak = true;
      continue;
    }
    const b = barAt(l.t);
    const prev = sung[sung.length - 1];
    if (prev && prev.bar === b) {
      prev.text += ' ' + l.text;
      continue;
    }
    if (pendingBreak && sung.length) breaks.add(sung.length);
    pendingBreak = false;
    sung.push({ t: l.t, text: l.text, bar: b });
  }
  if (!sung.length) return done(0);

  // 1拍(1音)あたりの秒数(行と行の間が詰まっている所から)。歌い終わりの見積もりに使う
  const moraOf = (text) => wOf(Array.from(text)).reduce((a, b) => a + b, 0);
  const rate =
    median(
      sung.slice(0, -1).map((l, i) => {
        const m = moraOf(l.text);
        const gap = sung[i + 1].t - l.t;
        return m >= 3 && gap < barLen * 4 ? gap / m : NaN;
      }),
    ) || 0.3;

  const emit = (kind, src, t0 = null, t1 = null, line = null) => {
    if (kind === 'blank' && (!rows.length || rows[rows.length - 1].kind === 'blank')) return;
    rows.push({ kind, src, t0, t1, line });
  };
  // コードだけの行(前奏・間奏・後奏)。4小節で1行
  const chordRows = (from, to, label) => {
    if (to <= from) return;
    if (label) {
      emit('blank', '');
      emit('label', `{c:${label}}`, bars[from].t0, bars[from].t0);
    }
    for (let i = from; i < to; i += 4) {
      const seg = bars.slice(i, Math.min(to, i + 4));
      emit('chords', '|' + seg.map((b) => b.chords.map((c) => `[${c}]`).join(' ') + ' ').join('|') + '|', seg[0].t0, seg[seg.length - 1].t1);
    }
  };

  chordRows(0, sung[0].bar, '前奏');
  sung.forEach((l, i) => {
    const next = sung[i + 1];
    const nextBar = next ? next.bar : nb;
    const chars = Array.from(l.text);
    const weights = wOf(chars);
    const mora = weights.reduce((a, b) => a + b, 0);
    // 歌い終わり: 次の行の頭か、音の数から見積もった長さの短いほう
    const guess = l.t + mora * rate * 1.15 + 0.6;
    const e = Math.max(l.t + 0.5, Math.min(next ? next.t : end, guess));
    let lastBar = Math.min(nextBar, barAt(e) + 1);
    // 次の行まで2小節以上あけば、そこは間奏(または後奏)としてコードだけの行にする
    if (nextBar - lastBar < 2) lastBar = nextBar;
    if (breaks.has(i)) emit('blank', '');

    const posOf = makePosOf(weights, l.t, e);
    const toks = [];
    let lastChord = null;
    for (let b = l.bar; b < lastBar; b++) {
      const bar = { type: 'bar', t: bars[b].t0, pos: posOf(bars[b].t0) };
      toks.push(bar);
      // 小節の途中で変わるときは、頭のコードも書く(自動スクロールの目印が「小節の後半」に来るように)
      const inBar = events.filter((ev) => ev.t >= bars[b].t0 - 0.02 && ev.t < bars[b].t1 - 0.02);
      for (const ev of inBar) {
        if (ev.c === lastChord && inBar.length < 2) continue;
        const key = `${i}:${ev.t.toFixed(2)}`;
        const auto = posOf(ev.t);
        const set = place && Number.isFinite(place[key]) ? Math.max(0, Math.min(chars.length, place[key])) : null;
        const tok = { type: 'chord', t: ev.t, c: ev.c, auto, pos: set ?? auto, key, fixed: set != null };
        toks.push(tok);
        // 小節の頭のコードを動かしたら、小節線もいっしょに動かす
        if (Math.abs(ev.t - bars[b].t0) < 0.03) bar.pos = tok.pos;
        lastChord = ev.c;
      }
    }
    // コードの変わらない小節の線は、次のコードより後ろに来ないように(耳で前へ動かしたコードを優先)
    for (let q = toks.length - 2; q >= 0; q--) if (toks[q].type === 'bar') toks[q].pos = Math.min(toks[q].pos, toks[q + 1].pos);
    // 行の最初の小節線はいつも行の頭に(小節線の前に歌い出しの文字が来ると、小節の数が1つ多く数えられて自動スクロールがずれる)
    toks[0].pos = 0;
    // 時間の順に、位置が戻らないようにそろえる
    let p = 0;
    for (const tk of toks) p = tk.pos = Math.max(p, tk.pos);
    let s = '';
    let k = 0;
    for (let c = 0; c <= chars.length; c++) {
      while (k < toks.length && toks[k].pos <= c) s += toks[k].type === 'bar' ? '|' : `[${toks[k].c}]`, k++;
      if (c < chars.length) s += chars[c];
    }
    emit('lyric', s, bars[l.bar].t0, bars[lastBar - 1].t1, { i, chars, weights, s: l.t, e, toks });

    if (lastBar < nextBar) chordRows(lastBar, nextBar, next ? (nextBar - lastBar >= 4 ? '間奏' : '') : '後奏');
  });
  return done(sung.length);
}

// 録音の中で、曲が鳴り始めた時刻(秒)。はじめから鳴っていたら null
export function musicStart(samples, sr) {
  const win = Math.round(sr * 0.05);
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += samples[k] * samples[k];
    rms.push(Math.sqrt(s / win));
  }
  if (rms.length < 40) return null;
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.05)];
  const loud = sorted[Math.floor(sorted.length * 0.6)];
  const th = Math.max(floor * 4, floor + (loud - floor) * 0.15, 1e-4);
  const hold = 10; // 0.5秒続いたら鳴り始め
  for (let i = 0; i + hold < rms.length; i++) {
    if (rms[i] < th) continue;
    let ok = 0;
    for (let k = i; k < i + hold; k++) if (rms[k] >= th * 0.5) ok++;
    if (ok >= hold * 0.8) return i < 6 ? null : (i * win) / sr;
  }
  return null;
}
