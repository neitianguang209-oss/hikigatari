// ひきがたり Edge Function(曲と合わせる): 原曲の YouTube の動画を探す
// 本体(hikigatari)と同じ端末の鍵で守る。結果は hikigatari_sheet_cache に7日置く。
// 返すのは動画の番号・題名・チャンネル名・長さだけ(動画そのものは、アプリの中の YouTube のプレーヤーが流す)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json().catch(() => ({}));
    const dev = await authDevice(req);
    if (!dev) return json({ error: 'この端末はつながっていません', code: 'unpaired' }, 401);
    if (body.action !== 'yt_search') return json({ error: 'unknown action' }, 400);
    const title = String(body.title || '').slice(0, 120).trim();
    const artist = String(body.artist || '').slice(0, 120).trim();
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
