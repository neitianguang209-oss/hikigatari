// 端末ごとの設定(localStorage)
import { useEffect, useState } from 'react';

const KEY = 'hk.prefs';
const PREFS_VERSION = 3;

export const DEFAULT_PREFS = {
  instrument: 'guitar', // guitar | piano
  easy: false, // ギター: かんたんモード(オフ = 教本どおりの押さえ方。はじめて開く曲に使う)
  inlineDiagrams: true, // ギター: 歌詞の上に押さえ方の図
  inlineStaff: true, // ピアノ: 歌詞の上に五線譜の図
  voicingPick: {}, // ギター: 「いつもこの形」で選んだ押さえ方(コード名 → フレット)
  maxCapo: 7,
  noteStyle: 'solfege', // solfege(ドレミ) | letter(CDE)
  theme: 'auto', // auto | light | dark
  fontScale: 1,
  barsPerLine: 0, // 小節線の無い譜面で、歌詞1行を何小節とみなすか(0 = コード数と歌詞の長さから自動)
  countIn: true,
  click: false,
  clickVolume: 1, // クリック音の大きさ(0.6 / 1 / 1.5)
  showBars: true,
  showCurrent: true, // 流しているあいだ、今の行に色を付ける
  tapToTurn: true, // 譜面の何も無いところを押すと、画面を下へ送る
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
    // v3: 「かんたんコード」(標準オン)を「かんたんモード」(標準オフ)に作り替えたので、古い値は捨てる
    delete saved.simple;
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
