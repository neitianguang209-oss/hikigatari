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

type YtHit = { id: string; title: string; channel: string; dur: number };

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
function collect(node: any, out: YtHit[], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14 || out.length >= 20) return;
  if (Array.isArray(node)) {
    for (const x of node) collect(x, out, depth + 1);
    return;
  }
  const v = node.videoRenderer;
  if (v?.videoId) {
    const dur = toSec(runs(v.lengthText));
    // 長さの無いもの(生配信・ショート)と、曲としては短すぎる・長すぎるものは外す
    if (dur >= 60 && dur <= 900 && !out.some((o) => o.id === v.videoId)) {
      out.push({ id: String(v.videoId), title: runs(v.title) || '', channel: runs(v.ownerText) || runs(v.longBylineText) || '', dur });
    }
    return;
  }
  for (const k in node) collect(node[k], out, depth + 1);
}

// 取り方その1: 検索の結果をデータ(JSON)でもらう
async function searchJson(q: string): Promise<YtHit[]> {
  const r = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'User-Agent': UA_DESKTOP, 'Content-Type': 'application/json', 'Accept-Language': 'ja,en;q=0.8' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ja', gl: 'JP' } }, query: q }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`取得失敗 HTTP ${r.status}`);
  const out: YtHit[] = [];
  collect((await r.json())?.contents, out);
  return out;
}

// 取り方その2: 検索結果のページに埋まっているデータを読む
async function searchPage(q: string): Promise<YtHit[]> {
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
  collect(JSON.parse(html.slice(from, end))?.contents, out);
  return out;
}

// たまに中身の無い返事が来るので、取り方を替えながら結果が出るまで試す
async function ytSearch(q: string): Promise<YtHit[]> {
  let last: unknown = null;
  for (const f of [searchJson, searchPage, searchJson]) {
    try {
      const out = await f(q);
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
