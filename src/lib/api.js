// Edge Function 呼び出し
import { FN_URL } from '../config.js';

const KEY = 'hk.key';

export const deviceKey = {
  get() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(k) {
    try {
      localStorage.setItem(KEY, k);
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  },
};

const listeners = new Set();
export function onUnpaired(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api(action, payload = {}, { timeout = 30000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  const key = deviceKey.get();
  if (key) headers['x-hk-key'] = key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(FN_URL, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error || `通信エラー (${r.status})`);
      err.status = r.status;
      err.code = j.code;
      if (j.code === 'unpaired') listeners.forEach((f) => f());
      throw err;
    }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('時間がかかりすぎたので中断しました');
      err.status = 0;
      throw err;
    }
    if (e.status === undefined) {
      const err = new Error(navigator.onLine ? 'サーバーにつながりませんでした' : 'オフラインです');
      err.status = 0;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Apple Music の共有URL → 曲名・アーティスト(iTunes Lookup は CORS 可)
export async function lookupAppleMusic(url) {
  let id = null;
  try {
    const u = new URL(url);
    id = u.searchParams.get('i');
    if (!id) {
      const m = u.pathname.match(/\/song\/[^/]*\/(\d+)|\/song\/(\d+)/);
      if (m) id = m[1] || m[2];
    }
    if (!id) {
      // アルバムURLだけのときはURLの曲名部分を使う
      const seg = u.pathname.split('/').filter(Boolean);
      const name = decodeURIComponent(seg[seg.length - 2] || '').replace(/-/g, ' ');
      return name ? { title: name, artist: '' } : null;
    }
  } catch {
    return null;
  }
  const r = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=jp&lang=ja_jp`);
  const j = await r.json();
  const x = (j.results || [])[0];
  return x ? { title: x.trackName, artist: x.artistName, artwork: x.artworkUrl100, appleId: x.trackId, durationMs: x.trackTimeMillis } : null;
}
