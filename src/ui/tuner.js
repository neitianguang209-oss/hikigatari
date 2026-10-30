// チューナー(ギターの音合わせ)。マイクの音から高さを測る。音は端末の外に出さない
// マイクが使えなくても、弦ごとの見本の音は鳴らせる
// 見た目と使い方は、定番のギターチューナーのアプリにならった形:
// ・ヘッド(糸巻き)の絵の上に6本の弦。鳴らした弦が光り、合った弦は緑の ✓
// ・横の目盛りの上を音名の丸が左右に動き、真ん中の緑に入ればぴったり。下に音の高さの流れ(線)
// ・自動(どの弦か自動) / 弦を選ぶ(押した弦だけを狙う) / クロマチック(どの音でも)
// ・チューニングの種類(標準・半音下げ・ドロップD・オープンG など)と、基準の A の高さ(440Hz など)
//
// iPhone でも確実に音が入るように:
// ・マイクを先に開いてから、そのマイク専用の音の部品(AudioContext)を作る
//   (先に作った部品にマイクをつなぐと、iPhone では無音しか届かないことがある)
// ・マイクを使う間は iPhone の音の扱いを「録音と再生」にする(メトロノームの「再生だけ」のままだとマイクが止まる)
// ・解析の部品は無音の出口までつなぐ(つながっていないと処理が止まる端末がある)
// ・それでも音がまったく届かない(ずっと 0)ときは、作り方を変えて自動でやり直す
// ・アプリを裏に回すとマイクは止まるので、戻ってきたら聞き直す
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { Sheet } from './common.js';
import { cx, signed } from '../lib/util.js';
import { chime, holdPlayback, releasePlayback, audioCtx, beginCapture, endCapture } from '../lib/sound.js';
import { detectPitch, freqOf, midiOf, rmsOf } from '../music/pitch.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
const html = htm.bind(React.createElement);
export { detectPitch };

// チューニングの種類。midi は 6弦 → 1弦、names はその音名
export const TUNINGS = [
  { id: 'std', name: '標準', sub: 'E A D G B E', midi: [40, 45, 50, 55, 59, 64], names: ['E', 'A', 'D', 'G', 'B', 'E'] },
  { id: 'half', name: '半音下げ', sub: 'E♭ A♭ D♭ G♭ B♭ E♭', midi: [39, 44, 49, 54, 58, 63], names: ['E♭', 'A♭', 'D♭', 'G♭', 'B♭', 'E♭'] },
  { id: 'whole', name: '全音下げ', sub: 'D G C F A D', midi: [38, 43, 48, 53, 57, 62], names: ['D', 'G', 'C', 'F', 'A', 'D'] },
  { id: 'dropd', name: 'ドロップD', sub: 'D A D G B E', midi: [38, 45, 50, 55, 59, 64], names: ['D', 'A', 'D', 'G', 'B', 'E'] },
  { id: 'dropcs', name: 'ドロップC♯', sub: 'C♯ G♯ C♯ F♯ A♯ D♯', midi: [37, 44, 49, 54, 58, 63], names: ['C♯', 'G♯', 'C♯', 'F♯', 'A♯', 'D♯'] },
  { id: 'openg', name: 'オープンG', sub: 'D G D G B D', midi: [38, 43, 50, 55, 59, 62], names: ['D', 'G', 'D', 'G', 'B', 'D'] },
  { id: 'opend', name: 'オープンD', sub: 'D A D F♯ A D', midi: [38, 45, 50, 54, 57, 62], names: ['D', 'A', 'D', 'F♯', 'A', 'D'] },
  { id: 'dadgad', name: 'DADGAD', sub: 'D A D G A D', midi: [38, 45, 50, 55, 57, 62], names: ['D', 'A', 'D', 'G', 'A', 'D'] },
];
const stringsOf = (tu) => tu.midi.map((m, i) => ({ n: 6 - i, name: tu.names[i], midi: m }));
const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const DO = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const IN_TUNE = 4; // ±4セント以内なら合っている
const TICK = 30; // 何ミリ秒ごとに測るか
const TRACE_MS = 3200; // 音の高さの流れを何ミリ秒ぶん出すか
const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: MIC });
  } catch (e) {
    // 細かい指定を受け付けない端末は、ふつうのマイクで
    if (e && (e.name === 'OverconstrainedError' || e.name === 'TypeError')) return navigator.mediaDevices.getUserMedia({ audio: true });
    throw e;
  }
}

