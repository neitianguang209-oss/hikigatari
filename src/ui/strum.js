// 弾き方(ストローク・アルペジオ)の見本: ボタンを押したときだけ、譜面の上に小さく出す。
// 譜面のサイトには弾き方が書かれていないので、拍子とテンポから定番の形を選んで「おすすめ」にする。
// 曲ごとに「この曲ではこれ」を覚える(st.strum)。▶ でその曲のテンポで鳴らして、リズムを確かめられる
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { audioCtx, click, holdPlayback, releasePlayback } from '../lib/sound.js';
import { cx } from '../lib/util.js';
import { api } from '../lib/api.js';
import { YT_FN_URL } from '../config.js';
const html = htm.bind(React.createElement);

// steps: 1小節を等しく分けたこま。'D' ダウン / 'U' アップ / 'X' ブラッシング(弦をミュートして「チャッ」) / '' 休み(手は空振り)
// アルペジオは弦の番号('B' = そのコードの根音の弦)。ピアノは 'L'(左手の根音) / 'R'(右手の和音) / 数字(和音の何番目の音)
const PATTERNS = {
  guitar: {
    4: [
      { id: 'g4-down', name: '4分のダウン', steps: ['D', 'D', 'D', 'D'], note: 'まずはこれ。拍ごとに1回、上から下へ。', lv: 1 },
      { id: 'g4-8', name: '8ビート', steps: ['D', 'U', 'D', 'U', 'D', 'U', 'D', 'U'], note: '手は止めずに上下に振りつづける。', lv: 1 },
      { id: 'g4-pop', name: '定番のストローク', steps: ['D', '', 'D', 'U', '', 'U', 'D', 'U'], note: '「ジャン・ジャカ・カ・ジャカ」。J-POP の弾き語りでいちばんよく使う形。休みのところも手は空振り。', lv: 2 },
      { id: 'g4-brush', name: 'ブラッシング入り', steps: ['D', 'U', 'X', 'U', 'D', 'U', 'X', 'U'], note: '2拍目・4拍目は左手の力をゆるめて弦をミュートし「チャッ」。ノリのいい曲に。', lv: 3 },
      { id: 'g4-arp', name: 'アルペジオ（8分）', steps: ['B', '3', '2', '3', '1', '3', '2', '3'], note: 'B = コードの根音の弦（C なら5弦、G なら6弦）。バラードやAメロに。', lv: 2, arp: true },
      { id: 'g4-ballad', name: 'ゆったりアルペジオ', steps: ['B', '3', '2', '1', '2', '3', '2', '3'], note: '上まで行って戻る。ゆっくりの曲・イントロに。', lv: 2, arp: true },
    ],
    3: [
      { id: 'g3-down', name: '3拍のダウン', steps: ['D', 'D', 'D'], note: '「ズン・チャ・チャ」の1拍目を少し強く。', lv: 1 },
      { id: 'g3-waltz', name: 'ワルツ', steps: ['D', '', 'D', 'U', 'D', 'U'], note: '1拍目はしっかり、2・3拍目は軽く。', lv: 2 },
      { id: 'g3-arp', name: 'アルペジオ（3拍子）', steps: ['B', '3', '2', '1', '2', '3'], note: 'B = コードの根音の弦。', lv: 2, arp: true },
    ],
    6: [
      { id: 'g6-six', name: '6/8 のストローク', steps: ['D', 'D', 'U', 'D', 'D', 'U'], note: '「1・2・3, 4・5・6」の1と4を強く。', lv: 2 },
      { id: 'g6-arp', name: '6/8 のアルペジオ', steps: ['B', '3', '2', '1', '2', '3'], note: 'B = コードの根音の弦。', lv: 2, arp: true },
    ],
  },
  piano: {
    4: [
      { id: 'p4-whole', name: '全部いっしょに', steps: ['R', '', '', ''], note: '左手の根音と右手の和音を、小節の頭で一緒に。のばしたまま。', lv: 1 },
      { id: 'p4-quarter', name: '4分で刻む', steps: ['LR', 'R', 'R', 'R'], note: '左手は小節の頭だけ、右手の和音を拍ごとに。', lv: 1 },
      { id: 'p4-8', name: '8ビート', steps: ['LR', 'R', 'R', 'R', 'LR', 'R', 'R', 'R'], note: '右手を8分で。左手は1拍目と3拍目。', lv: 2 },
      { id: 'p4-arp', name: 'アルペジオ', steps: ['L', '5', '8', '10', '8', '5', '8', '10'], note: '左手で 根音→5度→オクターブ→10度（3度の上）。バラードに。', lv: 3, arp: true },
    ],
    3: [
      { id: 'p3-waltz', name: 'ワルツ', steps: ['L', 'R', 'R'], note: '1拍目は左手の根音、2・3拍目は右手の和音。', lv: 1 },
      { id: 'p3-arp', name: 'アルペジオ（3拍子）', steps: ['L', '5', '8', '10', '8', '5'], note: '左手で 根音→5度→オクターブ→10度。', lv: 3, arp: true },
    ],
    6: [
      { id: 'p6-six', name: '6/8', steps: ['LR', 'R', 'R', 'LR', 'R', 'R'], note: '1と4を強く。', lv: 2 },
      { id: 'p6-arp', name: '6/8 のアルペジオ', steps: ['L', '5', '8', '10', '8', '5'], note: '左手で 根音→5度→オクターブ→10度。', lv: 3, arp: true },
    ],
  },
};

