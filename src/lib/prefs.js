// 端末ごとの設定(localStorage)
import { useEffect, useState } from 'react';

const KEY = 'hk.prefs';
const PREFS_VERSION = 2;

export const DEFAULT_PREFS = {
  instrument: 'guitar', // guitar | piano
  simple: true, // ギター: かんたんコード
  inlineDiagrams: true, // ギター: 歌詞の上に押さえ方の図
  inlineStaff: true, // ピアノ: 歌詞の上に五線譜の図
  maxCapo: 7,
  noteStyle: 'solfege', // solfege(ドレミ) | letter(CDE)
  theme: 'auto', // auto | light | dark
  fontScale: 1,
  barsPerLine: 0, // 小節線の無い譜面で、歌詞1行を何小節とみなすか(0 = コード数と歌詞の長さから自動)
  countIn: true,
  click: false,
  showBars: true,
  appleCardDismissed: false,
  homeSort: 'recent', // recent | added | title
};

let state = load();
const subs = new Set();


function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // v2: 「歌詞1行の長さ」の標準を 2小節 → 自動 に変えたので、古い保存値は捨てる
    if (!saved.v || saved.v < 2) delete saved.barsPerLine;
    return { ...DEFAULT_PREFS, ...saved, v: PREFS_VERSION };
  } catch {
    return { ...DEFAULT_PREFS, v: PREFS_VERSION };
  }
}

export function getPrefs() {
  return state;
}

export function setPrefs(patch) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  applyTheme();
  subs.forEach((f) => f(state));
}

export function usePrefs() {
  const [p, setP] = useState(state);
  useEffect(() => {
    subs.add(setP);
    return () => subs.delete(setP);
  }, []);
  return [p, setPrefs];
}

export function applyTheme() {
  const t = state.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121316' : '#FBF8F3');
}
