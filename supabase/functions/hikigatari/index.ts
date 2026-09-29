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
  s = s.replace(/\s+(feat\.?|ft\.|featuring)\s*\S.*$/i, ''); // 「すずめ feat.十明」→「すずめ」(Left などの語の中は消さない)
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

type Hit = { source: string; id: string; title: string; artist: string; badges?: string[]; url: string; crown?: number };

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

// sort=4 は歌ネットの「人気順」(歌詞の閲覧数)。同じ曲名の曲を人気順に並べる手がかりにもする。
// Bselect=4(曲名が完全に一致)で探し、無ければ部分一致(Bselect=3)で探し直す
async function utanetSearch(title: string): Promise<Hit[]> {
  const exact = await utanetList(title, 4);
  return exact.length ? exact : await utanetList(title, 3);
}

async function utanetList(title: string, bselect: number): Promise<Hit[]> {
  const html = await get(
    `https://www.uta-net.com/search/?Keyword=${encodeURIComponent(title)}&Aselect=2&Bselect=${bselect}&sort=4`,
  );
  const out: Hit[] = [];
  const re = /<a href="\/song\/(\d+)\/"[^>]*>\s*<span class="fw-bold songlist-title">([\s\S]*?)<\/span>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const artist = m[3].match(/utaidashi">([\s\S]*?)<\/span>/)?.[1] ?? '';
    const c = m[3].match(/crown_(million|platinum|gold)/)?.[1];
    out.push({
      source: 'utanet',
      id: m[1],
      title: stripTags(m[2]).trim(),
      artist: stripTags(artist).trim(),
      url: `https://www.uta-net.com/chord/${m[1]}/`,
      crown: c === 'million' ? 3 : c === 'platinum' ? 2 : c === 'gold' ? 1 : 0,
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

// 応答を待たせずに裏で走らせ切る(キャッシュの書き込みなど)
function bg(p: Promise<unknown>) {
  const q = p.catch(() => {});
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(q);
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
  bg(cachePut(ck, r));
  return r;
}

// ---------------------------------------------------------------- ひらがな・カタカナ入力の変換

const KANA_RE = /^[ぁ-ゖァ-ヺー・゛゜]+$/;
const toHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const toKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// 照合用: norm に加えてカタカナをひらがなにそろえる(「ハナタバ」と「はなたば」を同じに扱う)
function fold(s: string) {
  return toHira(norm(s));
}

const imeCache = new Map<string, string[]>();
// Google日本語入力の変換候補(「はなたば」→「花束」、「ばっくなんばー」→「back number」)
async function imeCandidates(word: string): Promise<string[]> {
  const hira = toHira(word);
  if (imeCache.has(hira)) return imeCache.get(hira)!;
  try {
    const r = await fetch(
      `https://inputtools.google.com/request?text=${encodeURIComponent(hira)}&itc=ja-t-ja-hira-i0-und&num=6`,
      { signal: AbortSignal.timeout(3000) },
    );
    const j = await r.json();
    const list: string[] = j?.[0] === 'SUCCESS' ? j[1]?.[0]?.[1] ?? [] : [];
    imeCache.set(hira, list);
    return list;
  } catch {
    return [];
  }
}

type Word = { raw: string; forms: string[]; alts: string[] };

// 検索語を単語に分け、かなの単語には漢字・英字の候補を足す
async function understand(q: string): Promise<Word[]> {
  const raws = q.split(' ').filter(Boolean).slice(0, 6);
  return await Promise.all(
    raws.map(async (raw) => {
      const forms = new Set([raw, toHira(raw), toKata(raw)]);
      let alts: string[] = [];
      if (KANA_RE.test(raw) && raw.length >= 2) {
        const cands = await imeCandidates(raw);
        cands.forEach((c) => forms.add(c));
        // 漢字・英字になっている候補を優先(かなのままの候補は照合用には残す)
        alts = cands.filter((c) => !KANA_RE.test(c.replace(/\s/g, '')) && !/^[｡-ﾟ]+$/.test(c));
        if (!alts.length && cands[0] && cands[0] !== raw) alts = [cands[0]];
      }
      return { raw, forms: [...forms].filter(Boolean), alts };
    }),
  );
}

function formHit(forms: string[], text: string) {
  const t = fold(text);
  if (!t) return false;
  return forms.some((f) => {
    const nf = fold(f);
    return nf && (t.includes(nf) || (nf.length >= 4 && nf.includes(t) && t.length >= 3));
  });
}

// ---------------------------------------------------------------- 横断検索

async function search(qRaw: string) {
  const q = qRaw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!q) return { groups: [] };
  const ck = 'search3:' + fold(q);
  const cached = await cacheGet(ck, SEARCH_TTL_MS);
  if (cached) return cached;

  // 曲名で引くサイトの問い合わせは同じ曲名で2度しないよう覚えておく(先に始めた分をあとで使い回す)
  const unMemo = new Map<string, Promise<Hit[]>>();
  const unFor = (t: string) => {
    if (!unMemo.has(t)) unMemo.set(t, utanetSearch(t).catch(() => [] as Hit[]));
    return unMemo.get(t)!;
  };
  // deno-lint-ignore no-explicit-any
  const cwMemo = new Map<string, Promise<any>>();
  const cwFor = (t: string) => {
    if (!cwMemo.has(t)) {
      cwMemo.set(t, getSheet('chordwiki', t, t, '', false, false).then((s) => ({ t, s })).catch(() => null));
    }
    return cwMemo.get(t)!;
  };
  // 1語で、かなだけではない検索語(「花束」「Lemon」など)は、そのまま曲名とみなして先に引き始める
  if (!q.includes(' ') && !KANA_RE.test(q)) {
    unFor(q);
    cwFor(q);
  }

  // 1) 単語ごとの候補(かな→漢字・英字)・U-FRET・iTunes(そのまま)を同時に引く
  const itRawP = itunes(q).catch(() => [] as Cand[]);
  const [words, ufRaw] = await Promise.all([understand(q), ufretSearch(q).catch(() => [] as Hit[])]);

  // 2) かなを変換したときだけ、iTunes を「変換後」「変換の第2候補」でも引く
  const itQueries: string[] = [];
  const conv = words.map((w) => w.alts[0] || w.raw).join(' ');
  if (fold(conv) !== fold(q)) itQueries.push(conv);
  const amb = words.findIndex((w) => w.alts.length >= 2);
  if (amb >= 0) itQueries.push(words.map((w, i) => (i === amb ? w.alts[1] : w.alts[0] || w.raw)).join(' '));
  const itLists = await Promise.all([itRawP, ...itQueries.map((x) => itunes(x).catch(() => [] as Cand[]))]);

  // 検索語の単語がいくつ曲名・アーティスト名に当たるか
  const rel = (title: string, artist: string) => {
    let matched = 0;
    let inTitle = 0;
    let exactTitle = false;
    for (const w of words) {
      const t = formHit(w.forms, title);
      const a = formHit(w.forms, artist);
      if (t || a) matched++;
      if (t) inTitle++;
      if (w.forms.some((f) => fold(f) === fold(baseTitle(title)))) exactTitle = true;
    }
    return { matched, all: matched === words.length, inTitle, exactTitle };
  };

  // iTunes の候補をまとめ、検索語によく当たるものを前に
  const candMap = new Map<string, Cand & { order: number }>();
  itLists.forEach((list, li) =>
    list.forEach((c, i) => {
      const k = fold(c.base) + '|' + fold(c.artist);
      const order = li * 0.5 + i;
      const cur = candMap.get(k);
      if (!cur || cur.order > order) candMap.set(k, { ...c, order });
    })
  );
  const cands = [...candMap.values()]
    .map((c) => ({ c, r: rel(c.base, c.artist) }))
    .sort((a, b) => Number(b.r.all) - Number(a.r.all) || b.r.matched - a.r.matched || a.c.order - b.c.order)
    .map((x) => x.c);
  const good = cands.filter((c) => rel(c.base, c.artist).all);

  // 3) 曲名で引くサイト(歌ネット/ChordWiki)に当てる曲名
  const titles: string[] = [];
  for (const c of (good.length ? good : cands).slice(0, 6)) if (!titles.some((t) => fold(t) === fold(c.base))) titles.push(c.base);
  if (!titles.length) {
    // iTunes で何も出ない曲: 変換後の語をそのまま曲名とみなす
    const t = words.map((w) => w.alts[0] || w.raw).join(' ');
    titles.push(baseTitle(t));
  }
  const probeTitles = titles.slice(0, 3);
  const candArtists = (good.length ? good : cands).slice(0, 8).map((c) => c.artist);

  // U-FRET: 上位候補は「曲名 アーティスト」でも引き直す(かなの入力や短い曲名で埋もれるのを防ぐ)
  const ufQueries = (good.length ? good : cands)
    .slice(0, 2)
    .filter((c) => !ufRaw.some((h) => fold(baseTitle(h.title)) === fold(c.base) && sameArtist(h.artist, c.artist)))
    .map((c) => `${c.base} ${c.artist}`);
  if (fold(conv) !== fold(q)) ufQueries.push(conv);
  if (!cands.length && !ufRaw.length && fold(probeTitles[0]) !== fold(q)) ufQueries.push(probeTitles[0]);

  const [unLists, cwList, ufExtra] = await Promise.all([
    Promise.all(probeTitles.map(unFor)),
    Promise.all(probeTitles.map(cwFor)),
    Promise.all([...new Set(ufQueries)].slice(0, 3).map((x) => ufretSearch(x).catch(() => [] as Hit[]))),
  ]);
  const uf = [...ufRaw];
  for (const list of ufExtra) for (const h of list) if (!uf.some((u) => u.id === h.id)) uf.push(h);

  // 人気度: 歌ネットの人気順リストでの順位(同じ曲名の中での並び)と、閲覧数の王冠
  const pop = new Map<string, number>();
  for (const list of unLists) {
    list.forEach((h, i) => {
      const k = fold(baseTitle(h.title)) + '|' + fold(h.artist);
      const p = Math.max(0, 60 - i * 3) + [0, 8, 16, 26][h.crown ?? 0];
      if (!pop.has(k) || pop.get(k)! < p) pop.set(k, p);
    });
  }
  const popOf = (title: string, artist: string) => {
    const t = fold(baseTitle(title));
    for (const [k, v] of pop) {
      const [kt, ka] = k.split('|');
      if (kt === t && sameArtist(ka, artist)) return v;
    }
    return 0;
  };

  // 歌ネット: 候補アーティストに合うもの(無ければ人気上位)を実際に開いてコード譜の有無を確かめる
  const unHits: Hit[] = [];
  const unSeen = new Set<string>();
  for (const list of unLists) {
    const filtered = candArtists.length ? list.filter((h) => candArtists.some((a) => sameArtist(a, h.artist))) : list;
    for (const h of (filtered.length ? filtered : list).slice(0, 6)) if (!unSeen.has(h.id)) (unSeen.add(h.id), unHits.push(h));
  }
  const unChecked = await Promise.all(
    unHits.slice(0, 4).map((h) =>
      getSheet('utanet', h.id, h.title, h.artist, false, false)
        .then(() => h)
        .catch(() => null)
    ),
  );

  // ---- グループ化: 曲名(版表記を除く)+アーティストで束ねる
  // deno-lint-ignore no-explicit-any
  const groups: any[] = [];
  const find = (title: string, artist: string) =>
    groups.find((g) => fold(g.title) === fold(baseTitle(title)) && (sameArtist(g.artist, artist) || !g.artist || !artist));
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
  for (const c of cands.slice(0, 12)) {
    if (!groups.some((g) => fold(g.title) === fold(c.base) && sameArtist(g.artist, c.artist))) {
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
  for (const g of groups) {
    if (g.artwork) continue;
    const c = cands.find((c) => fold(c.base) === fold(g.title) && sameArtist(c.artist, g.artist));
    if (c) Object.assign(g, { artwork: c.artwork, appleId: c.appleId, durationMs: c.durationMs });
  }

  // ---- 並べ替え: 検索語に全部当たる曲 > 曲名が一致 > 人気(歌ネットの人気順・王冠) > iTunesの順
  const score = (g: { title: string; artist: string }, idx: number) => {
    const r = rel(g.title, g.artist);
    // 検索語に当たる語が1つ多いほうが、人気だけの曲より必ず上(1語=100点 > 人気の最大86+24点)
    let s = r.all ? 300 : r.matched * 100;
    if (r.exactTitle) s += 50;
    else if (r.inTitle) s += 20;
    s += popOf(g.title, g.artist);
    const ci = cands.findIndex((c) => fold(c.base) === fold(g.title) && sameArtist(c.artist, g.artist));
    if (ci >= 0) s += Math.max(0, 24 - ci * 2);
    return s - idx * 0.01;
  };
  const ranked = groups.map((g, i) => ({ g, s: score(g, i) })).sort((a, b) => b.s - a.s).map((x) => x.g);
  const withSheets = ranked.filter((g) => g.sources.length).slice(0, 40);
  const without = ranked.filter((g) => !g.sources.length && rel(g.title, g.artist).all).slice(0, 3);
  const result = { q, groups: [...withSheets, ...without], understood: fold(conv) !== fold(q) ? conv : null };
  if (withSheets.length) bg(cachePut(ck, result));
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

// ---- つなぐための固定の6桁(設定で確認・変更できる)
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60e3;

async function pinRow() {
  const { data } = await db.from('hikigatari_pin').select('pin,failed,locked_until,updated_at').eq('id', 1).maybeSingle();
  return data;
}

// まだ決まっていなければ、はじめて見るときにランダムで作る
async function ensurePin() {
  const row = await pinRow();
  if (row) return row;
  const pin = randomCode();
  await db.from('hikigatari_pin').upsert({ id: 1, pin, failed: 0, locked_until: null, updated_at: new Date().toISOString() });
  return { pin, failed: 0, locked_until: null, updated_at: new Date().toISOString() };
}

function weakPin(pin: string) {
  return /^(\d)\1{5}$/.test(pin) || '01234567890'.includes(pin) || '09876543210'.includes(pin);
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
  // バックアップ(anonから読める app_backups)には取り込んだ歌詞を載せない。自分で入力した譜面・耳コピの下書き(歌詞なし)だけ残す。
  const { sheet, ...rest } = d ?? {};
  if (sheet && (d.source === 'manual' || d.source === 'ear')) return { ...rest, sheet };
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
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const row = await pinRow();
      if (row?.locked_until && new Date(row.locked_until).getTime() > now) {
        const min = Math.ceil((new Date(row.locked_until).getTime() - now) / 60e3);
        return json({ error: `まちがいが続いたので、あと${min}分ほどつなげません` }, 429);
      }
      // 設定画面の固定の6桁
      if (row && code === row.pin) {
        if (row.failed) await db.from('hikigatari_pin').update({ failed: 0 }).eq('id', 1);
        return json(await newDevice(body.name));
      }
      // 以前の「10分だけ使える数字」もまだ受け付ける
      const { data: codes } = await db
        .from('hikigatari_pair_codes')
        .select('id,code_hash,attempts')
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .lt('attempts', 5);
      const h = await sha256('pc:' + code);
      const hit = (codes ?? []).find((c) => c.code_hash === h);
      if (hit) {
        await db.from('hikigatari_pair_codes').update({ used_at: nowIso }).eq('id', hit.id);
        return json(await newDevice(body.name));
      }
      for (const c of codes ?? []) await db.from('hikigatari_pair_codes').update({ attempts: c.attempts + 1 }).eq('id', c.id);
      // まちがいを数え、続いたらしばらく受け付けない(総当たり対策)
      if (row) {
        const failed = (row.failed || 0) + 1;
        const lock = failed >= PIN_MAX_FAILS;
        await db
          .from('hikigatari_pin')
          .update({ failed: lock ? 0 : failed, locked_until: lock ? new Date(now + PIN_LOCK_MS).toISOString() : row.locked_until })
          .eq('id', 1);
        if (lock) return json({ error: 'まちがいが5回続いたので、15分ほどつなげません' }, 429);
        return json({ error: `数字が違います（あと${PIN_MAX_FAILS - failed}回まちがえると15分つなげなくなります）` }, 403);
      }
      return json({ error: '数字が違います' }, 403);
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
      case 'pin_get': {
        const row = await ensurePin();
        return json({ pin: row.pin, updatedAt: row.updated_at });
      }
      case 'pin_set': {
        const pin = String(body.pin || '').replace(/\D/g, '');
        if (pin.length !== 6) return json({ error: '6桁の数字にしてください' }, 400);
        if (weakPin(pin)) return json({ error: '同じ数字だけ・連番は当てられやすいので使えません' }, 400);
        await db.from('hikigatari_pin').upsert({ id: 1, pin, failed: 0, locked_until: null, updated_at: new Date().toISOString() });
        return json({ ok: true });
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
