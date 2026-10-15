// このキーで原曲を聴く: キーを変えたら、原曲がその高さでどう聞こえるかを確かめる(「この高さなら歌えるかも」「どこの音で歌えばいい？」)
// ・試聴30秒(Apple Music の曲の一部。サビのことが多い): どの端末でも。この端末の中でキーを変えてから流す。原曲キーとその場で聴き比べられる
//   (Apple の試聴は「お店で聴くため」のものなので、すぐ横に Apple Music への入口を置く)
// ・1曲まるごと: 自分の音源ファイル(ownaudio.js)を入れると、歌詞を押したところからそのキーで流れる。iPhone・iPad でも。広告なし
//   YouTube の動画の音は、キーを変えたり(加工)取り出したりしない(YouTube の決まりで禁じられている)
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Segmented } from './common.js';
import { shiftChannels, VOICE_FORMANT } from '../music/keyshift.js';
import { decodeAudio } from '../music/earcopy.js';
import { audioCtx, holdPlayback, releasePlayback } from '../lib/sound.js';
import { cx, signed } from '../lib/util.js';
import { mb } from './ownaudio.js';
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

// voice: 声(VOICE_FORMANT の名前)。キーを変えないときも、男性っぽく・女性っぽくなら変える
function usePreview({ active, getTrack, semis, voice = 'orig', cacheKey }) {
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
    const k = buf === shared.orig && (semis || voice !== 'orig') ? shared.cache.get(semis + '|' + voice) : null;
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
  // そのキー・声の音(作ったものは4つまで覚える)
  const bufFor = async (s) => {
    if (!s && voice === 'orig') return shared.orig;
    const key = s + '|' + voice;
    if (shared.cache.has(key)) return shared.cache.get(key);
    const tok = r.token;
    const o = shared.orig;
    setUi((u) => ({ ...u, stage: 'shift', prog: 0 }));
    const y = await shiftChannels(o.getChannelData(0), o.numberOfChannels > 1 ? o.getChannelData(1) : null, o.sampleRate, s, {
      onProgress: (p) => tok === r.token && setUi((u) => ({ ...u, prog: p })),
      cancelled: () => tok !== r.token,
      formant: VOICE_FORMANT[voice] ?? 1,
    });
    if (!y) return null;
    const b = audioCtx().createBuffer(2, o.length, o.sampleRate);
    b.copyToChannel(y.L, 0);
    b.copyToChannel(y.R, 1);
    shared.cache.set(key, b);
    if (shared.cache.size > 4) shared.cache.delete(shared.cache.keys().next().value);
    return b;
  };
  // 流すもの(このキー or 原曲キー)を、いまの位置のまま入れかえる
  const swap = async (which, s) => {
    const tok = ++r.token;
    const b = which === 'orig' ? shared.orig : await bufFor(s);
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
      const b = r.which === 'orig' ? shared.orig : await bufFor(semis);
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
  }, [semis, voice]);
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

// 30秒だけ聴くところ
const PARTS = [
  { mark: 'start', label: '歌い始め' },
  { mark: 'chorus', label: 'サビ' },
  { mark: 'bridge', label: 'Cメロ' },
];

const VOICES = [
  { value: 'orig', label: '歌手の声のまま' },
  { value: 'male', label: '男性っぽく' },
  { value: 'female', label: '女性っぽく' },
];

