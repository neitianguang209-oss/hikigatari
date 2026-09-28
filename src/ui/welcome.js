// はじめて開いたとき / 端末をつなぐとき
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Logo, Icon } from './icons.js';
import { Spinner, toast } from './common.js';
import { api, deviceKey } from '../lib/api.js';
import { resetSyncCursor } from '../lib/store.js';
import { deviceLabel } from '../lib/util.js';
const html = htm.bind(React.createElement);

export function Welcome({ onDone, initialMode = null }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(initialMode); // null(自動) | code | key
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [keyText, setKeyText] = useState('');
  const inputRef = useRef(null);

  const check = () => {
    setError(null);
    setStatus(null);
    api('status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  };
  useEffect(check, []);

  const finish = async (key) => {
    deviceKey.set(key);
    await resetSyncCursor();
    onDone();
  };

  const claim = async () => {
    setBusy(true);
    try {
      const r = await api('claim', { name: deviceLabel() });
      await finish(r.key);
      toast('ようこそ！ 曲を探してみましょう');
    } catch (e) {
      toast(e.message, { kind: 'error' });
      check();
    } finally {
      setBusy(false);
    }
  };

  const pair = async (e) => {
    e?.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    try {
      const r = await api('pair_finish', { code, name: deviceLabel() });
      await finish(r.key);
      toast('つながりました。お気に入りを読み込んでいます');
    } catch (err) {
      toast(err.message, { kind: 'error', ms: 3600 });
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const restore = async (e) => {
    e.preventDefault();
    const k = keyText.trim();
    if (k.length < 20) return;
    setBusy(true);
    deviceKey.set(k);
    try {
      await api('me');
      await finish(k);
      toast('復元しました');
    } catch (err) {
      deviceKey.clear();
      toast(err.status === 401 ? 'このキーは使えません' : err.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const showCode = mode === 'code' || (mode == null && status?.owned);

  return html`<div className="welcome">
    <div className="welcome-card">
      <div className="welcome-logo"><${Logo} size=${64} /></div>
      <h1>ひきがたり</h1>
      <p className="welcome-lead">好きな曲のコードを、広告なしで。<br />ギターは弾きやすいカポで、ピアノは原曲キーで。</p>

      ${error
        ? html`<div className="welcome-box">
            <p>${error}</p>
            <button className="btn btn-primary btn-block" onClick=${check}>もう一度</button>
          </div>`
        : !status
          ? html`<${Spinner} />`
          : mode === 'key'
            ? html`<form className="welcome-box" onSubmit=${restore}>
                <p className="small">設定画面の「バックアップ用キー」を貼り付けてください。</p>
                <textarea className="key-input" rows="3" value=${keyText} onInput=${(e) => setKeyText(e.target.value)} spellCheck=${false} autoComplete="off"></textarea>
                <button className="btn btn-primary btn-block" disabled=${busy || keyText.trim().length < 20}>復元する</button>
                <button type="button" className="btn btn-ghost btn-block" onClick=${() => setMode(null)}>戻る</button>
              </form>`
            : showCode
              ? html`<form className="welcome-box" onSubmit=${pair}>
                  <p><b>この端末をつなぐ</b></p>
                  <p className="small muted">いつも使っている端末の <b>設定 → 端末と同期 →「つなぐための6桁の数字」</b> に出ている数字を入れてください。</p>
                  <input
                    ref=${inputRef}
                    className="code-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength="6"
                    value=${code}
                    onInput=${(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    aria-label="6桁の数字"
                  />
                  <button className="btn btn-primary btn-block" disabled=${busy || code.length !== 6}>${busy ? 'つないでいます…' : 'つなぐ'}</button>
                  <button type="button" className="btn btn-ghost btn-block small" onClick=${() => setMode('key')}>バックアップ用キーで復元する</button>
                  ${!status.owned ? html`<button type="button" className="btn btn-ghost btn-block small" onClick=${() => setMode(null)}>戻る</button>` : null}
                </form>`
              : html`<div className="welcome-box">
                  <button className="btn btn-primary btn-block btn-lg" disabled=${busy} onClick=${claim}>${busy ? '準備しています…' : 'はじめる'}</button>
                  <p className="small muted">この端末があなた専用の鍵になります。ほかの端末（iPad・PCなど）はあとから6桁の数字でつなげます。</p>
                  <button className="btn btn-ghost btn-block small" onClick=${() => setMode('code')}>すでに別の端末で使っている</button>
                </div>`}
    </div>
  </div>`;
}
