// このキーで原曲を聴く: キーを変えたら、原曲がその高さでどう聞こえるかを確かめる(「この高さなら歌えるかも」「どこの音で歌えばいい？」)
// ・試聴30秒(Apple Music の曲の一部。サビのことが多い): どの端末でも。この端末の中でキーを変えてから流す。原曲キーとその場で聴き比べられる
//   (Apple の試聴は「お店で聴くため」のものなので、すぐ横に Apple Music への入口を置く)
// ・1曲まるごと: 自分の音源ファイル(ownaudio.js)を入れると、歌詞を押したところからそのキーで流れる。iPhone・iPad でも。広告なし
//   YouTube の動画の音は、キーを変えたり(加工)取り出したりしない(YouTube の決まりで禁じられている)
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Segmented } from './common.js';
import { shiftChannels } from '../music/keyshift.js';
import { decodeAudio } from '../music/earcopy.js';
import { audioCtx, holdPlayback, releasePlayback } from '../lib/sound.js';
import { cx, signed } from '../lib/util.js';
const html = htm.bind(React.createElement);

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- 試聴30秒をこのキーで

// 読み込んだ試聴と、キーを変えた音は、パネルを閉じても覚えておく(いま開いている曲のぶんだけ)
const shared = { key: null, orig: null, cache: new Map() };

// 音の大きさ(二乗平均の平方根。間引いて測る)
const loud = new WeakMap();
function loudness(buf) {
  if (loud.has(buf)) return loud.get(buf);
  let s = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i += 4) s += x[i] * x[i];
    n += Math.ceil(x.length / 4);
  }
  const v = Math.sqrt(s / Math.max(1, n));
  loud.set(buf, v);
  return v;
}

