// ひきがたり Edge Function(曲と合わせる): 原曲の YouTube の動画を探す / 文字ごとの時刻つき歌詞の候補をまとめて返す
// 本体(hikigatari)と同じ端末の鍵で守る。結果は hikigatari_sheet_cache に7日置く。
// yt_search が返すのは動画の番号・題名・チャンネル名・長さだけ(動画そのものは、アプリの中の YouTube のプレーヤーが流す)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-hk-key, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const TTL_MS = 7 * 24 * 3600e3;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authDevice(req: Request) {
  const key = req.headers.get('x-hk-key');
  if (!key || key.length < 20) return null;
  const h = await sha256('hk:' + key);
  const { data } = await db.from('hikigatari_devices').select('id').eq('key_hash', h).maybeSingle();
  return data;
}

function norm(s: string) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・,.、。!?'"’“”\-‐―~〜_()\[\]【】「」『』/:;&+*×]/g, '');
}

type YtHit = { id: string; title: string; channel: string; dur: number; views?: number };

// 「視聴回数 1,234,567 回」「12万 回視聴」→ 回数
function toViews(s: string) {
  const t = String(s || '').replace(/,/g, '');
  const m = t.match(/([\d.]+)\s*(億|万)?/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === '億' ? 1e8 : m[2] === '万' ? 1e4 : 1));
}

// 「4:23」「1:02:03」→ 秒
function toSec(s: string) {
  const p = String(s || '').split(':').map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return 0;
  return p.reduce((a, x) => a * 60 + x, 0);
}

// deno-lint-ignore no-explicit-any
const runs = (x: any) => (x?.simpleText ?? (x?.runs ?? []).map((r: any) => r.text).join('')) as string;

// 検索結果のページに埋まっているデータから、動画(videoRenderer)を上から順に拾う
// deno-lint-ignore no-explicit-any
function collect(node: any, out: YtHit[], depth = 0, len = [60, 900]) {
  if (!node || typeof node !== 'object' || depth > 14 || out.length >= 20) return;
  if (Array.isArray(node)) {
    for (const x of node) collect(x, out, depth + 1, len);
    return;
  }
  const v = node.videoRenderer;
  if (v?.videoId) {
    const dur = toSec(runs(v.lengthText));
    // 長さの無いもの(生配信・ショート)と、曲としては短すぎる・長すぎるものは外す
    if (dur >= len[0] && dur <= len[1] && !out.some((o) => o.id === v.videoId)) {
      out.push({ id: String(v.videoId), title: runs(v.title) || '', channel: runs(v.ownerText) || runs(v.longBylineText) || '', dur, views: toViews(runs(v.viewCountText)) });
    }
    return;
  }
  for (const k in node) collect(node[k], out, depth + 1, len);
}

// 取り方その1: 検索の結果をデータ(JSON)でもらう
async function searchJson(q: string, len?: number[]): Promise<YtHit[]> {
  const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'User-Agent': UA_DESKTOP, 'Content-Type': 'application/json', 'Accept-Language': 'ja,en;q=0.8' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } }, query: q }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`取得失敗 HTTP ${r.status}`);
  const out: YtHit[] = [];
  collect((await r.json())?.contents, out, 0, len);
  return out;
}

