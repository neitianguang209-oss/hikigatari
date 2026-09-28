// コードの図: ギターの押さえ方(SVG) / ピアノの鍵盤(SVG)
import React, { memo } from 'react';
import htm from 'htm';
import { guitarVoicings } from '../music/guitar.js';
import { noteName, solfege } from '../music/chord.js';
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------- ギター

export const GuitarDiagram = memo(function GuitarDiagram({ voicing, width = 96, fingers = true, compact = false }) {
  if (!voicing) return html`<div className="gd-none" style=${{ width }}>図なし</div>`;
  const v = voicing;
  const W = 100;
  const H = compact ? 104 : 118;
  const left = compact ? 14 : 20;
  const right = 8;
  const top = compact ? 18 : 22;
  const rows = compact ? 4 : 5;
  const fretH = (H - top - 6) / rows;
  const sx = (W - left - right) / 5;
  const xs = [0, 1, 2, 3, 4, 5].map((i) => left + i * sx);
  const start = v.maxF <= rows ? 1 : v.minF;
  const r = compact ? 6.4 : 5.8;
  const dotY = (f) => top + (f - start + 0.5) * fretH;
  const parts = [];
  // フレット・弦
  for (let k = 0; k <= rows; k++) {
    const y = top + k * fretH;
    parts.push(html`<line key=${'f' + k} x1=${xs[0]} x2=${xs[5]} y1=${y} y2=${y} className=${k === 0 && start === 1 ? 'gd-nut' : 'gd-fret'} />`);
  }
  xs.forEach((x, i) => parts.push(html`<line key=${'s' + i} x1=${x} x2=${x} y1=${top} y2=${top + rows * fretH} className="gd-string" />`));
  if (start > 1)
    parts.push(html`<text key="fr" x=${left - (compact ? 3 : 5)} y=${dotY(start) + 3.5} className="gd-frlabel" textAnchor="end">${start}</text>`);
  // 開放・ミュート
  v.frets.forEach((f, i) => {
    const y = top - (compact ? 8 : 9);
    if (f === 0) parts.push(html`<circle key=${'o' + i} cx=${xs[i]} cy=${y} r=${compact ? 4 : 3.6} className="gd-open" />`);
    else if (f < 0)
      parts.push(html`<path key=${'x' + i} d=${`M${xs[i] - 3.4} ${y - 3.4}L${xs[i] + 3.4} ${y + 3.4}M${xs[i] + 3.4} ${y - 3.4}L${xs[i] - 3.4} ${y + 3.4}`} className="gd-mute" />`);
  });
  // セーハ
  if (v.barre) {
    const y = dotY(v.barre.fret);
    parts.push(html`<rect key="barre" x=${xs[v.barre.from] - r} y=${y - r} width=${xs[v.barre.to] - xs[v.barre.from] + r * 2} height=${r * 2} rx=${r} className="gd-dot" />`);
  }
  v.frets.forEach((f, i) => {
    if (f <= 0) return;
    const inBarre = v.barre && f === v.barre.fret && i >= v.barre.from && i <= v.barre.to;
    const fg = v.fingers[i];
    if (!inBarre) parts.push(html`<circle key=${'d' + i} cx=${xs[i]} cy=${dotY(f)} r=${r} className="gd-dot" />`);
    if (fingers && !compact && fg && (!inBarre || i === v.barre.from))
      parts.push(html`<text key=${'n' + i} x=${xs[i]} y=${dotY(f) + 2.9} className="gd-finger" textAnchor="middle">${fg === 'T' ? 'T' : fg}</text>`);
  });
  return html`<svg className=${'gdiagram' + (compact ? ' is-compact' : '')} width=${width} height=${(width * H) / W} viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="押さえ方の図">${parts}</svg>`;
});

export function GuitarChordCard({ name, label, onClick, active, index = 0 }) {
  const vs = guitarVoicings(name);
  return html`<button className=${'chord-card' + (active ? ' is-active' : '')} onClick=${onClick}>
    <span className="chord-card-name">${label}</span>
    <${GuitarDiagram} voicing=${vs[index] || vs[0]} width=${64} fingers=${false} compact=${true} />
  </button>`;
}

// ---------------------------------------------------------------- ピアノ

const BLACK = new Set([1, 3, 6, 8, 10]);

export const PianoKeyboard = memo(function PianoKeyboard({ right = [], left = null, from = 48, to = 83, noteStyle = 'solfege', flat = false }) {
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
  const label = (m) => (noteStyle === 'letter' ? noteName(m, flat).replace('#', '♯').replace(/^([A-G])b/, '$1♭') : solfege(m, flat));
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
