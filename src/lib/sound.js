// 音を鳴らす共通の部品(メトロノームのクリック・チューナーの「ピコン」)
// iPhone は消音スイッチ(マナーモード)がオンだと、ふつうの効果音(Web Audio)が鳴らない。
// 鳴らしている間だけ「再生アプリ」扱いにして、マナーモードでも聞こえるようにする
let ctx = null;
let holders = 0;
let keepAlive = null;

export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch?.(() => {});
  return ctx;
}

// 無音の短い音声(古い iPhone 向け: これを流し続けると、効果音も「再生中の音」として鳴る)
function silentUrl() {
  const n = 800;
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  w(36, 'data');
  dv.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// 鳴らし始めるときに hold、止めるときに release(ほかの音楽アプリの邪魔をしないよう、鳴らす間だけ)
export function holdPlayback() {
  holders++;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    else {
      if (!keepAlive) {
        keepAlive = new Audio(silentUrl());
        keepAlive.loop = true;
        keepAlive.setAttribute('playsinline', '');
      }
      keepAlive.play().catch(() => {});
    }
  } catch {}
  audioCtx();
}
export function releasePlayback() {
  holders = Math.max(0, holders - 1);
  if (holders) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'auto';
    keepAlive?.pause();
  } catch {}
}

// メトロノームのクリック(木をたたいたような「カッ」)。when は audioCtx の時刻(0 = すぐ)
export function click(accent = false, when = 0, volume = 1) {
  try {
    const c = audioCtx();
    const t = Math.max(c.currentTime, when || 0) + 0.001;
    const out = c.createGain();
    out.gain.value = volume * (accent ? 1 : 0.62);
    out.connect(c.destination);
    // 音程のある部分
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(accent ? 2100 : 1500, t);
    o.frequency.exponentialRampToValueAtTime(accent ? 1400 : 1000, t + 0.03);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.9, t + 0.001);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.06);
    // たたいた瞬間の「カッ」(短い雑音)
    const len = Math.floor(c.sampleRate * 0.012);
    const nb = c.createBuffer(1, len, c.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const ns = c.createBufferSource();
    ns.buffer = nb;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const ng = c.createGain();
    ng.gain.value = 0.5;
    ns.connect(hp).connect(ng).connect(out);
    ns.start(t);
  } catch {}
}

// 「ピコン」(合ったとき)。big = true で全部そろったときの少し長い音
export function chime(big = false, c = null) {
  try {
    c = c || audioCtx();
    const t = c.currentTime + 0.01;
    const notes = big ? [1047, 1319, 1568, 2093] : [1319, 1976];
    notes.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const st = t + i * (big ? 0.09 : 0.075);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.35, st + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, st + (big ? 0.5 : 0.28));
      o.connect(g).connect(c.destination);
      o.start(st);
      o.stop(st + (big ? 0.55 : 0.3));
    });
  } catch {}
}