function usePreview({ active, getTrack, semis, cacheKey }) {
  if (shared.key !== cacheKey) Object.assign(shared, { key: cacheKey, orig: null, cache: new Map() });
  const r = useRef({ src: null, startAt: 0, offset: 0, which: 'key', token: 0 }).current;
  const [ui, setUi] = useState({ stage: 'idle', playing: false, prog: 0, err: '', which: 'key' });
  const [pos, setPos] = useState({ t: 0, d: 0 });

  const now = () => {
    const b = r.src?.buffer;
    if (!r.src || !b) return r.offset;
    return (audioCtx().currentTime - r.startAt) % b.duration;
  };
  const halt = () => {
    if (!r.src) return;
    r.offset = now();
    try {
      r.src.onended = null;
      r.src.stop();
    } catch {}
    r.src.disconnect();
    r.src = null;
  };
  // 原曲キーで聴き比べるときは、キーを変えた音と同じ大きさに(キーを変えた音は音割れ止めのぶん少し小さい)
  const gainFor = (buf) => {
    const k = buf === shared.orig && semis ? shared.cache.get(semis) : null;
    return k ? Math.min(1, loudness(k) / Math.max(1e-6, loudness(shared.orig))) : 1;
  };
  const startBuf = (buf, at) => {
    const c = audioCtx();
    const s = c.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const g = c.createGain();
    g.gain.value = gainFor(buf);
    s.connect(g).connect(c.destination);
    const off = Math.max(0, Math.min(at, buf.duration - 0.05));
    s.start(0, off);
    r.src = s;
    r.startAt = c.currentTime - off;
    r.offset = off;
  };
  // そのキーの音(作ったものは4つまで覚える)
  const bufFor = async (s) => {
    if (!s) return shared.orig;
    if (shared.cache.has(s)) return shared.cache.get(s);
    const tok = r.token;
    const o = shared.orig;
    setUi((u) => ({ ...u, stage: 'shift', prog: 0 }));
    const y = await shiftChannels(o.getChannelData(0), o.numberOfChannels > 1 ? o.getChannelData(1) : null, o.sampleRate, s, {
      onProgress: (p) => tok === r.token && setUi((u) => ({ ...u, prog: p })),
      cancelled: () => tok !== r.token,
    });
    if (!y) return null;
    const b = audioCtx().createBuffer(2, o.length, o.sampleRate);
    b.copyToChannel(y.L, 0);
    b.copyToChannel(y.R, 1);
    shared.cache.set(s, b);
    if (shared.cache.size > 4) shared.cache.delete(shared.cache.keys().next().value);
    return b;
  };
  // 流すもの(このキー or 原曲キー)を、いまの位置のまま入れかえる
  const swap = async (which, s) => {
    const tok = ++r.token;
    const b = await bufFor(which === 'orig' ? 0 : s);
    if (!b || tok !== r.token) return;
    const playing = !!r.src;
    const at = now();
    halt();
    if (playing) startBuf(b, at);
    setUi((u) => ({ ...u, stage: 'ready', which }));
  };

  const play = async () => {
    // iPhone は押した瞬間に音の出口を開けておく(マナーモードでも聞こえるように)
    holdPlayback();
    audioCtx();
    const tok = ++r.token;
    try {
      if (!shared.orig) {
        setUi((u) => ({ ...u, stage: 'load', err: '' }));
        const it = await getTrack();
        if (!it?.previewUrl) throw new Error('この曲の試聴が見つかりませんでした');
        const ab = await (await fetch(it.previewUrl)).arrayBuffer();
        shared.orig = await decodeAudio(ab);
        if (tok !== r.token) return releasePlayback();
      }
      const b = await bufFor(r.which === 'orig' ? 0 : semis);
      if (!b || tok !== r.token) return releasePlayback();
      halt();
      startBuf(b, r.offset);
      setUi((u) => ({ ...u, stage: 'ready', playing: true, err: '' }));
    } catch (e) {
      releasePlayback();
      setUi((u) => ({ ...u, stage: shared.orig ? 'ready' : 'idle', playing: false, err: e.message === 'この曲の試聴が見つかりませんでした' ? e.message : '試聴を読み込めませんでした。通信を確かめてください' }));
    }
  };
  const pause = () => {
    r.token++;
    if (r.src) {
      halt();
      releasePlayback();
    }
    setUi((u) => ({ ...u, playing: false, stage: shared.orig ? 'ready' : 'idle' }));
  };
  const seek = (t) => {
    if (r.src) {
      const b = r.src.buffer;
      halt();
      startBuf(b, t);
    } else r.offset = t;
    setPos((p) => ({ ...p, t }));
  };
  const setWhich = (w) => {
    r.which = w;
    setUi((u) => ({ ...u, which: w }));
    if (shared.orig) swap(w, semis);
  };

  // キーを変えたら、流している音もそのキーに(作り終わるまでは前の音のまま)
  useEffect(() => {
    if (shared.orig && r.which === 'key' && (ui.playing || shared.cache.size)) swap('key', semis);
  }, [semis]);
  // パネルを閉じたら止める
  useEffect(() => {
    if (!active) pause();
  }, [active]);
  useEffect(
    () => () => {
      r.token++;
      if (r.src) {
        halt();
        releasePlayback();
      }
    },
    [],
  );
  useEffect(() => {
    if (!ui.playing) return;
    const id = setInterval(() => setPos({ t: now(), d: r.src?.buffer?.duration || shared.orig?.duration || 0 }), 200);
    return () => clearInterval(id);
  }, [ui.playing]);

  return { ui, pos: { t: pos.t, d: pos.d || shared.orig?.duration || 0 }, play, pause, seek, setWhich };
}

