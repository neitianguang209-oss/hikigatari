// 弾き方(ストローク・アルペジオ)の見本: ボタンを押したときだけ、譜面の上に小さく出す。
// 譜面のサイトには弾き方が書かれていないので、拍子とテンポから定番の形を選んで「おすすめ」にする。
// 曲ごとに「この曲ではこれ」を覚える(st.strum)。▶ でその曲のテンポで鳴らして、リズムを確かめられる
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { audioCtx, click } from '../lib/sound.js';
import { cx } from '../lib/util.js';
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

// その曲のテンポで、2小節くり返して鳴らす(ほかのアプリの音は止めない)
function usePatternSound(p, bpm, m) {
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(-1);
  const r = useRef({ timer: 0, next: 0, k: 0, ui: [] }).current;
  const stop = () => {
    clearInterval(r.timer);
    r.ui.forEach(clearTimeout);
    r.ui = [];
    setOn(false);
    setAt(-1);
  };
  const start = () => {
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

// 譜面の上に出す小さなカード。onClose で閉じる。chosen: 曲ごとに選んだ形の id。onChoose(id) で覚える
export function StrumCard({ instrument, beatsPerBar, bpm, chosen, onChoose, onClose }) {
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
  return html`<div className="strum-card" role="dialog" aria-label="弾き方の見本">
    <div className="strum-head">
      <button className="icon-btn strum-nav" onClick=${() => go(-1)} aria-label="前の弾き方"><${Icon} name="back" size=${18} /></button>
      <div className="strum-title">
        <b>${p.name}</b>
        <small>${p === rec ? 'おすすめ（テンポから） ・ ' : ''}${'★'.repeat(p.lv)}${'☆'.repeat(3 - p.lv)} ・ ${idx + 1}/${list.length}</small>
      </div>
      <button className="icon-btn strum-nav strum-next" onClick=${() => go(1)} aria-label="次の弾き方"><${Icon} name="back" size=${18} /></button>
      <button className="icon-btn" onClick=${() => { snd.stop(); onClose(); }} aria-label="閉じる"><${Icon} name="close" size=${18} /></button>
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
  return strumList(instrument, beatsPerBar).find((p) => p.id === chosen)?.name || '';
}
