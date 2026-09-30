// チューナー(ギターの音合わせ)。マイクの音から高さを測る。音は端末の外に出さない
// マイクが使えなくても、弦ごとの見本の音は鳴らせる
import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { Sheet } from './common.js';
import { cx, signed } from '../lib/util.js';
import { chime, holdPlayback, releasePlayback, audioCtx } from '../lib/sound.js';
const html = htm.bind(React.createElement);

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
const A4 = 440;
const freqOf = (m) => A4 * 2 ** ((m - 69) / 12);
const midiOf = (f) => 69 + 12 * Math.log2(f / A4);
const IN_TUNE = 5; // ±5セント以内なら合っている

// 音の高さを測る(YIN法)。buf は時間波形、sr はサンプリング周波数
export function detectPitch(buf, sr) {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.006) return null; // 小さすぎる音(弾いていない)
  const minLag = Math.max(2, Math.floor(sr / 1100));
  const maxLag = Math.min(Math.floor(sr / 60), buf.length >> 1);
  const W = buf.length - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = buf[i] - buf[i + lag];
      s += x * x;
    }
    d[lag] = s;
  }
  // 累積平均で正規化した差分
  const c = new Float32Array(maxLag + 1);
  c[0] = 1;
  let run = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    run += d[lag];
    c[lag] = run ? (d[lag] * lag) / run : 1;
  }
  let lag = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (c[t] < 0.15) {
      while (t + 1 <= maxLag && c[t + 1] < c[t]) t++;
      lag = t;
      break;
    }
  }
  if (lag < 0) {
    let best = minLag;
    for (let t = minLag; t <= maxLag; t++) if (c[t] < c[best]) best = t;
    if (c[best] > 0.3) return null;
    lag = best;
  }
  // 放物線で補間して、サンプルの間の位置まで求める
  let exact = lag;
  if (lag > 1 && lag < maxLag) {
    const a = c[lag - 1], b = c[lag], e = c[lag + 1];
    const den = a + e - 2 * b;
    if (den) exact = lag + (a - e) / (2 * den);
  }
  return { freq: sr / exact, clarity: 1 - c[lag] };
}

