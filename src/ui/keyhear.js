// このキーで原曲を聴く: キーを変えたら、原曲がその高さでどう聞こえるかを確かめる(「この高さなら歌えるかも」「どこの音で歌えばいい？」)
// ・試聴30秒(Apple Music の曲の一部。サビのことが多い): どの端末でも。この端末の中でキーを変えてから流す。原曲キーとその場で聴き比べられる
// ・1曲まるごと(パソコンの Chrome・Edge だけ): アプリの中で流している YouTube の原曲を、小さい窓(key.html)がタブの音ごと取り込み、
//   キーを変えて流す(取り込んでいる間、このタブの元の音は消える)。キーはどちらの画面で変えても同じ(BroadcastChannel でやりとり)
// YouTube の音を抜き出したり保存したりはしない(鳴っている音を、その場で変えて流すだけ)
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Segmented, toast } from './common.js';
import { shiftChannels } from '../music/keyshift.js';
import { decodeAudio } from '../music/earcopy.js';
import { audioCtx, holdPlayback, releasePlayback } from '../lib/sound.js';
import { cx, signed } from '../lib/util.js';
const html = htm.bind(React.createElement);

const UA = navigator.userAgent;
const MOBILE = /iPhone|iPad|iPod|Android/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
// タブの音を取り込んで、このタブの元の音だけ消せるブラウザ(パソコンの Chrome・Edge)
export const CAN_FULL = (() => {
  try {
    return !MOBILE && !!navigator.mediaDevices?.getDisplayMedia && !!navigator.mediaDevices.getSupportedConstraints?.().suppressLocalAudioPlayback && typeof BroadcastChannel !== 'undefined';
  } catch {
    return false;
  }
})();

// 小さい窓が「取り込んだのは ひきがたり のタブ」と分かるように、このタブに名札をつけておく
try {
  if (CAN_FULL && window.top === window) navigator.mediaDevices.setCaptureHandleConfig?.({ handle: 'hikigatari', exposeOrigin: true, permittedOrigins: [location.origin] });
} catch {}

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- 小さい窓とのやりとり

const CH = 'hikigatari-key';
let bc = null;
let liveOn = false;
let lastKey = null;
let onSetKey = null;
const watchers = new Set();
function channel() {
  if (bc || !CAN_FULL) return bc;
  bc = new BroadcastChannel(CH);
  bc.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'state') {
      liveOn = !!d.on;
      watchers.forEach((f) => f(liveOn));
    } else if (d.type === 'hello') {
      bc.postMessage(lastKey || { type: 'key', songId: null, semis: 0, label: '', title: '' });
    } else if (d.type === 'setKey') onSetKey?.(d);
  };
  // 窓がもう開いていれば(このタブを読み込み直したときなど)、いまの様子を教えてもらう
  bc.postMessage({ type: 'ping' });
  return bc;
}

// 曲の画面から: いまのキーを窓へ知らせる・窓で変えたキーを受け取る。on = 窓が音を取り込んで流している
export function useKeyBridge({ songId, title, semis, label, setSemis }) {
  const [on, setOn] = useState(liveOn);
  const set = useRef(setSemis);
  set.current = setSemis;
  useEffect(() => {
    if (!CAN_FULL) return;
    channel();
    watchers.add(setOn);
    setOn(liveOn);
    onSetKey = (d) => d.songId === songId && set.current(Math.max(-6, Math.min(6, d.semis | 0)));
    return () => {
      watchers.delete(setOn);
      onSetKey = null;
      // 曲の画面を出たら、窓は原曲のキーに戻しておく
      lastKey = null;
      bc?.postMessage({ type: 'key', songId: null, semis: 0, label: '', title: '' });
    };
  }, [songId]);
  useEffect(() => {
    if (!CAN_FULL) return;
    lastKey = { type: 'key', songId, title, semis, label };
    channel()?.postMessage(lastKey);
  }, [songId, semis, label]);
  return {
    on,
    open() {
      const w = window.open('key.html', 'hikigatari-key', 'popup=yes,width=380,height=600');
      if (!w) toast('小さい窓を開けませんでした（ポップアップが止められています。アドレスバーの右の印から許可してください）', { kind: 'error', ms: 5000 });
      else w.focus?.();
    },
    stop() {
      channel()?.postMessage({ type: 'stop' });
    },
  };
}

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

// キーのパネルの中: 試聴をこのキーで / 1曲まるごと(パソコン)
export function KeyHear({ songId, active, semis, keyLabel, origLabel, getTrack, bridge, musicOn, onMusicOn }) {
  const pv = usePreview({ active, getTrack, semis, cacheKey: songId });
  const { ui, pos } = pv;
  const busy = ui.stage === 'load' || ui.stage === 'shift';
  const busyText = ui.stage === 'load' ? '試聴を読み込んでいます…' : `${signed(semis)} に変えています… ${Math.round(ui.prog * 100)}%`;
  const openFull = () => {
    pv.pause();
    if (!musicOn) onMusicOn();
    bridge.open();
  };
  return html`<div className="kh">
    <div className="panel-field">
      <div className="panel-field-label">このキーで原曲を聴く<small className="kh-sub">試聴30秒（サビのことが多い）</small></div>
      <div className="kh-row">
        <button className=${cx('kh-play', ui.playing && 'is-on')} onClick=${ui.playing ? pv.pause : pv.play} disabled=${ui.stage === 'load'} aria-label=${ui.playing ? '止める' : 'このキーで試聴を流す'}>
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
    </div>
    ${CAN_FULL
      ? html`<div className="panel-field">
          <div className="panel-field-label">1曲まるごと<small className="kh-sub">このパソコンの Chrome・Edge だけ</small></div>
          ${bridge.on
            ? html`<div className="kh-live" role="status">
                <span><i></i>原曲の動画を、このキーで流しています</span>
                <button className="btn btn-sm" onClick=${bridge.stop}>やめる</button>
              </div>`
            : html`<button className="btn kh-full" onClick=${openFull}><${Icon} name="headphones" size=${18} />原曲の動画をこのキーで流す</button>`}
          <p className="panel-note">
            ${bridge.on
              ? '歌詞やコードを押すと、そこからこのキーの高さで流れます。キーを変えると、その場で変わります。やめるときは「やめる」か、小さい窓を閉じてください。'
              : html`小さい窓が開きます。窓の「取り込んで、このキーで流す」を押して、出てきた一覧の「Chrome タブ」から<b>このタブ（ひきがたり）</b>を選び、「共有」を押してください。そのあとは、歌詞を押して流すと、このキーの高さで聞こえます（取り込んでいる間、このタブの元の音は消えます）。`}
          </p>
        </div>`
      : null}
  </div>`;
}
