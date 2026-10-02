// 耳コピ: まだどのサイトにも譜面が無い曲の、コード進行の下書きを音から作る
// 1曲まるごと(マイク・パソコンの音・音のファイル)を聴き取り、歌詞が見つかればその行に当てはめる。
// 行の中のコードの位置は「その行だけを何度でも聴いて、コードが光ったときに歌っている文字をタップ」で正確に直せる。
// 手早く試すなら Apple Music の試聴30秒(曲の一部だけ・歌詞なし)。計算は端末の中だけ
import React, { useEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, PlayIcon } from './icons.js';
import { Artwork, ChordText, Sheet, Segmented, toast } from './common.js';
import { analyzeAudio, barsToSheet, toMonoHQ, resample, liveChord, SR } from '../music/earcopy.js';
import { fitLyrics, musicStart, makeWeights } from '../music/lyricsfit.js';
import { parseSheet } from '../music/sheet.js';
import { pretty, keyName } from '../music/chord.js';
import { findLyrics, lyricsFromInput } from '../lib/lyrics.js';
import { lib } from '../lib/store.js';
import { go, back } from '../lib/router.js';
import { cx, songIdFor, baseTitle, norm, sameArtist } from '../lib/util.js';
const html = htm.bind(React.createElement);

const MAX_SEC = 9 * 60; // 聴くのは9分まで
const MIN_SEC = 15;
const PLAY_SR = 22050; // 聴き直す用に残す音の細かさ(コードの計算は 11025Hz)
const TAP_DELAY = 0.15; // タップは聞こえてから少し遅れるので、そのぶん前にずらす
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

// 聴き直す用: 何Hzでも → PLAY_SR(直線でつなぐだけの簡単な変換)
function toPlayRate(x, from) {
  if (from === PLAY_SR) return x.slice();
  const n = Math.floor((x.length * PLAY_SR) / from);
  const out = new Float32Array(n);
  const r = from / PLAY_SR;
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const k = Math.floor(p);
    const f = p - k;
    out[i] = x[k] * (1 - f) + (k + 1 < x.length ? x[k + 1] : x[k]) * f;
  }
  return out;
}

// 録った音 → WAV の URL(音量はそろえる)
function wavUrl(chunks, total, sr) {
  let peak = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const g = peak ? 0.9 / peak : 1;
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + total * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks)
    for (let i = 0; i < c.length && o < 44 + total * 2; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i] * g));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const sureLabel = (c) => (c >= 0.16 ? ['聴き取りやすい曲でした', 'is-good'] : c >= 0.1 ? ['ふつうに聴き取れました', ''] : ['聴き取りにくい曲でした（下書きとして見てください）', 'is-low']);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const signedSec = (s) => (s > 0 ? `+${s.toFixed(1)}` : s < 0 ? `−${Math.abs(s).toFixed(1)}` : '±0');

