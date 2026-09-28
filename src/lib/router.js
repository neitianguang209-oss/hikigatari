// ハッシュルーター(#/song/xxx など)。GitHub Pages のサブパスでも壊れない
import { useEffect, useState } from 'react';

export function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function useRoute() {
  const [r, setR] = useState(parseHash);
  useEffect(() => {
    const f = () => setR(parseHash());
    window.addEventListener('hashchange', f);
    window.addEventListener('popstate', f);
    return () => {
      window.removeEventListener('hashchange', f);
      window.removeEventListener('popstate', f);
    };
  }, []);
  return r;
}

// history.state.hk に「アプリ内で何画面進んだか」を持たせ、戻るボタンでアプリの外に出ないようにする
const depth = () => (history.state && history.state.hk) || 0;

export function go(path, { replace = false } = {}) {
  const url = '#' + path;
  if (replace) history.replaceState({ hk: depth() }, '', url);
  else history.pushState({ hk: depth() + 1 }, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function back(fallback = '/') {
  if (depth() > 0) history.back();
  else go(fallback, { replace: true });
}
