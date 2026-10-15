// ひきがたり Edge Function(自分の音源): 原曲として使う自分の音源ファイルを、端末どうしで共有する
// ・置き場は非公開のバケット hikigatari-audio(誰でも読めるようにはしない)。本体(hikigatari)と同じ端末の鍵で確かめてから、
//   期限つきの URL(入れる用・取り出す用)を渡すだけ。ファイルそのものはこの関数を通らない
// ・使うのは持ち主が自分で持っている音源(買った曲・CD から取り込んだ曲など)。YouTube などから抜き出した音は扱わない
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const BUCKET = 'hikigatari-audio';
const MAX_BYTES = 40 * 1024 * 1024; // 1曲 40MB まで(バケットの上限と同じ)
const EXTS = ['m4a', 'mp3', 'aac', 'wav', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'aif', 'aiff', 'caf'];
const PATH_RE = /^[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,40}\.[a-z0-9]{2,5}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-hk-key, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

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

const safeId = (s: unknown) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

// 置いてある音源の数と大きさ(曲ごとのフォルダを見て回る)
async function usage() {
  const st = db.storage.from(BUCKET);
  const { data: dirs, error } = await st.list('', { limit: 1000 });
  if (error) throw error;
  let files = 0;
  let bytes = 0;
  for (const d of dirs || []) {
    if (d.id) continue; // フォルダだけ(直下にファイルは置かない)
    const { data: items } = await st.list(d.name, { limit: 100 });
    for (const it of items || []) {
      if (!it.id) continue;
      files++;
      bytes += Number(it.metadata?.size || 0);
    }
  }
  return { files, bytes };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const dev = await authDevice(req);
  if (!dev) return json({ error: 'この端末はつながっていません', code: 'unpaired' }, 401);
  const st = db.storage.from(BUCKET);
  try {
    switch (body.action) {
      // 入れる: 置き場所を決めて、入れる用の URL を返す(端末から直接そこへ送る)
      case 'put': {
        const size = Number(body.size || 0);
        const ext = String(body.ext || '').toLowerCase();
        const song = safeId(body.songId);
        if (!song) return json({ error: '曲が分かりません' }, 400);
        if (!EXTS.includes(ext)) return json({ error: 'この形のファイルは置けません' }, 400);
        if (!(size > 0) || size > MAX_BYTES) return json({ error: `1曲 ${MAX_BYTES / 1024 / 1024}MB までです`, code: 'big' }, 400);
        const name = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);
        const path = `${song}/${name}.${ext}`;
        const { data, error } = await st.createSignedUploadUrl(path);
        if (error) throw error;
        return json({ path, url: data.signedUrl });
      }
      // 取り出す: 1時間だけ使える URL
      case 'get': {
        const path = String(body.path || '');
        if (!PATH_RE.test(path)) return json({ error: 'bad path' }, 400);
        const { data, error } = await st.createSignedUrl(path, 3600);
        if (error) return json({ error: '音源が見つかりませんでした', code: 'missing' }, 404);
        return json({ url: data.signedUrl });
      }
      case 'del': {
        const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).map(String).filter((p) => PATH_RE.test(p)).slice(0, 20);
        if (paths.length) await st.remove(paths);
        return json({ ok: true, removed: paths.length });
      }
      case 'usage':
        return json(await usage());
      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 500);
  }
});
