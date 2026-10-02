// BPMに合わせた自動スクロール。
// 譜面の各行に「何拍ぶんか」を割り当てて時間軸を作り、今の拍が画面の上から3割の位置に来るよう滑らかに動かす。
// 途中で指やホイールで動かすと一時停止し、手を離したところから続きを刻む。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioCtx, click as clickSound, holdPlayback, releasePlayback } from '../lib/sound.js';

// 小節線の無い行の長さ(小節数)の見積もり。
// ChordWiki の小節線つき譜面(10曲・333行)で、コード数と歌詞の音数から実際の小節数を当てはめた式。
// 「1行=2小節」決め打ちだと平均1.3小節ずれていたのが、約0.6小節に縮む。
export function estimateBars(line) {
  if (line.type === 'chords') return Math.min(8, Math.max(1, Math.round(0.4 * line.chordCount + 1)));
  const est = 0.267 * (line.chordCount || 0) + 0.056 * (line.mora || 0) + 1.05;
  return Math.min(8, Math.max(1, Math.round(est)));
}

// barsPerLine: 0 = 自動で見積もる / 1〜4 = その小節数に固定
export function lineBeats(line, barsPerLine, bpb) {
  if (line.type !== 'lyric' && line.type !== 'chords') return 0;
  if (line.bars) return line.bars * bpb;
  if (!barsPerLine) return estimateBars(line) * bpb;
  if (line.type === 'chords') return Math.min(8, Math.max(1, line.chordCount)) * bpb;
  return barsPerLine * bpb;
}

// 譜面全体を曲の実際の長さに合わせるための倍率(時間の伸び縮み)。合わせないときは 1
export function songFit(totalBeats, bpm, durationMs) {
  if (!durationMs || !bpm || !totalBeats) return null;
  const est = (totalBeats * 60) / bpm;
  const ratio = durationMs / 1000 / est;
  // 譜面に抜けている部分がある等で大きくずれるときは、無理に合わせない
  if (ratio < 0.6 || ratio > 1.7) return { ratio, usable: false };
  return { ratio, usable: true };
}

// ---------------------------------------------------------------- 自分の録音に合わせる
// anchors: [{ line, t }] = 「この行はこの時刻に始まる」の目印(歌を聴きながら行をタップして作る)。
// 目印と目印のあいだは拍どおりに割り振り、前後ははみ出しぶんを近くの速さで伸ばす。目印が無ければ BPM どおり
function points(anchors, starts) {
  return (anchors || [])
    .filter((a) => starts[a.line] != null)
    .map((a) => [a.t, starts[a.line]])
    .sort((x, y) => x[0] - y[0]);
}
export function beatAtTime(t, anchors, starts, bps) {
  const p = points(anchors, starts);
  if (!p.length) return t * bps;
  const rate = (k) => Math.max(0.05, (p[k + 1][1] - p[k][1]) / Math.max(0.05, p[k + 1][0] - p[k][0]));
  if (t <= p[0][0]) return p[0][1] + (t - p[0][0]) * (p.length > 1 ? rate(0) : bps);
  for (let k = 0; k < p.length - 1; k++) if (t <= p[k + 1][0]) return p[k][1] + (t - p[k][0]) * rate(k);
  const L = p.length - 1;
  return p[L][1] + (t - p[L][0]) * (L > 0 ? rate(L - 1) : bps);
}
export function timeAtBeat(b, anchors, starts, bps) {
  const p = points(anchors, starts);
  if (!p.length) return b / bps;
  const rate = (k) => Math.max(0.05, (p[k + 1][1] - p[k][1]) / Math.max(0.05, p[k + 1][0] - p[k][0]));
  if (b <= p[0][1]) return p[0][0] + (b - p[0][1]) / (p.length > 1 ? rate(0) : bps);
  for (let k = 0; k < p.length - 1; k++) if (b <= p[k + 1][1]) return p[k][0] + (b - p[k][1]) / rate(k);
  const L = p.length - 1;
  return p[L][0] + (b - p[L][1]) / (L > 0 ? rate(L - 1) : bps);
}

export function unlockAudio() {
  audioCtx();
}

