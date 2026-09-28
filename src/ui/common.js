// 共通の小さな部品: 下から出るシート / トースト / スイッチ / 切り替えボタン など
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { cx, artworkUrl, tileColor } from '../lib/util.js';
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------- シート(下から出るパネル)

export function Sheet({ open, onClose, title, children, wide = false }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    } else {
      setShown(false);
      const t = setTimeout(() => setMounted(false), 220);
      return () => clearTimeout(t);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!mounted) return null;
  return html`<div className=${cx('sheet-layer', shown && 'is-shown')} onClick=${onClose}>
    <div className=${cx('sheet', wide && 'sheet-wide')} role="dialog" aria-modal="true" aria-label=${title} onClick=${(e) => e.stopPropagation()}>
      <div className="sheet-grip" aria-hidden="true"></div>
      <div className="sheet-head">
        <h2>${title}</h2>
        <button className="icon-btn" onClick=${onClose} aria-label="閉じる"><${Icon} name="close" /></button>
      </div>
      <div className="sheet-body">${children}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- トースト

const toastSubs = new Set();
// action: { label, onClick } を渡すと「元に戻す」などのボタンが付く(そのぶん長めに出す)
export function toast(text, { kind = 'info', ms, action = null } = {}) {
  toastSubs.forEach((f) => f({ text, kind, id: Date.now() + Math.random(), ms: ms || (action ? 6000 : 2600), action }));
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const f = (t) => {
      setItems((xs) => [...xs.slice(-2), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.ms);
    };
    toastSubs.add(f);
    return () => toastSubs.delete(f);
  }, []);
  const run = (t) => {
    setItems((xs) => xs.filter((x) => x.id !== t.id));
    t.action.onClick();
  };
  return html`<div className="toast-host" aria-live="polite">
    ${items.map(
      (t) => html`<div key=${t.id} className=${cx('toast', 'toast-' + t.kind, t.action && 'has-action')}>
        <span>${t.text}</span>
        ${t.action ? html`<button className="toast-action" onClick=${() => run(t)}>${t.action.label}</button>` : null}
      </div>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------- 入力部品

export function Switch({ checked, onChange, label, hint }) {
  return html`<label className="switch-row">
    <span className="switch-text">
      <span>${label}</span>
      ${hint ? html`<small>${hint}</small>` : null}
    </span>
    <input type="checkbox" className="switch" checked=${!!checked} onChange=${(e) => onChange(e.target.checked)} />
  </label>`;
}

export function Segmented({ value, options, onChange, size = 'md', label }) {
  return html`<div className=${cx('segmented', 'seg-' + size)} role="radiogroup" aria-label=${label}>
    ${options.map(
      (o) => html`<button
        key=${String(o.value)}
        role="radio"
        aria-checked=${value === o.value}
        className=${cx('seg-btn', value === o.value && 'is-on')}
        onClick=${() => onChange(o.value)}
      >
        ${o.icon || null}${o.label ? html`<span>${o.label}</span>` : null}
      </button>`,
    )}
  </div>`;
}

export function Stepper({ value, onChange, min = -Infinity, max = Infinity, step = 1, format = (v) => v, label }) {
  const holdRef = useRef(null);
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const startHold = (d) => {
    onChange(clamp(value + d));
    let v = clamp(value + d);
    let n = 0;
    holdRef.current = setInterval(() => {
      n++;
      if (n < 4) return;
      v = clamp(v + d);
      onChange(v);
    }, 90);
  };
  const stopHold = () => clearInterval(holdRef.current);
  useEffect(() => stopHold, []);
  return html`<div className="stepper" aria-label=${label}>
    <button className="step-btn" aria-label="下げる" disabled=${value <= min} onClick=${(e) => e.detail === 0 && onChange(clamp(value - step))}
      onPointerDown=${() => startHold(-step)} onPointerUp=${stopHold} onPointerLeave=${stopHold} onPointerCancel=${stopHold}>
      <${Icon} name="minus" />
    </button>
    <div className="step-value">${format(value)}</div>
    <button className="step-btn" aria-label="上げる" disabled=${value >= max} onClick=${(e) => e.detail === 0 && onChange(clamp(value + step))}
      onPointerDown=${() => startHold(step)} onPointerUp=${stopHold} onPointerLeave=${stopHold} onPointerCancel=${stopHold}>
      <${Icon} name="plus" />
    </button>
  </div>`;
}

export function Artwork({ song, size = 48 }) {
  const [broken, setBroken] = useState(false);
  const url = song.artwork && !broken ? artworkUrl(song.artwork, size > 60 ? 300 : 120) : null;
  if (url)
    return html`<img className="artwork" src=${url} width=${size} height=${size} alt="" loading="lazy" onError=${() => setBroken(true)} />`;
  const ch = (song.title || '♪').trim().slice(0, 1);
  return html`<div className="artwork artwork-tile" style=${{ width: size, height: size, background: tileColor(song.title), fontSize: size * 0.42 }}>${ch}</div>`;
}

// コード名の ♯ ♭ だけ字形をそろえる(欧文フォントに無く、すき間が空いて見えるため)
export function ChordText({ name }) {
  return String(name || '')
    .split(/([♯♭])/)
    .map((p, i) => (p === '♯' || p === '♭' ? html`<span key=${i} className="acc">${p}</span>` : p));
}

export function Spinner({ label }) {
  return html`<div className="spinner-wrap" role="status"><span className="spinner"></span>${label ? html`<span>${label}</span>` : null}</div>`;
}

export function Empty({ icon = 'music', title, children }) {
  return html`<div className="empty">
    <div className="empty-icon"><${Icon} name=${icon} size=${28} /></div>
    <p className="empty-title">${title}</p>
    ${children ? html`<div className="empty-body">${children}</div>` : null}
  </div>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした', { kind: 'error' });
    }
    ta.remove();
  }
}