// キーのパネルの中: 試聴をこのキーで / 1曲まるごと(自分の音源)
// own: useOwnAudio の戻り値。mine: いま自分の音源で流している。onPlayFull: パネルを閉じて、自分の音源をこのキーで流す
export function KeyHear({ songId, active, semis, keyLabel, origLabel, getTrack, onApple, own, mine, onPickOwn, onUseOwn, onPlayFull, onBeforePreview }) {
  const pv = usePreview({ active, getTrack, semis, cacheKey: songId });
  const { ui, pos } = pv;
  const busy = ui.stage === 'load' || ui.stage === 'shift';
  const busyText = ui.stage === 'load' ? '試聴を読み込んでいます…' : `${signed(semis)} に変えています… ${Math.round(ui.prog * 100)}%`;
  const has = !!own?.own;
  const playPreview = () => {
    onBeforePreview?.();
    pv.play();
  };
  const full = () => {
    pv.pause();
    onPlayFull();
  };
  return html`<div className="kh">
    <div className="panel-field">
      <div className="panel-field-label">1曲まるごと、このキーで<small className="kh-sub">${has ? '自分の音源・広告なし' : 'iPhone・iPad・パソコン'}</small></div>
      ${has && mine
        ? html`<div className="kh-full-row">
              <button className="btn btn-primary kh-full" onClick=${full}><${PlayIcon} playing=${false} size=${18} />${semis ? `${signed(semis)}（${keyLabel}）で流す` : '原曲キーで流す'}</button>
            </div>
            <p className="panel-note">歌詞やコードを押すと、そこからこの高さで流れます。流しながらキーを変えても、その場で切りかわります。</p>`
        : has
          ? html`<div className="kh-full-row">
                <button className="btn btn-primary kh-full" onClick=${onUseOwn}><${Icon} name="music" size=${18} />自分の音源で流す</button>
              </div>
              <p className="panel-note">いまは YouTube で流しています。YouTube の動画の音はキーを変えられないので（YouTube の決まり）、自分の音源に切りかえると、このキーで流せます。</p>`
          : html`<div className="kh-full-row">
                <button className="btn btn-primary kh-full" onClick=${onPickOwn}><${Icon} name="upload" size=${18} />音源ファイルを選ぶ</button>
              </div>
              <p className="panel-note">自分で持っている原曲のファイル（買った曲・CD から取り込んだ曲など）を入れると、1曲まるごとこのキーで流せます。広告も入りません。一度入れれば、ほかの端末でもそのまま使えます。</p>`}
    </div>

    <div className="panel-field">
      <div className="panel-field-label">試聴で聴いてみる<small className="kh-sub">30秒（サビのことが多い）</small></div>
      <div className="kh-row">
        <button className=${cx('kh-play', ui.playing && 'is-on')} onClick=${ui.playing ? pv.pause : playPreview} disabled=${ui.stage === 'load'} aria-label=${ui.playing ? '止める' : 'このキーで試聴を流す'}>
          <${PlayIcon} playing=${ui.playing} size=${20} />
        </button>
        ${semis !== 0
          ? html`<${Segmented}
              size="sm"
              label="聴く高さ"
              value=${ui.which}
              onChange=${pv.setWhich}
              options=${[
                { value: 'orig', label: `原曲 ${origLabel}` },
                { value: 'key', label: `${signed(semis)}（${keyLabel}）` },
              ]}
            />`
          : html`<span className="kh-hint">キーを変えると、その高さで流れます</span>`}
      </div>
      ${busy ? html`<div className="kh-busy" role="status">${busyText}</div>` : null}
      ${ui.stage === 'ready' || ui.playing
        ? html`<div className="rec-row kh-seek">
            <span className="rec-time">${mmss(pos.t)}</span>
            <input type="range" className="rec-seek" min="0" max=${pos.d || 0} step="0.1" value=${Math.min(pos.t, pos.d || 0)} onInput=${(e) => pv.seek(Number(e.target.value))} aria-label="試聴の位置" />
            <span className="rec-time">${mmss(pos.d)}</span>
          </div>`
        : null}
      ${ui.err ? html`<p className="kh-err" role="alert">${ui.err}</p>` : null}
      <p className="panel-note">流しながら上の − ＋ でキーを変えると、その高さに切りかわります。「原曲」と押し比べると、どれくらい下がる（上がる）かが分かります。</p>
      <button className="kh-apple" onClick=${onApple}><${Icon} name="apple" size=${15} />試聴は Apple Music から（Apple Music でこの曲を開く）</button>
    </div>
  </div>`;
}
