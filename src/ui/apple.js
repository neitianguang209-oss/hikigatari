// Apple Music とつなぐ(iPhoneの「ショートカット」アプリを使う)案内
import React, { useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { Segmented, copyText } from './common.js';
import { back, go } from '../lib/router.js';
const html = htm.bind(React.createElement);

function Step({ n, children }) {
  return html`<li className="step"><span className="step-n">${n}</span><div className="step-body">${children}</div></li>`;
}

function CopyLine({ text }) {
  return html`<div className="copy-line"><code>${text}</code><button className="btn btn-sm" onClick=${() => copyText(text)}><${Icon} name="copy" size=${16} /> コピー</button></div>`;
}

export function AppleGuide() {
  const base = location.origin + location.pathname;
  const [tab, setTab] = useState('now');

  return html`<div className="page guide">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>Apple Musicとつなぐ</h1>
      <span className="page-top-spacer"></span>
    </header>

    <p className="guide-lead">
      iPhoneに最初から入っている<b>「ショートカット」アプリ</b>で、ボタンを1つ作ります。いちど作れば、Apple Musicで聴いている曲のコードがワンタップで開きます。
    </p>

    <${Segmented}
      label="作り方"
      value=${tab}
      onChange=${setTab}
      options=${[{ value: 'now', label: '今聴いている曲' }, { value: 'share', label: '共有ボタンから' }]}
    />

    ${tab === 'now'
      ? html`<ol className="steps">
          <${Step} n="1">「ショートカット」アプリを開き、右上の <b>＋</b> をタップ。</${Step}>
          <${Step} n="2">「アクションを追加」で <b>再生中の曲を取得</b> を検索して追加。</${Step}>
          <${Step} n="3">
            <b>テキスト</b> アクションを追加。中に「再生中の曲」の変数を入れてタップし、<b>タイトル</b>（表示によっては「名前」）を選ぶ。
            改行して、もう一度「再生中の曲」を入れて <b>アーティスト</b> を選ぶ。
          </${Step}>
          <${Step} n="4"><b>URLエンコード</b> アクションを追加（入力は3のテキストのまま）。</${Step}>
          <${Step} n="5">
            もう一度 <b>テキスト</b> アクションを追加し、下のURLを貼り付けて、その直後に「URLエンコードされたテキスト」の変数を入れる。
            <${CopyLine} text=${base + '?np='} />
          </${Step}>
          <${Step} n="6"><b>URLを開く</b> アクションを追加。</${Step}>
          <${Step} n="7">上の名前を「コードを開く」にして完了。</${Step}>
        </ol>
        <div className="guide-tip">
          <b>もっと手早く呼び出すには</b>
          <ul>
            <li>ショートカットを長押し → <b>ホーム画面に追加</b></li>
            <li>設定 → アクセシビリティ → タッチ → <b>背面タップ</b> → ダブルタップに「コードを開く」を割り当てると、iPhoneの背中を2回たたくだけで開きます</li>
            <li>iPhone 15 Pro 以降は <b>アクションボタン</b> にも割り当てられます</li>
          </ul>
        </div>`
      : html`<ol className="steps">
          <${Step} n="1">「ショートカット」アプリで <b>＋</b> → 下の <b>ⓘ（詳細）</b> で <b>共有シートに表示</b> をオン。受け取る種類は <b>URL</b> だけにする。</${Step}>
          <${Step} n="2"><b>URLエンコード</b> アクションを追加（入力は「ショートカットの入力」）。</${Step}>
          <${Step} n="3">
            <b>テキスト</b> アクションを追加し、下のURLを貼り付けて、その直後に「URLエンコードされたテキスト」の変数を入れる。
            <${CopyLine} text=${base + '?am='} />
          </${Step}>
          <${Step} n="4"><b>URLを開く</b> アクションを追加し、名前を「コードを開く」にして完了。</${Step}>
          <${Step} n="5">Apple Musicで曲の <b>…</b> → <b>共有</b> → 「コードを開く」を選ぶと、その曲のコードが開きます。</${Step}>
        </ol>`}

    <div className="guide-note">
      <${Icon} name="info" size=${18} />
      <div>
        ショートカットから開くと <b>Safari</b> で開きます。ホーム画面に追加したアプリとSafariは別の端末として扱われるので、
        Safariでも一度「この端末をつなぐ」（6桁の数字）をしておいてください。
      </div>
    </div>

    <div className="guide-try">
      <p className="small muted">動きを試す（マリーゴールド / あいみょん を開きます）</p>
      <button className="btn" onClick=${() => go('/open?np=' + encodeURIComponent('マリーゴールド\nあいみょん'))}>試してみる</button>
    </div>
  </div>`;
}