// 取り方その2: 検索結果のページに埋まっているデータを読む
async function searchPage(q: string, len?: number[]): Promise<YtHit[]> {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=ja&gl=JP`, {
    headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'ja,en;q=0.8', Cookie: 'SOCS=CAI; CONSENT=YES+1' },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`取得失敗 HTTP ${r.status}`);
  const html = await r.text();
  const at = html.indexOf('var ytInitialData = ');
  if (at < 0) throw new Error('検索結果を読み取れませんでした');
  const from = at + 'var ytInitialData = '.length;
  const end = html.indexOf(';</script>', from);
  const out: YtHit[] = [];
  collect(JSON.parse(html.slice(from, end))?.contents, out, 0, len);
  return out;
}

// たまに中身の無い返事が来るので、取り方を替えながら結果が出るまで試す
async function ytSearch(q: string, len?: number[]): Promise<YtHit[]> {
  let last: unknown = null;
  for (const f of [searchJson, searchPage, searchJson]) {
    try {
      const out = await f(q, len);
      if (out.length) return out;
    } catch (e) {
      last = e;
    }
  }
  if (last) throw last;
  return [];
}

// ---------------------------------------------------------------- 文字ごとの時刻つき歌詞(Kugou の KRC)の候補をまとめて
// 同じ曲でも、音源の版(シングル・アルバム・MV など)ごとに、時刻の違う歌詞がいくつか登録されている
// (「マリーゴールド」は、動画と同じ速さのものと、2.5% ゆっくりのものがある)。
// 本体の lyrics_krc は最初の1つだけを返すので、ここでは候補を4つまで返し、端末側で動画の時刻にいちばん合うものを選ぶ
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const KRC_CREDIT = /^[^\s]{0,8}\s*[:：]|^(TME|腾讯|酷狗|未经|本歌词|纯音乐|製作|制作人)/;
const fold = (s: string) => norm(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 版やタイアップ表記を落とした「曲名そのもの」(本体と同じ決まり)
function baseTitle(t: string) {
  let s = (t || '').normalize('NFKC');
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\s*[(\[【「『〔][^()\[\]【】「」『』〔〕]*[)\]】」』〕]\s*/g, ' ');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+[(\[【].*$/, '').replace(/\s+-\s+.*$/, '');
  s = s.replace(/\s+(feat\.?|ft\.|featuring)\s*\S.*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || (t || '').trim();
}

function sameArtist(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// deno-lint-ignore no-explicit-any
async function krcSearch(keyword: string, durationMs: number): Promise<any[]> {
  const r = await fetch(
    `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&duration=${durationMs || ''}&hash=`,
    { headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(6000) },
  );
  if (!r.ok) return [];
  // deno-lint-ignore no-explicit-any
  const j: any = await r.json().catch(() => ({}));
  return Array.isArray(j.candidates) ? j.candidates : [];
}

type KrcLine = { t: number; w: [number, number, string][] };

// deno-lint-ignore no-explicit-any
async function krcDownload(c: any, t: string): Promise<KrcLine[] | null> {
  const r = await fetch(
    `http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(c.id)}&accesskey=${encodeURIComponent(c.accesskey)}&fmt=krc&charset=utf8`,
    { headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(6000) },
  );
  // deno-lint-ignore no-explicit-any
  const j: any = await r.json().catch(() => ({}));
  if (!j.content) return null;
  // base64 → 先頭4バイト("krc1")を外す → 鍵で XOR → zlib をほどく
  const raw = Uint8Array.from(atob(j.content), (ch) => ch.charCodeAt(0)).slice(4);
  for (let i = 0; i < raw.length; i++) raw[i] ^= KRC_KEY[i % 16];
  const text = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).text();
  let offset = 0;
  const lines: KrcLine[] = [];
  for (const row of text.replace(/^\s+/, '').split(/\r?\n/)) {
    const off = row.match(/^\[offset:\s*(-?\d+)\]/);
    if (off) offset = Number(off[1]) / 1000;
    const m = row.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const start = Number(m[1]) / 1000;
    const w: [number, number, string][] = [];
    for (const x of m[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) {
      if (!x[3]) continue;
      w.push([Math.round((start + Number(x[1]) / 1000 + offset) * 1000) / 1000, Number(x[2]) / 1000, x[3]]);
    }
    const s = w.map((x) => x[2]).join('').trim();
    if (!s || !w.length) continue;
    if (KRC_CREDIT.test(s) || (lines.length === 0 && / - /.test(s) && fold(s).includes(fold(t)))) continue;
    lines.push({ t: w[0][0], w });
  }
  return lines.length >= 3 ? lines : null;
}

async function krcAll(title: string, artist: string, durationMs: number) {
  const t = baseTitle(title);
  if (!t) return [];
  let cands = await krcSearch(artist ? `${artist} - ${t}` : t, durationMs);
  if (!cands.length && artist) cands = await krcSearch(t, durationMs);
  // アーティスト名が中国語表記のこともあるので、合わなければ曲名と曲の長さがほぼ同じものでよい
  // deno-lint-ignore no-explicit-any
  const ok = (c: any) =>
    fold(baseTitle(String(c.song || ''))) === fold(t) &&
    (!artist || sameArtist(String(c.singer || ''), artist) || (!!durationMs && !!c.duration && Math.abs(Number(c.duration) - durationMs) < 3000));
  // 同じ長さの候補は中身も同じことが多い(訳つき・訳なしの違いなど)ので、長さごとに2つまで・全部で8つまで読む
  const per = new Map<number, number>();
  // deno-lint-ignore no-explicit-any
  const picked: any[] = [];
  for (const c of cands.filter(ok)) {
    const d = Number(c.duration) || 0;
    if ((per.get(d) || 0) >= 2 || picked.length >= 8) continue;
    per.set(d, (per.get(d) || 0) + 1);
    picked.push(c);
  }
  const got = await Promise.all(picked.map((c) => krcDownload(c, t).catch(() => null)));
  // 中身が同じもの(行の数と、最初・最後の行の時刻が同じ)は1つにまとめ、4つまで
  const out: { id: string; dur: number; lines: KrcLine[] }[] = [];
  const seen = new Set<string>();
  got.forEach((lines, i) => {
    if (!lines || out.length >= 4) return;
    const sig = `${lines.length}:${lines[0].t}:${lines[lines.length - 1].t}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ id: String(picked[i].id), dur: Number(picked[i].duration) || 0, lines });
  });
  return out;
}