// 音の部品が動き出すのを少しだけ待つ(動かなければ false)
function waitRunning(ctx, ms) {
  if (ctx.state === 'running') return Promise.resolve(true);
  return new Promise((res) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      res(ctx.state === 'running');
    };
    try {
      ctx.resume().then(fin, fin);
    } catch {}
    setTimeout(fin, ms);
  });
}

function newCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    return new AC({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

// マイク → 低いうなり(55Hz 未満)を切る → 高い音(1.5kHz 超)を切る → 解析 → 音量0で出口へ
function buildGraph(ctx, stream) {
  const src = ctx.createMediaStreamSource(stream);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 55;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0.707;
  const an = ctx.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(hp);
  hp.connect(lp);
  lp.connect(an);
  an.connect(mute);
  mute.connect(ctx.destination);
  return { an, nodes: [src, hp, lp, an, mute] };
}

// 見本の音(はじいた弦に近い、すぐ減衰する音)。f: 周波数
function playTone(f, c = null) {
  try {
    const toneCtx = c || audioCtx();
    const t = toneCtx.currentTime + 0.01;
    const out = toneCtx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    const lp = toneCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 8, t);
    lp.frequency.exponentialRampToValueAtTime(f * 2, t + 1.2);
    lp.connect(out).connect(toneCtx.destination);
    for (const [mul, type, g] of [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]]) {
      const o = toneCtx.createOscillator();
      const og = toneCtx.createGain();
      o.type = type;
      o.frequency.value = f * mul;
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + 2.7);
    }
  } catch {}
}

// 開いた瞬間(タップの中)に音の部品を動かしておく(マイクが開くまでの間に使う)
export function prepareTuner() {
  audioCtx();
}

