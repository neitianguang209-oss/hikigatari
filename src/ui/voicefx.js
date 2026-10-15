// 歌声のキーを変える(#/voice): 自分で撮った動画・録音の歌声を、キーと声の感じを変えて聴く・保存する。ちょっと遊ぶための道具。
// ・ファイルはこの画面の中だけで使い、端末には残さない(閉じたら消える)
// ・聴くときは、その場でキーを変えて流す(自分の音源と同じ仕組み)。動画は音を消して、音に合わせて動かす
// ・保存: 音だけ(WAV。すぐできる)/ 動画(音を変えてから、動画を流しながら録り直す。動画の長さぶん時間がかかる)
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Segmented, Stepper, toast } from './common.js';
import { useOwnPlayer, decodeOwn } from './ownaudio.js';
import { shiftChannels, VOICE_FORMANT } from '../music/keyshift.js';
import { audioCtx } from '../lib/sound.js';
import { back } from '../lib/router.js';
import { cx, signed } from '../lib/util.js';
const html = htm.bind(React.createElement);

const VOICES = [
  { value: 'orig', label: '元の声のまま' },
  { value: 'male', label: '男性っぽく' },
  { value: 'female', label: '女性っぽく' },
];
const PRESETS = [
  { label: '男性の声に', semis: -5, voice: 'male' },
  { label: '女性の声に', semis: 5, voice: 'female' },
  { label: '元に戻す', semis: 0, voice: 'orig' },
];
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const isVideoFile = (f) => /^video\//.test(f.type || '') || /\.(mov|mp4|m4v)$/i.test(f.name || '');

// 16bit の WAV
function wavBlob(L, R, sr) {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 4) {
    const a = Math.max(-1, Math.min(1, L[i]));
    const b = Math.max(-1, Math.min(1, R[i]));
    v.setInt16(o, a < 0 ? a * 0x8000 : a * 0x7fff, true);
    v.setInt16(o + 2, b < 0 ? b * 0x8000 : b * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// 保存: 共有できる端末(iPhone など)は共有シート(「ビデオを保存」「ファイルに保存」)、できなければダウンロード
async function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return false;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 4000);
  return true;
}

function videoMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export function VoiceFx() {
  const [rec, setRec] = useState(null); // { blob, fp, name, url, isVideo }
  const [semis, setSemis] = useState(0);
  const [voice, setVoice] = useState('orig');
  const [time, setTime] = useState({ t: 0, d: 0 });
  const [playing, setPlaying] = useState(false);
  const [job, setJob] = useState(null); // 作っている途中 { label, prog }
  const [result, setResult] = useState(null); // できあがり { blob, name, kind }(押して保存。iPhone の共有は押した瞬間でないと開けない)
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const cancel = useRef(false);
  const pl = useOwnPlayer(rec, { semis, voice, onEnd: () => setPlaying(false) });
  // キー・声・ファイルを変えたら、前に作ったものは使わない
  useEffect(() => setResult(null), [semis, voice, rec?.fp]);

  // 閉じたら片づける(ファイルは端末に残さない)
  useEffect(
    () => () => {
      cancel.current = true;
      pl.api.pause();
    },
    [],
  );
  useEffect(() => () => rec?.url && URL.revokeObjectURL(rec.url), [rec?.url]);

  // 位置の表示と、動画を音に合わせる
  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => {
      const t = pl.api.time();
      setTime({ t, d: pl.api.duration() });
      const v = videoRef.current;
      if (v && rec.isVideo && !job) {
        if (playing && Math.abs(v.currentTime - t) > 0.25) v.currentTime = t;
        if (playing && v.paused) v.play().catch(() => {});
        if (!playing && !v.paused) v.pause();
      }
    }, 200);
    return () => clearInterval(id);
  }, [rec?.fp, playing, !!job]);

  const pick = async (file) => {
    if (!file) return;
    pl.api.pause();
    setPlaying(false);
    if (rec?.url) URL.revokeObjectURL(rec.url);
    const fp = `${file.name}|${file.size}|${Date.now()}`;
    const isVideo = isVideoFile(file);
    setRec({ blob: file, fp, name: file.name, url: URL.createObjectURL(file), isVideo });
  };
  const toggle = () => {
    if (playing) {
      pl.api.pause();
      setPlaying(false);
    } else {
      pl.api.play();
      setPlaying(true);
    }
  };
  const seek = (t) => {
    pl.api.seek(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  const preset = (p) => {
    setSemis(p.semis);
    setVoice(p.voice);
  };

  const base = (rec?.name || '歌声').replace(/\.[^.]+$/, '');
  const tag = `${semis ? `キー${signed(semis)}` : '原曲キー'}${voice !== 'orig' ? `_${VOICES.find((v) => v.value === voice).label}` : ''}`;

  // 声を変えた音を作る(画面が止まらないよう少しずつ)
  const render = async (label) => {
    const buf = await decodeOwn(rec.blob, rec.fp);
    const y = await shiftChannels(buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, buf.sampleRate, semis, {
      formant: VOICE_FORMANT[voice] ?? 1,
      onProgress: (p) => setJob({ label, prog: p }),
      cancelled: () => cancel.current,
    });
    return y && { ...y, sr: buf.sampleRate };
  };

  const saveAudio = async () => {
    pl.api.pause();
    setPlaying(false);
    cancel.current = false;
    setJob({ label: '声を変えています', prog: 0 });
    try {
      const y = await render('声を変えています');
      if (!y) return;
      setResult({ blob: wavBlob(y.L, y.R, y.sr), name: `${base}_${tag}.wav`, kind: '音' });
    } catch {
      toast('作れませんでした', { kind: 'error' });
    } finally {
      setJob(null);
    }
  };

  // 動画: 声を変えた音を先に作り、動画を頭から流しながら、絵と音をいっしょに録り直す
  const saveVideo = async () => {
    const v = videoRef.current;
    if (!v || !window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      toast('この端末では動画を作れません。「音だけ作る」を使ってください', { kind: 'error', ms: 4000 });
      return;
    }
    pl.api.pause();
    setPlaying(false);
    cancel.current = false;
    const ctx = audioCtx(); // 押した瞬間に音の部品を動かす
    setJob({ label: '声を変えています', prog: 0 });
    let mr = null;
    try {
      const y = await render('声を変えています（1/2）');
      if (!y) return;
      const ab = ctx.createBuffer(2, y.L.length, y.sr);
      ab.copyToChannel(y.L, 0);
      ab.copyToChannel(y.R, 1);
      const scale = Math.min(1, 1280 / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      const cw = Math.max(2, Math.round((v.videoWidth * scale) / 2) * 2);
      const ch = Math.max(2, Math.round((v.videoHeight * scale) / 2) * 2);
      const cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      const g = cv.getContext('2d');
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = ab;
      src.connect(dest);
      const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const mime = videoMime();
      mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4e6 } : undefined);
      const chunks = [];
      mr.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
      const stopped = new Promise((r) => (mr.onstop = r));
      v.muted = true;
      v.pause();
      v.currentTime = 0;
      await new Promise((r) => (v.readyState >= 2 && v.currentTime === 0 ? r() : v.addEventListener('seeked', r, { once: true })));
      g.drawImage(v, 0, 0, cw, ch);
      mr.start(500);
      const t0 = ctx.currentTime + 0.12;
      src.start(t0);
      setTimeout(() => v.play().catch(() => {}), 120);
      const dur = ab.duration;
      // 絵は 1/30 秒ごとに写す(画面の書きかえの合図に頼らない。隠れている間も止まらないように)
      await new Promise((resolve) => {
        const step = () => {
          if (cancel.current) return resolve();
          g.drawImage(v, 0, 0, cw, ch);
          const t = ctx.currentTime - t0;
          setJob({ label: '動画を作っています（2/2）', prog: Math.max(0, Math.min(1, t / dur)) });
          if (t >= dur + 0.15 || v.ended) return resolve();
          setTimeout(step, 33);
        };
        step();
      });
      try {
        src.stop();
      } catch {}
      mr.stop();
      v.pause();
      await stopped;
      if (cancel.current) return;
      const type = mr.mimeType || mime || 'video/mp4';
      const ext = /mp4/.test(type) ? 'mp4' : 'webm';
      setResult({ blob: new Blob(chunks, { type: type.split(';')[0] }), name: `${base}_${tag}.${ext}`, kind: '動画' });
    } catch {
      toast('動画を作れませんでした。「音だけ作る」を使ってください', { kind: 'error', ms: 4000 });
    } finally {
      try {
        if (mr?.state === 'recording') mr.stop();
      } catch {}
      setJob(null);
    }
  };

  const ready = pl.ui.ready;
  return html`<div className="page vfx">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>歌声のキーを変える</h1>
      <span className="page-top-spacer"></span>
    </header>
    <p className="panel-lead vfx-lead">自分で撮った動画や録音の歌声を、<b>キーと声の感じを変えて</b>聴けます。そのまま保存もできます。選んだファイルは、この画面を閉じると消えます（端末には残りません）。</p>

    <input ref=${fileRef} type="file" accept="video/*,audio/*" hidden onChange=${(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
    ${!rec
      ? html`<button className="vfx-pick" onClick=${() => fileRef.current?.click()}>
          <${Icon} name="video" size=${28} />
          <b>動画・録音を選ぶ</b>
          <small>写真アプリの動画、ボイスメモ、その場で撮る、のどれでも</small>
        </button>`
      : html`<div className="vfx-media">
          ${rec.isVideo
            ? html`<video ref=${videoRef} src=${rec.url} muted playsInline preload="auto" className="vfx-video"></video>`
            : html`<div className="vfx-audio"><${Icon} name="mic" size=${30} /><span>${base}</span></div>`}
          <div className="rec-row vfx-seek">
            <button className=${cx('kh-play', playing && 'is-on')} onClick=${toggle} disabled=${!ready || !!job} aria-label=${playing ? '止める' : '流す'}><${PlayIcon} playing=${playing} size=${20} /></button>
            <span className="rec-time">${mmss(time.t)}</span>
            <input type="range" className="rec-seek" min="0" max=${time.d || 0} step="0.1" value=${Math.min(time.t, time.d || 0)} disabled=${!ready || !!job} onInput=${(e) => seek(Number(e.target.value))} aria-label="位置" />
            <span className="rec-time">${mmss(time.d)}</span>
          </div>
          ${!ready && !pl.ui.error ? html`<p className="kh-busy">読み込んでいます…</p>` : null}
          ${pl.ui.error ? html`<p className="kh-err">このファイルは読めませんでした。別の動画・録音を選んでください</p>` : null}
          <button className="kh-apple" onClick=${() => fileRef.current?.click()} disabled=${!!job}><${Icon} name="swap" size=${15} />別のファイルにする</button>
        </div>`}

    <div className="panel-field">
      <div className="panel-field-label">かんたん</div>
      <div className="row-gap vfx-presets">${PRESETS.map((p) => html`<button key=${p.label} className=${cx('btn btn-sm', semis === p.semis && voice === p.voice && 'btn-primary')} onClick=${() => preset(p)}>${p.label}</button>`)}</div>
    </div>
    <div className="panel-field">
      <div className="panel-field-label">キー（半音）</div>
      <${Stepper} label="キー" value=${semis} min=${-12} max=${12} onChange=${setSemis} format=${(v) => (v === 0 ? '元のまま' : signed(v))} />
    </div>
    <div className="panel-field">
      <div className="panel-field-label">声の感じ</div>
      <${Segmented} size="sm" label="声の感じ" value=${voice} onChange=${setVoice} options=${VOICES} />
      <p className="panel-note">流しながら変えると、その場で切りかわります。「女性の声に」は +5・女性っぽく、「男性の声に」は −5・男性っぽく。</p>
    </div>

    ${rec && ready
      ? html`<div className="panel-field">
          <div className="panel-field-label">保存</div>
          ${job
            ? html`<div className="vfx-job" role="status">
                <span>${job.label}… ${Math.round(job.prog * 100)}%</span>
                <span className="vfx-bar"><i style=${{ width: `${Math.round(job.prog * 100)}%` }}></i></span>
                <button className="btn btn-sm btn-ghost" onClick=${() => (cancel.current = true)}>やめる</button>
              </div>`
            : result
              ? html`<div className="vfx-done">
                  <span><${Icon} name="check" size=${18} />${result.kind}ができました（${(result.blob.size / 1024 / 1024).toFixed(1)}MB）</span>
                  <div className="row-gap">
                    <button className="btn btn-primary" onClick=${() => saveBlob(result.blob, result.name)}><${Icon} name="download" size=${18} />保存する</button>
                    <button className="btn btn-ghost" onClick=${() => setResult(null)}>作り直す</button>
                  </div>
                </div>`
              : html`<div className="row-gap">
                  ${rec.isVideo ? html`<button className="btn btn-primary" onClick=${saveVideo}><${Icon} name="video" size=${18} />動画で作る</button>` : null}
                  <button className=${cx('btn', !rec.isVideo && 'btn-primary')} onClick=${saveAudio}><${Icon} name="mic" size=${18} />音だけ作る</button>
                </div>`}
          <p className="panel-note">いまのキー・声の感じで作ります。${rec.isVideo ? '動画は、頭から流しながら作り直すので、動画の長さぶん時間がかかります（終わるまでこの画面のままにしてください）。' : ''}できたら「保存する」。iPhone・iPad は共有の画面が出るので、「ビデオを保存」や「"ファイル"に保存」を選んでください。</p>
        </div>`
      : null}
  </div>`;
}
