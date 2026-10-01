// 耳コピ: まだどのサイトにも譜面が無い曲の、コード進行の下書きを音から作る
// 1曲まるごと(マイク・パソコンの音・音のファイル)を聴き取り、歌詞が見つかればその行に当てはめる。
// 手早く試すなら Apple Music の試聴30秒(曲の一部だけ・歌詞なし)。計算は端末の中だけ
import React, { useEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Artwork, ChordText, toast } from './common.js';
import { analyzeAudio, barsToSheet, toMonoHQ, resample, liveChord, SR } from '../music/earcopy.js';
import { fitLyrics, musicStart } from '../music/lyricsfit.js';
import { parseSheet } from '../music/sheet.js';
import { pretty, keyName } from '../music/chord.js';
import { findLyrics } from '../lib/lyrics.js';
import { lib } from '../lib/store.js';
import { go, back } from '../lib/router.js';
import { cx, songIdFor, baseTitle, norm, sameArtist } from '../lib/util.js';
const html = htm.bind(React.createElement);

const MAX_SEC = 9 * 60; // 聴くのは9分まで
const MIN_SEC = 15;
const UA = navigator.userAgent;
const MOBILE = /iPhone|iPad|iPod|Android/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
// パソコンの Chrome / Edge は、画面共有の「システム オーディオ」で鳴っている音をそのまま聴ける
const CAN_SYSTEM = !MOBILE && !!navigator.mediaDevices?.getDisplayMedia;

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
const signedSec = (s) => (s > 0 ? `+${s.toFixed(1)}` : s < 0 ? `−${Math.abs(s).toFixed(1)}` : '±0');

