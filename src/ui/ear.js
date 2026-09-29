// 耳コピ: まだどのサイトにも譜面が無い曲の、コード進行の下書きを音から作る
// 音は Apple Music の試聴(30秒)・マイク(1曲まるごと)・音のファイル のどれか。計算は端末の中だけ
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Artwork, ChordText, toast } from './common.js';
import { analyzeAudio, barsToSheet, toMono, resample, liveChord, SR } from '../music/earcopy.js';
import { pretty, keyName } from '../music/chord.js';
import { lib } from '../lib/store.js';
import { go, back } from '../lib/router.js';
import { cx, songIdFor, baseTitle, norm, sameArtist } from '../lib/util.js';
const html = htm.bind(React.createElement);

const MAX_SEC = 8 * 60; // マイクで聴くのは8分まで
const MIN_SEC = 15;

// Apple Music の試聴(と、ジャケット・曲の長さ)を探す
async function findTrack({ title, artist, appleId }) {
  let it = null;
  if (appleId) {
    const j = await (await fetch(`https://itunes.apple.com/lookup?id=${appleId}&country=jp&lang=ja_jp`)).json();
    it = j.results?.[0] || null;
  }
  if (!it?.previewUrl) {
    const q = `${baseTitle(title)} ${artist || ''}`.trim();
    const j = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&entity=song&limit=15&lang=ja_jp`)).json();
    const list = j.results || [];
    it =
      list.find((x) => norm(baseTitle(x.trackName)) === norm(baseTitle(title)) && (!artist || sameArtist(x.artistName, artist))) ||
      list.find((x) => norm(baseTitle(x.trackName)) === norm(baseTitle(title))) ||
      null;
  }
  return it;
}

async function decode(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
  } finally {
    ctx.close?.().catch?.(() => {});
  }
}

const sureLabel = (c) => (c >= 0.16 ? ['聴き取りやすい曲でした', 'is-good'] : c >= 0.1 ? ['ふつうに聴き取れました', ''] : ['聴き取りにくい曲でした（下書きとして見てください）', 'is-low']);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function EarCopy({ params }) {
  const [title, setTitle] = useState(params.title || '');
  const [artist, setArtist] = useState(params.artist || '');
  const [track, setTrack] = useState(null);
  const [stage, setStage] = useState(null); // { text, p }
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { r, buffer, source }
  const [rec, setRec] = useState(null); // { sec, level, chord }
  const recRef = useRef(null);
  const playRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(-1);
  const fileRef = useRef(null);
  const busy = !!stage || !!rec;

  // ジャケットと曲の情報(試聴の有無)を先に調べておく
  useEffect(() => {
    if (!title) return;
    let alive = true;
    findTrack({ title, artist, appleId: params.appleId })
      .then((it) => alive && setTrack(it))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => {
    stopPlay();
    stopRec(true);
  }, []);

  const run = async (samples, buffer, source) => {
    setError('');
    setResult(null);
    try {
      const r = await analyzeAudio(samples, { progress: (p, text) => setStage({ p, text }) });
      if (!r.bars.length) throw new Error('コードを聴き取れませんでした');
      setResult({ r, buffer, source });
    } catch (e) {
      setError(e.message || '聴き取れませんでした');
    } finally {
      setStage(null);
    }
  };

  const fromPreview = async () => {
    setError('');
    setStage({ p: 0, text: 'Apple Music の試聴を探しています' });
    try {
      const it = track?.previewUrl ? track : await findTrack({ title, artist, appleId: params.appleId });
      if (!it?.previewUrl) throw new Error('この曲の試聴が見つかりませんでした。曲名・アーティスト名を確かめるか、マイクで聴かせてください');
      setTrack(it);
      setStage({ p: 0, text: '試聴を読み込んでいます' });
      const buf = await decode(await (await fetch(it.previewUrl)).arrayBuffer());
      await run(toMono(buf), buf, '試聴30秒');
    } catch (e) {
      setStage(null);
      setError(e.message || '試聴を読み込めませんでした');
    }
  };

  const fromFile = async (file) => {
    if (!file) return;
    setError('');
    setStage({ p: 0, text: 'ファイルを読み込んでいます' });
    try {
      const buf = await decode(await file.arrayBuffer());
      await run(toMono(buf), buf, 'ファイル');
    } catch {
      setStage(null);
      setError('このファイルは読み込めませんでした（mp3・m4a・wav などの音のファイルを選んでください）');
    }
  };

  // ---------------------------------------------------------------- マイク
  const startRec = async () => {
    setError('');
    setResult(null);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx(); // iPhone は押した瞬間に作る
    ctx.resume?.().catch?.(() => {});
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0.6;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(an);
      src.connect(proc);
      proc.connect(mute).connect(ctx.destination);
      const chunks = [];
      let total = 0;
      let level = 0;
      proc.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        level = Math.sqrt(s / d.length);
        const r = resample(d, ctx.sampleRate);
        chunks.push(r.slice());
        total += r.length;
      };
      const db = new Float32Array(an.frequencyBinCount);
      const t0 = performance.now();
      const timer = setInterval(() => {
        an.getFloatFrequencyData(db);
        const lc = liveChord(db, ctx.sampleRate, an.fftSize);
        const sec = (performance.now() - t0) / 1000;
        setRec((p) => ({ sec, level, chord: lc && lc.sure > 0.015 ? lc.name : p?.chord || null }));
        if (sec >= MAX_SEC) stopRec();
      }, 250);
      recRef.current = { ctx, stream, proc, timer, chunks, getTotal: () => total };
      setRec({ sec: 0, level: 0, chord: null });
    } catch (e) {
      ctx.close?.().catch?.(() => {});
      setError(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'マイクが許可されていません。ブラウザ(またはアプリ)の設定でマイクを許可してください' : 'マイクを使えませんでした');
    }
  };

  function stopRec(silent = false) {
    const r = recRef.current;
    recRef.current = null;
    if (!r) return;
    clearInterval(r.timer);
    r.proc.onaudioprocess = null;
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close?.().catch?.(() => {});
    setRec(null);
    if (silent) return;
    const total = r.getTotal();
    if (total < MIN_SEC * SR) {
      setError(`短すぎました。${MIN_SEC}秒以上（できれば1曲まるごと）聴かせてください`);
      return;
    }
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of r.chunks) {
      samples.set(c, o);
      o += c.length;
    }
    let buffer = null;
    try {
      buffer = new AudioBuffer({ length: samples.length, sampleRate: SR, numberOfChannels: 1 });
      buffer.copyToChannel(samples, 0);
    } catch {}
    run(samples, buffer, 'マイク');
  }

  // ---------------------------------------------------------------- 聴きながら確かめる
  function stopPlay() {
    const p = playRef.current;
    playRef.current = null;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    try {
      p.src.onended = null;
      p.src.stop();
    } catch {}
    p.ctx.close?.().catch?.(() => {});
    setPlaying(false);
    setCur(-1);
  }
  const play = (fromBar = 0) => {
    if (!result?.buffer) return;
    stopPlay();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createBufferSource();
    src.buffer = result.buffer;
    src.connect(ctx.destination);
    const bars = result.r.bars;
    const offset = Math.max(0, bars[fromBar]?.t0 ?? 0);
    const startAt = ctx.currentTime + 0.05;
    src.start(startAt, offset);
    const p = { ctx, src, raf: 0 };
    const step = () => {
      const t = ctx.currentTime - startAt + offset;
      let i = bars.findIndex((b) => t >= b.t0 && t < b.t1);
      setCur(i);
      p.raf = requestAnimationFrame(step);
    };
    p.raf = requestAnimationFrame(step);
    src.onended = () => stopPlay();
    playRef.current = p;
    setPlaying(true);
  };

  // ---------------------------------------------------------------- 保存
  const save = async (edit) => {
    const t = title.trim();
    if (!t) {
      toast('曲名を入れてください', { kind: 'error' });
      return;
    }
    const a = artist.trim();
    const id = songIdFor(t, a);
    const existing = lib.get(id);
    if (existing && !existing.deleted && existing.sheet && existing.source !== 'ear' && !confirm('この曲にはすでに譜面があります。耳コピの下書きに置き換えますか？')) return;
    const text = barsToSheet(result.r, { note: `耳コピの下書き（${result.source}・自動）` });
    const sheet = { text, key: null, bpm: result.r.bpm, beatsPerBar: 4, fetchedAt: new Date().toISOString() };
    const common = { source: 'ear', sourceId: null, sourceUrl: null, sourceLabel: '', sheet, edited: false, watch: true, watchCheckedAt: Date.now(), watchFound: null };
    if (existing && !existing.deleted) await lib.patch(id, common);
    else
      await lib.put({
        id,
        title: baseTitle(t),
        artist: a,
        artwork: track?.artworkUrl100 || null,
        appleId: track?.trackId || null,
        durationMs: track?.trackTimeMillis || null,
        sources: [],
        fav: false,
        settings: {},
        createdAt: Date.now(),
        ...common,
      });
    stopPlay();
    toast('耳コピの下書きを保存しました');
    go(edit ? '/edit/' + id : '/song/' + id, { replace: true });
  };

  const [sure, sureCls] = result ? sureLabel(result.r.confidence) : ['', ''];

  return html`<div className="page ear-page">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>耳コピで下書きを作る</h1>
      <span className="page-top-spacer"></span>
    </header>

    <div className="ear-song">
      <${Artwork} song=${{ title: title || '♪', artwork: track?.artworkUrl100 || null }} size=${56} />
      <div className="ear-song-fields">
        <input className="ear-input ear-title" value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="曲名" aria-label="曲名" disabled=${busy} />
        <input className="ear-input" value=${artist} onInput=${(e) => setArtist(e.target.value)} placeholder="アーティスト名" aria-label="アーティスト名" disabled=${busy} />
      </div>
    </div>
    <p className="ear-lead">まだどのサイトにも譜面が無い曲でも、曲の音からコード進行を聴き取って、下書きを作ります。計算はこの端末の中だけで行い、音はどこにも送りません。</p>

    ${rec
      ? html`<div className="ear-rec" role="status">
          <div className="ear-rec-chord"><${ChordText} name=${rec.chord ? pretty(rec.chord) : '…'} /></div>
          <div className="ear-rec-meter"><i style=${{ transform: `scaleX(${Math.min(1, rec.level * 6)})` }}></i></div>
          <div className="ear-rec-time">聴いています ${mmss(rec.sec)} <small>（最長 ${MAX_SEC / 60}分）</small></div>
          <p className="muted small">曲が終わったら「聴き終わった」を押してください。上の大きな文字は、いま聴こえているコードの目安です。</p>
          <button className="btn btn-primary btn-lg" onClick=${() => stopRec()}><${Icon} name="check" size=${18} /> 聴き終わった</button>
        </div>`
      : stage
        ? html`<div className="ear-progress" role="status">
            <div className="ear-progress-text">${stage.text}…</div>
            <div className="ear-progress-bar"><i style=${{ transform: `scaleX(${stage.p || 0})` }}></i></div>
          </div>`
        : result
          ? null
          : html`<div className="ear-sources">
            <button className="ear-source is-main" onClick=${fromPreview} disabled=${!title.trim()}>
              <span className="ear-source-icon"><${Icon} name="headphones" /></span>
              <span className="ear-source-text">
                <b>試聴30秒で聴き取る <em>いちばん手軽</em></b>
                <small>Apple Music の試聴を使います（サビのことが多い）${track && !track.previewUrl ? '。この曲は試聴が無いようです' : ''}</small>
              </span>
            </button>
            <button className="ear-source" onClick=${startRec}>
              <span className="ear-source-icon"><${Icon} name="mic" /></span>
              <span className="ear-source-text">
                <b>マイクで1曲まるごと聴かせる</b>
                <small>別の端末やスピーカーで曲を流して、この端末に聴かせます</small>
              </span>
            </button>
            <button className="ear-source" onClick=${() => fileRef.current?.click()}>
              <span className="ear-source-icon"><${Icon} name="music" /></span>
              <span className="ear-source-text">
                <b>音のファイルから</b>
                <small>mp3・m4a・wav など（パソコンに入っている曲や、録音した音）</small>
              </span>
            </button>
            <input ref=${fileRef} type="file" accept="audio/*,video/mp4" hidden onChange=${(e) => fromFile(e.target.files?.[0])} />
          </div>`}

    ${result ? html`<input ref=${fileRef} type="file" accept="audio/*,video/mp4" hidden onChange=${(e) => fromFile(e.target.files?.[0])} />` : null}
    ${error ? html`<p className="ear-error" role="alert">${error}</p>` : null}

    ${result
      ? html`<section className="ear-result">
          <div className="ear-summary">
            <b>Key ${keyName(result.r.key)}</b><span>♩=${result.r.bpm}</span><span>${result.r.bars.length}小節</span>
            <em className=${cx('ear-sure', sureCls)}>${sure}</em>
          </div>
          ${result.buffer
            ? html`<button className="btn ear-play" onClick=${() => (playing ? stopPlay() : play(0))}>
                <${PlayIcon} playing=${playing} size=${18} /> ${playing ? '止める' : '聴きながら確かめる'}
              </button>`
            : null}
          <div className="ear-bars">
            ${result.r.bars.map(
              (b, i) => html`<button key=${i} className=${cx('ear-bar', i === cur && 'is-now')} onClick=${() => result.buffer && play(i)} aria-label=${`${i + 1}小節目 ${b.chords.join(' ')}`}>
                <small>${i + 1}</small>
                ${b.chords.map((c, k) => html`<span key=${k}><${ChordText} name=${pretty(c)} /></span>`)}
              </button>`,
            )}
          </div>
          <p className="muted small">小節をタップすると、そこから聴けます。歌詞は入りません。保存したあと、ギターの押さえ方・カポ・自動スクロールはふつうの譜面と同じように使えます。どこかのサイトに譜面が出たら、ホームでお知らせします。</p>
          <div className="ear-actions">
            <button className="btn btn-primary btn-lg" onClick=${() => save(false)}><${Icon} name="check" size=${18} /> この下書きで保存して開く</button>
            <button className="btn" onClick=${() => save(true)}><${Icon} name="edit" size=${18} /> 直してから保存</button>
          </div>
          <div className="ear-again">
            <span className="muted small">別の方法で聴き直す</span>
            <div className="row-gap">
              <button className="btn btn-sm" onClick=${() => { stopPlay(); fromPreview(); }}><${Icon} name="headphones" size=${16} /> 試聴</button>
              <button className="btn btn-sm" onClick=${() => { stopPlay(); startRec(); }}><${Icon} name="mic" size=${16} /> マイク</button>
              <button className="btn btn-sm" onClick=${() => { stopPlay(); fileRef.current?.click(); }}><${Icon} name="music" size=${16} /> ファイル</button>
            </div>
          </div>
        </section>`
      : null}

    <div className="ear-foot">
      <button className="link-btn" onClick=${() => go(`/add?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)}>耳コピではなく、自分で入力する</button>
    </div>
  </div>`;
}
