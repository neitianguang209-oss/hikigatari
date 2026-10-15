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

// url: 本体とは別の Edge Function を呼ぶとき(動画を探す hikigatari-yt)。signal: 外から打ち切るとき
export async function api(action, payload = {}, { timeout = 30000, url = FN_URL, signal = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  const key = deviceKey.get();
  if (key) headers['x-hk-key'] = key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const outer = () => ctrl.abort();
  signal?.addEventListener('abort', outer);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }), signal: ctrl.signal });
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
    signal?.removeEventListener('abort', outer);
  }
}

// つながりにくいときも、あきらめずに何回か問い合わせる(検索など)。
// ・時間切れ・つながらない(status 0)ときだけやり直す(サーバーが「無い」と答えたときはそのまま)
// ・iPhone・iPad はアプリを裏にすると通信が止まったままになることがあるので、表に戻ったら待たずにやり直す
// ・オフラインなら、つながるまで待ってから
// onRetry(n): n 回めのやり直しを始めるとき
export async function apiRetry(action, payload = {}, { tries = 3, timeout = 20000, onRetry = null, url } = {}) {
  let last = null;
  for (let n = 0; n < tries; n++) {
    if (n > 0) onRetry?.(n);
    if (!navigator.onLine) await waitOnline(15000);
    const ctrl = new AbortController();
    let hidden = document.visibilityState === 'hidden';
    const onVis = () => {
      if (document.visibilityState === 'hidden') hidden = true;
      else if (hidden) ctrl.abort(); // 裏から戻ってきた: いまの問い合わせは止まっているかもしれないので、すぐ出し直す
    };
    document.addEventListener('visibilitychange', onVis);
    try {
      return await api(action, payload, { timeout: timeout + n * 5000, signal: ctrl.signal, ...(url ? { url } : {}) });
    } catch (e) {
      last = e;
      if (e.status !== 0) throw e;
      if (n < tries - 1 && !ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 800 * (n + 1)));
    } finally {
      document.removeEventListener('visibilitychange', onVis);
    }
  }
  throw last;
}

function waitOnline(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      window.removeEventListener('online', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    window.addEventListener('online', done);
  });
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
