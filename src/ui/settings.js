// 設定: 演奏・表示・端末(つなぐ/解除)・データ(書き出し/読み込み)
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, GuitarIcon, PianoIcon } from './icons.js';
import { Segmented, Switch, Sheet, Spinner, toast, copyText } from './common.js';
import { SyncBadge } from './home.js';
import { usePrefs } from '../lib/prefs.js';
import { api, deviceKey } from '../lib/api.js';
import { lib, syncNow, useSyncState, exportAll, useLibrary, pendingCount } from '../lib/store.js';
import { go, back } from '../lib/router.js';
import { formatAgo, downloadFile } from '../lib/util.js';
import { APP_VERSION } from '../config.js';
const html = htm.bind(React.createElement);

function Section({ title, children }) {
  return html`<section className="set-section"><h2>${title}</h2><div className="set-card">${children}</div></section>`;
}

function Row({ label, hint, children }) {
  return html`<div className="set-row"><div className="set-row-text"><span>${label}</span>${hint ? html`<small>${hint}</small>` : null}</div><div className="set-row-ctl">${children}</div></div>`;
}

export function Settings() {
  const [p, set] = usePrefs();
  const sync = useSyncState();
  const L = useLibrary();
  const [pairOpen, setPairOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const fileRef = useRef(null);
  const hasKey = !!deviceKey.get();

  const doExport = async () => {
    const data = await exportAll();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    downloadFile(`hikigatari-${stamp}.json`, JSON.stringify(data, null, 1));
    toast(`${data.songs.length}曲を書き出しました`);
  };
  const doImport = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const n = await lib.importMany(j.songs || []);
      toast(`${n}曲を読み込みました`);
    } catch {
      toast('読み込めないファイルでした', { kind: 'error' });
    }
  };

  return html`<div className="page settings">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>設定</h1>
      <span className="page-top-spacer"></span>
    </header>

    <${Section} title="演奏">
      <${Row} label="最初に開く楽器" hint="曲ごとに切り替えた楽器は、その曲で覚えています">
        <${Segmented}
          label="楽器"
          value=${p.instrument}
          onChange=${(v) => set({ instrument: v })}
          options=${[{ value: 'guitar', label: 'ギター', icon: html`<${GuitarIcon} />` }, { value: 'piano', label: 'ピアノ', icon: html`<${PianoIcon} />` }]}
        />
      </${Row}>
      <${Switch} label="ギター: かんたんモード" hint="オフ: 教本どおりの押さえ方（F や B もバレーコードのまま）。オン: バレーコードなどを、曲を通して弾きやすい形に置き換えます。はじめて開く曲に使い、曲ごとにも切り替えられます" checked=${p.easy} onChange=${(v) => set({ easy: v })} />
      <${Switch} label="ギター: 歌詞の上に押さえ方の図" checked=${p.inlineDiagrams} onChange=${(v) => set({ inlineDiagrams: v })} />
      <${Switch} label="ピアノ: 歌詞の上に五線譜の図" hint="タップすると鍵盤の図が出ます" checked=${p.inlineStaff} onChange=${(v) => set({ inlineStaff: v })} />
      <${Row} label="ギター: カポの上限" hint="自動で選ぶカポ位置の上限">
        <${Segmented} size="sm" label="カポの上限" value=${p.maxCapo} onChange=${(v) => set({ maxCapo: v })} options=${[4, 5, 7, 9].map((n) => ({ value: n, label: String(n) }))} />
      </${Row}>
      <${Row} label="ピアノ: 音名の表記">
        <${Segmented} size="sm" label="音名の表記" value=${p.noteStyle} onChange=${(v) => set({ noteStyle: v })} options=${[{ value: 'solfege', label: 'ドレミ' }, { value: 'letter', label: 'CDE' }]} />
      </${Row}>
    </${Section}>

    <${Section} title="自動スクロール">
      <${Row} label="歌詞1行の長さ（標準）" hint="小節線の無い譜面で使います。「自動」はコードの数と歌詞の長さから見積もります">
        <${Segmented} size="sm" label="歌詞1行の長さ" value=${p.barsPerLine} onChange=${(v) => set({ barsPerLine: v })} options=${[{ value: 0, label: "自動" }, ...[1, 2, 3, 4].map((n) => ({ value: n, label: `${n}小節` }))]} />
      </${Row}>
      <${Switch} label="スタート前に1小節カウント" checked=${p.countIn} onChange=${(v) => set({ countIn: v })} />
      <${Switch} label="クリック音（メトロノーム）" hint="曲ごとにも切り替えられます" checked=${p.click} onChange=${(v) => set({ click: v })} />
      <${Switch} label="小節線を表示" checked=${p.showBars} onChange=${(v) => set({ showBars: v })} />
      <${Switch} label="今の行に色を付ける" hint="自動スクロール中、今の行を黄色くします" checked=${!!p.showCurrent} onChange=${(v) => set({ showCurrent: v })} />
      <${Switch} label="何も無いところを押して画面を送る" hint="譜面の空いたところ（歌詞の右など）を押すと下へ送ります。流しているときは次の行へ。歌詞を押すとその行へ移ります" checked=${p.tapToTurn !== false} onChange=${(v) => set({ tapToTurn: v })} />
    </${Section}>

    <${Section} title="表示">
      <${Row} label="テーマ">
        <${Segmented} size="sm" label="テーマ" value=${p.theme} onChange=${(v) => set({ theme: v })} options=${[{ value: 'auto', label: '自動' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }]} />
      </${Row}>
      <${Row} label="文字の大きさ（標準）">
        <input type="range" className="range range-sm" min="0.7" max="1.8" step="0.05" value=${p.fontScale} onInput=${(e) => set({ fontScale: Number(e.target.value) })} aria-label="文字の大きさ" />
      </${Row}>
    </${Section}>

    <${Section} title="Apple Music">
      <button className="set-link" onClick=${() => go('/apple')}>
        <${Icon} name="music" /><span>聴いている曲をワンタップで開く設定</span><${Icon} name="back" className="rot-180" />
      </button>
    </${Section}>

    <${Section} title="端末と同期">
      <div className="set-row"><${SyncBadge} sync=${sync} /><button className="btn btn-sm" disabled=${!hasKey || sync.status === 'syncing'} onClick=${() => syncNow()}>今すぐ同期</button></div>
      ${hasKey
        ? html`<${Devices} />
            <button className="set-link" onClick=${() => setPairOpen(true)}><${Icon} name="lock" /><span>つなぐための6桁の数字（確認・変更）</span></button>
            <button className="set-link" onClick=${() => setKeyOpen(true)}><${Icon} name="device" /><span>バックアップ用キー</span></button>`
        : html`<button className="set-link" onClick=${() => go('/pair')}><${Icon} name="device" /><span>この端末をつなぐ</span></button>`}
    </${Section}>

    <${Section} title="データ">
      <${Row} label="保存している曲" hint=${`お気に入り ${L.all().filter((s) => s.fav).length}曲 ・ 全部で ${L.all().length}曲${pendingCount() ? ` ・ 未送信 ${pendingCount()}件` : ''}`}></${Row}>
      <button className="set-link" onClick=${doExport}><${Icon} name="download" /><span>ファイルに書き出す（バックアップ）</span></button>
      <button className="set-link" onClick=${() => fileRef.current?.click()}><${Icon} name="upload" /><span>書き出したファイルを読み込む</span></button>
      <input ref=${fileRef} type="file" accept="application/json,.json" hidden onChange=${doImport} />
    </${Section}>

    <${Section} title="このアプリについて">
      <p className="set-about">
        譜面は、曲を開いたときに U-FRET・ChordWiki・歌ネット から1曲ずつ取り込んで表示しています。各サイトの規約上、<b>自分専用</b>で使ってください（譜面を人に配ったり公開したりしない）。
      </p>
      <p className="set-about muted small">ひきがたり ${APP_VERSION}</p>
    </${Section}>

    <${PinSheet} open=${pairOpen} onClose=${() => setPairOpen(false)} />
    <${KeySheet} open=${keyOpen} onClose=${() => setKeyOpen(false)} />
  </div>`;
}

