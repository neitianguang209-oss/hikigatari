// コードの図: ギターの押さえ方(横向き・SVG) / ピアノの五線譜(SVG) / ピアノの鍵盤(SVG)
import React, { memo } from 'react';
import htm from 'htm';
import { guitarVoicings } from '../music/guitar.js';
import { staffNotes } from '../music/piano.js';
import { noteName, solfege } from '../music/chord.js';
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------- ギター(横向き)
// 上が1弦・下が6弦、左端がナット。開放弦○とミュート×はナットの左に置く(U-FRET などと同じ向き)

export const GuitarDiagram = memo(function GuitarDiagram({ voicing, width = 120, fingers = true, compact = false }) {
  if (!voicing) return html`<div className="gd-none" style=${{ width }}>図なし</div>`;
  const v = voicing;
  const W = 100;
  const H = compact ? 72 : 74;
  const left = compact ? 15 : 14;
  const right = 3;
  const top = 5;
  const bottom = compact ? 11 : 12;
  const cols = compact ? 4 : 5;
  const fretW = (W - left - right) / cols;
  const gap = (H - top - bottom) / 5;
  const start = v.maxF <= cols ? 1 : v.minF;
  const yOf = (s) => top + (5 - s) * gap; // s: 0=6弦 … 5=1弦
  const xOf = (f) => left + (f - start + 0.5) * fretW;
  const r = compact ? 4.6 : 4.1;
  const parts = [];
  for (let k = 0; k <= cols; k++) {
    const x = left + k * fretW;
    parts.push(html`<line key=${'f' + k} x1=${x} x2=${x} y1=${yOf(5)} y2=${yOf(0)} className=${k === 0 && start === 1 ? 'gd-nut' : 'gd-fret'} />`);
  }
  for (let s = 0; s < 6; s++) parts.push(html`<line key=${'s' + s} x1=${left} x2=${W - right} y1=${yOf(s)} y2=${yOf(s)} className="gd-string" />`);
  if (start > 1)
    parts.push(html`<text key="fr" x=${xOf(start)} y=${H - 1.5} className="gd-frlabel" textAnchor="middle">${start}</text>`);
  v.frets.forEach((f, s) => {
    const x = left - (compact ? 7 : 6.5);
    const y = yOf(s);
    const m = compact ? 3.2 : 2.8;
    if (f === 0) parts.push(html`<circle key=${'o' + s} cx=${x} cy=${y} r=${m} className="gd-open" />`);
    else if (f < 0) parts.push(html`<path key=${'x' + s} d=${`M${x - m} ${y - m}L${x + m} ${y + m}M${x + m} ${y - m}L${x - m} ${y + m}`} className="gd-mute" />`);
  });
  if (v.barre) {
    const x = xOf(v.barre.fret);
    const y1 = yOf(v.barre.to);
    const y2 = yOf(v.barre.from);
    parts.push(html`<rect key="barre" x=${x - r} y=${y1 - r} width=${r * 2} height=${y2 - y1 + r * 2} rx=${r} className="gd-dot" />`);
  }
  v.frets.forEach((f, s) => {
    if (f <= 0) return;
    const inBarre = v.barre && f === v.barre.fret && s >= v.barre.from && s <= v.barre.to;
    if (!inBarre) parts.push(html`<circle key=${'d' + s} cx=${xOf(f)} cy=${yOf(s)} r=${r} className="gd-dot" />`);
    const fg = v.fingers[s];
    if (fingers && !compact && fg && (!inBarre || s === v.barre.to))
      parts.push(html`<text key=${'n' + s} x=${xOf(f)} y=${yOf(s) + 2.5} className="gd-finger" textAnchor="middle">${fg}</text>`);
  });
  return html`<svg className=${'gdiagram' + (compact ? ' is-compact' : '')} width=${width} height=${(width * H) / W} viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="押さえ方の図">${parts}</svg>`;
});

// 「いつもこの押さえ方」で選んだ形(フレットを","でつないだ文字列)があればそれ、無ければいちばんやさしい形
export function chosenVoicing(name, pick) {
  const vs = guitarVoicings(name);
  return (pick && vs.find((v) => v.frets.join(',') === pick)) || vs[0];
}

export function GuitarChordCard({ name, label, onClick, active, pick }) {
  return html`<button className=${'chord-card' + (active ? ' is-active' : '')} onClick=${onClick}>
    <span className="chord-card-name">${label}</span>
    <${GuitarDiagram} voicing=${chosenVoicing(name, pick)} width=${76} fingers=${false} compact=${true} />
  </button>`;
}

// ---------------------------------------------------------------- ピアノ(五線譜)
// ト音記号の五線に、右手の和音を全音符で重ねて書く(臨時記号つき)

const ACC = { 1: '♯', '-1': '♭', 2: '𝄪', '-2': '♭♭' };