const meterOf = (bpb) => (bpb === 3 ? 3 : bpb === 6 ? 6 : 4);
export const strumList = (instrument, bpb) => PATTERNS[instrument === 'piano' ? 'piano' : 'guitar'][meterOf(bpb)];

// テンポからのおすすめ: ゆっくり(〜78)はアルペジオ、ふつうは定番、速い(140〜)は8ビート
export function recommendStrum(instrument, bpb, bpm) {
  const list = strumList(instrument, bpb);
  const by = (id) => list.find((p) => p.id === id);
  const m = meterOf(bpb);
  if (instrument === 'piano') return (m === 4 ? (bpm < 78 ? by('p4-arp') : by('p4-8')) : list[0]) || list[0];
  if (m === 4) return (bpm < 78 ? by('g4-ballad') : bpm >= 140 ? by('g4-8') : by('g4-pop')) || list[0];
  if (m === 3) return (bpm < 90 ? by('g3-arp') : by('g3-waltz')) || list[0];
  return (bpm < 70 ? by('g6-arp') : by('g6-six')) || list[0];
}

// こまの下に出す数え方(1 & 2 & …)
function counts(n, m) {
  if (m === 6) return ['1', '2', '3', '4', '5', '6'];
  const per = n / m;
  return Array.from({ length: n }, (_, i) => (i % per === 0 ? String(i / per + 1) : per === 2 ? '&' : ''));
}

const ARROW = { D: '↓', U: '↑', X: '✕' };

// その曲のテンポで、くり返して鳴らす(鳴らす間だけ「再生アプリ」扱い。iPhone のマナーモードでも聞こえる)
function usePatternSound(p, bpm, m) {
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(-1);
  const r = useRef({ timer: 0, next: 0, k: 0, ui: [], held: false }).current;
  const stop = () => {
    clearInterval(r.timer);
    if (r.held) {
      r.held = false;
      releasePlayback();
    }
    r.ui.forEach(clearTimeout);
    r.ui = [];
    setOn(false);
    setAt(-1);
  };
  const start = () => {
    if (!r.held) {
      r.held = true;
      holdPlayback();
    }
    const c = audioCtx();
    const n = p.steps.length;
    const barSec = (60 / bpm) * (m === 6 ? 3 : m); // 6/8 は 付点4分を1拍として2拍(=8分6つ)… ここでは8分=BPM の半分の長さで数える
    const stepSec = m === 6 ? 60 / bpm / 2 : barSec / n;
    r.next = c.currentTime + 0.08;
    r.k = 0;
    const tick = () => {
      while (r.next < c.currentTime + 0.15) {
        const i = r.k % n;
        const s = p.steps[i];
        if (s) {
          const strong = i === 0 || (m === 6 && i === 3);
          const vol = s === 'X' ? 0.35 : s === 'U' || /^\d/.test(s) ? 0.55 : strong ? 1 : 0.8;
          click(strong && s !== 'X', r.next, vol);
        }
        const d = Math.max(0, (r.next - c.currentTime) * 1000);
        r.ui.push(setTimeout(() => setAt(i), d));
        if (r.ui.length > 64) r.ui.splice(0, 32);
        r.next += stepSec;
        r.k++;
      }
    };
    tick();
    r.timer = setInterval(tick, 25);
    setOn(true);
  };
  useEffect(() => stop, [p.id, bpm]);
  return { on, at, toggle: () => (on ? stop() : start()), stop };
}