function Devices() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const load = () =>
    api('devices')
      .then((r) => setList(r.devices))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const revoke = async (d) => {
    if (!confirm(`「${d.name || '名前なし'}」の接続を解除しますか？\nその端末では同期・検索ができなくなります（その端末に保存した曲は消えません）。`)) return;
    try {
      await api('revoke', { id: d.id });
      if (d.isMe) {
        deviceKey.clear();
        location.reload();
        return;
      }
      toast('解除しました');
      load();
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  };
  const rename = async (d) => {
    const name = prompt('この端末の名前', d.name || '');
    if (name == null) return;
    await api('rename', { name }).catch((e) => toast(e.message, { kind: 'error' }));
    load();
  };
  if (err) return html`<p className="muted small set-pad">${err}</p>`;
  if (!list) return html`<div className="set-pad"><${Spinner} /></div>`;
  return html`<ul className="device-list">
    ${list.map(
      (d) => html`<li key=${d.id} className="device">
        <${Icon} name="device" size=${20} />
        <div className="device-text">
          <span>${d.name || '名前なし'}${d.isMe ? html` <em>この端末</em>` : null}</span>
          <small>最後に使った: ${formatAgo(new Date(d.last_seen_at).getTime())}</small>
        </div>
        ${d.isMe ? html`<button className="btn btn-sm btn-ghost" onClick=${() => rename(d)}>名前</button>` : null}
        <button className="btn btn-sm btn-ghost is-danger" onClick=${() => revoke(d)}>解除</button>
      </li>`,
    )}
  </ul>`;
}

