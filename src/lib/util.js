// 小物ユーティリティ

// 表記ゆれを吸収した比較用キー(サーバー側の norm と同じ規則)
export function norm(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・,.、。!?'"’“”\-‐―~〜_()[\]【】「」『』/:;&+*×]/g, '');
}

export function baseTitle(t) {
  let s = (t || '').normalize('NFKC');
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\s*[([【「『〔][^()[\]【】「」『』〔〕]*[)\]】」』〕]\s*/g, ' ');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+[([【].*$/, '').replace(/\s+-\s+.*$/, '');
  s = s.replace(/\s+(feat\.?|ft\.|featuring)\s*\S.*$/i, ''); // 「すずめ feat.十明」→「すずめ」(Left などの語の中は消さない)
  s = s.replace(/\s*(弾き語り|ピアノ|piano|バンド|アコギ|アコースティック|acoustic|ギター|guitar|簡単|初心者|tv|full|short|ショート)?\s*(ver\.?|version|バージョン)\s*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || (t || '').trim();
}

export function sameArtist(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// 同じ曲(曲名+アーティスト)なら、どのサイトから開いても同じID
export function songIdFor(title, artist) {
  return 's_' + fnv1a(norm(baseTitle(title)) + '|' + norm(artist));
}

export function newManualId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function cx(...xs) {
  return xs.filter(Boolean).join(' ');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function sourceName(src) {
  return { ufret: 'U-FRET', chordwiki: 'ChordWiki', utanet: '歌ネット', manual: '自分で入力', ear: '耳コピ' }[src] || src || '';
}

export function formatAgo(ms) {
  if (!ms) return '';
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'たった今';
  if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}日前`;
  const dt = new Date(ms);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let d = 'この端末';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) d = 'iPad';
  else if (/iPhone/.test(ua)) d = 'iPhone';
  else if (/Android/.test(ua)) d = 'Android';
  else if (/Windows/.test(ua)) d = 'Windows PC';
  else if (/Macintosh/.test(ua)) d = 'Mac';
  let b = '';
  if (standalone) b = 'ホーム画面';
  else if (/Edg\//.test(ua)) b = 'Edge';
  else if (/CriOS|Chrome\//.test(ua)) b = 'Chrome';
  else if (/Safari\//.test(ua)) b = 'Safari';
  return b ? `${d}（${b}）` : d;
}

export function artworkUrl(url, size = 200) {
  if (!url) return '';
  return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

// 曲名から、ジャケットが無いとき用の色を決める
export function tileColor(s) {
  let h = 0;
  for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 52%)`;
}

export function downloadFile(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// 符号つきの数(+2 / −1)。マイナスは長音「ー」と見分けやすい数学記号にする
export function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}