// ---------------------------------------------------------------- 弾き方(ストローク・アルペジオ)をネットから
// 公式の弾き方は無いので、ネットに書かれた弾き方を集める。検索でいちばん上に出る解説ページの形を先頭に、ほかは同じ形が多いものほど上:
// ・いちばん上(と2番目)の解説ページは、楽譜の画像も Gemini に読んでもらう(キーが無ければ文字だけ)
// ・解説のページやブログに文字で書かれたストロークの矢印(↓↑)とアルペジオの弦の順番
// ・再生回数の多い弾き方の解説動画(ストローク・アルペジオ それぞれ4本まで)の説明と、コメント欄の書き込み
//   (動画そのものは返さない。アプリでは集めた形を図で見せる)
type Pat = { arrows: string; steps: string[] | null; rhythm: string; label: string; src: { name: string; url: string }[]; top?: boolean };

const SKIP_HOST = /youtube\.com|youtu\.be|ufret\.jp|piascore|at-elise|print-gakufu|songsterr|kurotochord|mfmf|amazon|rakuten|twitter\.com|x\.com|instagram|tiktok|facebook|chordwiki|j-total|music\.j-total|utaten|uta-net|apple\.com|spotify|wikipedia/;

async function ddg(q: string): Promise<string[]> {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'ja,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`検索 HTTP ${r.status}`);
  const h = await r.text();
  const out: string[] = [];
  for (const m of h.matchAll(/class="result__a" href="([^"]+)"/g)) {
    const u = m[1].replace(/&amp;/g, '&');
    const q2 = u.match(/uddg=([^&]+)/);
    out.push(q2 ? decodeURIComponent(q2[1]) : u);
  }
  return out;
}