// つなぐための固定の6桁(いつでも確認・自分の好きな数字に変更できる)
function PinSheet({ open, onClose }) {
  const [pin, setPin] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPin(null);
    setErr(null);
    setEditing(false);
    api('pin_get')
      .then((r) => setPin(r.pin))
      .catch((e) => setErr(e.message));
  }, [open]);
  const save = async (e) => {
    e.preventDefault();
    if (draft.length !== 6) return;
    setBusy(true);
    try {
      await api('pin_set', { pin: draft });
      setPin(draft);
      setEditing(false);
      toast('数字を変えました');
    } catch (er) {
      toast(er.message, { kind: 'error', ms: 3600 });
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="つなぐための6桁の数字">
    ${err
      ? html`<p className="muted">${err}</p>`
      : !pin
        ? html`<${Spinner} />`
        : editing
          ? html`<form className="pin-edit" onSubmit=${save}>
              <p className="panel-lead">新しい6桁の数字を決めてください（同じ数字だけ・連番は使えません）。</p>
              <input
                className="code-input"
                inputMode="numeric"
                autoComplete="off"
                maxLength="6"
                value=${draft}
                onInput=${(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                aria-label="新しい6桁の数字"
                autoFocus
              />
              <div className="row-gap center">
                <button type="button" className="btn" onClick=${() => setEditing(false)}>やめる</button>
                <button className="btn btn-primary" disabled=${busy || draft.length !== 6}>${busy ? '保存しています…' : 'この数字にする'}</button>
              </div>
            </form>`
          : html`<div className="pair-code">
              <p className="panel-lead">iPad・PC・Safari などほかの端末でこのアプリを開き、「この端末をつなぐ」にこの数字を入れるとつながります。</p>
              <div className="pair-digits" aria-label=${'6桁の数字 ' + pin}>${pin.split('').map((c, i) => html`<span key=${i}>${c}</span>`)}</div>
              <div className="row-gap center">
                <button className="btn" onClick=${() => copyText(pin)}><${Icon} name="copy" size=${16} /> コピー</button>
                <button className="btn" onClick=${() => { setDraft(''); setEditing(true); }}><${Icon} name="edit" size=${16} /> 変更する</button>
              </div>
              <p className="panel-note">5回続けてまちがえると、15分つなげなくなります（当てずっぽうで入れられないように）。</p>
            </div>`}
  </${Sheet}>`;
}

function KeySheet({ open, onClose }) {
  const [show, setShow] = useState(false);
  const key = deviceKey.get() || '';
  useEffect(() => {
    if (!open) setShow(false);
  }, [open]);
  return html`<${Sheet} open=${open} onClose=${onClose} title="バックアップ用キー">
    <p className="panel-lead">端末をすべて失くしたときに、このキーで復元できます。人には見せないでください。パスワード管理アプリなどに控えておくと安心です。</p>
    <div className="key-box">${show ? key : '•'.repeat(24)}</div>
    <div className="row-gap center">
      <button className="btn" onClick=${() => setShow(!show)}>${show ? '隠す' : '表示する'}</button>
      <button className="btn" onClick=${() => copyText(key)}><${Icon} name="copy" size=${16} /> コピー</button>
    </div>
  </${Sheet}>`;
}
