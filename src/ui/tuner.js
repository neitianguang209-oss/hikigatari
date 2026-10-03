// チューナー(ギターの音合わせ)。マイクの音から高さを測る。音は端末の外に出さない
// マイクが使えなくても、弦ごとの見本の音は鳴らせる
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
const html = htm.bind(React.createElement);
export { detectPitch };

// 6弦 → 1弦(標準チューニング)
const STRINGS = [
  { n: 6, name: 'E', midi: 40 },
  { n: 5, name: 'A', midi: 45 },
  { n: 4, name: 'D', midi: 50 },
  { n: 3, name: 'G', midi: 55 },
  { n: 2, name: 'B', midi: 59 },
  { n: 1, name: 'E', midi: 64 },
];
const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const DO = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const IN_TUNE = 5; // ±5セント以内なら合っている
const TICK = 40; // 何ミリ秒ごとに測るか
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

// 見本の音(はじいた弦に近い、すぐ減衰する音)
function playTone(midi, c = null) {
  try {
    const toneCtx = c || audioCtx();
    const t = toneCtx.currentTime + 0.01;
    const f = freqOf(midi);
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
  return html`<${Sheet} open=${open} onClose=${onClose} title="チューナー（ギターの音合わせ）">
    <${Tuner} />
  </${Sheet}>`;
}

// 入ってくる音の大きさ(rms) → メーターの長さ 0〜1(−66dB 〜 −16dB)
const meterOf = (v) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 66) / 50));

