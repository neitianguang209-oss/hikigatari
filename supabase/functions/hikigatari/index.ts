// ひきがたり Edge Function
// ・コード譜サイト(U-FRET / ChordWiki / 歌ネット)の検索と取り込み
// ・端末ごとの鍵による「自分専用」ロック(端末の追加は6桁コード)
// ・お気に入り/履歴(hikigatari_songs)の同期
// テーブルはRLSでanonから閉じてあり、ここ(service role)からだけ読み書きする。
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
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const SHEET_TTL_MS = 3 * 24 * 3600e3;
const SEARCH_TTL_MS = 6 * 3600e3;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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

function randomKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomCode() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 1_000_000).padStart(6, '0');
}

// ---------------------------------------------------------------- 文字列ユーティリティ

function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k] ?? m;
  });
}

function stripTags(s: string) {
  return decodeEntities(s.replace(/<[^>]*>/g, ''));
}

// 表記ゆれを吸収した比較用キー(スペース・記号・全角半角・大文字小文字を無視)
function norm(s: string) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・,.、。!?'"’“”\-‐―~〜_()\[\]【】「」『』/:;&+*×]/g, '');
}

// 版やタイアップ表記を落とした「曲名そのもの」
function baseTitle(t: string) {
  let s = (t || '').normalize('NFKC');
  // 「アイドル (アニメ「【推しの子】」OP)」のような入れ子も、内側から順に外す
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\s*[(\[【「『〔][^()\[\]【】「」『』〔〕]*[)\]】」』〕]\s*/g, ' ');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+[(\[【].*$/, ''); // 閉じていない括弧以降
  s = s.replace(/\s+-\s+.*$/, '');
  s = s.replace(
    /\s*(弾き語り|ピアノ|piano|バンド|アコギ|アコースティック|acoustic|ギター|guitar|簡単|初心者|tv|full|short|ショート)?\s*(ver\.?|version|バージョン)\s*$/i,
    '',
  );
  s = s.replace(/\s+/g, ' ').trim();
  return s || (t || '').trim();
}

