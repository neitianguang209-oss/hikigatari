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
// 公式の弾き方は無いので、2つの手がかりを集める:
// ・解説のページやブログに文字で書かれたストロークの矢印(↓↑)。同じ形を載せているページが多いものほど上に
//   (画像で載せているページは読めない)
// ・YouTube の弾き方の解説動画を、再生回数の多い順に(ストローク・アルペジオそれぞれ)。動画の説明に矢印があればそれも拾う
type Pat = { arrows: string; rhythm: string; label: string; src: { name: string; url: string }[] };

const SKIP_HOST = /youtube\.com|youtu\.be|ufret\.jp|piascore|amazon|rakuten|twitter\.com|x\.com|instagram|tiktok|facebook|chordwiki|j-total|music\.j-total|utaten|uta-net|apple\.com|spotify|wikipedia/;

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
  return [...h.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="(https?:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
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
const RHYTHM = /^[タンッーカジャチャ・\s]+$/;

// 矢印だけの行(前に「サビ：」などの見出しがついていてもよい)を拾う
function arrowsIn(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: { arrows: string; rhythm: string; label: string }[] = [];
  lines.forEach((line, i) => {
    let label = '';
    let body = line;
    const pre = line.match(/^(.{1,12}?)[:：]\s*(.+)$/);
    if (pre && SECTION.test(pre[1])) {
      label = pre[1].trim();
      body = pre[2];
    }
    body = body.replace(/[xX✕✖]/g, '×').replace(/\s+/g, ' ').trim();
    const bare = body.replace(/\s/g, '');
    const n = (bare.match(/[↓↑]/g) || []).length;
    if (n < 4 || n > 48 || !/^[↓↑×・\-()（）]+$/.test(bare)) return;
    if (!label && i > 0 && lines[i - 1].length <= 24 && SECTION.test(lines[i - 1])) label = lines[i - 1].replace(/[【】\[\]■●◆▼・:：]/g, ' ').trim();
    const next = lines[i + 1] || '';
    const rhythm = next.length <= 60 && RHYTHM.test(next) && /[タン]/.test(next) ? next.replace(/\s+/g, ' ') : '';
    out.push({ arrows: body, rhythm, label });
  });
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

async function strumFind(title: string, artist: string) {
  const t = baseTitle(title);
  const ft = fold(t);
  const about = (s: string) => fold(s).includes(ft);

  // 解説動画(ストローク・アルペジオ)
  const vids = async (q: string, ok: (s: string) => boolean) => {
    const got = await ytSearch(q, [20, 2400]).catch(() => [] as YtHit[]);
    return got
      .filter((v) => about(v.title) && LESSON.test(v.title) && ok(v.title))
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 3);
  };
  const [stroke, arp, urlsA, urlsB] = await Promise.all([
    // ストローク: アルペジオだけの動画は外す
    vids(`${artist} ${t} ギター 弾き方 ストローク`, (s) => !/アルペジオ|指弾き/.test(s) || /ストローク/.test(s)),
    vids(`${artist} ${t} ギター アルペジオ 弾き方`, (s) => /アルペジオ|指弾き|arpeggio/i.test(s)),
    webSearch(`${t} ${artist} ギター ストローク パターン`),
    webSearch(`${t} ${artist} ギター 弾き方 ストローク 矢印`),
  ]);

  // ページ(と動画の説明)から矢印を集め、同じ形をまとめる
  const urls = [...new Set([...urlsA.slice(0, 6), ...urlsB.slice(0, 4)])].filter((u) => !SKIP_HOST.test(hostOf(u))).slice(0, 8);
  const found: { arrows: string; rhythm: string; label: string; name: string; url: string }[] = [];
  await Promise.all([
    ...urls.map(async (u) => {
      try {
        const h = await getText(u);
        const ttl = unescape(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
        if (!about(ttl)) return; // ほかの曲のページ
        for (const a of arrowsIn(pageText(h)).slice(0, 6)) found.push({ ...a, name: hostOf(u), url: u });
      } catch {
        // 読めないページは飛ばす
      }
    }),
    ...stroke.slice(0, 3).map(async (v) => {
      try {
        for (const a of arrowsIn(await ytDescription(v.id)).slice(0, 4)) found.push({ ...a, name: v.channel || 'YouTube', url: `https://www.youtube.com/watch?v=${v.id}` });
      } catch {
        // 説明が読めなければ飛ばす
      }
    }),
  ]);
  const by = new Map<string, Pat>();
  for (const f of found) {
    const k = f.arrows.replace(/\s/g, '');
    const p = by.get(k) || { arrows: f.arrows, rhythm: f.rhythm, label: f.label, src: [] };
    if (!p.rhythm && f.rhythm) p.rhythm = f.rhythm;
    if (!p.label && f.label) p.label = f.label;
    if (!p.src.some((s) => s.url === f.url)) p.src.push({ name: f.name, url: f.url });
    by.set(k, p);
  }
  const patterns = [...by.values()].sort((a, b) => b.src.length - a.src.length).slice(0, 6);
  return { patterns, stroke, arp };
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
      if (!title) return json({ patterns: [], stroke: [], arp: [] });
      const ck = `strum1:${norm(`${artist} ${baseTitle(title)}`)}`;
      if (!body.force) {
        const { data } = await db.from('hikigatari_sheet_cache').select('data,fetched_at').eq('key', ck).maybeSingle();
        if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL_MS) return json({ ...data.data, cached: true });
      }
      const out = await strumFind(title, artist);
      if (out.patterns.length || out.stroke.length || out.arp.length) await db.from('hikigatari_sheet_cache').upsert({ key: ck, data: out, fetched_at: new Date().toISOString() });
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