async function bing(q: string): Promise<string[]> {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ja&cc=JP`, {
    headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'ja,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`検索 HTTP ${r.status}`);
  const h = await r.text();
  return [...h.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="(https?:[^"]+)"/g)].map((m) => {
    const u = m[1].replace(/&amp;/g, '&');
    const enc = u.match(/[?&]u=a1([^&]+)/)?.[1];
    if (!enc) return u;
    try {
      return atob(enc.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return u;
    }
  });
}

async function webSearch(q: string) {
  for (const f of [ddg, bing]) {
    try {
      const out = (await f(q)).filter((u) => /^https?:/.test(u));
      if (out.length) return out;
    } catch {
      // 次の検索で
    }
  }
  return [] as string[];
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', darr: '↓', uarr: '↑', times: '×' };
function unescape(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function pageText(h: string) {
  const t = h
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|p|div|li|tr|td|th|h\d|section|article|figcaption|pre|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return unescape(t)
    .replace(/[ \t\u3000\u00a0]+/g, ' ')
    .replace(/[⬇⇩]\uFE0F?/g, '↓')
    .replace(/[⬆⇧]\uFE0F?/g, '↑');
}

const SECTION = /(イントロ|Aメロ|Bメロ|Cメロ|サビ|間奏|アウトロ|大サビ|ラスサビ|基本|メイン|パターン|1番|2番)/i;
const RHYTHM = /^[タンッーカジャチャじゃんかちゃっ・〜\s]+$/;

// 矢印の並び → 1こまずつ(D=ダウン U=アップ X=ミュート ''=空振り/のばす)。こまの数が拍に合わないときは null(箱で見せるだけ)
function stepsOf(arrows: string): string[] | null {
  const st = [...arrows.replace(/\s/g, '')].map((c) => (c === '↓' ? 'D' : c === '↑' ? 'U' : c === '×' ? 'X' : ''));
  const rest = st.some((s) => !s);
  if (!rest && st.join('') === 'DDUUDU') return ['D', '', 'D', 'U', '', 'U', 'D', 'U']; // 「ジャン・ジャカ・カ・ジャカ」の書き方
  if ([6, 8, 12, 16].includes(st.length) && (rest || st.length === 8 || st.length === 16)) return st;
  return null;
}

// 「ダウン ダウン アップ」のような言葉の書き方を矢印に
function wordsToArrows(line: string) {
  if (!/^((ダウン|アップ|空振り|空ピッキング|ミュート)[\s、,・→\-]*){4,}$/.test(line)) return line;
  return line.replace(/ダウン/g, '↓').replace(/アップ/g, '↑').replace(/ミュート/g, '×').replace(/空振り|空ピッキング/g, '・').replace(/[、,→\-]/g, ' ');
}

// 矢印だけの行(前に「サビ：」などの見出し、後ろに「(自分用)」などの短い書き足しがあってもよい)を拾う。
// 続けて書かれた半小節ずつの行(間に「じゃーん じゃん」の行があってもよい)は1つにつなぐ
function arrowsIn(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: { arrows: string; rhythm: string; label: string; at: number }[] = [];
  lines.forEach((raw, i) => {
    let label = '';
    let body = wordsToArrows(raw);
    const pre = body.match(/^(.{1,12}?)[:：→]\s*(.+)$/);
    if (pre && SECTION.test(pre[1])) {
      label = pre[1].trim();
      body = pre[2];
    }
    body = body
      .replace(/[（(][^↓↑（）()]{1,16}[）)]\s*$/, '')
      .replace(/^([↓↑×xX✕✖・〜~～\-ー_()（）\s]+?)\s*[^↓↑\s][^↓↑]{0,14}$/, '$1')
      .replace(/[（(]\s*[↓↑]\s*[）)]/g, '・')
      .replace(/[xX✕✖]/g, '×')
      .replace(/[〜~～ー_\-]/g, '・')
      .replace(/\s+/g, ' ')
      .trim();
    const bare = body.replace(/\s/g, '');
    const n = (bare.match(/[↓↑]/g) || []).length;
    if (n < 3 || bare.length > 48 || !/^[↓↑×・]+$/.test(bare)) return;
    if (!label && i > 0 && lines[i - 1].length <= 24 && SECTION.test(lines[i - 1])) label = lines[i - 1].replace(/[【】\[\]■●◆▼・:：]/g, ' ').trim();
    const next = lines[i + 1] || '';
    const rhythm = next.length <= 60 && RHYTHM.test(next) && /[タンじゃジャ]/.test(next) ? next.replace(/\s+/g, ' ') : '';
    const prev = out[out.length - 1];
    const plen = prev ? prev.arrows.replace(/\s/g, '').length : 0;
    if (prev && !label && i - prev.at <= 2 && plen === bare.length && plen + bare.length <= 16) {
      prev.arrows += ' ' + body;
      if (rhythm) prev.rhythm = prev.rhythm ? `${prev.rhythm} ${rhythm}` : rhythm;
      prev.at = i;
      return;
    }
    if (n < 4 && bare.length < 8) return;
    out.push({ arrows: body, rhythm, label, at: i });
  });
  return out.map(({ at: _at, ...a }) => a);
}

// アルペジオ: 「5→3→2→3→1→3→2→3」「5弦-3弦-2弦…」のような弦の順番の行を拾う(B = 根音の弦)
function arpIn(text: string) {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw
      .trim()
      .replace(/弦/g, '')
      .replace(/根音|ルート|ベース|[RB]/g, 'B')
      .replace(/[（(][^）)]{1,16}[）)]\s*$/, '')
      .replace(/^[^\dB]{1,10}[:：]\s*/, '');
    if (!/[→\-ー>＞]/.test(l)) continue;
    if (/^[1-6B](\s*[→\-ー>＞、,・]\s*[1-6B]){3,15}$/.test(l)) out.push(l.split(/[^1-6B]+/).filter(Boolean).join(' '));
  }
  return out;
}

async function getText(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(7000), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer()).slice(0, 1_500_000);
  const head = new TextDecoder('latin1').decode(buf.slice(0, 3000));
  const cs = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || head.match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(cs.toLowerCase());
  } catch {
    dec = new TextDecoder('utf-8');
  }
  return dec.decode(buf);
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

// 動画の説明文(矢印が書いてあることがある)
async function ytDescription(id: string) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'User-Agent': UA_DESKTOP, 'Content-Type': 'application/json', 'Accept-Language': 'ja' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } }, videoId: id }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return '';
  // deno-lint-ignore no-explicit-any
  const j: any = await r.json().catch(() => ({}));
  return String(j?.videoDetails?.shortDescription || '');
}

const LESSON = /弾き方|解説|レッスン|ストローク|アルペジオ|講座|初心者|簡単|コード|tab|弾き語り|how to|tutorial|指弾き|リズム/i;

// 動画のコメント(上の方に出る20件)。「↓〜〜〜↓〜↓↑…（自分用）」のように書き残す人が多い
async function ytComments(id: string) {
  const yt = (body: Record<string, unknown>) =>
    fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: { 'User-Agent': UA_DESKTOP, 'Content-Type': 'application/json', 'Accept-Language': 'ja' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } }, ...body }),
      signal: AbortSignal.timeout(6000),
    }).then((r) => (r.ok ? r.json() : {}));
  // deno-lint-ignore no-explicit-any
  const walk = (n: any, f: (o: any) => void) => {
    if (Array.isArray(n)) n.forEach((x) => walk(x, f));
    else if (n && typeof n === 'object') {
      f(n);
      for (const v of Object.values(n)) walk(v, f);
    }
  };
  const first = await yt({ videoId: id });
  let tok = '';
  walk(first, (o) => {
    if (o.sectionIdentifier === 'comment-item-section') walk(o, (c) => (tok ||= c.continuationCommand?.token || ''));
  });
  if (!tok) walk(first, (o) => (o.continuationCommand?.token ? (tok = o.continuationCommand.token) : null));
  if (!tok) return [] as string[];
  const page = await yt({ continuation: tok });
  const out: string[] = [];
  walk(page, (o) => {
    const c = o.commentEntityPayload?.properties?.content?.content;
    if (typeof c === 'string') out.push(c);
  });
  return out;
}

type Found = { arrows: string; rhythm: string; label: string; name: string; url: string; views: number };

// 同じ形(空白を除いて同じ並び)をまとめ、載っている所が多い順(同じなら再生回数の多い動画から出た順)
function group(found: Found[], arp = false) {
  const by = new Map<string, Pat & { views: number }>();
  for (const f of found) {
    const k = f.arrows.replace(/\s/g, '');
    const p = by.get(k) || { arrows: f.arrows, steps: arp ? f.arrows.split(' ') : stepsOf(f.arrows), rhythm: f.rhythm, label: f.label, src: [], views: 0 };
    if (!p.rhythm && f.rhythm) p.rhythm = f.rhythm;
    if (!p.label && f.label) p.label = f.label;
    if (!p.src.some((s) => s.url === f.url && s.name === f.name)) p.src.push({ name: f.name, url: f.url });
    p.views = Math.max(p.views, f.views);
    by.set(k, p);
  }
  return [...by.values()]
    .sort((a, b) => b.src.length - a.src.length || b.views - a.views)
    .slice(0, 6)
    .map(({ views: _v, ...p }) => p);
}

// ---- 検索でいちばん上に出る解説ページの楽譜(画像)を、Gemini に読んでもらう
// 多くの解説ページはストロークを楽譜の画像で載せているので、文字だけでは読めない。
// キーは同じ Supabase の中にある、あさよみ用の Gemini のキー(asayomi_secret.gemini_key)を借りる。無ければ AI は使わない
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';
const TEXT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

async function geminiSetup() {
  const { data } = await db.from('asayomi_secret').select('k,v').in('k', ['gemini_key', 'gemini_models']);
  const get = (k: string) => (data || []).find((r: { k: string }) => r.k === k)?.v || '';
  let models = TEXT_MODELS;
  try {
    const m = JSON.parse(get('gemini_models') || '{}');
    if (Array.isArray(m.text) && m.text.length) models = [...new Set([...m.text.slice(0, 3), ...TEXT_MODELS])];
  } catch {
    // 決まった順で
  }
  return { key: Deno.env.get('GEMINI_API_KEY') || get('gemini_key'), models };
}

// 本文の画像(遅れて読みこむ data-src なども)。アイコン・小さい縮小版・広告は外す
function imagesIn(h: string, base: string) {
  const body = h.match(/<article[\s\S]*?<\/article>/i)?.[0] || h.match(/<main[\s\S]*?<\/main>/i)?.[0] || h;
  const out: { url: string; hint: number }[] = [];
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // 遅れて読みこむ画像は src が仮の絵なので、data-src などを先に見る
    const src = ['data-lazy-src', 'data-src', 'data-original', 'src'].map((a) => tag.match(new RegExp(`\\s${a}=["']([^"']+)["']`, 'i'))?.[1]).find((v) => v && !v.startsWith('data:')) || '';
    if (!src || src.startsWith('data:') || /\.svg(\?|$)|gravatar|emoji|icon|logo|avatar|banner|amazon|rakuten|\bads?\b|-\d{2,3}x\d{2,3}\.|thumb/i.test(src)) continue;
    let url = '';
    try {
      url = new URL(unescape(src), base).href;
    } catch {
      continue;
    }
    if (out.some((o) => o.url === url)) continue;
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
    const at = m.index || 0;
    const near = body.slice(Math.max(0, at - 600), at + 200);
    const hint = (/ストローク|リズム|パターン|弾き方|譜/.test(alt) ? 3 : 0) + (/ストローク|リズム|パターン|ダウン|アップ|ブラッシング/.test(near) ? 2 : 0) + (/アルペジオ/.test(near + alt) ? 1 : 0);
    out.push({ url, hint });
  }
  return out;
}

async function imagePart(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, Referer: url }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 6000 || buf.length > 1_800_000) return null; // 小さすぎるのは飾り、大きすぎるのは送らない
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: type, data: btoa(bin) } };
}

const AI_SYSTEM = [
  'あなたはギターの先生です。渡すのは、ある曲のギターの弾き方を解説しているウェブページの文章と、そのページの画像です。',
  'ページに書かれている(画像の楽譜・図に描かれている)ストロークのパターンとアルペジオの弦の順番を、そのまま書き写してください。自分で考えて作ってはいけません。ページに無ければ空にします。',
  'ストロークの書き方: 1小節を16分音符16こま(4拍×4)で、拍ごとに空白で区切る。↓=ダウン、↑=アップ、×=ブラッシング(ミュート)、・=弦に当てない(空振り・のばす)。例: "↓・↓↑ ・↑↓↑ ↓・↓↑ ・↑↓↑"。',
  '楽譜の記号の読み方: ┏┓ や ⊓ や П はダウン、V はアップ、× は ブラッシング。8分音符だけの曲は1拍を "↓・↑・" のように4こまで書く。3拍子は12こま。',
  'アルペジオの書き方: 1小節で弾く弦の番号を順に空白で区切る。根音の弦(コードで変わる)は B。例: "B 3 2 3 1 3 2 3"。',
  'Aメロ・サビなどで違うなら、場所ごとに分けて label に書く(最大4つ)。',
  '答えは JSON だけ: {"stroke":[{"label":"Aメロ","arrows":"↓・↓↑ ・↑↓↑ ↓・↓↑ ・↑↓↑"}],"arpeggio":[{"label":"イントロ","strings":"B 3 2 3 1 3 2 3"}]}',
].join('\n');

// ページ(上から2つまで)の文章と画像を見せて、書いてある弾き方をもらう
async function aiRead(pages: { url: string; html: string; text: string }[], title: string) {
  const { key, models } = await geminiSetup();
  if (!key || !pages.length) return null;
  const parts: unknown[] = [];
  for (const p of pages.slice(0, 2)) {
    const t = p.text.replace(/\n{2,}/g, '\n');
    const at = Math.max(0, t.search(/ストローク|リズム|弾き方/) - 300);
    parts.push({ text: `ページ: ${p.url}\n曲: ${title}\n---\n${t.slice(at, at + 2500)}` });
    const imgs = imagesIn(p.html, p.url)
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => b.hint - a.hint || a.i - b.i)
      .slice(0, 6);
    const got = await Promise.all(imgs.map((x) => imagePart(x.url).catch(() => null)));
    for (const g of got) if (g) parts.push(g);
  }
  for (const model of models) {
    const r = await fetch(`${GEMINI}models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: AI_SYSTEM }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(40000),
    }).catch(() => null);
    if (!r) continue;
    if (!r.ok) {
      if (r.status === 400 || r.status === 401 || r.status === 403) return null; // キーがだめ
      continue; // 混んでいる・そのモデルが無い → 次のモデル
    }
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const raw = (j?.candidates?.[0]?.content?.parts || []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('');
    try {
      const o = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      return {
        // deno-lint-ignore no-explicit-any
        stroke: (Array.isArray(o.stroke) ? o.stroke : []).map((s: any) => ({ label: String(s.label || '').slice(0, 20), arrows: cleanArrows(String(s.arrows || '')) })).filter((s: { arrows: string }) => s.arrows),
        // deno-lint-ignore no-explicit-any
        arp: (Array.isArray(o.arpeggio) ? o.arpeggio : []).map((s: any) => ({ label: String(s.label || '').slice(0, 20), strings: String(s.strings || '').replace(/[^1-6B ]/g, ' ').replace(/\s+/g, ' ').trim() })).filter((s: { strings: string }) => s.strings.split(' ').length >= 3),
      };
    } catch {
      return null;
    }
  }
  return null;
}