export function EarCopy({ params }) {
  const [title, setTitle] = useState(params.title || '');
  const [artist, setArtist] = useState(params.artist || '');
  const [track, setTrack] = useState(null);
  const [lyrics, setLyrics] = useState(undefined); // undefined=探している / null=無い / { synced, plain, source }
  const [stage, setStage] = useState(null); // { text, p }
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { r, buffer, source, kind: full|preview, start, tapFirst }
  const [rec, setRec] = useState(null); // { sec, level, chord, kind, startAt, tapFirst }
  const recRef = useRef(null);
  const playRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState({ bar: -1, row: -1 });
  const [shift, setShift] = useState(0); // 歌詞のタイミングの手直し(秒)
  const [taps, setTaps] = useState(null); // 時刻なしの歌詞: 行ごとにタップした録音の時刻
  const [tapping, setTapping] = useState(false);
  const fileRef = useRef(null);
  const sheetRef = useRef(null);
  const busy = !!stage || !!rec;
  const durSec = track?.trackTimeMillis ? track.trackTimeMillis / 1000 : null;

  // ジャケット・曲の長さ・試聴と、歌詞を先に調べておく(曲名やアーティストを直したら探し直す)
  const lookKey = `${baseTitle(title).trim()}|${artist.trim()}`;
  useEffect(() => {
    if (!baseTitle(title).trim()) {
      setLyrics(null);
      return;
    }
    let alive = true;
    setLyrics(undefined);
    const t = setTimeout(async () => {
      let it = null;
      try {
        it = await findTrack({ title, artist, appleId: lookKey === `${baseTitle(params.title || '').trim()}|${(params.artist || '').trim()}` ? params.appleId : null });
        if (alive) setTrack(it);
      } catch {}
      const ly = await findLyrics({ title, artist: artist.trim(), durationMs: it?.trackTimeMillis }).catch(() => null);
      if (alive) setLyrics(ly);
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [lookKey]);

  useEffect(() => () => {
    stopPlay();
    stopRec(true);
  }, []);

  const run = async (samples, buffer, source, extra) => {
    setError('');
    setResult(null);
    setShift(0);
    setTaps(null);
    try {
      const r = await analyzeAudio(samples, { progress: (p, text) => setStage({ p, text }) });
      if (!r.bars.length) throw new Error('コードを聴き取れませんでした');
      setResult({ r, buffer, source, ...extra });
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
      if (!it?.previewUrl) throw new Error('この曲の試聴が見つかりませんでした。曲名・アーティスト名を確かめるか、1曲まるごと聴かせてください');
      setTrack(it);
      setStage({ p: 0, text: '試聴を読み込んでいます' });
      const buf = await decode(await (await fetch(it.previewUrl)).arrayBuffer());
      await run(await toMonoHQ(buf), buf, '試聴30秒', { kind: 'preview' });
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
      const samples = await toMonoHQ(buf);
      await run(samples, buf, 'ファイル', { kind: 'full', start: musicStart(samples, SR) ?? 0, tapFirst: null });
    } catch {
      setStage(null);
      setError('このファイルは読み込めませんでした（mp3・m4a・wav などの音のファイルを選んでください）');
    }
  };

  // ---------------------------------------------------------------- 1曲まるごと聴く(マイク / パソコンの音)
  const startRec = async (kind = 'mic') => {
    setError('');
    setResult(null);
    stopPlay();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx(); // iPhone は押した瞬間に作る
    ctx.resume?.().catch?.(() => {});
    let stream = null;
    try {
      if (kind === 'system') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include',
        });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((t) => t.stop());
          throw Object.assign(new Error('noaudio'), { code: 'noaudio' });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0.6;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(an);
      src.connect(proc);
      proc.connect(mute).connect(ctx.destination);
      const st = { ctx, stream, proc, chunks: [], total: 0, level: 0, kind, floor: [], loud: 0, startAt: null, tapFirst: null, timer: 0 };
      proc.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        st.level = Math.sqrt(s / d.length);
        const r = resample(d, ctx.sampleRate);
        st.chunks.push(r.slice());
        st.total += r.length;
        // 曲が鳴り始めた時刻を見つける(はじめの1秒の静けさを基準に、0.4秒続けて大きくなったら)
        const now = st.total / SR;
        const dt = d.length / ctx.sampleRate;
        if (st.startAt == null) {
          if (now < 1) st.floor.push(st.level);
          const base = st.floor.length ? st.floor.reduce((a, b) => a + b, 0) / st.floor.length : 0;
          if (now >= 1 && base > 0.02) st.startAt = 0; // はじめから鳴っていた
          else if (st.level > Math.max(0.004, base * 5)) {
            st.loud += dt;
            if (st.loud >= 0.4) st.startAt = Math.max(0, now - st.loud);
          } else st.loud = 0;
        }
      };
      stream.getAudioTracks()[0].addEventListener('ended', () => recRef.current === st && stopRec());
      const db = new Float32Array(an.frequencyBinCount);
      const t0 = performance.now();
      st.timer = setInterval(() => {
        an.getFloatFrequencyData(db);
        const lc = liveChord(db, ctx.sampleRate, an.fftSize);
        const sec = (performance.now() - t0) / 1000;
        setRec((p) => ({ sec, level: st.level, kind, startAt: st.startAt, tapFirst: st.tapFirst, chord: lc && lc.sure > 0.015 ? lc.name : p?.chord || null }));
        // 曲の長さがわかっていれば、終わったら自動で止める
        if (sec >= MAX_SEC || (durSec && st.startAt != null && sec >= st.startAt + durSec + 2.5)) stopRec();
      }, 250);
      recRef.current = st;
      setRec({ sec: 0, level: 0, chord: null, kind, startAt: null, tapFirst: null });
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      ctx.close?.().catch?.(() => {});
      if (e?.code === 'noaudio') setError('音が共有されませんでした。共有する画面を選ぶときに「システム オーディオも共有する」（タブなら「タブの音声も共有する」）をオンにしてください');
      else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) setError(kind === 'system' ? '共有が取りやめられました' : 'マイクが許可されていません。ブラウザ(またはアプリ)の設定でマイクを許可してください');
      else setError(kind === 'system' ? 'パソコンの音を聴けませんでした' : 'マイクを使えませんでした');
    }
  };

  // 時刻つきの歌詞があるとき: 最初の行が聴こえた瞬間にタップしてもらうと、歌詞の時刻がぴったり合う
  const tapFirstLine = () => {
    const st = recRef.current;
    if (!st) return;
    st.tapFirst = st.total / SR;
    setRec((p) => p && { ...p, tapFirst: st.tapFirst });
  };

  function stopRec(silent = false) {
    const st = recRef.current;
    recRef.current = null;
    if (!st) return;
    clearInterval(st.timer);
    st.proc.onaudioprocess = null;
    st.stream.getTracks().forEach((t) => t.stop());
    st.ctx.close?.().catch?.(() => {});
    setRec(null);
    if (silent) return;
    if (st.total < MIN_SEC * SR) {
      setError(`短すぎました。${MIN_SEC}秒以上（できれば1曲まるごと）聴かせてください`);
      return;
    }
    const samples = new Float32Array(st.total);
    let o = 0;
    for (const c of st.chunks) {
      samples.set(c, o);
      o += c.length;
    }
    let buffer = null;
    try {
      buffer = new AudioBuffer({ length: samples.length, sampleRate: SR, numberOfChannels: 1 });
      buffer.copyToChannel(samples, 0);
    } catch {}
    const start = musicStart(samples, SR) ?? st.startAt ?? 0;
    run(samples, buffer, st.kind === 'system' ? 'パソコンの音' : 'マイク', { kind: 'full', start, tapFirst: st.tapFirst });
  }

  // ---------------------------------------------------------------- 歌詞を当てはめる
  const fit = useMemo(() => {
    if (!result || result.kind !== 'full' || !lyrics) return null;
    const note = `耳コピの下書き（${result.source}・自動）・歌詞は${lyrics.source}`;
    if (lyrics.synced) {
      const first = lyrics.synced.find((l) => l.text);
      // 録音の時刻 = 歌詞の時刻 + ずれ。歌い出しのタップがあればそれ、無ければ曲が鳴り始めた時刻から
      const base = result.tapFirst != null ? result.tapFirst - 0.2 - first.t : result.start || 0;
      const off = base + shift;
      return { ...fitLyrics(result.r, lyrics.synced.map((l) => ({ t: l.t + off, text: l.text })), { note }), mode: 'synced' };
    }
    if (taps && taps.length) {
      const lines = [];
      let k = 0;
      for (const l of lyrics.plain) {
        if (!l) lines.push({ t: (taps[k] ?? Infinity) - 0.01, text: '' });
        else if (k < taps.length) lines.push({ t: taps[k++], text: l });
      }
      return { ...fitLyrics(result.r, lines, { note }), mode: 'tap' };
    }
    return null;
  }, [result, lyrics, shift, taps]);
  const plainLines = useMemo(() => (lyrics?.plain || []).filter(Boolean), [lyrics]);

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
    setTapping(false);
    setCur({ bar: -1, row: -1 });
  }
  const rowsRef = useRef([]);
  rowsRef.current = fit?.rows || [];
  const play = (from = 0) => {
    if (!result?.buffer) return;
    stopPlay();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createBufferSource();
    src.buffer = result.buffer;
    src.connect(ctx.destination);
    const bars = result.r.bars;
    const offset = Math.max(0, from);
    const startAt = ctx.currentTime + 0.05;
    src.start(startAt, offset);
    const p = { ctx, src, raf: 0, now: () => ctx.currentTime - startAt + offset, last: '' };
    const step = () => {
      const t = p.now();
      const bar = bars.findIndex((b) => t >= b.t0 && t < b.t1);
      const row = rowsRef.current.findIndex((r) => r.t0 != null && r.kind !== 'label' && t >= r.t0 && t < r.t1);
      const key = bar + ':' + row;
      if (key !== p.last) {
        p.last = key;
        setCur({ bar, row });
      }
      p.raf = requestAnimationFrame(step);
    };
    p.raf = requestAnimationFrame(step);
    src.onended = () => stopPlay();
    playRef.current = p;
    setPlaying(true);
  };

  // 演奏中の行を見える位置に
  useEffect(() => {
    if (cur.row < 0 || !sheetRef.current) return;
    sheetRef.current.querySelector(`[data-row="${cur.row}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur.row]);

  // 時刻なしの歌詞: 再生しながら、各行の歌い出しでタップ
  const startTapping = () => {
    setTaps([]);
    play(0); // play の中で一度止めるので、合わせるモードはそのあとで
    setTapping(true);
  };
  const tapLine = () => {
    const p = playRef.current;
    if (!p) return;
    const t = p.now();
    setTaps((xs) => [...(xs || []), t]);
  };
  const undoTap = () => setTaps((xs) => (xs || []).slice(0, -1));
  // 全部の行をタップし終えたら止める
  useEffect(() => {
    if (!tapping || !taps || taps.length < plainLines.length) return;
    const t = setTimeout(stopPlay, 400);
    return () => clearTimeout(t);
  }, [taps, tapping]);
  useEffect(() => {
    if (!tapping) return;
    const onKey = (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        tapLine();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tapping, plainLines.length]);

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
    const text = fit && fit.used ? fit.text : barsToSheet(result.r, { note: `耳コピの下書き（${result.source}・自動）` });
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
    toast(fit && fit.used ? '歌詞つきの耳コピの下書きを保存しました' : '耳コピの下書きを保存しました');
    go(edit ? '/edit/' + id : '/song/' + id, { replace: true });
  };

  const [sure, sureCls] = result ? sureLabel(result.r.confidence) : ['', ''];
  const firstLine = lyrics?.synced?.find((l) => l.text);
  const recPos = rec && rec.startAt != null ? rec.sec - rec.startAt : null;
  const liveLine = rec && rec.tapFirst != null && lyrics?.synced ? [...lyrics.synced].reverse().find((l) => l.text && l.t <= rec.sec - rec.tapFirst + firstLine.t) : null;

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
    <p className=${cx('ear-lyrics-status', lyrics && 'is-found', lyrics === null && 'is-none')}>
      <${Icon} name=${lyrics ? 'check' : lyrics === null ? 'info' : 'search'} size=${16} />
      <span>
        ${lyrics === undefined
          ? '歌詞を探しています…'
          : lyrics === null
            ? '歌詞は見つかりませんでした（コードだけの下書きになります）'
            : lyrics.synced
              ? html`歌詞が見つかりました（${lyrics.source}・時刻つき）。1曲まるごと聴かせると、コードを歌詞の行に当てはめます`
              : html`歌詞が見つかりました（${lyrics.source}）。時刻が無いので、聴き取ったあとに歌い出しをタップして合わせます`}
        ${durSec ? html` <small>曲の長さ ${mmss(durSec)}</small>` : null}
      </span>
    </p>

    ${rec
      ? html`<div className="ear-rec" role="status">
          <div className="ear-rec-chord"><${ChordText} name=${rec.chord ? pretty(rec.chord) : '…'} /></div>
          <div className="ear-rec-meter"><i style=${{ transform: `scaleX(${Math.min(1, rec.level * 6)})` }}></i></div>
          <div className="ear-rec-time">
            ${recPos == null
              ? html`曲を最初から流してください <small>（まだ音が聴こえていません）</small>`
              : html`聴いています ${mmss(recPos)}${durSec ? html` / ${mmss(durSec)}` : null}`}
          </div>
          ${durSec && recPos != null ? html`<div className="ear-rec-song"><i style=${{ transform: `scaleX(${Math.min(1, recPos / durSec)})` }}></i></div>` : null}
          ${firstLine
            ? rec.tapFirst == null
              ? html`<button className="btn ear-tap-first" onClick=${tapFirstLine}>
                  <b>歌い出しでタップ</b>
                  <small>「${firstLine.text}」が聴こえた瞬間に押すと、歌詞の位置がぴったり合います（押さなくても大丈夫）</small>
                </button>`
              : html`<p className="ear-live-line">♪ ${liveLine?.text || '…'}</p>`
            : null}
          <p className="muted small">${durSec ? '曲が終わると自動で止まります。' : '曲が終わったら「聴き終わった」を押してください。'}上の大きな文字は、いま聴こえているコードの目安です。</p>
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
            ${CAN_SYSTEM
              ? html`<button className="ear-source is-main" onClick=${() => startRec('system')} disabled=${!title.trim()}>
                  <span className="ear-source-icon"><${Icon} name="device" /></span>
                  <span className="ear-source-text">
                    <b>このパソコンで流す曲を、1曲まるごと聴き取る <em>いちばん正確</em></b>
                    <small>押すと「画面の共有」が出るので、画面を選んで「システム オーディオも共有する」をオンに。そのあと Apple Music などで曲を最初から流してください</small>
                  </span>
                </button>`
              : null}
            <button className=${cx('ear-source', !CAN_SYSTEM && 'is-main')} onClick=${() => startRec('mic')} disabled=${!title.trim()}>
              <span className="ear-source-icon"><${Icon} name="mic" /></span>
              <span className="ear-source-text">
                <b>マイクで1曲まるごと聴き取る${CAN_SYSTEM ? '' : html` <em>おすすめ</em>`}</b>
                <small>別の端末（iPad・パソコン・スピーカーなど）で曲を最初から流して、この端末に聴かせます。同じ端末で流しながらだと止まることがあります</small>
              </span>
            </button>
            <button className="ear-source" onClick=${() => fileRef.current?.click()} disabled=${!title.trim()}>
              <span className="ear-source-icon"><${Icon} name="music" /></span>
              <span className="ear-source-text">
                <b>音のファイルから（1曲まるごと）</b>
                <small>mp3・m4a・wav など（パソコンに入っている曲や、録音した音）</small>
              </span>
            </button>
            <button className="ear-source is-quick" onClick=${fromPreview} disabled=${!title.trim()}>
              <span className="ear-source-icon"><${Icon} name="headphones" /></span>
              <span className="ear-source-text">
                <b>試聴30秒で手早く</b>
                <small>Apple Music の試聴を使います。曲の一部（サビのことが多い）だけで、歌詞は当てはめません${track && !track.previewUrl ? '。この曲は試聴が無いようです' : ''}</small>
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

          ${tapping
            ? html`<div className="ear-tapper" role="group" aria-label="歌詞の行に合わせる">
                <p className="muted small">歌が聴こえたら、その行の歌い出しで「タップ」（スペースキーでも）。${taps?.length || 0} / ${plainLines.length} 行</p>
                <p className="ear-tap-next">${plainLines[taps?.length || 0] || '（ここまで）'}</p>
                <div className="row-gap center">
                  <button className="btn btn-primary btn-lg ear-tap-btn" onClick=${tapLine}>タップ</button>
                  <button className="btn btn-sm" onClick=${undoTap} disabled=${!taps?.length}>1行戻す</button>
                  <button className="btn btn-sm" onClick=${stopPlay}>ここで終わる</button>
                </div>
              </div>`
            : result.buffer
              ? html`<div className="row-gap ear-play-row">
                  <button className="btn ear-play" onClick=${() => (playing ? stopPlay() : play(0))}>
                    <${PlayIcon} playing=${playing} size=${18} /> ${playing ? '止める' : '聴きながら確かめる'}
                  </button>
                  ${fit?.mode === 'synced'
                    ? html`<span className="ear-shift" role="group" aria-label="歌詞のタイミング">
                        <span className="muted small">歌詞のタイミング</span>
                        <button className="btn btn-sm" onClick=${() => setShift((s) => Math.round((s - 0.5) * 10) / 10)}>早く</button>
                        <b>${signedSec(shift)}秒</b>
                        <button className="btn btn-sm" onClick=${() => setShift((s) => Math.round((s + 0.5) * 10) / 10)}>遅く</button>
                      </span>`
                    : null}
                </div>`
              : null}

          ${result.kind === 'full' && lyrics && !lyrics.synced && result.buffer && !tapping
            ? html`<div className="ear-tap-intro">
                <p className="small">${taps?.length ? `${taps.length}行ぶん合わせました。` : '歌詞に時刻が無いので、曲を流しながら各行の歌い出しでタップして合わせます（1回聴くだけ）。'}</p>
                <button className="btn btn-sm btn-primary" onClick=${startTapping}>${taps?.length ? 'もう一度合わせる' : '歌詞の行に合わせる'}</button>
              </div>`
            : null}

          ${fit && fit.used
            ? html`<${SheetPreview} rows=${fit.rows} cur=${cur.row} innerRef=${sheetRef} onRow=${(t) => result.buffer && play(Math.max(0, t - 0.3))} />`
            : html`<div className="ear-bars">
                ${result.r.bars.map(
                  (b, i) => html`<button key=${i} className=${cx('ear-bar', i === cur.bar && 'is-now')} onClick=${() => result.buffer && play(b.t0)} aria-label=${`${i + 1}小節目 ${b.chords.join(' ')}`}>
                    <small>${i + 1}</small>
                    ${b.chords.map((c, k) => html`<span key=${k}><${ChordText} name=${pretty(c)} /></span>`)}
                  </button>`,
                )}
              </div>`}
          <p className="muted small">
            ${fit && fit.used
              ? `歌詞${fit.used}行にコードを当てはめました。行をタップすると、そこから聴けます。歌詞の中のコードの位置は目安です（保存したあと「譜面を直す」で直せます）。`
              : result.kind === 'preview'
                ? '試聴は曲の一部だけなので、歌詞は当てはめていません。小節をタップすると、そこから聴けます。'
                : '小節をタップすると、そこから聴けます。'}
            保存したあとは、ギターの押さえ方・カポ・自動スクロールもふつうの譜面と同じように使えます。どこかのサイトに譜面が出たら、ホームでお知らせします。
          </p>
          <div className="ear-actions">
            <button className="btn btn-primary btn-lg" onClick=${() => save(false)}><${Icon} name="check" size=${18} /> この下書きで保存して開く</button>
            <button className="btn" onClick=${() => save(true)}><${Icon} name="edit" size=${18} /> 直してから保存</button>
          </div>
          <div className="ear-again">
            <span className="muted small">別の方法で聴き直す</span>
            <div className="row-gap">
              ${CAN_SYSTEM ? html`<button className="btn btn-sm" onClick=${() => startRec('system')}><${Icon} name="device" size=${16} /> パソコンの音</button>` : null}
              <button className="btn btn-sm" onClick=${() => startRec('mic')}><${Icon} name="mic" size=${16} /> マイク</button>
              <button className="btn btn-sm" onClick=${() => { stopPlay(); fileRef.current?.click(); }}><${Icon} name="music" size=${16} /> ファイル</button>
              <button className="btn btn-sm" onClick=${() => { stopPlay(); fromPreview(); }}><${Icon} name="headphones" size=${16} /> 試聴</button>
            </div>
          </div>
        </section>`
      : null}

    <div className="ear-foot">
      <button className="link-btn" onClick=${() => go(`/add?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)}>耳コピではなく、自分で入力する</button>
    </div>
  </div>`;
}

// 歌詞を当てはめた下書きの見本(曲の画面と同じ見た目)。演奏中の行に色を付ける
function SheetPreview({ rows, cur, innerRef, onRow }) {
  const parsed = useMemo(() => rows.map((r) => (r.kind === 'blank' ? null : parseSheet(r.src).lines.find((l) => l.type !== 'blank'))), [rows]);
  return html`<div className="ear-sheet" ref=${innerRef}>
    ${rows.map((r, i) => {
      const l = parsed[i];
      if (!l || r.kind === 'blank') return html`<div key=${i} className="ln ln-blank"></div>`;
      if (l.type === 'label') return html`<div key=${i} className="ln ln-label"><span>${l.text}</span></div>`;
      if (!l.segs) return null;
      const hasChord = l.segs.some((s) => s.c);
      return html`<div key=${i} data-row=${i} className=${cx('ln', 'ln-' + l.type, i === cur && 'is-current')} onClick=${() => r.t0 != null && onRow(r.t0)}>
        ${l.segs.map(
          (s, k) => html`<span key=${k} className=${cx('seg', s.c && 'has-chord')}>
            ${hasChord
              ? html`<span className="ch">
                  ${s.bar ? html`<i className="bar" aria-hidden="true"></i>` : null}
                  ${s.c ? html`<span className="chord-name"><${ChordText} name=${pretty(s.c)} /></span>` : html`<span className="chord-space"> </span>`}
                </span>`
              : null}
            ${l.type === 'lyric' ? html`<span className="ly">${s.t || (s.c ? ' ' : '')}</span>` : null}
          </span>`,
        )}
      </div>`;
    })}
  </div>`;
}