// ---------------------------------------------------------------- この曲の弾き方(ネットから)
// 解説ページに矢印で書かれたストローク(載せているページが多い形ほど上)と、
// 再生回数の多い解説動画(ストローク・アルペジオ)を、Edge Function(hikigatari-yt の strum_find)が集める
const webCache = new Map();
function useStrumWeb(title, artist, on) {
  const key = `${title}|${artist}`;
  const [st, setSt] = useState(() => ({ busy: false, data: webCache.get(key) || null, err: null }));
  const load = () => {
    setSt({ busy: true, data: null, err: null });
    api('strum_find', { title, artist }, { url: YT_FN_URL, timeout: 60000 })
      .then((d) => {
        webCache.set(key, d);
        setSt({ busy: false, data: d, err: null });
      })
      .catch((e) => setSt({ busy: false, data: null, err: e.message }));
  };
  useEffect(() => {
    if (on && title && !webCache.has(key)) load();
  }, [on, key]);
  return { ...st, retry: load };
}

const fmtViews = (n) => (!n ? '' : n >= 1e8 ? `${(n / 1e8).toFixed(1)}億回` : n >= 1e5 ? `${Math.round(n / 1e4)}万回` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万回` : `${n}回`);
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// 矢印の並び。空白で区切られたかたまりを1つの箱にする(多くのページは1拍ずつ空けて書いている)
function Arrows({ text }) {
  const groups = text.split(' ').filter(Boolean);
  return html`<div className="strum-arrows" aria-label=${text.replace(/↓/g, 'ダウン ').replace(/↑/g, 'アップ ').replace(/×/g, 'ミュート ')}>
    ${groups.map(
      (g, i) => html`<span key=${i} className="strum-beat">${[...g].map(
        (c, k) => html`<span key=${k} className=${cx('strum-ar', c === '↓' ? 'is-down' : c === '↑' ? 'is-up' : 'is-mute')}>${c}</span>`,
      )}</span>`,
    )}
  </div>`;
}

function SongStrum({ title, artist, chosen, onChoose }) {
  const web = useStrumWeb(title, artist, true);
  const d = web.data;
  const pats = d?.patterns || [];
  const [pi, setPi] = useState(0);
  useEffect(() => {
    const at = pats.findIndex((p) => 'web:' + p.arrows === chosen);
    if (at >= 0) setPi(at);
  }, [d]);
  const [vt, setVt] = useState('stroke');
  const [watch, setWatch] = useState(null); // 流している解説動画の id
  // 動画を流している間は「再生アプリ」扱い(iPhone のマナーモードでも聞こえる)
  useEffect(() => {
    if (!watch) return;
    holdPlayback();
    return () => releasePlayback();
  }, [watch]);
  if (web.busy) return html`<p className="strum-wait">ネットで「${title}」の弾き方を探しています…（10秒ほど）</p>`;
  if (web.err)
    return html`<div className="strum-wait">
      <p>弾き方を探せませんでした（${web.err}）</p>
      <button className="btn btn-sm" onClick=${web.retry}>もう一度</button>
    </div>`;
  if (!d) return null;
  const p = pats[pi] || null;
  const mine = p && chosen === 'web:' + p.arrows;
  const vids = (vt === 'stroke' ? d.stroke : d.arp) || [];
  return html`<div className="strum-song">
    <div className="strum-sec">ストローク（解説ページから）</div>
    ${p
      ? html`<div className="strum-pat">
          <div className="strum-pat-head">
            <b>${p.label || (pi === 0 ? 'いちばん多く載っている形' : `ほかの形 ${pi}`)}</b>
            <small>${p.src.length > 1 ? `${p.src.length}か所で同じ形` : '1か所で見つけた形'}</small>
          </div>
          <${Arrows} text=${p.arrows} />
          ${p.rhythm ? html`<div className="strum-rhythm">${p.rhythm}</div>` : null}
          <div className="strum-src">
            ${p.src.slice(0, 3).map((s, i) => html`<a key=${i} href=${s.url} target="_blank" rel="noopener">${s.name}</a>`)}
          </div>
          <div className="strum-foot">
            ${pats.length > 1
              ? pats.map(
                  (q, i) => html`<button key=${i} className=${cx('chip chip-sm', i === pi && 'is-on')} onClick=${() => setPi(i)} aria-label=${`形 ${i + 1}`}>${i === 0 ? 'いちばん多い' : `形${i + 1}`}</button>`,
                )
              : null}
            <button className=${cx('chip chip-sm', mine && 'is-on')} onClick=${() => onChoose(mine ? null : 'web:' + p.arrows)} aria-pressed=${!!mine}>${mine ? html`<${Icon} name="check" size=${14} />この曲ではこれ` : 'この曲ではこれにする'}</button>
          </div>
        </div>`
      : html`<p className="strum-note">矢印で書かれたストロークは見つかりませんでした（画像で載せているページが多いため）。下の解説動画か「定番の形」を見てください。</p>`}

    <div className="strum-sec strum-sec-row">
      <span>いちばん見られている解説動画</span>
      <span className="strum-mini-tabs">
        <button className=${cx(vt === 'stroke' && 'is-on')} onClick=${() => { setVt('stroke'); setWatch(null); }}>ストローク</button>
        <button className=${cx(vt === 'arp' && 'is-on')} onClick=${() => { setVt('arp'); setWatch(null); }}>アルペジオ</button>
      </span>
    </div>
    ${vids.length
      ? vids.map(
          (v, i) => html`<div key=${v.id} className=${cx('strum-vid', i === 0 && 'is-top')}>
            ${watch === v.id
              ? html`<div className="strum-embed">
                  <iframe src=${`https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&playsinline=1&rel=0`} title=${v.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen></iframe>
                </div>`
              : null}
            <button className="strum-vid-row" onClick=${() => setWatch(watch === v.id ? null : v.id)} aria-label=${`${v.title} を${watch === v.id ? '閉じる' : '見る'}`}>
              ${watch === v.id ? null : html`<img src=${ytThumb(v.id)} alt="" width="96" height="54" loading="lazy" />`}
              <span className="strum-vid-text">
                <b>${v.title}</b>
                <small>${[i === 0 ? `いちばん再生が多い` : '', fmtViews(v.views) && `再生 ${fmtViews(v.views)}`, v.channel].filter(Boolean).join(' ・ ')}</small>
              </span>
            </button>
          </div>`,
        )
      : html`<p className="strum-note">${vt === 'arp' ? 'アルペジオの解説動画は見つかりませんでした。' : 'ストロークの解説動画は見つかりませんでした。'}</p>`}
  </div>`;
}

// 譜面の上に出す小さなカード。onClose で閉じる。chosen: 曲ごとに選んだ形(定番の形は id、ネットの形は 'web:矢印')。onChoose で覚える
// ギターは「この曲の弾き方」(ネットから)と「定番の形」(拍子とテンポから)。ピアノは定番の形だけ
export function StrumCard({ instrument, beatsPerBar, bpm, chosen, onChoose, onClose, title = '', artist = '' }) {
  const guitar = instrument !== 'piano';
  const [tab, setTab] = useState(guitar && title ? 'song' : 'basic');
  return html`<div className="strum-card" role="dialog" aria-label="弾き方の見本">
    <div className="strum-top">
      ${guitar && title
        ? html`<div className="strum-tabs" role="tablist">
            <button role="tab" aria-selected=${tab === 'song'} className=${cx(tab === 'song' && 'is-on')} onClick=${() => setTab('song')}>この曲の弾き方</button>
            <button role="tab" aria-selected=${tab === 'basic'} className=${cx(tab === 'basic' && 'is-on')} onClick=${() => setTab('basic')}>定番の形</button>
          </div>`
        : html`<b className="strum-top-title">弾き方の見本</b>`}
      <button className="icon-btn" onClick=${onClose} aria-label="閉じる"><${Icon} name="close" size=${18} /></button>
    </div>
    ${tab === 'song'
      ? html`<${SongStrum} title=${title} artist=${artist} chosen=${chosen} onChoose=${onChoose} />`
      : html`<${BasicStrum} instrument=${instrument} beatsPerBar=${beatsPerBar} bpm=${bpm} chosen=${chosen} onChoose=${onChoose} />`}
  </div>`;
}

// 定番の形(拍子とテンポからのおすすめ)。▶ でその曲のテンポで鳴らせる
function BasicStrum({ instrument, beatsPerBar, bpm, chosen, onChoose }) {
  const list = strumList(instrument, beatsPerBar);
  const rec = recommendStrum(instrument, beatsPerBar, bpm);
  const first = list.find((p) => p.id === chosen) || rec;
  const [idx, setIdx] = useState(() => Math.max(0, list.indexOf(first)));
  const p = list[idx] || list[0];
  const m = meterOf(beatsPerBar);
  const snd = usePatternSound(p, bpm, m);
  const cnt = counts(p.steps.length, m);
  const go = (d) => setIdx((i) => (i + d + list.length) % list.length);
  const mine = chosen === p.id;
  return html`<div>
    <div className="strum-head">
      <button className="icon-btn strum-nav" onClick=${() => go(-1)} aria-label="前の弾き方"><${Icon} name="back" size=${18} /></button>
      <div className="strum-title">
        <b>${p.name}</b>
        <small>${p === rec ? 'おすすめ（テンポから） ・ ' : ''}${'★'.repeat(p.lv)}${'☆'.repeat(3 - p.lv)} ・ ${idx + 1}/${list.length}</small>
      </div>
      <button className="icon-btn strum-nav strum-next" onClick=${() => go(1)} aria-label="次の弾き方"><${Icon} name="back" size=${18} /></button>
    </div>
    <div className=${cx('strum-steps', p.arp && 'is-arp')} style=${{ '--n': p.steps.length }}>
      ${p.steps.map(
        (s, i) => html`<div key=${i} className=${cx('strum-step', !s && 'is-rest', snd.at === i && 'is-now', s === 'X' && 'is-mute')}>
          <span className="strum-mark">${s ? ARROW[s] || s : '・'}</span>
          <span className="strum-count">${cnt[i]}</span>
        </div>`,
      )}
    </div>
    <p className="strum-note">${p.note}</p>
    <div className="strum-foot">
      <button className=${cx('chip chip-sm', snd.on && 'is-on')} onClick=${snd.toggle} aria-label=${snd.on ? '止める' : `♩=${bpm} で鳴らす`}><${PlayIcon} playing=${snd.on} size=${14} />♩=${bpm}</button>
      <button className=${cx('chip chip-sm', mine && 'is-on')} onClick=${() => onChoose(mine ? null : p.id)} aria-pressed=${mine}>${mine ? html`<${Icon} name="check" size=${14} />この曲ではこれ` : 'この曲ではこれにする'}</button>
    </div>
  </div>`;
}

// ボタンに出す短い名前
export function strumLabel(instrument, beatsPerBar, chosen) {
  if (chosen?.startsWith('web:')) return chosen.slice(4);
  return strumList(instrument, beatsPerBar).find((p) => p.id === chosen)?.name || '';
}