export function EarCopy({ params }) {
  const [title, setTitle] = useState(params.title || '');
  const [artist, setArtist] = useState(params.artist || '');
  const [track, setTrack] = useState(null);
  const [lyrics, setLyrics] = useState(undefined); // undefined=探している / null=無い / { synced, plain, source, ruby }
  const [autoLyrics, setAutoLyrics] = useState(null); // 自動で見つけた歌詞(貼り付けから戻すとき用)
  const [lyricsForm, setLyricsForm] = useState(false);
  const [stage, setStage] = useState(null); // { text, p }
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { r, url, source, kind: full|preview, start, tapFirst }
  const [rec, setRec] = useState(null); // { sec, level, chord, kind, startAt, tapFirst }
  const recRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState({ bar: -1, row: -1 });
  const [shift, setShift] = useState(0); // 歌詞のタイミングの手直し(秒)
  const [taps, setTaps] = useState(null); // 時刻なしの歌詞: 行ごとにタップした録音の時刻
  const [tapping, setTapping] = useState(false);
  const [place, setPlace] = useState({}); // 耳で直したコードの位置 { 'i:時刻': 文字の位置 }
  const [checked, setChecked] = useState(() => new Set()); // 確かめ終わった行(i)
  const [align, setAlign] = useState(null); // 位置を合わせている行(rows の番号)
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
      if (!alive) return;
      const usable = ly && (ly.synced || ly.plain.some(Boolean)) ? ly : null;
      setAutoLyrics(ly);
      setLyrics(usable);
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [lookKey]);

  // 歌詞を変えたら、合わせた位置は最初から
  useEffect(() => {
    setPlace({});
    setChecked(new Set());
    setTaps(null);
    setShift(0);
  }, [lyrics]);

  useEffect(() => () => {
    stopPlay();
    stopRec(true);
  }, []);
  // 録った音の URL は使い終わったら捨てる
  useEffect(() => {
    const u = result?.url;
    return () => {
      if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
    };
  }, [result?.url]);

  const run = async (samples, url, source, extra) => {
    setError('');
    setResult(null);
    setPlace({});
    setChecked(new Set());
    setShift(0);
    setTaps(null);
    try {
      const r = await analyzeAudio(samples, { progress: (p, text) => setStage({ p, text }) });
      if (!r.bars.length) throw new Error('コードを聴き取れませんでした');
      setResult({ r, url, source, ...extra });
    } catch (e) {
      setError(e.message || '聴き取れませんでした');
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
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
      await run(await toMonoHQ(buf), it.previewUrl, '試聴30秒', { kind: 'preview' });
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
      await run(samples, URL.createObjectURL(file), 'ファイル', { kind: 'full', start: musicStart(samples, SR) ?? 0, tapFirst: null });
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
      const st = { ctx, stream, proc, chunks: [], total: 0, hq: [], hqTotal: 0, level: 0, kind, floor: [], loud: 0, startAt: null, tapFirst: null, timer: 0 };
      proc.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        st.level = Math.sqrt(s / d.length);
        const r = resample(d, ctx.sampleRate);
        st.chunks.push(r.slice());
        st.total += r.length;
        const h = toPlayRate(d, ctx.sampleRate);
        st.hq.push(h);
        st.hqTotal += h.length;
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
    const url = wavUrl(st.hq, st.hqTotal, PLAY_SR);
    st.hq = [];
    const start = musicStart(samples, SR) ?? st.startAt ?? 0;
    run(samples, url, st.kind === 'system' ? 'パソコンの音' : 'マイク', { kind: 'full', start, tapFirst: st.tapFirst });
  }

  // ---------------------------------------------------------------- 歌詞を当てはめる
  const weights = useMemo(() => makeWeights(lyrics?.ruby), [lyrics]);
  const fit = useMemo(() => {
    if (!result || result.kind !== 'full' || !lyrics) return null;
    const note = `耳コピの下書き（${result.source}・自動）・歌詞は${lyrics.source}`;
    if (lyrics.synced) {
      const first = lyrics.synced.find((l) => l.text);
      // 録音の時刻 = 歌詞の時刻 + ずれ。歌い出しのタップがあればそれ、無ければ曲が鳴り始めた時刻から
      const base = result.tapFirst != null ? result.tapFirst - 0.2 - first.t : result.start || 0;
      const off = base + shift;
      return { ...fitLyrics(result.r, lyrics.synced.map((l) => ({ t: l.t + off, text: l.text })), { note, weights, place }), mode: 'synced' };
    }
    if (taps && taps.length) {
      const lines = [];
      let k = 0;
      for (const l of lyrics.plain) {
        if (!l) lines.push({ t: (taps[k] ?? Infinity) - 0.01, text: '' });
        else if (k < taps.length) lines.push({ t: taps[k++], text: l });
      }
      return { ...fitLyrics(result.r, lines, { note, weights, place }), mode: 'tap' };
    }
    return null;
  }, [result, lyrics, shift, taps, place, weights]);
  const plainLines = useMemo(() => (lyrics?.plain || []).filter(Boolean), [lyrics]);
  const lyricRows = useMemo(() => (fit?.rows || []).map((r, k) => (r.kind === 'lyric' ? k : -1)).filter((k) => k >= 0), [fit]);

  // ---------------------------------------------------------------- 聴く(聴きながら確かめる・行だけ聴く・ゆっくり)
  function stopPlay() {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    setPlaying(false);
    setTapping(false);
    setCur({ bar: -1, row: -1 });
  }
  const rowsRef = useRef([]);
  rowsRef.current = fit?.rows || [];
  const now = () => audioRef.current?.currentTime ?? 0;
  const play = async (from = 0, { to = null, rate = 1 } = {}) => {
    const a = audioRef.current;
    if (!a || !result?.url) return;
    cancelAnimationFrame(rafRef.current);
    a.pause();
    if (a.readyState < 1) await new Promise((res) => a.addEventListener('loadedmetadata', res, { once: true }));
    a.playbackRate = rate;
    a.preservesPitch = true; // ゆっくりでも音の高さはそのまま
    a.webkitPreservesPitch = true;
    a.currentTime = Math.max(0, from);
    try {
      await a.play();
    } catch {
      return;
    }
    setPlaying(true);
    const bars = result.r.bars;
    let last = '';
    const step = () => {
      const t = a.currentTime;
      if (a.paused || a.ended || (to != null && t >= to)) {
        stopPlay();
        return;
      }
      const bar = bars.findIndex((b) => t >= b.t0 && t < b.t1);
      const row = rowsRef.current.findIndex((r) => r.t0 != null && r.kind !== 'label' && t >= r.t0 && t < r.t1);
      const key = bar + ':' + row;
      if (key !== last) {
        last = key;
        setCur({ bar, row });
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // 演奏中の行を見える位置に
  useEffect(() => {
    if (cur.row < 0 || !sheetRef.current || align != null) return;
    sheetRef.current.querySelector(`[data-row="${cur.row}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur.row]);

  // 時刻なしの歌詞: 再生しながら、各行の歌い出しでタップ
  const startTapping = async () => {
    setTaps([]);
    await play(0); // play の中で一度止めるので、合わせるモードはそのあとで
    setTapping(true);
  };
  const tapLine = () => {
    if (!audioRef.current || audioRef.current.paused) return;
    const t = Math.max(0, now() - TAP_DELAY);
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
  }, [tapping]);

  // ---------------------------------------------------------------- コードの位置を耳で合わせる
  // k 番目のコードを文字の位置 p へ。前後のコードと順番が入れ替わらないように、はみ出したものは一緒に動かす
  const placeChord = (line, k, p) => {
    const chords = line.toks.filter((t) => t.type === 'chord');
    if (!chords[k]) return;
    setPlace((prev) => {
      const next = { ...prev, [chords[k].key]: p };
      for (let j = k + 1; j < chords.length; j++) if ((next[chords[j].key] ?? chords[j].pos) < p) next[chords[j].key] = p;
      for (let j = k - 1; j >= 0; j--) if ((next[chords[j].key] ?? chords[j].pos) > p) next[chords[j].key] = p;
      return next;
    });
  };
  const resetLine = (line) =>
    setPlace((prev) => {
      const next = { ...prev };
      for (const t of line.toks) if (t.type === 'chord') delete next[t.key];
      return next;
    });
  const openAlign = (k) => {
    setAlign(k);
    const r = fit?.rows[k];
    if (r) play(Math.max(0, r.t0 - 0.8), { to: r.t1 + 0.3 });
  };
  const moveAlign = (dir) => {
    const at = lyricRows.indexOf(align);
    const k = lyricRows[at + dir];
    if (k != null) openAlign(k);
  };
  const checkLine = () => {
    const r = fit?.rows[align];
    if (r?.line) setChecked((s) => new Set(s).add(r.line.i));
    const at = lyricRows.indexOf(align);
    if (at + 1 < lyricRows.length) openAlign(lyricRows[at + 1]);
    else {
      stopPlay();
      setAlign(null);
      toast('最後の行まで確かめました');
    }
  };

  // ---------------------------------------------------------------- 歌詞を自分で指定する(サイトの URL か、貼り付け)
  const applyLyrics = async (input) => {
    const ly = await lyricsFromInput(input);
    // 自動で見つけたふりがなは、貼り付けた歌詞にも使う
    const ruby = new Map([...(autoLyrics?.ruby || []), ...ly.ruby]);
    setLyrics({ ...ly, ruby });
    setLyricsForm(false);
    toast(`歌詞を${ly.source}から読み込みました（${ly.plain.filter(Boolean).length}行）`);
  };

  // 拍子を選び直す(コードの聴き取りはそのまま、小節の区切りだけやり直す)。合わせたコードの位置は小節が変わるので最初から
  const changeMeter = (m) => {
    if (!result?.r.rebar || m === result.r.beatsPerBar) return;
    stopPlay();
    setPlace({});
    setChecked(new Set());
    setResult((prev) => ({ ...prev, r: { ...prev.r, ...prev.r.rebar(m) } }));
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
    const text = fit && fit.used ? fit.text : barsToSheet(result.r, { note: `耳コピの下書き（${result.source}・自動）` });
    const sheet = { text, key: null, bpm: result.r.bpm, beatsPerBar: result.r.beatsPerBar || 4, fetchedAt: new Date().toISOString() };
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
  const alignRow = align != null ? fit?.rows[align] : null;

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
    <div className=${cx('ear-lyrics-status', lyrics && 'is-found', lyrics === null && 'is-none')}>
      <${Icon} name=${lyrics ? 'check' : lyrics === null ? 'info' : 'search'} size=${16} />
      <span>
        ${lyrics === undefined
          ? '歌詞を探しています…'
          : lyrics === null
            ? '歌詞は見つかりませんでした。歌詞サイトのリンクか、歌詞そのものを貼り付けると当てはめられます'
            : lyrics.synced
              ? html`歌詞が見つかりました（${lyrics.source}・時刻つき）。1曲まるごと聴かせると、コードを歌詞の行に当てはめます`
              : html`歌詞: ${lyrics.source}（${plainLines.length}行）。時刻が無いので、聴き取ったあとに各行の歌い出しをタップして合わせます`}
        ${lyrics?.ruby?.size ? html` <small>ふりがな ${lyrics.ruby.size}語</small>` : null}
        ${durSec ? html` <small>曲の長さ ${mmss(durSec)}</small>` : null}
        ${lyrics !== undefined && !busy ? html` <button className="link-btn" onClick=${() => setLyricsForm(true)}>${lyrics ? '別の歌詞にする' : '歌詞を貼る'}</button>` : null}
      </span>
    </div>

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
                    <small>押すと「画面の共有」が出るので、曲を流すタブ（または画面）を選び「音声も共有する」をオンに。そのあと YouTube や Apple Music などで曲を最初から流してください</small>
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
    ${result ? html`<audio ref=${audioRef} src=${result.url} preload="auto" hidden></audio>` : null}
    ${error ? html`<p className="ear-error" role="alert">${error}</p>` : null}

    ${result
      ? html`<section className="ear-result">
          <div className="ear-summary">
            <b>Key ${keyName(result.r.key)}</b><span>♩=${result.r.bpm}</span><span>${result.r.bars.length}小節</span>
            <${Segmented}
              size="sm"
              label="拍子"
              value=${result.r.beatsPerBar || 4}
              onChange=${changeMeter}
              options=${[4, 3].map((m) => ({ value: m, label: `${m}拍子${m === result.r.detectedMeter ? '（自動）' : ''}` }))}
            />
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
            : html`<div className="row-gap ear-play-row">
                <button className="btn ear-play" onClick=${() => (playing ? stopPlay() : play(0))}>
                  <${PlayIcon} playing=${playing} size=${18} /> ${playing ? '止める' : '聴きながら確かめる'}
                </button>
                ${fit?.mode === 'synced'
                  ? html`<span className="ear-shift" role="group" aria-label="歌詞のタイミング">
                      <span className="muted small">歌詞全体のタイミング</span>
                      <button className="btn btn-sm" onClick=${() => setShift((s) => Math.round((s - 0.25) * 100) / 100)}>早く</button>
                      <b>${signedSec(shift)}秒</b>
                      <button className="btn btn-sm" onClick=${() => setShift((s) => Math.round((s + 0.25) * 100) / 100)}>遅く</button>
                    </span>`
                  : null}
              </div>`}

          ${result.kind === 'full' && lyrics && !lyrics.synced && !tapping
            ? html`<div className="ear-tap-intro">
                <p className="small">${taps?.length ? `${taps.length}行ぶん合わせました。` : '歌詞に時刻が無いので、曲を流しながら各行の歌い出しでタップして合わせます（1回聴くだけ）。'}</p>
                <button className="btn btn-sm btn-primary" onClick=${startTapping}>${taps?.length ? 'もう一度合わせる' : '歌詞の行に合わせる'}</button>
              </div>`
            : null}

          ${fit && fit.used
            ? html`<div className="ear-align-intro">
                  <p className="small">
                    <b>コードの位置を耳で確かめる</b>（${checked.size} / ${lyricRows.length}行）<br />
                    行をタップすると、その行だけを何度でも・ゆっくりでも聴けます。コードが光った瞬間に歌っている文字をタップすると、そこに決まります。
                  </p>
                  ${lyricRows.length ? html`<button className="btn btn-sm btn-primary" onClick=${() => openAlign(lyricRows.find((k) => !checked.has(fit.rows[k].line.i)) ?? lyricRows[0])}>${checked.size ? '続きから合わせる' : '1行目から合わせる'}</button>` : null}
                </div>
                <${SheetPreview} rows=${fit.rows} cur=${cur.row} innerRef=${sheetRef} checked=${checked} onRow=${(k) => {
                  const r = fit.rows[k];
                  if (r.kind === 'lyric') openAlign(k);
                  else if (r.t0 != null) play(Math.max(0, r.t0 - 0.3));
                }} />`
            : html`<div className="ear-bars">
                ${result.r.bars.map(
                  (b, i) => html`<button key=${i} className=${cx('ear-bar', i === cur.bar && 'is-now')} onClick=${() => play(b.t0)} aria-label=${`${i + 1}小節目 ${b.chords.join(' ')}`}>
                    <small>${i + 1}</small>
                    ${b.chords.map((c, k) => html`<span key=${k}><${ChordText} name=${pretty(c)} /></span>`)}
                  </button>`,
                )}
              </div>`}
          <p className="muted small">
            ${fit && fit.used
              ? `歌詞${fit.used}行にコードを当てはめました。自動の位置は、ふりがな（あれば）で数えた歌う長さからの見積もりです。耳で合わせた行には ✓ が付きます。`
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

    <${LyricsForm} open=${lyricsForm} onClose=${() => setLyricsForm(false)} onApply=${applyLyrics} canRestore=${!!autoLyrics && lyrics !== autoLyrics && (autoLyrics.synced || autoLyrics.plain.some(Boolean))} onRestore=${() => { setLyrics(autoLyrics); setLyricsForm(false); }} />
    <${Aligner}
      row=${alignRow}
      count=${lyricRows.length}
      index=${align != null ? lyricRows.indexOf(align) : -1}
      audioRef=${audioRef}
      play=${play}
      playing=${playing}
      stop=${stopPlay}
      onClose=${() => { stopPlay(); setAlign(null); }}
      onPlace=${placeChord}
      onReset=${resetLine}
      onMove=${moveAlign}
      onCheck=${checkLine}
      checked=${alignRow?.line ? checked.has(alignRow.line.i) : false}
    />
  </div>`;
}

// 歌詞を当てはめた下書きの見本(曲の画面と同じ見た目)。演奏中の行に色を付ける
function SheetPreview({ rows, cur, innerRef, onRow, checked }) {
  const parsed = useMemo(() => rows.map((r) => (r.kind === 'blank' ? null : parseSheet(r.src).lines.find((l) => l.type !== 'blank'))), [rows]);
  return html`<div className="ear-sheet" ref=${innerRef}>
    ${rows.map((r, i) => {
      const l = parsed[i];
      if (!l || r.kind === 'blank') return html`<div key=${i} className="ln ln-blank"></div>`;
      if (l.type === 'label') return html`<div key=${i} className="ln ln-label"><span>${l.text}</span></div>`;
      if (!l.segs) return null;
      const hasChord = l.segs.some((s) => s.c);
      const ok = r.line && checked.has(r.line.i);
      return html`<div key=${i} data-row=${i} className=${cx('ln', 'ln-' + l.type, i === cur && 'is-current', ok && 'is-checked')} onClick=${() => onRow(i)}>
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
        ${r.kind === 'lyric' ? html`<span className=${cx('ln-check', ok && 'is-on')} aria-label=${ok ? '確かめた行' : 'タップして合わせる'}>${ok ? '✓' : '合わせる'}</span>` : null}
      </div>`;
    })}
  </div>`;
}

// 今歌っているあたりの文字。合わせたコードの位置(時刻と文字)を目印にして、目印の間は歌う長さの割合で割り振る
function singingAt(line, chords, t) {
  const n = line.chars.length;
  if (t < line.s || t >= line.e || !n) return -1;
  const marks = [{ t: line.s, p: 0 }, ...chords.filter((c) => c.t > line.s && c.t < line.e).map((c) => ({ t: c.t, p: c.pos })), { t: line.e, p: n }];
  let k = 0;
  while (k + 2 < marks.length && marks[k + 1].t <= t) k++;
  const a = marks[k];
  const b = marks[k + 1];
  if (b.p <= a.p) return Math.min(n - 1, a.p);
  const w = line.weights.slice(a.p, b.p);
  const total = w.reduce((x, y) => x + y, 0) || 1;
  const goal = ((t - a.t) / Math.max(0.01, b.t - a.t)) * total;
  let acc = 0;
  let p = a.p;
  for (const x of w) {
    if (acc + x > goal) break;
    acc += x;
    p++;
  }
  return Math.min(n - 1, p);
}

// 1行ぶんのコードの位置を、耳で合わせる
// 行だけを聴く(1 / 0.75 / 0.5倍、音の高さはそのまま)。コードは鳴り始めた瞬間に光り、今歌っているあたりの文字にも印が付く
function Aligner({ row, count, index, audioRef, play, playing, stop, onClose, onPlace, onReset, onMove, onCheck, checked }) {
  const [sel, setSel] = useState(0);
  const [rate, setRate] = useState(1);
  const [t, setT] = useState(-1);
  const line = row?.line || null;
  const chords = line ? line.toks.filter((x) => x.type === 'chord') : [];
  useEffect(() => setSel(0), [line?.i]);
  // 再生位置を見て、光らせるコードと文字を決める
  useEffect(() => {
    if (!line || !playing) {
      setT(-1);
      return;
    }
    let raf = 0;
    const step = () => {
      setT(audioRef.current?.currentTime ?? -1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [line?.i, playing]);
  if (!row || !line) return html`<${Sheet} open=${false} onClose=${onClose} title="コードの位置" />`;

  const n = line.chars.length;
  const lit = t < 0 ? -1 : chords.reduce((acc, c, k) => (c.t <= t + 0.02 ? k : acc), -1);
  const singing = singingAt(line, chords, t);
  const listen = (from) => play(Math.max(0, from), { to: row.t1 + 0.3, rate });
  const pick = (p) => {
    onPlace(line, sel, p);
    if (sel + 1 < chords.length) setSel(sel + 1);
  };

  return html`<${Sheet} open=${true} onClose=${onClose} title="コードの位置を合わせる" heading=${`コードの位置を合わせる（${index + 1} / ${count}行目）`} wide=${true}>
    <p className="al-help">
      ① 下のコードを選ぶ　② ▶で聴いて、そのコードが<b>光った瞬間に歌っている文字</b>をタップ。合わせると次のコードへ進みます。
    </p>
    <div className="al-line" role="group" aria-label="歌詞の文字">
      ${[...line.chars, ''].map((ch, p) => {
        const here = chords.map((c, k) => ({ c, k })).filter((x) => x.c.pos === p);
        return html`<button key=${p} className=${cx('al-cell', p === n && 'is-end', p === singing && 'is-singing')} onClick=${() => pick(p)} aria-label=${p === n ? '行の最後' : `${p + 1}文字目 ${ch}`}>
          <span className="al-cell-chords">
            ${here.map((x) => html`<span key=${x.k} className=${cx('al-mark', x.k === sel && 'is-sel', x.k === lit && 'is-lit', x.c.fixed && 'is-fixed')}><${ChordText} name=${pretty(x.c.c)} /></span>`)}
          </span>
          <span className="al-cell-ch">${p === n ? '⏎' : ch === ' ' ? '␣' : ch}</span>
        </button>`;
      })}
    </div>
    <div className="al-chips" role="radiogroup" aria-label="合わせるコード">
      ${chords.map(
        (c, k) => html`<button key=${c.key} role="radio" aria-checked=${k === sel} className=${cx('al-chip', k === sel && 'is-sel', k === lit && 'is-lit', c.fixed && 'is-fixed')} onClick=${() => { setSel(k); listen(c.t - 1.6); }}>
          <${ChordText} name=${pretty(c.c)} />${c.fixed ? html`<small>✓</small>` : null}
        </button>`,
      )}
    </div>
    <div className="al-controls">
      <button className="btn btn-primary" onClick=${() => (playing ? stop() : listen(row.t0 - 0.8))}><${PlayIcon} playing=${playing} size=${18} /> ${playing ? '止める' : 'この行を聴く'}</button>
      <${Segmented} size="sm" label="速さ" value=${rate} onChange=${setRate} options=${[{ value: 1, label: '1倍' }, { value: 0.75, label: '0.75' }, { value: 0.5, label: '0.5' }]} />
      <button className="btn btn-sm btn-ghost" onClick=${() => onReset(line)}>自動の位置に戻す</button>
    </div>
    <div className="al-nav">
      <button className="btn btn-sm" onClick=${() => onMove(-1)} disabled=${index <= 0} aria-label="前の行"><${Icon} name="back" size=${16} /> 前</button>
      <button className="btn btn-primary" onClick=${onCheck}><${Icon} name="check" size=${18} /> ${checked ? '次の行へ' : 'この行はOK・次へ'}</button>
      <button className="btn btn-sm" onClick=${() => onMove(1)} disabled=${index >= count - 1} aria-label="次の行">次 <${Icon} name="chevron" size=${16} /></button>
    </div>
  </${Sheet}>`;
}

// 歌詞サイトのリンク、または歌詞そのものを貼り付けて使う
function LyricsForm({ open, onClose, onApply, canRestore, onRestore }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await onApply(text);
      setText('');
    } catch (e) {
      setErr(e.message || '読み込めませんでした');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="歌詞を指定する">
    <p className="small muted">歌詞サイトのページのリンク（歌ネット・UtaTen・J-Lyric・歌詞GET・プチリリ など）か、歌詞そのものを貼り付けてください。UtaTen はふりがな付きなので、コードの位置の見積もりがより正確になります。</p>
    <textarea className="ear-lyrics-input" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${'https://utaten.com/lyric/...\nまたは歌詞をそのまま'}></textarea>
    ${err ? html`<p className="ear-error" role="alert">${err}</p>` : null}
    <div className="row-gap">
      <button className="btn btn-primary" onClick=${submit} disabled=${busy || !text.trim()}>${busy ? '読み込んでいます…' : 'この歌詞を使う'}</button>
      ${canRestore ? html`<button className="btn" onClick=${onRestore}>自動で見つけた歌詞に戻す</button>` : null}
    </div>
    <p className="small muted">時刻の無い歌詞は、聴き取ったあとに曲を流しながら各行の歌い出しをタップして合わせます。</p>
  </${Sheet}>`;
}