// 見本の音(はじいた弦に近い、すぐ減衰する音)
function playTone(midi) {
  try {
    const toneCtx = audioCtx();
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

// 開いた瞬間(タップの中)に音の部品を動かしておくと、iPhone でも開いてすぐ聞き始められる
export function prepareTuner() {
  audioCtx();
}

export function TunerSheet({ open, onClose }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="チューナー（ギターの音合わせ）">
    <${Tuner} />
  </${Sheet}>`;
}

function Tuner() {
  const [status, setStatus] = useState('idle'); // idle | starting | on | denied | error
  const [reading, setReading] = useState(null); // { midi, cents, freq, string }
  const rt = useRef(null);
  // 合わせ終わった弦(ぴったりが0.6秒続いたら「ピコン」)と、弦ごとの最後のずれ(セント)
  const [done, setDone] = useState(() => new Set());
  const doneRef = useRef(new Set());
  const [last, setLast] = useState({});
  const stable = useRef({ n: null, count: 0 });
  const resetDone = () => {
    stable.current = { n: null, count: 0 };
    doneRef.current = new Set();
    setDone(new Set());
    setLast({});
  };

  const stop = () => {
    const r = rt.current;
    rt.current = null;
    if (!r) return;
    clearInterval(r.timer);
    r.stream?.getTracks().forEach((t) => t.stop());
    try {
      r.src?.disconnect();
    } catch {}
  };
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      stop();
    },
    [],
  );

  const start = async () => {
    setStatus('starting');
    // 音の部品はアプリで1つを使い回す(開くときのタップで動かしてある)
    const ctx = audioCtx();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      // 許可を待つあいだに閉じられていたら、マイクをすぐ止める
      if (!alive.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      // それでも動かないとき(開いてからしばらくたった等)は、ボタンを押してもらう
      if (ctx.state !== 'running') {
        stream.getTracks().forEach((t) => t.stop());
        setStatus('idle');
        return;
      }
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 4096;
      src.connect(an);
      const raw = new Float32Array(an.fftSize);
      const half = new Float32Array(an.fftSize >> 1);
      const sr = ctx.sampleRate / 2; // 半分に間引いて計算を軽くする(ギターの音域には十分)
      const hist = [];
      let lastHeard = 0;
      let cur = null; // いま合わせている弦 { n, mm }(ペグを回して音がなめらかに動く間は同じ弦とみなす)
      let quietUntil = 0; // 「ピコン」の音をマイクで拾わないよう、鳴らした直後は測らない
      const timer = setInterval(() => {
        if (performance.now() < quietUntil) return;
        an.getFloatTimeDomainData(raw);
        for (let i = 0; i < half.length; i++) half[i] = (raw[2 * i] + raw[2 * i + 1]) / 2;
        const p = detectPitch(half, sr);
        const now = performance.now();
        if (!p || p.freq < 60 || p.freq > 1100) {
          if (now - lastHeard > 1600) {
            hist.length = 0;
            cur = null;
            setReading(null);
          }
          return;
        }
        const m = midiOf(p.freq);
        // 別の音に変わったら、ならしをやり直す
        if (hist.length && Math.abs(m - hist[hist.length - 1]) > 0.6) hist.length = 0;
        hist.push(m);
        if (hist.length > 7) hist.shift();
        lastHeard = now;
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
        const ref = str.midi;
        const rd = { midi: ref, cents: Math.round((mm - ref) * 100), freq: p.freq, string: str.n };
        setReading(rd);
        if (rd.string) {
          setLast((x) => (x[rd.string] === rd.cents ? x : { ...x, [rd.string]: rd.cents }));
          const st = stable.current;
          const D = doneRef.current;
          if (Math.abs(rd.cents) <= IN_TUNE) {
            if (st.n === rd.string) st.count++;
            else {
              st.n = rd.string;
              st.count = 1;
            }
            // ぴったりが0.6秒続いたら、その弦はできあがり
            if (st.count === 12 && !D.has(rd.string)) {
              D.add(rd.string);
              doneRef.current = new Set(D);
              setDone(new Set(D));
              chime(D.size === STRINGS.length, ctx);
              quietUntil = performance.now() + (D.size === STRINGS.length ? 900 : 600);
              hist.length = 0;
            }
          } else {
            st.count = 0;
            // 合わせたあとで大きくずれたら、印を外す
            if (Math.abs(rd.cents) > 15 && D.has(rd.string)) {
              D.delete(rd.string);
              doneRef.current = new Set(D);
              setDone(new Set(D));
            }
          }
        }
      }, 50);
      rt.current = { stream, ctx, timer, src };
      setStatus('on');
    } catch (e) {
      setStatus(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'error');
    }
  };
  // 開いたらすぐ聞き始める(弦を選ぶ必要はない)
  useEffect(() => {
    start();
  }, []);

  const pickString = (s) => {
    // マイクを使っていないときは、マナーモードでも見本の音が聞こえるようにする
    const listening = !!rt.current;
    if (!listening) holdPlayback();
    playTone(s.midi);
    if (!listening) setTimeout(releasePlayback, 2800);
  };

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
      : status === 'on'
        ? '弦を1本ずつ鳴らしてください'
        : ''
    : ok
      ? reading.string && done.has(reading.string)
        ? `ぴったり！ ${reading.string}弦 OK`
        : 'ぴったり！ そのまま鳴らしていてください'
      : abs > 50
        ? `かなり${cents < 0 ? '低い' : '高い'}（半音 ${(abs / 100).toFixed(1)} 個ぶん）… ペグを${cents < 0 ? '巻いて上げる' : 'ゆるめて下げる'}`
        : `少し${cents < 0 ? '低い' : '高い'}（あと ${abs} セント）… ペグを少し${cents < 0 ? '巻く' : 'ゆるめる'}`;

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
        <span>${reading ? `${DO[pc]}${reading.string ? ` ・ ${reading.string}弦` : ''}` : status === 'on' ? '聞いています…' : ''}</span>
      </div>
      <div className=${cx('tuner-cents', reading && !ok && (abs > 50 ? 'is-far' : 'is-near'))}>
        ${reading ? html`<b>${signed(cents)}</b> セント <small>（100で半音 ・ ${reading.freq.toFixed(1)} Hz）</small>` : ' '}
      </div>
    </div>
    <p className=${cx('tuner-guide', ok && 'is-ok')} aria-live="polite">${guide || ' '}</p>

    ${status === 'starting'
      ? html`<p className="tuner-start muted small">マイクの準備をしています…（はじめてのときは、マイクの許可を聞かれます）</p>`
      : status !== 'on'
      ? html`<div className="tuner-start">
          <button className="btn btn-primary" onClick=${start}><${Icon} name="mic" size=${18} /> タップして聞き始める</button>
          <p className="muted small">
            ${status === 'denied'
              ? 'マイクが許可されていません。iPhone は 設定 → Safari → マイク（ホーム画面から開いた場合はアプリの設定）で許可してください。下の弦ボタンで見本の音を鳴らして、耳で合わせることもできます。'
              : status === 'error'
                ? 'マイクを使えませんでした。下の弦ボタンで見本の音を鳴らして、耳で合わせられます。'
                : '音はこの画面の中だけで測り、どこにも送りません。カポは外して合わせてください。'}
          </p>
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
    ${status === 'on'
      ? html`<div className=${cx('tuner-progress', allDone && 'is-all')}>
          <span>${allDone ? '6本ぜんぶ合いました！' :`合わせた弦 ${done.size} / 6`}</span>
          ${done.size ? html`<button className="link-btn" onClick=${resetDone}>やり直す</button>` : null}
        </div>`
      : null}
    <div className="tuner-foot">
      <span className="muted small">弦を1本ずつ鳴らすだけで、どの弦か自動で見分けます。ボタンを押すと、その弦の見本の音が鳴ります。</span>
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