// clock: 自分の録音に合わせるときの時計 { time, seekTime, play, pause, ended, duration, anchors, bps }(使わないときは null)
// clickVolume: クリック音の大きさ(0.6 / 1 / 1.5)
export function useAutoScroll({ scrollRef, lines, bpm, barsPerLine, beatsPerBar, countIn, click, durationMs, fitSong, clock = null, clickVolume = 1 }) {
  const [playing, setPlaying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [progress, setProgress] = useState(0);
  const [loop, setLoopState] = useState(null); // 区間リピート { from, to }(行の番号)
  const s = useRef({ beat: 0, raf: 0, last: 0, holding: false, idle: 0, expect: null, tops: [], heights: [], countEnd: null, startBeat: 0, lastInt: null, cur: -1, lastProg: 0, clickPhase: 0, loop: null, beatEl: null, beatShown: -1, sched: 0 }).current;
  const live = useRef({});

  const tl = useMemo(() => {
    const starts = [];
    const durs = [];
    let t = 0;
    for (const l of lines) {
      const d = lineBeats(l, barsPerLine, beatsPerBar);
      starts.push(t);
      durs.push(d);
      t += d;
    }
    const timed = [];
    durs.forEach((d, i) => d > 0 && timed.push(i));
    return { starts, durs, total: t, timed };
  }, [lines, barsPerLine, beatsPerBar]);
  s.tl = tl; // requestAnimationFrame のループからも常に最新の時間軸を見る

  // 曲の長さに合わせる: 譜面の拍を進める速さだけを変える(クリック音は本来のBPMのまま)
  const fit = useMemo(() => songFit(tl.total, bpm, durationMs), [tl.total, bpm, durationMs]);
  const scrollRate = fitSong && fit && fit.usable ? 1 / fit.ratio : 1;
  live.current = { bpm, click, countIn, beatsPerBar, scrollRate, clock, clickVolume };
  const clockBeat = () => {
    const c = live.current.clock;
    return beatAtTime(c.time(), c.anchors, s.tl.starts, c.bps);
  };
  const clockSeek = (b) => {
    const c = live.current.clock;
    const d = c.duration() || Infinity;
    c.seekTime(Math.max(0, Math.min(d - 0.05, timeAtBeat(b, c.anchors, s.tl.starts, c.bps))));
  };

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    s.tops = [];
    s.heights = [];
    el.querySelectorAll('[data-i]').forEach((n) => {
      const r = n.getBoundingClientRect();
      s.tops[+n.dataset.i] = r.top - base;
      s.heights[+n.dataset.i] = r.height;
    });
  }, []);

  const anchor = () => (scrollRef.current ? scrollRef.current.clientHeight * 0.3 : 200);

  const timedIndexAt = (b) => {
    const { timed, starts, durs } = s.tl;
    if (!timed.length) return -1;
    let lo = 0;
    let hi = timed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[timed[mid]] <= b) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const posAtBeat = (b) => {
    const { timed, starts, durs } = s.tl;
    const k = timedIndexAt(b);
    if (k < 0) return 0;
    const i = timed[k];
    const top = s.tops[i] ?? 0;
    const next = k + 1 < timed.length ? s.tops[timed[k + 1]] ?? top : top + (s.heights[i] || 40);
    const f = Math.min(1, Math.max(0, (b - starts[i]) / durs[i]));
    return top + f * (next - top);
  };

  const beatAtPos = (y) => {
    const { timed, starts, durs, total } = s.tl;
    for (let k = 0; k < timed.length; k++) {
      const i = timed[k];
      const top = s.tops[i] ?? 0;
      const next = k + 1 < timed.length ? s.tops[timed[k + 1]] ?? top : top + (s.heights[i] || 40);
      if (y < next) return y <= top ? starts[i] : starts[i] + ((y - top) / Math.max(1, next - top)) * durs[i];
    }
    return total;
  };

  // その拍を含む行の頭の拍(行の後ろ3割より先まで読み進めていたら、次の行の頭)
  const lineStartAt = (b) => {
    const { timed, starts, durs } = s.tl;
    const k = timedIndexAt(b);
    if (k < 0) return 0;
    const i = timed[k];
    if (b - starts[i] > durs[i] * 0.7 && k + 1 < timed.length) return starts[timed[k + 1]];
    return starts[i];
  };

  // 今の読み位置(画面の上から3割)にある拍。いちばん上にいるときは曲の頭
  const beatFromScroll = () => {
    const el = scrollRef.current;
    if (!el || el.scrollTop < 4) return 0;
    return beatAtPos(el.scrollTop + anchor());
  };

  const setScroll = (y) => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const v = Math.max(0, Math.min(max, y));
    s.expect = v;
    el.scrollTop = v;
  };

  const highlight = (b) => {
    const k = timedIndexAt(b);
    const i = k >= 0 ? s.tl.timed[k] : -1;
    if (i === s.cur) return;
    const el = scrollRef.current;
    if (!el) return;
    el.querySelector('.is-current')?.classList.remove('is-current');
    if (i >= 0 && s.playingFlag) el.querySelector(`[data-i="${i}"]`)?.classList.add('is-current');
    s.cur = i;
  };

  const clearHighlight = () => {
    scrollRef.current?.querySelector('.is-current')?.classList.remove('is-current');
    s.cur = -1;
  };

  const frame = (ts) => {
    if (!s.playingFlag) return;
    // 自分の録音に合わせるとき: 録音の再生位置から今の拍を出す(クリックもカウントもしない)
    if (live.current.clock) {
      const c = live.current.clock;
      let eff = clockBeat();
      if (s.loop) {
        const a = s.tl.starts[s.loop.from];
        const b = s.tl.starts[s.loop.to] + s.tl.durs[s.loop.to];
        if (eff >= b && b > a) {
          clockSeek(a);
          eff = a;
        }
      }
      if (!s.holding) setScroll(posAtBeat(eff) - anchor());
      highlight(eff);
      if (ts - s.lastProg > 250) {
        s.lastProg = ts;
        const d = c.duration();
        setProgress(d ? Math.min(1, c.time() / d) : 0);
      }
      if (c.ended()) {
        stop();
        return;
      }
      s.raf = requestAnimationFrame(frame);
      return;
    }
    // 拍は音の時計から計算する(クリック・拍の点・コードの切り替わり・スクロールが全部同じ時計)
    const { beatsPerBar: bpb } = live.current;
    reanchor();
    wrapLoop();
    // 画面は「音が実際に耳に届く時刻」に合わせる(スピーカー・イヤホンまでの遅れぶん、目印を遅らせる)
    const ac = audioCtx();
    const lat = s.holding ? 0 : Math.min(0.5, ac.outputLatency || ac.baseLatency || 0);
    const b = beatNow() - lat * s.bps;
    s.beat = b;
    let eff = b;
    if (s.countEnd != null) {
      if (b < s.countEnd) {
        eff = s.startBeat;
        const n = Math.max(1, Math.min(bpb, Math.ceil(s.countEnd - b - 1e-6)));
        if (n !== s.lastCount) {
          s.lastCount = n;
          setCountdown(n);
        }
      } else {
        s.countEnd = null;
        s.lastCount = 0;
        setCountdown(0);
      }
    }
    showBeat(((Math.floor(b + 1e-6) % bpb) + bpb) % bpb);
    if (!s.holding) setScroll(posAtBeat(eff) - anchor());
    highlight(eff);
    if (ts - s.lastProg > 250) {
      s.lastProg = ts;
      setProgress(s.tl.total ? Math.min(1, eff / s.tl.total) : 0);
    }
    if (eff >= s.tl.total && s.tl.total > 0) {
      stop();
      return;
    }
    s.raf = requestAnimationFrame(frame);
  };

  // ---- 拍の時計
  // 拍 = anchorBeat + (音の時刻 - anchorTime) × 1秒あたりの拍数。基準は音の時計(audioCtx().currentTime)なので、
  // 画面の書きかえが遅れても、クリックの鳴る瞬間とコードの切り替わりはずれない
  const nowT = () => audioCtx().currentTime;
  // その拍での速さ: カウント中とクリック音オンのときは BPM どおり、それ以外は曲の長さに合わせた速さ
  const wantBps = (at) => {
    const { bpm: B, click: C, scrollRate } = live.current;
    const counting = s.countEnd != null && at < s.countEnd;
    return (B / 60) * (counting || C ? 1 : scrollRate);
  };
  const beatNow = () => (s.holding ? s.frozenBeat : s.anchorBeat + (nowT() - s.anchorTime) * s.bps);
  const setBeat = (b, lead = 0) => {
    s.anchorBeat = b;
    s.anchorTime = nowT() + lead;
    s.bps = wantBps(b);
  };
  // 速さが変わったら(BPM・クリックのオンオフ・カウントの終わり)、今の拍を起点に付け直す
  const reanchor = () => {
    if (s.holding) return;
    const b = beatNow();
    const bps = wantBps(b);
    if (Math.abs(bps - s.bps) > 1e-9) {
      s.anchorBeat = b;
      s.anchorTime = nowT();
      s.bps = bps;
    }
  };
  // 区間リピート: 最後の行を弾き終えたら最初の行へ(ずらすのは小節の整数倍なので、強拍の位置も崩れない)
  const wrapLoop = () => {
    if (!s.loop || s.holding) return;
    const a = s.tl.starts[s.loop.from];
    const e = s.tl.starts[s.loop.to] + s.tl.durs[s.loop.to];
    if (e <= a) return;
    const b = beatNow();
    if ((s.countEnd != null && b < s.countEnd) || b < e) return;
    const shift = (e - a) * Math.floor((b - a) / (e - a));
    s.anchorBeat -= shift;
    s.sched -= shift;
  };
  // クリックの予約係: 画面の書きかえとは別に 25ミリ秒ごとに動き、0.15秒先までの拍を、音の時計の正確な時刻に予約する
  const tickClicks = () => {
    if (!s.playingFlag || live.current.clock) return;
    reanchor();
    wrapLoop();
    if (s.holding) return;
    const { click: C, beatsPerBar: bpb, clickVolume } = live.current;
    const now = nowT();
    for (let guard = 0; guard < 16; guard++) {
      const next = s.sched + 1;
      const t = s.anchorTime + (next - s.anchorBeat) / s.bps;
      if (t > now + 0.15) break;
      s.sched = next;
      if (t < now - 0.03) continue; // 間に合わなかった拍(アプリが裏にいた等)は鳴らさない
      const counting = s.countEnd != null && next < s.countEnd;
      if (C || counting) clickSound(((next % bpb) + bpb) % bpb === 0, t, clickVolume);
    }
  };

  // 拍の目印(再生バーの点)。React を通さず直接切り替える
  const showBeat = (b) => {
    const el = s.beatEl;
    if (!el || b === s.beatShown) return;
    el.children[s.beatShown]?.classList.remove('on');
    el.children[b]?.classList.add('on');
    s.beatShown = b;
  };
  const bindBeat = useCallback((el) => {
    s.beatEl = el;
    s.beatShown = -1;
  }, []);

  const start = (fromBeat) => {
    if (!s.tl.timed.length) return;
    if (live.current.clock) {
      // 録音: 止めたところから続ける(行を指定されたらその行の時刻から)
      measure();
      if (fromBeat != null) clockSeek(fromBeat);
      else if (s.loop) {
        const a = s.tl.starts[s.loop.from];
        const e = s.tl.starts[s.loop.to] + s.tl.durs[s.loop.to];
        const b = clockBeat();
        if (b < a || b >= e) clockSeek(a);
      }
      if (live.current.clock.ended()) live.current.clock.seekTime(0);
      live.current.clock.play();
      s.holding = false;
      s.playingFlag = true;
      setPlaying(true);
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(frame);
      return;
    }
    unlockAudio();
    measure();
    // いま読んでいる行の頭(= 小節の頭)から始める。拍の途中から始めると、クリックとコードの切り替わりがずれるため
    let b = fromBeat != null ? fromBeat : lineStartAt(beatFromScroll());
    // 区間リピート中は、区間の外から始めたら区間の頭から
    if (s.loop) {
      const a = s.tl.starts[s.loop.from];
      const e = s.tl.starts[s.loop.to] + s.tl.durs[s.loop.to];
      if (b < a || b >= e) b = a;
    }
    s.startBeat = b >= s.tl.total ? 0 : b;
    const { countIn: ci, beatsPerBar: bpb } = live.current;
    s.countEnd = ci ? s.startBeat : null;
    s.holding = false;
    s.beat = ci ? s.startBeat - bpb : s.startBeat;
    // 60ミリ秒あとを最初の拍(カウントの1拍目)にして、そこから音の時計で刻む
    setBeat(s.beat, 0.06);
    s.sched = s.beat - 1;
    s.playingFlag = true;
    setPlaying(true);
    clearInterval(s.tick);
    s.tick = setInterval(tickClicks, 25);
    tickClicks();
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(frame);
  };

  const stop = () => {
    live.current.clock?.pause();
    s.playingFlag = false;
    clearInterval(s.tick);
    cancelAnimationFrame(s.raf);
    s.countEnd = null;
    setCountdown(0);
    setPlaying(false);
    clearHighlight();
    s.beatEl?.children[s.beatShown]?.classList.remove('on');
    s.beatShown = -1;
  };

  // 区間リピートを決める/やめる(行の番号。範囲外や逆順も受け付ける)
  const setLoop = (from, to) => {
    if (from == null) {
      s.loop = null;
      setLoopState(null);
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    s.loop = { from: lo, to: hi };
    setLoopState({ from: lo, to: hi });
    if (!s.playingFlag) jumpToLine(lo);
  };

  const toggle = () => (s.playingFlag ? stop() : start());

  const toStart = () => {
    stop();
    live.current.clock?.seekTime(0);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    setProgress(0);
  };

  // 行へ移動(再生中はその行から続ける)
  const jumpToLine = (i) => {
    measure();
    const b = s.tl.starts[i] ?? 0;
    if (live.current.clock) {
      if (s.playingFlag) clockSeek(b);
      else {
        clockSeek(b);
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: Math.max(0, (s.tops[i] ?? 0) - anchor()), behavior: 'smooth' });
      }
      return;
    }
    if (s.playingFlag) {
      s.countEnd = null;
      setCountdown(0);
      s.holding = false;
      s.beat = b;
      setBeat(b, 0.03);
      s.sched = b - 1;
      tickClicks();
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: Math.max(0, (s.tops[i] ?? 0) - anchor()), behavior: 'smooth' });
    }
  };

  const step = (dir) => {
    measure();
    const cur = live.current.clock && s.playingFlag ? clockBeat() : s.playingFlag ? Math.max(beatNow(), s.startBeat) : beatFromScroll();
    const k = timedIndexAt(cur);
    const nk = Math.max(0, Math.min(s.tl.timed.length - 1, k + dir));
    const i = s.tl.timed[nk];
    if (i != null) jumpToLine(i);
  };

  // ユーザーが自分でスクロールしたら、止まるまで待ってからそこを新しい位置にする
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!s.playingFlag) return;
      if (s.expect != null && Math.abs(el.scrollTop - s.expect) <= 3) return;
      // 指で動かしている間は、拍の時計を止めておく
      if (!s.holding && !live.current.clock) s.frozenBeat = beatNow();
      s.holding = true;
      clearTimeout(s.idle);
      s.idle = setTimeout(() => {
        measure();
        // 録音に合わせているときは、録音の再生位置をスクロールしたところへ動かす
        if (live.current.clock) {
          clockSeek(beatFromScroll());
          s.expect = el.scrollTop;
          s.holding = false;
          return;
        }
        // 手を離したところの行の頭から、拍をそろえて続ける
        if (s.countEnd != null) {
          s.countEnd = null;
          setCountdown(0);
        }
        s.holding = false;
        s.beat = lineStartAt(beatFromScroll());
        setBeat(s.beat, 0.05);
        s.sched = s.beat - 1;
        s.expect = el.scrollTop;
      }, 450);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [scrollRef.current]);

  useEffect(() => {
    measure();
    // 譜面が変わったら(版の切り替えなど)区間リピートは解除する
    s.loop = null;
    setLoopState(null);
  }, [lines]);

  // クリック音を鳴らしながら流している間だけ、マナーモードでも聞こえるようにする
  useEffect(() => {
    const want = playing && click && !clock;
    if (want && !s.held) {
      holdPlayback();
      s.held = true;
    } else if (!want && s.held) {
      releasePlayback();
      s.held = false;
    }
  }, [playing, click, !!clock]);

  useEffect(() => () => {
    s.playingFlag = false;
    clearInterval(s.tick);
    cancelAnimationFrame(s.raf);
    if (s.held) releasePlayback();
  }, []);

  return { playing, countdown, progress, toggle, start, stop, toStart, jumpToLine, step, measure, totalBeats: tl.total, starts: tl.starts, fit, scrollRate, loop, setLoop, bindBeat };
}