// AI の答えの矢印を、アプリの書き方(↓↑×・と空白)にそろえる
function cleanArrows(s: string) {
  const a = s.replace(/[xX✕✖]/g, '×').replace(/[〜~～ー_\-]/g, '・').replace(/[^↓↑×・\s]/g, '').replace(/\s+/g, ' ').trim();
  return (a.match(/[↓↑]/g) || []).length >= 2 ? a : '';
}

// 解説ページと、再生回数の多い解説動画(説明とコメント)から、弾き方(矢印・弦の順番)を集める。
// 検索でいちばん上に出る解説ページの弾き方(画像の楽譜は AI が読む)を先頭に、ほかは同じ形が多い順
async function strumFind(title: string, artist: string) {
  const t = baseTitle(title);
  const ft = fold(t);
  const about = (s: string) => fold(s).includes(ft);

  const vids = async (q: string, ok: (s: string) => boolean) => {
    const got = await ytSearch(q, [20, 2400]).catch(() => [] as YtHit[]);
    return got
      .filter((v) => about(v.title) && LESSON.test(v.title) && ok(v.title))
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 4);
  };
  const [stroke, arp, urlsA, urlsB] = await Promise.all([
    vids(`${artist} ${t} ギター 弾き方 ストローク`, (s) => !/アルペジオ|指弾き/.test(s) || /ストローク/.test(s)),
    vids(`${artist} ${t} ギター アルペジオ 弾き方`, (s) => /アルペジオ|指弾き|arpeggio/i.test(s)),
    webSearch(`${t} ストローク`), // 人がふつうに調べる言葉(いちばん上の解説ページを見つける)
    webSearch(`${t} ${artist} ギター 弾き方 ストローク`),
  ]);

  const urls = [...new Set([...urlsA.slice(0, 7), ...urlsB.slice(0, 5)])].filter((u) => !SKIP_HOST.test(hostOf(u))).slice(0, 8);
  const found: Found[] = [];
  const arps: Found[] = [];
  const pages: { url: string; html: string; text: string; rank: number }[] = [];
  const times = (n = 0) => (n >= 1e4 ? `再生${Math.round(n / 1e4)}万回` : n ? `再生${n}回` : '');
  const fromVideo = async (v: YtHit, kind: 'stroke' | 'arp') => {
    const url = `https://www.youtube.com/watch?v=${v.id}`;
    const [desc, coms] = await Promise.all([ytDescription(v.id).catch(() => ''), ytComments(v.id).catch(() => [] as string[])]);
    const who = `${v.channel || 'YouTube'}の解説動画${v.views ? `（${times(v.views)}）` : ''}`;
    const texts: [string, string][] = [[desc, `${who}の説明`], ...coms.map((c) => [c, `${who}のコメント`] as [string, string])];
    for (const [tx, name] of texts) {
      if (kind === 'stroke') for (const a of arrowsIn(tx).slice(0, 3)) found.push({ ...a, name, url, views: v.views || 0 });
      for (const a of arpIn(tx).slice(0, 2)) arps.push({ arrows: a, rhythm: '', label: '', name, url, views: v.views || 0 });
    }
  };
  await Promise.all([
    ...urls.map(async (u, rank) => {
      try {
        const h = await getText(u);
        const ttl = unescape(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
        if (!about(ttl)) return; // ほかの曲のページ
        const tx = pageText(h);
        pages.push({ url: u, html: h, text: tx, rank });
        for (const a of arrowsIn(tx).slice(0, 6)) found.push({ ...a, name: hostOf(u), url: u, views: 0 });
        for (const a of arpIn(tx).slice(0, 3)) arps.push({ arrows: a, rhythm: '', label: '', name: hostOf(u), url: u, views: 0 });
      } catch {
        // 読めないページは飛ばす
      }
    }),
    ...stroke.map((v) => fromVideo(v, 'stroke').catch(() => {})),
    ...arp.slice(0, 3).map((v) => fromVideo(v, 'arp').catch(() => {})),
  ]);

  // いちばん上の解説ページ(と2番目)を AI に読んでもらう
  pages.sort((a, b) => a.rank - b.rank);
  const top = pages.slice(0, 2);
  const ai = await aiRead(top, `${t}${artist ? ` / ${artist}` : ''}`).catch(() => null);
  const src = top.map((p) => ({ name: `${hostOf(p.url)}（検索でいちばん上のページ）`, url: p.url }));
  const first = src[0] ? [src[0]] : [];
  const topPats: Pat[] = (ai?.stroke || []).slice(0, 4).map((s) => ({ arrows: s.arrows, steps: stepsOf(s.arrows), rhythm: '', label: s.label, src: first, top: true }));
  const topArps: Pat[] = (ai?.arp || []).slice(0, 3).map((s) => ({ arrows: s.strings, steps: s.strings.split(' '), rhythm: '', label: s.label, src: first, top: true }));
  const same = (a: string, b: string) => a.replace(/\s/g, '') === b.replace(/\s/g, '');
  const rest = group(found).filter((p) => !topPats.some((q) => same(q.arrows, p.arrows)));
  const restArps = group(arps, true).filter((p) => !topArps.some((q) => same(q.arrows, p.arrows)));

  // 解説動画の題名にある「16ビート」「8ビート」(矢印が見つからないときの手がかり)
  const bt = [...stroke, ...arp].map((v) => v.title.normalize('NFKC').match(/(16|8)\s*ビート/)?.[1]).find(Boolean) || '';
  return {
    patterns: [...topPats, ...rest].slice(0, 6),
    arps: [...topArps, ...restArps].slice(0, 3),
    beat: bt,
    top: top[0] ? { name: hostOf(top[0].url), url: top[0].url } : null,
    ai: ai ? 'ok' : 'none',
    looked: stroke.length + arp.length + urls.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json().catch(() => ({}));
    const dev = await authDevice(req);
    if (!dev) return json({ error: 'この端末はつながっていません', code: 'unpaired' }, 401);
    const title = String(body.title || '').slice(0, 120).trim();
    const artist = String(body.artist || '').slice(0, 120).trim();
    if (body.action === 'krc_all') {
      if (!title) return json({ list: [] });
      const ck = `krcs2:${norm(`${artist} ${baseTitle(title)}`)}`;
      const { data } = await db.from('hikigatari_sheet_cache').select('data,fetched_at').eq('key', ck).maybeSingle();
      if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL_MS) return json({ list: data.data, cached: true });
      const list = await krcAll(title, artist, Number(body.durationMs) || 0).catch(() => []);
      if (list.length) await db.from('hikigatari_sheet_cache').upsert({ key: ck, data: list, fetched_at: new Date().toISOString() });
      return json({ list });
    }
    if (body.action === 'strum_find') {
      if (!title) return json({ patterns: [], arps: [], beat: '' });
      const ck = `strum3:${norm(`${artist} ${baseTitle(title)}`)}`;
      if (!body.force) {
        const { data } = await db.from('hikigatari_sheet_cache').select('data,fetched_at').eq('key', ck).maybeSingle();
        if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL_MS) return json({ ...data.data, cached: true });
      }
      const out = await strumFind(title, artist);
      if (out.patterns.length || out.arps.length) await db.from('hikigatari_sheet_cache').upsert({ key: ck, data: out, fetched_at: new Date().toISOString() });
      return json(out);
    }
    if (body.action !== 'yt_search') return json({ error: 'unknown action' }, 400);
    if (!title) return json({ items: [] });
    const q = `${artist} ${title}`.trim();
    const ck = `yt1:${norm(q)}`;
    if (!body.force) {
      const { data } = await db.from('hikigatari_sheet_cache').select('data,fetched_at').eq('key', ck).maybeSingle();
      if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL_MS) return json({ items: data.data, cached: true });
    }
    const items = await ytSearch(q);
    if (items.length) await db.from('hikigatari_sheet_cache').upsert({ key: ck, data: items, fetched_at: new Date().toISOString() });
    return json({ items });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