function Tuner() {
  // starting | on | tap(タップで動かす) | denied | error | silent(音が届かない)
  const [status, setStatus] = useState('starting');
  const [reading, setReading] = useState(null); // { midi, cents, freq, string }
  const [level, setLevel] = useState(0);
  const [hush, setHush] = useState(false); // 聞いているのに、しばらく音の高さが取れていない
  // 合わせ終わった弦(ぴったりが0.6秒続いたら「ピコン」)と、弦ごとの最後のずれ(セント)
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
    let floor = null; // まわりの雑音の大きさ
    let lastHeard = performance.now();
    let cur = null; // いま合わせている弦 { n, mm }(ペグを回して音がなめらかに動く間は同じ弦とみなす)
    let quietUntil = 0; // 「ピコン」の音をマイクで拾わないよう、鳴らした直後は測らない
    let okSince = 0;
    let okString = null;
    let lastLevel = -1;
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
      const p = detectPitch(buf, sr, { gate: Math.max(0.0008, floor * 2.5) });
      if (!p || p.freq < 60 || p.freq > 1100) {
        if (now - lastHeard > 1500) {
          hist.length = 0;
          cur = null;
          okSince = 0;
          setReading(null);
        }
        if (now - lastHeard > 6000) setHush(true);
        return;
      }
      const mNow = midiOf(p.freq);
      // 別の音に変わったら、ならしをやり直す。新しい音は2回続けて聞こえてから出す(弾いた瞬間の雑音で針が飛ばないように)
      if (hist.length && Math.abs(mNow - hist[hist.length - 1]) > 0.6) hist.length = 0;
      hist.push(mNow);
      if (hist.length > 5) hist.shift();
      if (hist.length < 2) return;
      lastHeard = now;
      setHush(false);
      const sorted = [...hist].sort((a, b) => a - b);
      let mm = sorted[sorted.length >> 1];
      // どの弦かを自動で決める: 合わせている途中の弦は、音がなめらかにつながる限りその弦のまま
      // (大きくずれた弦を巻き上げていく途中で、となりの弦と取り違えないように)
      let str = null;
      if (cur) {
        const t = STRINGS.find((s) => s.n === cur.n);
        // 低い弦の倍音(1オクターブ上)を拾ったときは折り返す
        if (Math.abs(Math.abs(mm - t.midi) - 12) < 1.2) mm -= Math.sign(mm - t.midi) * 12;
        if (Math.abs(mm - cur.mm) < 1 && Math.abs(mm - t.midi) < 5) str = t;
      }
      if (!str) str = STRINGS.reduce((a, b) => (Math.abs(b.midi - mm) < Math.abs(a.midi - mm) ? b : a));
      cur = { n: str.n, mm };
      const rd = { midi: str.midi, cents: Math.round((mm - str.midi) * 100), freq: p.freq, string: str.n };
      setReading(rd);
      setLast((x) => (x[rd.string] === rd.cents ? x : { ...x, [rd.string]: rd.cents }));
      const D = doneRef.current;
      if (Math.abs(rd.cents) <= IN_TUNE) {
        if (okString !== rd.string) {
          okString = rd.string;
          okSince = now;
        }
        // ぴったりが0.6秒続いたら、その弦はできあがり
        if (now - okSince >= 600 && !D.has(rd.string)) {
          D.add(rd.string);
          doneRef.current = new Set(D);
          setDone(new Set(D));
          chime(D.size === STRINGS.length, ctx);
          quietUntil = now + (D.size === STRINGS.length ? 900 : 600);
          hist.length = 0;
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

  // 開いたらすぐ聞き始める(弦を選ぶ必要はない)。閉じたら止める
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

  const pickString = (s) => {
    const listening = !!eng.current;
    if (listening) {
      // 聞いている間は、見本の音をマイクで拾って「合った」にならないよう、鳴っている間は測らない
      toneUntil.current = performance.now() + 2600;
      playTone(s.midi, eng.current.ctx);
      return;
    }
    // マイクを使っていないときは、マナーモードでも見本の音が聞こえるようにする
    holdPlayback();
    playTone(s.midi);
    setTimeout(releasePlayback, 2800);
  };

  const on = status === 'on';
  const cents = reading ? reading.cents : 0;
  const ok = reading && Math.abs(cents) <= IN_TUNE;
  const angle = Math.max(-50, Math.min(50, cents)) * 1.2; // ±50セント → ±60度
  const pc = reading ? ((reading.midi % 12) + 12) % 12 : null;
  const abs = Math.abs(cents);
  const allDone = done.size === STRINGS.length;
  // どれくらい離れているか: 50セント(半音の半分)までは「あと何セント」、それより大きいときは「半音いくつぶん」
  const guide = !reading
    ? allDone
      ? '6本ぜんぶ合いました！'
      : on
        ? hush
          ? level > 0.35
            ? '音は聞こえています。弦を1本ずつ、はっきり鳴らしてください'
            : '音が小さいようです。ギターを端末のマイクに近づけて鳴らしてください'
          : '弦を1本ずつ鳴らしてください'
        : ''
    : ok
      ? reading.string && done.has(reading.string)
        ? `ぴったり！ ${reading.string}弦 OK`
        : 'ぴったり！ そのまま鳴らしていてください'
      : abs > 50
        ? `かなり${cents < 0 ? '低い' : '高い'}（半音 ${(abs / 100).toFixed(1)} 個ぶん）… ペグを${cents < 0 ? '巻いて上げる' : 'ゆるめて下げる'}`
        : `少し${cents < 0 ? '低い' : '高い'}（あと ${abs} セント）… ペグを少し${cents < 0 ? '巻く' : 'ゆるめる'}`;

  const help =
    status === 'denied'
      ? 'マイクが許可されていません。iPhone は 設定 → Safari → マイク（ホーム画面から開いた場合は 設定 → アプリ → Safari → マイク）で「許可」にしてから、下のボタンを押してください。弦ボタンで見本の音を鳴らして、耳で合わせることもできます。'
      : status === 'silent'
        ? 'マイクから音が届いていません。通話・録音・ビデオなど、ほかのアプリがマイクを使っていないか確かめてから、もう一度押してください。'
        : status === 'error'
          ? 'マイクを使えませんでした。もう一度押すか、弦ボタンで見本の音を鳴らして、耳で合わせてください。'
          : status === 'tap'
            ? '音を測る準備のため、一度だけタップしてください。'
            : '';

  return html`<div className="tuner">
    <div className=${cx('tuner-gauge', ok && 'is-ok', reading && 'is-live')}>
      <svg viewBox="0 0 240 132" aria-hidden="true">
        <path d="M24 120 A96 96 0 0 1 216 120" className="tg-arc" />
        <path d=${arcPath(IN_TUNE * 1.2)} className="tg-ok" />
        ${[-50, -25, 0, 25, 50].map((c) => {
          const a = ((c * 1.2 - 90) * Math.PI) / 180;
          return html`<line key=${c} x1=${120 + 88 * Math.cos(a)} y1=${120 + 88 * Math.sin(a)} x2=${120 + (c === 0 ? 74 : 80) * Math.cos(a)} y2=${120 + (c === 0 ? 74 : 80) * Math.sin(a)} className="tg-tick" />`;
        })}
        <g style=${{ transform: `rotate(${reading ? angle : 0}deg)`, transformOrigin: '120px 120px' }} className="tg-needle">
          <line x1="120" y1="36" x2="120" y2="8" />
          <circle cx="120" cy="24" r="8" />
        </g>
      </svg>
      <div className="tuner-note">
        <b>${reading ? NOTE[pc] : '–'}</b>
        <span>${reading ? `${DO[pc]}${reading.string ? ` ・ ${reading.string}弦` : ''}` : on ? '聞いています…' : ''}</span>
      </div>
      <div className=${cx('tuner-cents', reading && !ok && (abs > 50 ? 'is-far' : 'is-near'))}>
        ${reading ? html`<b>${signed(cents)}</b> セント <small>（100で半音 ・ ${reading.freq.toFixed(1)} Hz）</small>` : ' '}
      </div>
    </div>
    ${on
      ? html`<div className="tuner-level" aria-label="マイクに入っている音の大きさ">
          <${Icon} name="mic" size=${14} />
          <span className="tuner-level-bar"><i style=${{ transform: `scaleX(${level})` }}></i></span>
        </div>`
      : null}
    <p className=${cx('tuner-guide', ok && 'is-ok')} aria-live="polite">${guide || ' '}</p>

    ${status === 'starting'
      ? html`<p className="tuner-start muted small">マイクの準備をしています…（はじめてのときは、マイクの許可を聞かれます）</p>`
      : !on
        ? html`<div className="tuner-start">
            <button className="btn btn-primary" onClick=${() => start(true)}><${Icon} name="mic" size=${18} /> ${status === 'tap' ? 'タップして聞き始める' : 'もう一度マイクで聞く'}</button>
            ${help ? html`<p className="muted small">${help}</p>` : null}
          </div>`
        : null}

    <div className="tuner-strings" role="group" aria-label="弦（タップで見本の音）">
      ${STRINGS.map(
        (s) => html`<button
          key=${s.n}
          className=${cx('tuner-string', reading && reading.string === s.n && 'is-hit', done.has(s.n) && 'is-done', reading && reading.string === s.n && ok && 'is-ok')}
          onClick=${() => pickString(s)}
          aria-label=${`${s.n}弦 ${s.name} の見本の音${done.has(s.n) ? '（合わせ済み）' : ''}`}
        >
          <small>${s.n}弦</small><b>${s.name}</b>
          <em>${done.has(s.n) ? '✓ OK' : last[s.n] != null ? signed(last[s.n]) : '—'}</em>
        </button>`,
      )}
    </div>
    ${on
      ? html`<div className=${cx('tuner-progress', allDone && 'is-all')}>
          <span>${allDone ? '6本ぜんぶ合いました！' : `合わせた弦 ${done.size} / 6`}</span>
          ${done.size ? html`<button className="link-btn" onClick=${resetDone}>やり直す</button>` : null}
        </div>`
      : null}
    <div className="tuner-foot">
      <span className="muted small">弦を1本ずつ鳴らすだけで、どの弦か自動で見分けます。ボタンを押すと、その弦の見本の音が鳴ります。カポは外して合わせてください。音はこの画面の中だけで測り、どこにも送りません。</span>
    </div>
  </div>`;
}

// 真ん中から左右に deg 度ぶんの円弧
function arcPath(deg) {
  const p = (a) => {
    const r = ((a - 90) * Math.PI) / 180;
    return `${(120 + 96 * Math.cos(r)).toFixed(2)} ${(120 + 96 * Math.sin(r)).toFixed(2)}`;
  };
  return `M${p(-deg)} A96 96 0 0 1 ${p(deg)}`;
}