// キーのパネルの中: 声 / 1曲まるごと(自分の音源。歌い始め・サビから) / 試聴30秒(サビのあたり)
// own: useOwnAudio の戻り値。mine: いま自分の音源で流している。marks: { start, chorus }(行の番号)
// onPlayFull(from): パネルを閉じて、自分の音源をこのキーで流す(from = 'start' | 'chorus' | null)
export function KeyHear({ songId, active, semis, keyLabel, origLabel, getTrack, onApple, own, mine, marks = {}, voice = 'orig', setVoice, onPickOwn, onUseOwn, onPlayFull, onBeforePreview }) {
  const pv = usePreview({ active, getTrack, semis, voice, cacheKey: songId });
  const { ui, pos } = pv;
  const busy = ui.stage === 'load' || ui.stage === 'shift';
  const busyText = ui.stage === 'load' ? '試聴を読み込んでいます…' : `${semis ? signed(semis) : '原曲キー'}・${VOICES.find((v) => v.value === voice)?.label} に変えています… ${Math.round(ui.prog * 100)}%`;
  const has = !!own?.own;
  const playPreview = () => {
    onBeforePreview?.();
    pv.play();
  };
  const full = (from, opt) => {
    pv.pause();
    onPlayFull(from, opt);
  };
  const removeOwn = () => {
    if (!confirm('この曲の音源を外しますか？（この端末とクラウドから消えます。元のファイルはそのままです）')) return;
    onBeforePreview?.();
    own.remove();
  };
  const keyTxt = semis ? `${signed(semis)}（${keyLabel}）` : '原曲キー';
  return html`<div className="kh">
    <div className="panel-field">
      <div className="panel-field-label">声<small className="kh-sub">キーを変えて聴くときの声の感じ</small></div>
      <${Segmented} size="sm" label="声" value=${voice} onChange=${setVoice} options=${VOICES} />
      <p className="panel-note">「歌手の声のまま」は、高さだけ変えて声の感じ（響き）は元の歌手のまま。女性の歌を下げても女性の声で聞こえます。「男性っぽく」「女性っぽく」は響きを低く・高くします。</p>
    </div>

    <div className="panel-field">
      <div className="panel-field-label">1曲まるごと、${keyTxt}で<small className="kh-sub">${has ? '自分の音源・広告なし' : 'iPhone・iPad・パソコン'}</small></div>
      ${has && mine
        ? html`<div className="kh-full-row">
              <button className="btn btn-primary kh-full" onClick=${() => full('start')} disabled=${marks.start == null}><${PlayIcon} playing=${false} size=${18} />歌い始めから</button>
              <button className="btn kh-full" onClick=${() => full('chorus')} disabled=${marks.chorus == null}><${PlayIcon} playing=${false} size=${18} />サビから</button>
              <button className="btn btn-ghost kh-full" onClick=${() => full(null)}>続きから</button>
            </div>
            <p className="panel-note">歌い始め・サビは、少し手前（前奏の終わり）から流れます。${marks.chorus == null ? 'この譜面ではサビの場所が分からなかったので、サビは歌詞を押して流してください。' : ''}流しながらキーや声を変えても、その場で切りかわります。</p>
            <button className="kh-apple kh-remove" onClick=${removeOwn}><${Icon} name="trash" size=${15} />使い終わったら: この音源を外す（${own.own.size ? mb(own.own.size) : ''}・元のファイルはそのまま）</button>`
        : has
          ? html`<div className="kh-full-row">
                <button className="btn btn-primary kh-full" onClick=${onUseOwn}><${Icon} name="music" size=${18} />自分の音源で流す</button>
              </div>
              <p className="panel-note">いまは YouTube で流しています。YouTube の動画の音はキーを変えられないので（YouTube の決まり）、自分の音源に切りかえると、このキーで流せます。</p>`
          : html`<div className="kh-full-row">
                <button className="btn btn-primary kh-full" onClick=${onPickOwn}><${Icon} name="upload" size=${18} />音源ファイルを選ぶ</button>
              </div>
              <p className="panel-note">自分で持っている原曲のファイル（買った曲・CD から取り込んだ曲など）を入れると、<b>歌い始めから・サビから</b>を選んで、1曲まるごとこのキーで流せます。広告も入りません。一度入れれば、ほかの端末でもそのまま使えます。</p>`}
    </div>

    <div className="panel-field">
      <div className="panel-field-label">30秒だけ聴く<small className="kh-sub">${keyTxt}${has ? '・自分の音源から' : ''}</small></div>
      <div className="kh-parts" role="group" aria-label="聴くところ">
        ${PARTS.map((p) => {
          const at = marks[p.mark];
          // 自分の音源があれば、その場所から30秒。無ければ Apple の試聴(サビのあたり)だけ
          const can = has ? at != null : p.mark === 'chorus';
          return html`<button key=${p.mark} className=${cx('chip kh-part', can && 'is-on')} disabled=${!can || ui.stage === 'load'} onClick=${() => (has ? full(p.mark, { clip: 30 }) : ui.playing ? pv.pause() : playPreview())}>
            <${PlayIcon} playing=${!has && p.mark === 'chorus' && ui.playing} size=${14} />${p.label}
          </button>`;
        })}
      </div>
      ${has
        ? html`<p className="panel-note">押すと、そこの少し手前から30秒、${keyTxt}で流れて止まります（途中で歌詞を押せば、そのまま流れつづけます）。${marks.bridge == null ? 'この譜面では Cメロ の場所が分からなかったので、Cメロは歌詞を押して流してください。' : ''}</p>`
        : html`<p className="panel-note">いまは Apple の試聴（サビのあたり30秒）だけ聴けます。<b>歌い始め・Cメロ</b>も選ぶには、上の「音源ファイルを選ぶ」で自分の音源を入れてください（試聴の長さと場所は Apple が決めていて、変えられません）。</p>`}
    </div>

    <div className="panel-field" hidden=${has}>
      <div className="panel-field-label">Apple の試聴<small className="kh-sub">30秒・サビのあたり</small></div>
      <div className="kh-row">
        <button className=${cx('kh-play', ui.playing && 'is-on')} onClick=${ui.playing ? pv.pause : playPreview} disabled=${ui.stage === 'load'} aria-label=${ui.playing ? '止める' : 'このキーで試聴を流す'}>
          <${PlayIcon} playing=${ui.playing} size=${20} />
        </button>
        ${semis !== 0 || voice !== 'orig'
          ? html`<${Segmented}
              size="sm"
              label="聴く高さ"
              value=${ui.which}
              onChange=${pv.setWhich}
              options=${[
                { value: 'orig', label: `原曲 ${origLabel}` },
                { value: 'key', label: semis ? `${signed(semis)}（${keyLabel}）` : '声を変えたもの' },
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
      <p className="panel-note">原曲キーと押し比べられます。</p>
      <button className="kh-apple" onClick=${onApple}><${Icon} name="apple" size=${15} />試聴は Apple Music から（Apple Music でこの曲を開く）</button>
    </div>
  </div>`;
}