function sameArtist(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

async function get(url: string, { mobile = false, timeout = 9000 } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': mobile ? UA_MOBILE : UA_DESKTOP, 'Accept-Language': 'ja,en;q=0.8' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `取得失敗 HTTP ${r.status}`);
  return await r.text();
}

// ---------------------------------------------------------------- U-FRET

type Hit = { source: string; id: string; title: string; artist: string; badges?: string[]; url: string };

async function ufretSearch(q: string): Promise<Hit[]> {
  const html = await get('https://www.ufret.jp/search.php?key=' + encodeURIComponent(q), { mobile: true });
  const out: Hit[] = [];
  const seen = new Set<string>();
  const re = /<a href="\/song\.php\?data=(\d+)" class="c-list__link">([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const block = m[2];
    const titleHtml = block.match(/c-list__title">([\s\S]*?)<\/p>/)?.[1] ?? '';
    const artistHtml = block.match(/c-list__artist">([\s\S]*?)<\/p>/)?.[1] ?? '';
    const badges: string[] = [];
    if (/c-icon__rookie/.test(titleHtml)) badges.push('初心者ver');
    if (/c-icon__youtube/.test(titleHtml)) badges.push('動画あり');
    const title = stripTags(titleHtml.replace(/<span[\s\S]*?<\/span>/g, '')).replace(/\s+/g, ' ').trim();
    out.push({
      source: 'ufret',
      id: m[1],
      title,
      artist: stripTags(artistHtml).trim(),
      badges,
      url: `https://www.ufret.jp/song.php?data=${m[1]}`,
    });
  }
  return out;
}

async function ufretSheet(id: string) {
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'bad id');
  const html = await get(`https://www.ufret.jp/song.php?data=${id}`, { mobile: true });
  const m = html.match(/ufret_chord_datas\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new HttpError(404, 'このページには譜面データがありませんでした');
  const arr: string[] = JSON.parse(m[1]);
  const text = arr.map((l) => String(l).replace(/\r/g, '').replace(/\s+$/, '')).join('\n');
  const bpm = html.match(/bpm_scrollbar"\s+value="(\d+)"/)?.[1];
  const title = decodeEntities(html.match(/var song_name\s*=\s*'([^']*)'/)?.[1] ?? '');
  const artist = decodeEntities(html.match(/var artist_name\s*=\s*'([^']*)'/)?.[1] ?? '');
  return { text, bpm: bpm ? Number(bpm) : null, key: null, title, artist, url: `https://www.ufret.jp/song.php?data=${id}` };
}

// ---------------------------------------------------------------- ChordWiki(曲名=ページ名)

function cwArtist(sub: string) {
  const s = sub.normalize('NFKC');
  const parts = s.split(/\s{2,}|　|\s(?=[^\s]*[:：])/).map((p) => p.trim()).filter(Boolean);
  const sing = parts.find((p) => /^歌/.test(p) && /[:：]/.test(p)) ?? parts.find((p) => /[:：]/.test(p));
  if (!sing) return s.trim();
  return sing.split(/[:：]/).slice(1).join(':').trim();
}

async function chordwikiSheet(title: string) {
  const html = await get(`https://ja.chordwiki.org/wiki.cgi?c=edit&t=${encodeURIComponent(title)}`);
  const m = html.match(/<textarea[^>]*name="chord"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!m) return null;
  const text = decodeEntities(m[1]).replace(/\r/g, '').trim();
  const body = text
    .split('\n')
    .filter((l) => l.trim() && !/^\{\s*(title|t|subtitle|st)\s*:/.test(l.trim()));
  if (body.length < 4) return null; // 未作成ページはタイトル行だけのテンプレートが返る
  const sub = text.match(/\{\s*(?:subtitle|st)\s*:\s*([^}]*)\}/)?.[1] ?? '';
  const t = text.match(/\{\s*(?:title|t)\s*:\s*([^}]*)\}/)?.[1] ?? title;
  const key = text.match(/\{\s*key\s*:\s*([^}]*)\}/)?.[1]?.trim() || null;
  const bpm = text.match(/BPM\s*[=:：]?\s*(\d{2,3})/i)?.[1];
  return {
    text,
    key,
    bpm: bpm ? Number(bpm) : null,
    title: baseTitle(t),
    artist: cwArtist(sub),
    url: `https://ja.chordwiki.org/wiki/${encodeURIComponent(title)}`,
  };
}

// ---------------------------------------------------------------- 歌ネット

async function utanetSearch(title: string): Promise<Hit[]> {
  const html = await get(
    `https://www.uta-net.com/search/?Keyword=${encodeURIComponent(title)}&Aselect=2&Bselect=3`,
  );
  const out: Hit[] = [];
  const re = /<a href="\/song\/(\d+)\/"[^>]*>\s*<span class="fw-bold songlist-title">([\s\S]*?)<\/span>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const artist = m[3].match(/utaidashi">([\s\S]*?)<\/span>/)?.[1] ?? '';
    out.push({
      source: 'utanet',
      id: m[1],
      title: stripTags(m[2]).trim(),
      artist: stripTags(artist).trim(),
      url: `https://www.uta-net.com/chord/${m[1]}/`,
    });
  }
  return out;
}

async function utanetSheet(id: string) {
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'bad id');
  const html = await get(`https://www.uta-net.com/chord/${id}/`);
  const start = html.indexOf('id="kashi_area"');
  if (start < 0 || !html.includes('code-span')) return null;
  const open = html.indexOf('>', start) + 1;
  const end = html.indexOf('</div>', open);
  const area = html.slice(open, end);
  const lines = area.split(/<br\s*\/?>/i).map((line) => {
    const withChords = line.replace(/<rt>([\s\S]*?)<\/rt>/gi, (_all, inner: string) => {
      const c = inner.match(/code-span[^>]*>([^<]*)</);
      return c ? `[${decodeEntities(c[1]).trim()}]` : '';
    });
    return stripTags(withChords).replace(/[\r\n\t]/g, '').replace(/\s+$/, '');
  });
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ttl = stripTags(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  return { text: lines.join('\n'), bpm: null, key: null, title: ttl.split(/ギター|\|｜/)[0].trim(), artist: '', url: `https://www.uta-net.com/chord/${id}/` };
}

// ---------------------------------------------------------------- iTunes(曲名の正規化・ジャケット)

type Cand = { title: string; artist: string; artwork: string; appleId: number; durationMs: number; base: string };

async function itunes(q: string): Promise<Cand[]> {
  const r = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&entity=song&limit=15&lang=ja_jp`,
    { signal: AbortSignal.timeout(6000) },
  );
  if (!r.ok) return [];
  const j = await r.json();
  const out: Cand[] = [];
  const seen = new Set<string>();
  for (const x of j.results ?? []) {
    const base = baseTitle(x.trackName);
    const k = norm(base) + '|' + norm(x.artistName);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      title: x.trackName,
      artist: x.artistName,
      artwork: x.artworkUrl100,
      appleId: x.trackId,
      durationMs: x.trackTimeMillis,
      base,
    });
  }
  return out;
}

// ---------------------------------------------------------------- キャッシュ

async function cacheGet(key: string, ttl: number) {
  const { data } = await db.from('hikigatari_sheet_cache').select('data,fetched_at').eq('key', key).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < ttl) return data.data;
  return null;
}
async function cachePut(key: string, data: unknown) {
  await db.from('hikigatari_sheet_cache').upsert({ key, data, fetched_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- 譜面の取得

async function bpmFromUfret(title: string, artist: string) {
  const hits = (await ufretSearch(`${baseTitle(title)} ${artist}`)).filter(
    (h) => sameArtist(h.artist, artist) && norm(baseTitle(h.title)) === norm(baseTitle(title)),
  );
  if (!hits.length) return null;
  const s = await getSheet('ufret', hits[0].id, '', '', false, false);
  return s?.bpm ?? null;
}

// deno-lint-ignore no-explicit-any
async function getSheet(source: string, id: string, title: string, artist: string, force: boolean, lookupBpm = true): Promise<any> {
  const ck = `sheet:${source}:${id}`;
  if (!force) {
    const c = await cacheGet(ck, SHEET_TTL_MS);
    if (c) return c;
  }
  // deno-lint-ignore no-explicit-any
  let r: any = null;
  if (source === 'ufret') r = await ufretSheet(id);
  else if (source === 'chordwiki') r = await chordwikiSheet(id);
  else if (source === 'utanet') r = await utanetSheet(id);
  else throw new HttpError(400, 'unknown source');
  if (!r) throw new HttpError(404, 'このサイトにはこの曲の譜面がありませんでした');
  // 呼び出し側(検索結果)が曲名・アーティストを知っていればそちらを優先する
  if (title) r.title = baseTitle(title);
  if (artist) r.artist = artist;
  if (!r.bpm && lookupBpm && r.title && r.artist && source !== 'ufret') {
    r.bpm = await bpmFromUfret(r.title, r.artist).catch(() => null);
  }
  r.source = source;
  r.sourceId = id;
  r.fetchedAt = new Date().toISOString();
  await cachePut(ck, r);
  return r;
}

// ---------------------------------------------------------------- 横断検索

async function search(qRaw: string) {
  const q = qRaw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!q) return { groups: [] };
  const ck = 'search:' + norm(q);
  const cached = await cacheGet(ck, SEARCH_TTL_MS);
  if (cached) return cached;

  const [ufR, itR] = await Promise.allSettled([ufretSearch(q), itunes(q)]);
  let uf = ufR.status === 'fulfilled' ? ufR.value : [];
  const cands = itR.status === 'fulfilled' ? itR.value : [];

  // 曲名だけで引くサイト(歌ネット/ChordWiki)には、iTunesで整えた曲名で当たる
  const titles: string[] = [];
  for (const c of cands.slice(0, 5)) if (!titles.some((t) => norm(t) === norm(c.base))) titles.push(c.base);
  if (!titles.length) titles.push(baseTitle(q));
  const probeTitles = titles.slice(0, 3);
  const candArtists = cands.slice(0, 8).map((c) => c.artist);

  // U-FRETは「アイドル」のような短い語だと関係ない曲で上位が埋まるので、
  // iTunesの上位候補については「曲名 アーティスト」でも引き直す
  const ufExtraQueries = cands
    .slice(0, 2)
    .filter((c) => !uf.some((h) => norm(baseTitle(h.title)) === norm(c.base) && sameArtist(h.artist, c.artist)))
    .map((c) => `${c.base} ${c.artist}`);
  if (!cands.length && !uf.length && norm(probeTitles[0]) !== norm(q)) ufExtraQueries.push(probeTitles[0]);

  const [unLists, cwList, ufExtra] = await Promise.all([
    Promise.all(probeTitles.map((t) => utanetSearch(t).catch(() => [] as Hit[]))),
    Promise.all(
      probeTitles.map((t) =>
        getSheet('chordwiki', t, t, '', false, false)
          .then((s) => ({ t, s }))
          .catch(() => null)
      ),
    ),
    Promise.all(ufExtraQueries.map((x) => ufretSearch(x).catch(() => [] as Hit[]))),
  ]);
  for (const list of ufExtra) for (const h of list) if (!uf.some((u) => u.id === h.id)) uf.push(h);

  // 歌ネットは同名異曲が多いので、iTunesの候補アーティストに合うものだけ(候補が無ければ上位)を実際に開いて確かめる
  const unHits: Hit[] = [];
  const unSeen = new Set<string>();
  for (const list of unLists) {
    const filtered = candArtists.length ? list.filter((h) => candArtists.some((a) => sameArtist(a, h.artist))) : list;
    for (const h of filtered) if (!unSeen.has(h.id)) (unSeen.add(h.id), unHits.push(h));
  }
  const unChecked = await Promise.all(
    unHits.slice(0, 5).map((h) =>
      getSheet('utanet', h.id, h.title, h.artist, false, false)
        .then(() => h)
        .catch(() => null)
    ),
  );

  // ---- グループ化: 曲名(版表記を除く)+アーティストで束ねる
  // deno-lint-ignore no-explicit-any
  const groups: any[] = [];
  const find = (title: string, artist: string) =>
    groups.find((g) => norm(g.title) === norm(baseTitle(title)) && (sameArtist(g.artist, artist) || !g.artist || !artist));
  // deno-lint-ignore no-explicit-any
  const add = (title: string, artist: string, src: any) => {
    let g = find(title, artist);
    if (!g) {
      g = { title: baseTitle(title), artist, sources: [] };
      groups.push(g);
    }
    if (!g.artist && artist) g.artist = artist;
    if (!g.sources.some((s: Hit) => s.source === src.source && s.id === src.id)) g.sources.push(src);
  };

  // iTunesの並び(人気順)を優先して器を作る
  for (const c of cands.slice(0, 10)) {
    if (!groups.some((g) => norm(g.title) === norm(c.base) && sameArtist(g.artist, c.artist))) {
      groups.push({ title: c.base, artist: c.artist, sources: [], artwork: c.artwork, appleId: c.appleId, durationMs: c.durationMs });
    }
  }
  const ufSorted = [...uf].sort((a, b) => Number((a.badges ?? []).includes('初心者ver')) - Number((b.badges ?? []).includes('初心者ver')));
  for (const h of ufSorted) {
    const extra = h.title.normalize('NFKC').replace(baseTitle(h.title), '').trim();
    const label = [extra, ...(h.badges ?? [])].filter(Boolean).join('・');
    add(h.title, h.artist, { source: 'ufret', id: h.id, label, url: h.url });
  }
  for (const r of cwList) {
    if (!r) continue;
    add(r.s.title || r.t, r.s.artist || '', { source: 'chordwiki', id: r.t, label: '', url: r.s.url, bpm: r.s.bpm, key: r.s.key });
  }
  for (const h of unChecked) {
    if (!h) continue;
    add(h.title, h.artist, { source: 'utanet', id: h.id, label: '', url: h.url });
  }

  // ジャケット・曲の長さを付ける
  for (const g of groups) {
    if (g.artwork) continue;
    const c = cands.find((c) => norm(c.base) === norm(g.title) && sameArtist(c.artist, g.artist));
    if (c) Object.assign(g, { artwork: c.artwork, appleId: c.appleId, durationMs: c.durationMs });
  }

  // 並べ替え: iTunesの候補に一致(=実在の曲として有名) > 曲名が検索語と一致 > 曲名に含む > アーティスト一致
  const nq = norm(q);
  const words = q.split(' ').map(norm).filter(Boolean);
  const score = (g: { title: string; artist: string; appleId?: number }, idx: number) => {
    const nt = norm(g.title);
    const na = norm(g.artist);
    let s = 0;
    const ci = cands.findIndex((c) => norm(c.base) === nt && sameArtist(c.artist, g.artist));
    if (ci >= 0) s += 100 - ci * 3;
    if (nt === nq || words.some((w) => w === nt)) s += 60;
    else if (nt && (nq.includes(nt) || nt.includes(nq))) s += 30;
    if (na && (nq.includes(na) || words.some((w) => w && na.includes(w)))) s += 25;
    return s - idx * 0.01;
  };
  const ranked = groups.map((g, i) => ({ g, s: score(g, i) })).sort((a, b) => b.s - a.s).map((x) => x.g);
  const withSheets = ranked.filter((g) => g.sources.length).slice(0, 40);
  const without = ranked.filter((g) => !g.sources.length).slice(0, 3);
  const result = { q, groups: [...withSheets, ...without] };
  if (withSheets.length) await cachePut(ck, result);
  return result;
}

// ---------------------------------------------------------------- 端末

async function authDevice(req: Request) {
  const key = req.headers.get('x-hk-key');
  if (!key || key.length < 20) return null;
  const h = await sha256('hk:' + key);
  const { data } = await db.from('hikigatari_devices').select('id,name,last_seen_at').eq('key_hash', h).maybeSingle();
  if (!data) return null;
  if (Date.now() - new Date(data.last_seen_at).getTime() > 3600e3) {
    await db.from('hikigatari_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  }
  return data;
}

async function isOwned() {
  const { count } = await db.from('hikigatari_devices').select('id', { count: 'exact', head: true });
  return (count ?? 0) > 0;
}

async function newDevice(name: string) {
  const key = randomKey();
  const { data, error } = await db
    .from('hikigatari_devices')
    .insert({ key_hash: await sha256('hk:' + key), name: (name || '').slice(0, 60) })
    .select('id')
    .single();
  if (error) throw error;
  return { key, deviceId: data.id };
}

// ---------------------------------------------------------------- ライブラリ同期

// deno-lint-ignore no-explicit-any
function backupShape(d: any) {
  // バックアップ(anonから読める app_backups)には取り込んだ歌詞を載せない。自分で入力した譜面だけ残す。
  const { sheet, ...rest } = d ?? {};
  if (sheet && d.source === 'manual') return { ...rest, sheet };
  return { ...rest, sheet: sheet ? { key: sheet.key, bpm: sheet.bpm, beatsPerBar: sheet.beatsPerBar } : null };
}

async function maybeBackup() {
  const { data: last } = await db.from('app_backups').select('updated_at').eq('app', 'hikigatari').maybeSingle();
  if (last && Date.now() - new Date(last.updated_at).getTime() < 10 * 60e3) return;
  const { data } = await db.from('hikigatari_songs').select('id,data').eq('deleted', false);
  if (!data || !data.length) return; // 0件は送らない(空で上書きしない)
  await db.from('app_backups').upsert({
    app: 'hikigatari',
    data: data.map((r) => backupShape(r.data)),
    item_count: data.length,
    device: 'edge-function',
    updated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------- ルーター

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    // --- 認証なしで呼べるもの
    if (action === 'status') return json({ owned: await isOwned() });
    if (action === 'claim') {
      if (await isOwned()) return json({ error: 'すでに使い始めています。ほかの端末から6桁コードでつないでください' }, 409);
      return json(await newDevice(body.name));
    }
    if (action === 'pair_finish') {
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length !== 6) return json({ error: '6桁の数字を入れてください' }, 400);
      const nowIso = new Date().toISOString();
      const { data: codes } = await db
        .from('hikigatari_pair_codes')
        .select('id,code_hash,attempts')
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .lt('attempts', 5);
      const h = await sha256('pc:' + code);
      const hit = (codes ?? []).find((c) => c.code_hash === h);
      if (!hit) {
        for (const c of codes ?? []) await db.from('hikigatari_pair_codes').update({ attempts: c.attempts + 1 }).eq('id', c.id);
        return json({ error: 'コードが違うか、期限(10分)が切れています' }, 403);
      }
      await db.from('hikigatari_pair_codes').update({ used_at: nowIso }).eq('id', hit.id);
      return json(await newDevice(body.name));
    }

    // --- ここから先は端末の鍵が必要
    const dev = await authDevice(req);
    if (!dev) return json({ error: 'この端末はつながっていません', code: 'unpaired' }, 401);

    switch (action) {
      case 'me':
        return json({ deviceId: dev.id, name: dev.name });
      case 'pair_start': {
        const code = randomCode();
        await db.from('hikigatari_pair_codes').delete().eq('created_by', dev.id);
        const expires = new Date(Date.now() + 10 * 60e3).toISOString();
        await db.from('hikigatari_pair_codes').insert({ code_hash: await sha256('pc:' + code), created_by: dev.id, expires_at: expires });
        return json({ code, expiresAt: expires });
      }
      case 'devices': {
        const { data } = await db.from('hikigatari_devices').select('id,name,created_at,last_seen_at').order('created_at');
        return json({ devices: (data ?? []).map((d) => ({ ...d, isMe: d.id === dev.id })) });
      }
      case 'rename': {
        await db.from('hikigatari_devices').update({ name: String(body.name || '').slice(0, 60) }).eq('id', dev.id);
        return json({ ok: true });
      }
      case 'revoke': {
        await db.from('hikigatari_devices').delete().eq('id', String(body.id || ''));
        return json({ ok: true });
      }
      case 'search':
        return json(await search(String(body.q || '')));
      case 'sheet': {
        const s = await getSheet(String(body.source), String(body.id), String(body.title || ''), String(body.artist || ''), !!body.force);
        return json(s);
      }
      case 'lib_pull': {
        const since = body.since ? new Date(body.since).toISOString() : '1970-01-01T00:00:00Z';
        const serverTime = new Date().toISOString();
        const items = [];
        let from = 0;
        for (;;) {
          const { data, error } = await db
            .from('hikigatari_songs')
            .select('id,data,deleted,updated_at')
            .gt('updated_at', since)
            .order('updated_at')
            .range(from, from + 499);
          if (error) throw error;
          items.push(...(data ?? []));
          if (!data || data.length < 500) break;
          from += 500;
        }
        return json({ items, serverTime });
      }
      case 'lib_push': {
        // deno-lint-ignore no-explicit-any
        const incoming: any[] = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
        if (!incoming.length) return json({ accepted: [], newer: [] });
        const ids = incoming.map((i) => String(i.id));
        const { data: existing } = await db.from('hikigatari_songs').select('id,data,deleted,updated_at').in('id', ids);
        const exMap = new Map((existing ?? []).map((e) => [e.id, e]));
        const accept = [];
        const newer = [];
        for (const it of incoming) {
          const ex = exMap.get(String(it.id));
          const inAt = Number(it.data?.updatedAt || 0);
          const exAt = Number(ex?.data?.updatedAt || 0);
          if (ex && exAt > inAt) {
            newer.push(ex); // サーバー側の方が新しい → 端末に返して合わせてもらう
            continue;
          }
          accept.push({ id: String(it.id), data: it.data, deleted: !!it.deleted, updated_at: new Date().toISOString() });
        }
        if (accept.length) {
          const { error } = await db.from('hikigatari_songs').upsert(accept);
          if (error) throw error;
          // 応答を返したあともバックアップ処理を走らせ切る
          const p = maybeBackup().catch(() => {});
          // deno-lint-ignore no-explicit-any
          const rt = (globalThis as any).EdgeRuntime;
          if (rt?.waitUntil) rt.waitUntil(p);
          else await p;
        }
        return json({ accepted: accept.map((a) => a.id), newer });
      }
      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, status);
  }
});
