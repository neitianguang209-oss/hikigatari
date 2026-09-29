// 譜面テキスト(ChordPro風: [C]歌詞[G]歌詞 / {key:D} など)を行データに分解する
import { parseChord } from './chord.js';

const LABEL_RE =
  /^[\s　]*[【\[(（<＜《]?\s*(イントロ|intro|前奏|a\s*メロ|b\s*メロ|c\s*メロ|d\s*メロ|サビ|大サビ|落ちサビ|ラスサビ|間奏|後奏|アウトロ|outro|エンディング|ending|verse\s*\d*|pre-?chorus|chorus|bridge|interlude|solo|ソロ|ブリッジ|コーラス|1番|2番|3番|繰り返し|repeat|×\s*\d|x\s*\d)\s*\d*\s*[】\])）>＞》]?[\s　]*$/i;

const SYMBOL_ONLY = /^[\s　>\-=○●・.\/*~^_:;＞－ー]*$/;

// 歌詞のおおよその音の数(拍の長さの見積もりに使う)。小さい「ゃゅょ」は数えず、漢字は約1.7音
export function moraCount(text) {
  let m = 0;
  for (const c of text || '') {
    if (/[ぁ-ゖァ-ヺ]/.test(c)) m += /[ゃゅょャュョぁぃぅぇぉァィゥェォ]/.test(c) ? 0 : 1;
    else if (c === 'ー') m += 1;
    else if (/[一-鿿々]/.test(c)) m += 1.7;
    else if (/[A-Za-z]/.test(c)) m += 0.4;
  }
  return m;
}

// ChordWiki のふりがな「心(ここ[Bm]ろ)」を外して、コードを漢字の前後に寄せる
function stripRuby(line) {
  return line.replace(
    /([一-鿿々〆ヵヶ]+)[(（]((?:[ぁ-んゔァ-ヶー]|\[[^\]]*\])+)[)）]/g,
    (all, kanji, inside) => {
      const chords = inside.match(/\[[^\]]*\]/g) || [];
      const kana = inside.replace(/\[[^\]]*\]/g, '');
      if (!kana) return all;
      if (!chords.length) return kanji;
      const firstPos = inside.indexOf('[');
      const kanaBefore = inside.slice(0, firstPos).replace(/\[[^\]]*\]/g, '').length;
      return kanaBefore >= kana.length / 2 ? kanji + chords.join('') : chords.join('') + kanji;
    },
  );
}

function parseBody(line, chorus) {
  const src = stripRuby(line);
  const segs = [];
  let cur = { c: null, t: '', bar: false };
  let pendingBar = false;
  let markers = 0;
  let firstTok = null;
  let lastTok = null;
  const re = /\[([^\]]*)\]|\|/g;
  let last = 0;
  let m;
  const flush = () => {
    if (cur.c || cur.t) segs.push(cur);
  };
  while ((m = re.exec(src))) {
    const before = src.slice(last, m.index);
    if (before) {
      cur.t += before;
      lastTok = 'text';
      if (firstTok == null && before.trim()) firstTok = 'text';
    }
    last = re.lastIndex;
    const tok = m[0] === '|' ? '|' : m[1].trim();
    if (tok === '|' || tok === '||' || tok === '|:' || tok === ':|') {
      markers++;
      if (firstTok == null) firstTok = 'bar';
      lastTok = 'bar';
      if (cur.c || cur.t.trim()) {
        flush();
        cur = { c: null, t: '', bar: true };
      } else {
        cur.bar = true;
        pendingBar = true;
      }
      continue;
    }
    const ch = parseChord(tok);
    if (ch) {
      if (firstTok == null) firstTok = 'chord';
      lastTok = 'chord';
      if (cur.c || cur.t) {
        flush();
        cur = { c: tok, t: '', bar: pendingBar };
      } else {
        cur.c = tok;
        cur.bar = cur.bar || pendingBar;
      }
      pendingBar = false;
      continue;
    }
    if (SYMBOL_ONLY.test(tok)) continue; // リズム記号などは表示しない
    cur.t += `[${tok}]`;
  }
  const tail = src.slice(last);
  if (tail) {
    cur.t += tail;
    if (tail.trim()) lastTok = 'text';
  }
  flush();
  // ChordWiki のリズム記号(>=アクセント、-=8分、==16分)は、単独の語になっているものだけ消す
  for (const s of segs) {
    s.t = s.t.replace(/(^|[\s　])[>\-=]+(?=[\s　]|$)/g, '$1');
    if (!s.t.replace(/[\s　]/g, '')) s.t = s.c ? '' : s.t.replace(/[\s　]+/g, ' ');
  }

  const plain = segs.map((s) => s.t).join('');
  const hasText = plain.replace(/[\s　\-=>|・.○●ー－~]/g, '').length > 0;
  const hasChord = segs.some((s) => s.c);
  let bars = null;
  if (markers) {
    const startsBar = firstTok === 'bar';
    const endsBar = lastTok === 'bar';
    bars = Math.max(1, markers - (startsBar && endsBar ? 1 : 0) + (!startsBar && !endsBar ? 1 : 0));
  }
  if (!hasChord) {
    if (LABEL_RE.test(plain)) return { type: 'label', text: plain.trim().replace(/^[【\[(（<＜《]\s*|\s*[】\])）>＞》]$/g, ''), chorus };
    return { type: 'lyric', segs: [{ c: null, t: plain, bar: false }], bars, chorus, chordCount: 0, mora: moraCount(plain) };
  }
  if (!hasText) {
    // コードだけの行(イントロ・間奏など)。リズム用のハイフンは落とす
    const only = segs.filter((s) => s.c).map((s) => ({ c: s.c, t: '', bar: s.bar }));
    return { type: 'chords', segs: only, bars, chorus, chordCount: only.length };
  }
  return { type: 'lyric', segs, bars, chorus, chordCount: segs.filter((s) => s.c).length, mora: moraCount(plain) };
}

export function parseSheet(text) {
  const meta = { title: '', subtitle: '', key: null, bpm: null, beatsPerBar: 4, keyChanges: [] };
  const lines = [];
  let chorus = false;
  let pendingKey = null; // 途中の {key:} (転調)。次の行に印をつける
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/[\s]+$/, '');
    const t = line.trim();
    if (!t) {
      lines.push({ type: 'blank' });
      continue;
    }
    const dir = t.match(/^\{\s*([a-zA-Z_]+)\s*(?::\s*([\s\S]*?))?\s*\}$/);
    if (dir) {
      const name = dir[1].toLowerCase();
      const val = (dir[2] || '').trim();
      if (name === 'title' || name === 't') meta.title = val;
      else if (name === 'subtitle' || name === 'st') meta.subtitle = val;
      else if (name === 'key') {
        if (!meta.key) meta.key = val;
        else pendingKey = val;
      }
      else if (name === 'tempo') meta.bpm = Number(val) || meta.bpm;
      else if (name === 'time') {
        const ts = val.match(/(\d+)\s*\/\s*(\d+)/);
        if (ts) meta.beatsPerBar = Number(ts[1]);
      } else if (['c', 'comment', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight'].includes(name)) {
        const bpm = val.match(/BPM\s*[=:：]?\s*(\d{2,3})/i);
        if (bpm && !meta.bpm) meta.bpm = Number(bpm[1]);
        const ts = val.match(/(\d)\s*\/\s*(4|8)\s*拍子/);
        if (ts) meta.beatsPerBar = Number(ts[1]);
        // BPM・拍子・簡単コードの案内はアプリ側の機能と重なるので出さない
        if (!/^(BPM|簡単コード|原曲キー|\(?下記に)/i.test(val)) {
          if (LABEL_RE.test(val) || val.length <= 16) lines.push({ type: 'label', text: val, chorus });
          else lines.push({ type: 'comment', text: val });
        }
      } else if (name === 'soc' || name === 'start_of_chorus') chorus = true;
      else if (name === 'eoc' || name === 'end_of_chorus') chorus = false;
      continue;
    }
    if (/^\{[^}]*\}$/.test(t)) continue; // ChordWiki の独自記法(リンク等)は無視
    const body = parseBody(line, chorus);
    if (pendingKey) {
      body.keyChange = pendingKey;
      pendingKey = null;
    }
    lines.push(body);
  }
  // 前後の空行を落とし、連続する空行は1つにまとめる
  const out = [];
  for (const l of lines) {
    if (l.type === 'blank' && (!out.length || out[out.length - 1].type === 'blank')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1].type === 'blank') out.pop();
  out.forEach((l, i) => l.keyChange && meta.keyChanges.push({ at: i, key: l.keyChange }));
  return { meta, lines: out };
}

// 譜面に出てくるコード(出てくる順・重複なし)と回数
export function chordStats(lines) {
  const order = [];
  const count = new Map();
  for (const l of lines) {
    if (!l.segs) continue;
    for (const s of l.segs) {
      if (!s.c) continue;
      const ch = parseChord(s.c);
      if (!ch || ch.special) continue;
      if (!count.has(s.c)) order.push(s.c);
      count.set(s.c, (count.get(s.c) || 0) + 1);
    }
  }
  return { order, count };
}

// ---------------------------------------------------------------- 貼り付けテキストの変換

function colWidth(ch) {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　]/.test(ch) ? 2 : 1;
}

function chordTokenOk(t) {
  const x = t.replace(/^[(（]|[)）]$/g, '');
  return !!parseChord(x) || /^[-–|/%.:]+$/.test(x);
}

export function isChordLine(line) {
  const toks = line.trim().split(/[\s　]+/).filter(Boolean);
  if (!toks.length) return false;
  return toks.every(chordTokenOk) && toks.some((t) => parseChord(t.replace(/^[(（]|[)）]$/g, '')));
}

export function looksLikeChordPro(text) {
  const tokens = String(text).match(/\[[^\]\n]{1,14}\]/g) || [];
  return tokens.filter((t) => parseChord(t.slice(1, -1))).length >= 2;
}

// 「コード行の下に歌詞行」の形式を [C]歌詞 の形に変換する(文字幅で位置合わせ)
export function plainToChordPro(text) {
  const src = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const L = src[i];
    if (!isChordLine(L)) {
      out.push(L);
      continue;
    }
    const chars = Array.from(L);
    const chords = [];
    let col = 0;
    let tok = '';
    let tokCol = 0;
    const push = () => {
      const name = tok.replace(/^[(（]|[)）]$/g, '');
      if (tok && parseChord(name)) chords.push({ name, col: tokCol });
      tok = '';
    };
    for (const ch of chars) {
      if (/[\s　]/.test(ch)) push();
      else {
        if (!tok) tokCol = col;
        tok += ch;
      }
      col += colWidth(ch);
    }
    push();
    const next = src[i + 1];
    if (next != null && next.trim() && !isChordLine(next)) {
      const lyric = Array.from(next);
      let c = 0;
      let ci = 0;
      let res = '';
      for (const ch of lyric) {
        const w = colWidth(ch);
        // 全角文字の右半分に乗っているコードも、その文字の上とみなす
        while (ci < chords.length && chords[ci].col <= c + w - 1) res += `[${chords[ci++].name}]`;
        res += ch;
        c += w;
      }
      while (ci < chords.length) res += `　[${chords[ci++].name}]`;
      out.push(res);
      i++;
    } else {
      out.push(chords.map((c) => `[${c.name}]`).join('　'));
    }
  }
  return out.join('\n');
}

// [C]形式とコード行+歌詞行の形式が混ざっていても、コード行だけを変換する
export function normalizePasted(text) {
  return plainToChordPro(String(text).replace(/\r/g, ''));
}