export const StaffDiagram = memo(function StaffDiagram({ name, width = 64, big = false }) {
  const notes = staffNotes(name);
  if (!notes) return html`<div className="gd-none" style=${{ width }}>—</div>`;
  const W = 42;
  const H = 44;
  const topLine = 10;
  const half = 3; // 線と間の1段ぶん
  const bottomLine = topLine + half * 8; // E4
  const yOf = (step) => bottomLine - (step - 30) * half;
  const noteX = 26;
  const parts = [];
  for (let i = 0; i < 5; i++) parts.push(html`<line key=${'l' + i} x1=${1.5} x2=${W - 1.5} y1=${topLine + i * half * 2} y2=${topLine + i * half * 2} className="st-line" />`);
  parts.push(html`<line key="bar" x1=${1.5} x2=${1.5} y1=${topLine} y2=${bottomLine} className="st-line" />`);
  // 2度でぶつかる音は右にずらす
  const sorted = [...notes].sort((a, b) => a.step - b.step);
  let prev = null;
  const placed = sorted.map((n) => {
    const shift = prev && n.step - prev.step === 1 && !prev.shift;
    const p = { ...n, x: noteX + (shift ? 7.2 : 0), shift };
    prev = p;
    return p;
  });
  // 加線
  for (const n of placed) {
    const lines = [];
    if (n.step <= 28) for (let s = 28; s >= n.step; s -= 2) lines.push(s);
    if (n.step >= 40) for (let s = 40; s <= n.step; s += 2) lines.push(s);
    for (const s of lines) parts.push(html`<line key=${'lg' + n.step + '-' + s} x1=${n.x - 6} x2=${n.x + 6} y1=${yOf(s)} y2=${yOf(s)} className="st-line" />`);
  }
  // 臨時記号(近い音どうしは左にずらして重ならないように)
  let accCol = 0;
  let lastAccStep = -99;
  for (const n of placed.filter((n) => n.acc).sort((a, b) => b.step - a.step)) {
    accCol = lastAccStep - n.step < 6 ? accCol + 1 : 0;
    lastAccStep = n.step;
    parts.push(html`<text key=${'a' + n.step} x=${noteX - 9.5 - accCol * 6.5} y=${yOf(n.step) + 3.6} className="st-acc" textAnchor="middle">${ACC[n.acc] || ''}</text>`);
  }
  for (const n of placed)
    parts.push(html`<ellipse key=${'n' + n.step} cx=${n.x} cy=${yOf(n.step)} rx="3.7" ry="2.7" transform=${`rotate(-18 ${n.x} ${yOf(n.step)})`} className="st-note" />`);
  return html`<svg className=${'staff' + (big ? ' is-big' : '')} width=${width} height=${(width * H) / W} viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="五線譜の図">${parts}</svg>`;
});

export function PianoChordCard({ name, label, onClick }) {
  return html`<button className="chord-card" onClick=${onClick}>
    <span className="chord-card-name">${label}</span>
    <${StaffDiagram} name=${name} width=${58} />
  </button>`;
}

// ---------------------------------------------------------------- ピアノ(鍵盤)

const BLACK = new Set([1, 3, 6, 8, 10]);

export const PianoKeyboard = memo(function PianoKeyboard({ right = [], left = null, from = 48, to = 83, noteStyle = 'solfege', flat = false, nameOf = null }) {
  const WW = 10;
  const WH = 48;
  const BW = 6.2;
  const BH = 30;
  const whites = [];
  const blacks = [];
  let x = 0;
  for (let m = from; m <= to; m++) {
    if (BLACK.has(m % 12)) blacks.push({ m, x: x - BW / 2 });
    else {
      whites.push({ m, x });
      x += WW;
    }
  }
  const width = x;
  const rightSet = new Set(right);
  const label = (m) => (nameOf ? nameOf(m) : noteStyle === 'letter' ? noteName(m, flat).replace('#', '♯').replace(/^([A-G])b/, '$1♭') : solfege(m, flat));
  const cls = (m, base) => base + (rightSet.has(m) ? ' is-right' : left === m ? ' is-left' : '');
  return html`<svg className="keyboard" viewBox=${`-0.5 -0.5 ${width + 1} ${WH + 1}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="鍵盤の図">
    ${whites.map(
      (k) => html`<g key=${k.m}>
        <rect x=${k.x} y=${0} width=${WW} height=${WH} rx="1.4" className=${cls(k.m, 'kb-white')} />
        ${k.m === 60 ? html`<circle cx=${k.x + WW / 2} cy=${WH + -3} r="0.9" className="kb-c4" />` : null}
        ${rightSet.has(k.m) || left === k.m
          ? html`<text x=${k.x + WW / 2} y=${WH - 5} textAnchor="middle" className="kb-label">${label(k.m)}</text>`
          : null}
      </g>`,
    )}
    ${blacks.map(
      (k) => html`<g key=${k.m}>
        <rect x=${k.x} y=${0} width=${BW} height=${BH} rx="1" className=${cls(k.m, 'kb-black')} />
        ${rightSet.has(k.m) || left === k.m
          ? html`<text x=${k.x + BW / 2} y=${BH - 4} textAnchor="middle" className="kb-label kb-label-b">${label(k.m)}</text>`
          : null}
      </g>`,
    )}
  </svg>`;
});