export function TunerSheet({ open, onClose }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="チューナー">
    <${Tuner} />
  </${Sheet}>`;
}

// 入ってくる音の大きさ(rms) → メーターの長さ 0〜1(−66dB 〜 −16dB)
const meterOf = (v) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 66) / 50));

const MODES = [
  { value: 'auto', label: '自動' },
  { value: 'pick', label: '弦を選ぶ' },
  { value: 'chroma', label: 'クロマチック' },
];

function Tuner() {
  // starting | on | tap(タップで動かす) | denied | error | silent(音が届かない)
  const [status, setStatus] = useState('starting');
  const [reading, setReading] = useState(null); // { midi, cents, freq, string, pc }
  const [level, setLevel] = useState(0);
  const [hush, setHush] = useState(false); // 聞いているのに、しばらく音の高さが取れていない
  const [trace, setTrace] = useState([]); // 音の高さの流れ [{ t, c }](c = セント。音が無いところは null)
  // 設定(端末に覚える): チューニング・モード・基準の A の高さ
  const [tuningId, setTuningId] = useState(() => getPrefs().tunerTuning || 'std');
  const [mode, setMode] = useState(() => getPrefs().tunerMode || 'auto');
  const [a4, setA4] = useState(() => getPrefs().tunerA4 || 440);
  const [target, setTarget] = useState(null); // 「弦を選ぶ」で狙っている弦の番号
  const [showTunings, setShowTunings] = useState(false);
  const tuning = TUNINGS.find((t) => t.id === tuningId) || TUNINGS[0];
  const STRINGS = stringsOf(tuning);
  // 測る処理(setInterval の中)からいまの設定を読むため
  const cfg = useRef({});
  cfg.current = { STRINGS, mode, a4, target };
  // 合わせ終わった弦(ぴったりが0.5秒続いたら「ピコン」)と、弦ごとの最後のずれ(セント)
  const [done, setDone] = useState(() => new Set());
  const doneRef = useRef(new Set());
  const [last, setLast] = useState({});
  const eng = useRef(null); // いま動いているマイクの仕組み
  const run = useRef(0); // 始め直すたびに増やす(古い処理が後から割り込まないように)
  const alive = useRef(true);
  const captured = useRef(false);
  const toneUntil = useRef(0);

  const resetDone = () => {
    doneRef.current = new Set();
    setDone(new Set());
    setLast({});
  };
  const pickTuning = (id) => {
    setTuningId(id);
    setPrefs({ tunerTuning: id });
    setShowTunings(false);
    setTarget(null);
    resetDone();
  };
  const pickMode = (m) => {
    setMode(m);
    setPrefs({ tunerMode: m });
    if (m !== 'pick') setTarget(null);
  };
  const changeA4 = (d) => {
    const v = Math.max(430, Math.min(450, (cfg.current.a4 || 440) + d));
    cfg.current.a4 = v; // 続けて押したとき、画面が書きかわる前でも次の値から
    setA4(v);
    setPrefs({ tunerA4: v === 440 ? null : v });
    resetDone();
  };

  const capture = (on) => {
    if (on && !captured.current) beginCapture();
    if (!on && captured.current) endCapture();
    captured.current = on;
  };

  // 音の部品をはずす(マイクはそのまま)
  const detach = (e) => {
    if (!e) return;
    clearInterval(e.timer);
    try {
      e.g?.nodes.forEach((n) => n.disconnect());
    } catch {}
    if (e.ctx) e.ctx.onstatechange = null;
    if (e.own) e.ctx?.close?.().catch?.(() => {});
  };
  const stopAll = () => {
    run.current++;
    const e = eng.current;
    eng.current = null;
    detach(e);
    e?.stream?.getTracks().forEach((t) => t.stop());
    capture(false);
  };

  // マイクの音を音の部品につないで、測り始める。ways: まだ試していない作り方(fresh = 新しく作る / shared = アプリ共通のもの)
  const attach = async (stream, ways, my, reopened = false) => {
    for (let k = 0; k < ways.length; k++) {
      const way = ways[k];
      const ctx = way === 'fresh' ? newCtx() : audioCtx();
      if (!ctx) continue;
      const ok = await waitRunning(ctx, 900);
      if (my !== run.current) {
        // 待っている間に閉じられた・始め直された: このマイクはもう使わない
        if (way === 'fresh') ctx.close?.().catch?.(() => {});
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!ok) {
        if (way === 'fresh') ctx.close?.().catch?.(() => {});
        continue;
      }
      let g;
      try {
        g = buildGraph(ctx, stream);
      } catch {
        if (way === 'fresh') ctx.close?.().catch?.(() => {});
        continue;
      }
      const e = { stream, ctx, own: way === 'fresh', g, rest: ways.slice(k + 1), reopened, t0: performance.now(), heard: false, my };
      eng.current = e;
      listen(e);
      setStatus('on');
      return;
    }
    // どの作り方でも音の部品が動かなかった(タップが必要)
    stream.getTracks().forEach((t) => t.stop());
    capture(false);
    if (my === run.current) setStatus('tap');
  };

  const start = async (fromTap = false) => {
    stopAll();
    const my = run.current;
    setStatus('starting');
    setHush(false);
    if (fromTap) audioCtx(); // タップの中で、共通の音の部品を動かしておく
    let stream;
    try {
      capture(true);
      stream = await getMic();
    } catch (e) {
      capture(false);
      if (my === run.current) setStatus(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'error');
      return;
    }
    // 許可を待つあいだに閉じられていたら、マイクをすぐ止める
    if (!alive.current || my !== run.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    watchEnd(stream);
    attach(stream, ['fresh', 'shared'], my);
  };
  // ほかのアプリにマイクを取られた等でマイクが止まったら、見えているなら聞き直す
  const watchEnd = (stream) => {
    const tr = stream.getAudioTracks()[0];
    if (tr)
      tr.onended = () => {
        if (eng.current?.stream === stream && alive.current && document.visibilityState === 'visible') start();
      };
  };

  // ---- 測る
  const listen = (e) => {
    const { an } = e.g;
    const ctx = e.ctx;
    const sr = ctx.sampleRate;
    const buf = new Float32Array(an.fftSize);
    const hist = [];
    const tr = []; // 音の高さの流れ
    let floor = null; // まわりの雑音の大きさ
    let lastHeard = performance.now();
    let cur = null; // いま合わせている弦 { n, mm }(ペグを回して音がなめらかに動く間は同じ弦とみなす)
    let quietUntil = 0; // 「ピコン」の音をマイクで拾わないよう、鳴らした直後は測らない
    let okSince = 0;
    let okString = null;
    let lastLevel = -1;
    let shown = null; // 画面に出しているセント(なめらかにする)
    let lastTrace = 0;
    const pushTrace = (now, c) => {
      tr.push({ t: now, c });
      while (tr.length && now - tr[0].t > TRACE_MS) tr.shift();
      if (now - lastTrace > 60) {
        lastTrace = now;
        setTrace(tr.slice());
      }
    };
    ctx.onstatechange = () => {
      if (eng.current !== e) return;
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        waitRunning(ctx, 1200).then((ok) => {
          if (!ok && eng.current === e) {
            stopAll();
            setStatus('tap');
          }
        });
      }
    };
    e.timer = setInterval(() => {
      if (eng.current !== e) return;
      if (an.getFloatTimeDomainData) an.getFloatTimeDomainData(buf);
      else {
        const b8 = new Uint8Array(an.fftSize);
        an.getByteTimeDomainData(b8);
        for (let i = 0; i < b8.length; i++) buf[i] = (b8[i] - 128) / 128;
      }
      const now = performance.now();
      // 音がまったく届いていない(ずっと 0)なら、作り方を変えてやり直す
      if (!e.heard) {
        for (let i = 0; i < buf.length; i += 7)
          if (buf[i] !== 0) {
            e.heard = true;
            break;
          }
        if (!e.heard) {
          if (now - e.t0 > 1600) {
            detach(e);
            eng.current = null;
            if (e.rest.length) attach(e.stream, e.rest, e.my, e.reopened);
            else if (!e.reopened) {
              // マイクそのものを開き直して、もう一度
              e.stream.getTracks().forEach((t) => t.stop());
              getMic()
                .then((s) => {
                  if (e.my !== run.current) return s.getTracks().forEach((t) => t.stop());
                  watchEnd(s);
                  attach(s, ['fresh', 'shared'], e.my, true);
                })
                .catch(() => e.my === run.current && (capture(false), setStatus('error')));
            } else {
              e.stream.getTracks().forEach((t) => t.stop());
              capture(false);
              setStatus('silent');
            }
          }
          return;
        }
      }
      const lv = rmsOf(buf);
      floor = floor == null ? lv : lv < floor ? (lv + floor) / 2 : Math.min(0.02, floor * 1.003);
      const m = meterOf(lv);
      if (Math.abs(m - lastLevel) > 0.02) {
        lastLevel = m;
        setLevel(m);
      }
      if (now < quietUntil || now < toneUntil.current) return;
      const { STRINGS: SS, mode: md, a4: A, target: tg } = cfg.current;
      const p = detectPitch(buf, sr, { gate: Math.max(0.0008, floor * 2.5) });
      if (!p || p.freq < 60 || p.freq > 1100) {
        if (now - lastHeard > 1200) {
          hist.length = 0;
          cur = null;
          shown = null;
          okSince = 0;
          setReading(null);
        }
        pushTrace(now, null);
        if (now - lastHeard > 6000) setHush(true);
        return;
      }
      // 基準の A の高さ(440Hz 以外)は、そのぶん音の番号をずらして数える
      const mNow = midiOf(p.freq) - 12 * Math.log2(A / 440);
      // 別の音に変わったら、ならしをやり直す。新しい音は2回続けて聞こえてから出す(弾いた瞬間の雑音で針が飛ばないように)
      if (hist.length && Math.abs(mNow - hist[hist.length - 1]) > 0.6) {
        hist.length = 0;
        shown = null;
      }
      hist.push(mNow);
      if (hist.length > 5) hist.shift();
      if (hist.length < 2) return;
      lastHeard = now;
      setHush(false);
      const sorted = [...hist].sort((a, b) => a - b);
      let mm = sorted[sorted.length >> 1];
      let rd;
      if (md === 'chroma') {
        // どの音でも、いちばん近い音名に合わせる
        const n = Math.round(mm);
        rd = { midi: n, cents: (mm - n) * 100, freq: p.freq, string: null };
      } else {
        let str = null;
        if (md === 'pick' && tg) {
          // 選んだ弦だけを狙う。1オクターブずれて聞こえた(倍音)ときは折り返す
          str = SS.find((s) => s.n === tg);
          while (mm - str.midi > 7) mm -= 12;
          while (str.midi - mm > 7) mm += 12;
        } else {
          // どの弦かを自動で決める: 合わせている途中の弦は、音がなめらかにつながる限りその弦のまま
          // (大きくずれた弦を巻き上げていく途中で、となりの弦と取り違えないように)
          if (cur) {
            const t = SS.find((s) => s.n === cur.n);
            // 低い弦の倍音(1オクターブ上)を拾ったときは折り返す
            if (t && Math.abs(Math.abs(mm - t.midi) - 12) < 1.2) mm -= Math.sign(mm - t.midi) * 12;
            if (t && Math.abs(mm - cur.mm) < 1 && Math.abs(mm - t.midi) < 5) str = t;
          }
          if (!str) str = SS.reduce((a, b) => (Math.abs(b.midi - mm) < Math.abs(a.midi - mm) ? b : a));
          cur = { n: str.n, mm };
        }
        rd = { midi: str.midi, cents: (mm - str.midi) * 100, freq: p.freq, string: str.n };
      }
      // 目盛りの動き: 大きく動いたときはすぐ、近くでは少しならして、ぶるぶる震えないように
      const raw = rd.cents;
      shown = shown == null || Math.abs(raw - shown) > 12 ? raw : shown + (raw - shown) * 0.45;
      rd.cents = Math.round(shown);
      rd.pc = ((rd.midi % 12) + 12) % 12;
      setReading(rd);
      pushTrace(now, Math.max(-50, Math.min(50, shown)));
      if (rd.string == null) return;
      setLast((x) => (x[rd.string] === rd.cents ? x : { ...x, [rd.string]: rd.cents }));
      const D = doneRef.current;
      if (Math.abs(rd.cents) <= IN_TUNE) {
        if (okString !== rd.string) {
          okString = rd.string;
          okSince = now;
        }
        // ぴったりが0.5秒続いたら、その弦はできあがり
        if (now - okSince >= 500 && !D.has(rd.string)) {
          D.add(rd.string);
          doneRef.current = new Set(D);
          setDone(new Set(D));
          chime(D.size === SS.length, ctx);
          quietUntil = now + (D.size === SS.length ? 900 : 600);
          hist.length = 0;
          // 「弦を選ぶ」のときは、まだの弦へ自動で進む(6弦 → 1弦の順)
          if (cfg.current.mode === 'pick') {
            const next = SS.find((s) => !D.has(s.n));
            setTarget(next ? next.n : null);
          }
        }
      } else {
        okString = null;
        // 合わせたあとで大きくずれたら、印を外す
        if (Math.abs(rd.cents) > 15 && D.has(rd.string)) {
          D.delete(rd.string);
          doneRef.current = new Set(D);
          setDone(new Set(D));
        }
      }
    }, TICK);
  };

  // 開いたらすぐ聞き始める。閉じたら止める
  useEffect(() => {
    alive.current = true;
    start();
    // アプリを裏に回すとマイクは止まるので、戻ってきたら聞き直す
    const onVis = () => {
      if (!alive.current) return;
      if (document.visibilityState === 'hidden') {
        if (eng.current) {
          stopAll();
          setStatus('starting');
        }
      } else if (!eng.current) start();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVis);
      stopAll();
    };
  }, []);

  // 弦(糸巻き)を押した: 見本の音を鳴らす。「弦を選ぶ」のときは、その弦を狙う
  const pickString = (s) => {
    if (mode === 'chroma') pickMode('auto');
    if (mode === 'pick') setTarget(s.n);
    const f = freqOf(s.midi) * (a4 / 440);
    const listening = !!eng.current;
    if (listening) {
      // 聞いている間は、見本の音をマイクで拾って「合った」にならないよう、鳴っている間は測らない
      toneUntil.current = performance.now() + 2600;
      playTone(f, eng.current.ctx);
      return;
    }
    // マイクを使っていないときは、マナーモードでも見本の音が聞こえるようにする
    holdPlayback();
    playTone(f);
    setTimeout(releasePlayback, 2800);
  };

  const on = status === 'on';
  const cents = reading ? reading.cents : 0;
  const ok = reading && Math.abs(cents) <= IN_TUNE;
  const abs = Math.abs(cents);
  const allDone = done.size === STRINGS.length;
  const active = reading?.string ?? (mode === 'pick' ? target : null);
  const tgt = STRINGS.find((s) => s.n === active);
  // どれくらい離れているか: 50セント(半音の半分)までは「あと何セント」、それより大きいときは「半音いくつぶん」
  const guide = !reading
    ? allDone && mode !== 'chroma'
      ? '6本ぜんぶ合いました！'
      : on
        ? hush
          ? level > 0.35
            ? '音は聞こえています。弦を1本ずつ、はっきり鳴らしてください'
            : '音が小さいようです。ギターを端末のマイクに近づけて鳴らしてください'
          : mode === 'pick'
            ? target
              ? `${target}弦（${tgt?.name}）を鳴らしてください`
              : '合わせる弦を、下の糸巻きから選んでください'
            : '弦を1本ずつ鳴らしてください'
        : ''
    : ok
      ? reading.string && done.has(reading.string)
        ? `ぴったり！ ${reading.string}弦 OK`
        : 'ぴったり！ そのまま鳴らしていてください'
      : mode === 'chroma'
        ? `${cents < 0 ? '低い' : '高い'}（${abs} セント）`
        : abs > 50
          ? `かなり${cents < 0 ? '低い' : '高い'}（半音 ${(abs / 100).toFixed(1)} 個ぶん）… ペグを${cents < 0 ? '巻いて上げる' : 'ゆるめて下げる'}`
          : `少し${cents < 0 ? '低い' : '高い'}（あと ${abs} セント）… ペグを少し${cents < 0 ? '巻く' : 'ゆるめる'}`;

  const help =
    status === 'denied'
      ? 'マイクが許可されていません。iPhone は 設定 → Safari → マイク（ホーム画面から開いた場合は 設定 → アプリ → Safari → マイク）で「許可」にしてから、下のボタンを押してください。糸巻きを押すと見本の音が鳴るので、耳で合わせることもできます。'
      : status === 'silent'
        ? 'マイクから音が届いていません。通話・録音・ビデオなど、ほかのアプリがマイクを使っていないか確かめてから、もう一度押してください。'
        : status === 'error'
          ? 'マイクを使えませんでした。もう一度押すか、糸巻きを押して見本の音を鳴らし、耳で合わせてください。'
          : status === 'tap'
            ? '音を測る準備のため、一度だけタップしてください。'
            : '';

  // 目盛りの上の丸の位置(±50セントを左右いっぱいに)
  const x = reading ? 50 + Math.max(-50, Math.min(50, cents)) : 50;
  const noteName = reading ? (mode !== 'chroma' && tgt ? tgt.name : NOTE[reading.pc]) : mode === 'pick' && tgt ? tgt.name : '–';
  const now = performance.now();

  return html`<div className=${cx('tuner', ok && 'is-ok', reading && 'is-live')}>
    <div className="tn-top">
      <button className="tn-tuning" onClick=${() => setShowTunings(!showTunings)} aria-expanded=${showTunings}>
        <span><b>${tuning.name}</b><small>${tuning.sub}</small></span>
        <${Icon} name="chevron" size=${16} />
      </button>
      <div className="tn-a4" role="group" aria-label="基準の A の高さ">
        <button onClick=${() => changeA4(-1)} aria-label="基準を下げる">−</button>
        <span>A=${a4}</span>
        <button onClick=${() => changeA4(1)} aria-label="基準を上げる">＋</button>
      </div>
    </div>
    ${showTunings
      ? html`<div className="tn-tunings" role="listbox" aria-label="チューニング">
          ${TUNINGS.map(
            (t) => html`<button key=${t.id} role="option" aria-selected=${t.id === tuning.id} className=${cx('tn-tuning-item', t.id === tuning.id && 'is-on')} onClick=${() => pickTuning(t.id)}>
              <b>${t.name}</b><small>${t.sub}</small>
            </button>`,
          )}
        </div>`
      : null}

    <div className="tn-modes" role="group" aria-label="モード">
      ${MODES.map((m) => html`<button key=${m.value} className=${cx('tn-mode', mode === m.value && 'is-on')} aria-pressed=${mode === m.value} onClick=${() => pickMode(m.value)}>${m.label}</button>`)}
    </div>

    <div className="tn-meter" aria-hidden="true">
      <div className="tn-scale">
        <span className="tn-zone"></span>
        ${[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((c) => html`<i key=${c} className=${cx('tn-tick', c % 50 === 0 && 'is-big', c === 0 && 'is-zero')} style=${{ left: `${50 + c}%` }}></i>`)}
        <div className="tn-bubble" style=${{ left: `${x}%` }}>
          <b>${noteName}</b>
        </div>
      </div>
      <div className="tn-scale-labels"><span>♭ 低い</span><span>高い ♯</span></div>
      <svg className="tn-trace" viewBox="0 0 100 40" preserveAspectRatio="none">
        <line x1="50" y1="0" x2="50" y2="40" className="tn-trace-mid" />
        ${trace.length > 1 ? html`<path d=${tracePath(trace, now)} className="tn-trace-line" />` : null}
      </svg>
    </div>

    <div className="tn-readout">
      <div className=${cx('tn-cents', reading && !ok && (abs > 50 ? 'is-far' : 'is-near'))}>
        ${reading ? html`<b>${ok ? '✓' : signed(cents)}</b>${ok ? '' : ' セント'}` : html`<b> </b>`}
      </div>
      <div className="tn-sub">${reading ? `${DO[reading.pc]}${reading.string ? ` ・ ${reading.string}弦` : ''} ・ ${reading.freq.toFixed(1)} Hz` : on ? '聞いています…' : ' '}</div>
      ${reading && !ok && mode !== 'chroma' ? html`<div className=${cx('tn-turn', cents < 0 ? 'is-up' : 'is-down')}>${cents < 0 ? '↑ 巻いて上げる' : '↓ ゆるめて下げる'}</div>` : null}
    </div>
    <p className=${cx('tuner-guide', ok && 'is-ok')} aria-live="polite">${guide || ' '}</p>

    ${status === 'starting'
      ? html`<p className="tuner-start muted small">マイクの準備をしています…（はじめてのときは、マイクの許可を聞かれます）</p>`
      : !on
        ? html`<div className="tuner-start">
            <button className="btn btn-primary" onClick=${() => start(true)}><${Icon} name="mic" size=${18} /> ${status === 'tap' ? 'タップして聞き始める' : 'もう一度マイクで聞く'}</button>
            ${help ? html`<p className="muted small">${help}</p>` : null}
          </div>`
        : null}

    ${mode === 'chroma'
      ? null
      : html`<${Headstock} strings=${STRINGS} active=${active} ok=${ok} done=${done} last=${last} target=${mode === 'pick' ? target : null} onPick=${pickString} />`}

    ${on
      ? html`<div className="tn-bottom">
          <span className="tuner-level" aria-label="マイクに入っている音の大きさ">
            <${Icon} name="mic" size=${14} />
            <span className="tuner-level-bar"><i style=${{ transform: `scaleX(${level})` }}></i></span>
          </span>
          ${mode === 'chroma'
            ? null
            : html`<span className=${cx('tuner-progress', allDone && 'is-all')}>
                <span>${allDone ? 'ぜんぶ合いました！' : `${done.size} / 6`}</span>
                ${done.size ? html`<button className="link-btn" onClick=${resetDone}>やり直す</button>` : null}
              </span>`}
        </div>`
      : null}
    <div className="tuner-foot">
      <span className="muted small">${mode === 'auto'
        ? '弦を1本ずつ鳴らすだけで、どの弦か自動で見分けます。'
        : mode === 'pick'
          ? '糸巻きを押した弦だけを狙います（大きくずれている弦や、切れた弦を張り替えたときに）。合うと次の弦へ進みます。'
          : 'どの音でも、いちばん近い音名とずれを出します（ほかの楽器・半音ずらしたいとき）。'}
        糸巻きを押すと、その弦の見本の音が鳴ります。カポは外して合わせてください。音はこの画面の中だけで測り、どこにも送りません。</span>
    </div>
  </div>`;
}

// 音の高さの流れの線(上が今)。音が途切れたところ・別の弦に変わって大きく飛んだところでは線を切る
function tracePath(trace, now) {
  let d = '';
  let prev = null;
  for (const q of trace) {
    if (q.c == null) {
      prev = null;
      continue;
    }
    const x = (50 + q.c).toFixed(1);
    const y = (((now - q.t) / TRACE_MS) * 40).toFixed(1);
    d += `${prev == null || Math.abs(q.c - prev) > 15 ? 'M' : 'L'}${x} ${y} `;
    prev = q.c;
  }
  return d;
}

// ギターのヘッド(糸巻き 3+3)。左に 4・5・6弦、右に 3・2・1弦(上から)。弦はナットへ向かって集まる
function Headstock({ strings, active, ok, done, last, target, onPick }) {
  const left = [4, 5, 6].map((n) => strings.find((s) => s.n === n));
  const right = [3, 2, 1].map((n) => strings.find((s) => s.n === n));
  // 糸巻きの軸の位置(絵の中の x, y)とナットでの位置
  const post = (s) => {
    const i = s.n >= 4 ? [4, 5, 6].indexOf(s.n) : [3, 2, 1].indexOf(s.n);
    return { x: s.n >= 4 ? 86 : 154, y: 34 + i * 44 };
  };
  const nutX = (s) => 99 + (6 - s.n) * 8.4;
  const peg = (s, side) => {
    const st = done.has(s.n) ? 'is-done' : '';
    const on = active === s.n;
    return html`<button
      key=${s.n}
      className=${cx('tn-peg', 'is-' + side, st, on && 'is-hit', on && ok && 'is-ok', target === s.n && 'is-target')}
      onClick=${() => onPick(s)}
      aria-label=${`${s.n}弦 ${s.name} の見本の音${done.has(s.n) ? '（合わせ済み）' : ''}`}
    >
      <b>${s.name}</b>
      <small>${done.has(s.n) ? '✓' : last[s.n] != null && on ? signed(last[s.n]) : `${s.n}弦`}</small>
    </button>`;
  };
  return html`<div className="tn-head">
    <div className="tn-pegs">${left.map((s) => peg(s, 'l'))}</div>
    <svg className="tn-head-art" viewBox="0 0 240 190" aria-hidden="true">
      <path d="M80 6 Q120 -2 160 6 L172 150 Q120 166 68 150 Z" className="tn-wood" />
      <rect x="92" y="150" width="56" height="8" rx="2" className="tn-nut" />
      <rect x="94" y="158" width="52" height="32" className="tn-neck" />
      ${strings.map((s) => {
        const p = post(s);
        const on = active === s.n;
        return html`<g key=${s.n} className=${cx('tn-str', on && 'is-hit', on && ok && 'is-ok', done.has(s.n) && 'is-done')}>
          <line x1=${p.x} y1=${p.y} x2=${nutX(s)} y2="152" style=${{ strokeWidth: 0.9 + (s.n - 1) * 0.28 }} />
          <line x1=${nutX(s)} y1="152" x2=${nutX(s)} y2="190" style=${{ strokeWidth: 0.9 + (s.n - 1) * 0.28 }} />
          <circle cx=${p.x} cy=${p.y} r="7" className="tn-post" />
        </g>`;
      })}
    </svg>
    <div className="tn-pegs">${right.map((s) => peg(s, 'r'))}</div>
  </div>`;
}
