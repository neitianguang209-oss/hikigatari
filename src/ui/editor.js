// 譜面の追加・編集(貼り付けにも対応)
import React, { useMemo, useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { Segmented, toast } from './common.js';
import { SheetPreview } from './song.js';
import { parseSheet, normalizePasted, chordStats } from '../music/sheet.js';
import { lib } from '../lib/store.js';
import { go, back } from '../lib/router.js';
import { songIdFor, baseTitle } from '../lib/util.js';
const html = htm.bind(React.createElement);

const KEYS = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const SAMPLE = `[C]あの日[G]見た[Am]空の[Em]色を
[F]今でも[C]覚えて[Dm7]いる[G7]

C       G        Am
コードの行の下に歌詞の行を書いてもOK`;

export function Editor({ id, params = {} }) {
  const existing = id ? lib.get(id) : null;
  const [title, setTitle] = useState(existing?.title || params.title || '');
  const [artist, setArtist] = useState(existing?.artist || params.artist || '');
  const [keyText, setKeyText] = useState(existing?.sheet?.key || '');
  const [bpm, setBpm] = useState(existing?.sheet?.bpm ? String(existing.sheet.bpm) : '');
  const [text, setText] = useState(existing?.sheet?.text || '');
  const [view, setView] = useState('edit');

  const normalized = useMemo(() => normalizePasted(text), [text]);
  const parsed = useMemo(() => parseSheet(normalized), [normalized]);
  const nChords = useMemo(() => chordStats(parsed.lines).order.length, [parsed]);

  const save = async () => {
    if (!title.trim()) return toast('曲名を入れてください', { kind: 'error' });
    if (!nChords) return toast('コードが1つも見つかりません。[C] のように書くか、コードの行を歌詞の上に置いてください', { kind: 'error', ms: 4200 });
    const sheet = {
      text: normalized,
      key: keyText || null,
      bpm: Number(bpm) || parsed.meta.bpm || null,
      beatsPerBar: parsed.meta.beatsPerBar || 4,
      fetchedAt: existing?.sheet?.fetchedAt || null,
    };
    let targetId = existing?.id;
    if (existing) {
      await lib.patch(existing.id, { title: title.trim(), artist: artist.trim(), sheet, edited: existing.source !== 'manual' });
    } else {
      targetId = songIdFor(title, artist);
      const cur = lib.get(targetId);
      if (cur && !cur.deleted) {
        await lib.patch(targetId, { sheet, edited: cur.source !== 'manual' });
      } else {
        await lib.put({
          id: targetId,
          title: baseTitle(title.trim()),
          artist: artist.trim(),
          source: 'manual',
          sourceId: null,
          sourceUrl: null,
          sources: [],
          sheet,
          fav: true,
          favAt: Date.now(),
          settings: {},
          createdAt: Date.now(),
        });
      }
    }
    toast('保存しました');
    go('/song/' + targetId, { replace: true });
  };

  return html`<div className="page editor">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>${existing ? '譜面を直す' : '譜面を追加'}</h1>
      <button className="btn btn-primary btn-sm" onClick=${save}>保存</button>
    </header>

    <div className="form-grid">
      <label className="field"><span>曲名</span><input value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="例: マリーゴールド" /></label>
      <label className="field"><span>アーティスト</span><input value=${artist} onInput=${(e) => setArtist(e.target.value)} placeholder="例: あいみょん" /></label>
      <label className="field field-sm">
        <span>原曲キー</span>
        <select value=${keyText} onChange=${(e) => setKeyText(e.target.value)}>
          <option value="">自動で判定</option>
          ${KEYS.map((k) => html`<option key=${k} value=${k}>${k}</option>`)}
          ${KEYS.map((k) => html`<option key=${k + 'm'} value=${k + 'm'}>${k}m</option>`)}
        </select>
      </label>
      <label className="field field-sm"><span>BPM</span><input inputMode="numeric" value=${bpm} onInput=${(e) => setBpm(e.target.value.replace(/\D/g, ''))} placeholder="わかれば" /></label>
    </div>

    <div className="editor-switch">
      <${Segmented} size="sm" label="表示" value=${view} onChange=${setView} options=${[{ value: 'edit', label: '入力' }, { value: 'preview', label: `プレビュー（コード${nChords}種）` }]} />
    </div>

    <div className=${'editor-panes view-' + view}>
      <div className="editor-input">
        <textarea
          className="sheet-textarea"
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          placeholder=${SAMPLE}
          spellCheck=${false}
          aria-label="譜面"
        ></textarea>
        <details className="help">
          <summary>書き方</summary>
          <ul>
            <li><code>[C]歌詞[G]歌詞</code> のように、コードを [ ] で囲んで歌詞の中に入れる</li>
            <li>または、コードだけの行のすぐ下に歌詞の行を書く（位置を合わせて自動で変換します）</li>
            <li><code>{c:サビ}</code> や <code>【Aメロ】</code> の行は見出しになります</li>
            <li><code>[|]</code> を入れると小節線になり、自動スクロールが小節どおりに進みます</li>
            <li>U-FRETなどのページからコピーして貼り付けても、たいてい読み取れます</li>
          </ul>
        </details>
      </div>
      <div className="editor-preview">
        ${nChords ? html`<${SheetPreview} lines=${parsed.lines} />` : html`<p className="muted center">コードを入れるとここに表示されます</p>`}
      </div>
    </div>
  </div>`;
}
