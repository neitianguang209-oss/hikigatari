// 自分の音源: 持っている原曲のファイル(買った曲・CD から取り込んだ曲など)を、この曲の「原曲」として流す。
// ・広告が入らない / iPhone・iPad でも1曲まるごと好きなキー・速さで流せる(音の高さはこの端末の中で変える)
// ・歌詞やコードを押すとそこから流れる(曲と合わせる と同じ。時刻は原曲の時刻つき歌詞から)
// ・ファイルはこの端末(IndexedDB の media、'src:曲ID')に置き、40MB までなら非公開のクラウド(hikigatari-audio)にも置いて、
//   ほかの端末では最初に流すときに一度だけ取ってくる。曲の設定 settings.own = { name, size, dur, fp, path, type, at } は同期される
// ・Apple Music の曲は保護されていてファイルにできないので使えない。YouTube などから抜き出した音は扱わない
import { useEffect, useRef, useState } from 'react';
import { api, deviceKey } from '../lib/api.js';
import { lib, media } from '../lib/store.js';
import { AUDIO_FN_URL } from '../config.js';
import { audioCtx, holdPlayback, releasePlayback } from '../lib/sound.js';
import { decodeAudio } from '../music/earcopy.js';
import { aacFromMp4 } from '../music/voice.js';
import { shifterLatency, VOICE_FORMANT } from '../music/keyshift.js';

export const CLOUD_MAX = 40 * 1024 * 1024; // クラウドに置けるのは1曲 40MB まで
const LOCAL_MAX = 400 * 1024 * 1024;
const mid = (songId) => 'src:' + songId;
const extOf = (name) => (String(name).match(/\.([A-Za-z0-9]{2,5})$/)?.[1] || '').toLowerCase();
const isVideo = (f) => /^video\//.test(f.type || '') || /\.(mov|mp4|m4v)$/i.test(f.name || '');
export const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;

// ---------------------------------------------------------------- 音を読む

// 読んだ音は、いま使っている曲のぶんだけ覚えておく(同じファイルを読み直さない)
let decoded = { fp: null, buf: null };
export async function decodeOwn(blob, fp) {
  if (fp && decoded.fp === fp && decoded.buf) return decoded.buf;
  let ab = null;
  // 動画は音のところだけ取り出して読む(丸ごと読むとメモリが足りなくなる)
  if (isVideo(blob)) {
    try {
      const a = await aacFromMp4(blob);
      if (a) ab = a.buffer;
    } catch {}
  }
  const buf = await decodeAudio(ab || (await blob.arrayBuffer()));
  if (!buf?.duration) throw new Error('decode');
  decoded = { fp, buf };
  return buf;
}

// 選んだファイル → この曲の音源として使える形(動画なら音だけ取り出す)と長さ
async function prepareFile(file) {
  if (file.size > LOCAL_MAX * 3) throw Object.assign(new Error('big'), { code: 'big' });
  let blob = file;
  let name = file.name || '音源';
  if (isVideo(file)) {
    const a = await aacFromMp4(file).catch(() => null);
    if (a) {
      blob = new Blob([a], { type: 'audio/aac' });
      name = name.replace(/\.[^.]+$/, '') + '.aac';
    } else if (file.size > LOCAL_MAX) throw Object.assign(new Error('big'), { code: 'big' });
  }
  if (blob.size > LOCAL_MAX) throw Object.assign(new Error('big'), { code: 'big' });
  const fp = `${name}|${blob.size}`;
  let buf;
  try {
    buf = await decodeOwn(blob, fp);
  } catch {
    throw Object.assign(new Error('decode'), { code: 'decode' });
  }
  if (buf.duration < 20) throw Object.assign(new Error('short'), { code: 'short' });
  return { blob, name, fp, type: blob.type || 'audio/mp4', size: blob.size, dur: Math.round(buf.duration * 10) / 10 };
}

// ---------------------------------------------------------------- クラウド

const call = (action, payload = {}, opt = {}) => api(action, payload, { url: AUDIO_FN_URL, ...opt });

function putWithProgress(url, blob, type, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('content-type', type || 'application/octet-stream');
    x.setRequestHeader('x-upsert', 'false');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`送れませんでした (${x.status})`)));
    x.onerror = () => reject(new Error('送れませんでした（通信を確かめてください）'));
    x.send(blob);
  });
}

async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`取ってこられませんでした (${r.status})`);
  const total = Number(r.headers.get('content-length') || 0);
  if (!r.body || !total) return r.blob();
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(got / total);
  }
  return new Blob(parts, { type: r.headers.get('content-type') || '' });
}

export const ownCloud = {
  usage: () => call('usage', {}, { timeout: 20000 }),
  del: (paths) => call('del', { paths: paths.filter(Boolean) }).catch(() => {}),
};

// ---------------------------------------------------------------- 曲ごとの音源(この端末にあるか・取ってくる・入れる・外す)

// need: いま流したい(この端末に無ければクラウドから取ってくる)
// 戻り値 status: none(音源なし) | check | local(この端末にある) | remote(クラウドにある・まだ取ってきていない) | down(取ってきている) | missing(ほかの端末にだけある) | error
export function useOwnAudio(song, { need = false } = {}) {
  const own = song.settings?.own || null;
  const [s, setS] = useState({ rec: null, status: own ? 'check' : 'none', prog: 0, err: '' });
  const [up, setUp] = useState(null); // クラウドへ送っている: { prog } / 失敗: { err }
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // この端末にあるか
  useEffect(() => {
    if (!own) {
      setS({ rec: null, status: 'none', prog: 0, err: '' });
      return;
    }
    let ok = true;
    setS((p) => (p.rec?.fp === own.fp ? p : { rec: null, status: 'check', prog: 0, err: '' }));
    media.get(mid(song.id)).then((loc) => {
      if (!ok) return;
      if (loc?.blob && loc.fp === own.fp) setS({ rec: loc, status: 'local', prog: 0, err: '' });
      else setS({ rec: null, status: own.path ? 'remote' : 'missing', prog: 0, err: '' });
    });
    return () => {
      ok = false;
    };
  }, [song.id, own?.fp, own?.path]);

  // 流したいのにこの端末に無ければ、クラウドから一度だけ取ってくる
  const busy = useRef(false);
  const download = async () => {
    if (busy.current || !own?.path) return;
    busy.current = true;
    setS((p) => ({ ...p, status: 'down', prog: 0, err: '' }));
    try {
      const { url } = await call('get', { path: own.path });
      const blob = await fetchWithProgress(url, (prog) => alive.current && setS((p) => ({ ...p, prog })));
      const rec = { blob, name: own.name, type: own.type || blob.type, size: blob.size, fp: own.fp, path: own.path, savedAt: Date.now() };
      await media.put(mid(song.id), rec).catch(() => {});
      if (alive.current) setS({ rec, status: 'local', prog: 1, err: '' });
    } catch (e) {
      if (alive.current) setS({ rec: null, status: e.code === 'missing' ? 'missing' : 'error', prog: 0, err: e.message });
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    if (need && s.status === 'remote') download();
  }, [need, s.status]);

  // クラウドに置く(ほかの端末でも使えるように)
  const upload = async (rec, meta) => {
    if (!deviceKey.get() || rec.size > CLOUD_MAX) return;
    setUp({ prog: 0 });
    try {
      const { path, url } = await call('put', { songId: song.id, ext: extOf(rec.name) || 'm4a', size: rec.size });
      await putWithProgress(url, rec.blob, rec.type, (prog) => alive.current && setUp({ prog }));
      const cur = lib.get(song.id)?.settings?.own;
      // 送っているあいだに別のファイルに替えていたら、送ったものは捨てる
      if (!cur || cur.fp !== meta.fp) {
        ownCloud.del([path]);
      } else {
        await lib.patchSettings(song.id, { own: { ...cur, path } });
        await media.put(mid(song.id), { ...rec, path }).catch(() => {});
      }
      if (alive.current) setUp(null);
    } catch (e) {
      if (alive.current) setUp({ err: e.message });
    }
  };

  // ファイルを選んだ: この曲の音源にする(前のものは置きかえ)
  const attach = async (file) => {
    const prev = lib.get(song.id)?.settings?.own;
    const p = await prepareFile(file);
    const rec = { blob: p.blob, name: p.name, type: p.type, size: p.size, fp: p.fp, path: null, savedAt: Date.now() };
    await media.put(mid(song.id), rec);
    const meta = { name: p.name, size: p.size, dur: p.dur, fp: p.fp, type: p.type, path: null, at: Date.now() };
    await lib.patchSettings(song.id, { own: meta, musicSrc: 'own', ytOn: true, recOn: false });
    setS({ rec, status: 'local', prog: 0, err: '' });
    if (prev?.path) ownCloud.del([prev.path]);
    upload(rec, meta);
    return { ...meta, cloud: !!deviceKey.get() && p.size <= CLOUD_MAX };
  };
  const remove = async () => {
    const prev = lib.get(song.id)?.settings?.own;
    await media.del(mid(song.id));
    await lib.patchSettings(song.id, { own: null, musicSrc: null });
    if (prev?.path) ownCloud.del([prev.path]);
    setS({ rec: null, status: 'none', prog: 0, err: '' });
    setUp(null);
  };
  const retryUpload = () => s.rec && own && upload(s.rec, own);

  return { own, ...s, up, attach, remove, download, retryUpload };
}

// ---------------------------------------------------------------- 流す(好きなキー・速さで)

const WORKLET = new URL('../music/keyshift-worklet.js', import.meta.url).href;
const workletLoads = new WeakMap();
function workletReady(ctx) {
  if (!workletLoads.has(ctx)) {
    const p = ctx.audioWorklet.addModule(WORKLET);
    p.catch(() => workletLoads.delete(ctx));
    workletLoads.set(ctx, p);
  }
  return workletLoads.get(ctx);
}

// rec: { blob, fp, name } を流す。戻り値は YouTube のプレーヤー(useYouTube)と同じ形 { ui, api }(自動スクロールの時計に使う)。
// semis: キー(半音)。速さを変えても音の高さは変わらないよう、そのぶんもキーで戻す
export function useOwnPlayer(rec, { semis = 0, voice = 'orig', onEnd } = {}) {
  const [ui, setUi] = useState({ ready: false, state: -1, blocked: false, error: null });
  const cb = useRef(onEnd);
  cb.current = onEnd;
  const r = useRef({ buf: null, ctx: null, node: null, gain: null, src: null, t0: 0, off: 0, rate: 1, semis, voice, playing: false, want: false, held: false, name: '' }).current;
  const total = () => r.semis + 12 * Math.log2(1 / r.rate);
  // 声の響き: 速さを変えた(速く・遅く読んだ)ぶんも響きが動くので、そのぶんも戻す
  const fmt = () => (VOICE_FORMANT[r.voice] ?? 1) / r.rate;
  const lag = () => {
    const c = r.ctx;
    if (!c) return 0;
    return shifterLatency(c.sampleRate, total()) + (c.outputLatency || 0) + (c.baseLatency || 0);
  };
  const dur = () => r.buf?.duration || 0;
  // 耳に聞こえている位置
  const heard = () => {
    if (!r.playing || !r.ctx) return r.off;
    const el = r.ctx.currentTime - r.t0 - lag();
    return el <= 0 ? r.off : Math.min(dur(), r.off + el * r.rate);
  };
  const hold = (on) => {
    if (on && !r.held) holdPlayback();
    if (!on && r.held) releasePlayback();
    r.held = on;
  };
  const stopSrc = () => {
    const s = r.src;
    if (!s) return;
    r.src = null;
    const now = r.ctx.currentTime;
    const g = r.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.025);
    try {
      s.stop(now + 0.03);
    } catch {}
  };
  const startAt = (off) => {
    const c = r.ctx;
    stopSrc();
    const s = c.createBufferSource();
    s.buffer = r.buf;
    s.playbackRate.value = r.rate;
    s.connect(r.node);
    const t0 = c.currentTime + 0.045;
    // 前の場所の音を捨ててから、新しい場所を流し始める
    r.node.port.postMessage({ reset: t0 - 0.006, semis: total(), formant: fmt() });
    const g = r.gain.gain;
    g.setValueAtTime(1, t0);
    s.start(t0, Math.max(0, Math.min(off, dur() - 0.02)));
    s.onended = () => {
      if (r.src !== s) return;
      r.src = null;
      r.playing = false;
      r.off = dur();
      hold(false);
      setUi((u) => ({ ...u, state: 0 }));
      cb.current?.();
    };
    r.src = s;
    r.t0 = t0;
    r.off = off;
    r.playing = true;
  };

  const api = useRef(null);
  if (!api.current) {
    api.current = {
      time: () => heard(),
      seek(t) {
        const to = Math.max(0, Math.min(t, Math.max(0, dur() - 0.05)));
        if (r.playing) startAt(to);
        else r.off = to;
      },
      play() {
        r.want = true;
        hold(true);
        // iPhone は押した瞬間に音の出口を開ける
        audioCtx();
        if (!r.node || !r.buf || r.playing) return;
        if (r.off >= dur() - 0.05) r.off = 0;
        startAt(r.off);
        setUi((u) => ({ ...u, state: 1 }));
      },
      pause() {
        r.want = false;
        if (r.playing) {
          r.off = heard();
          stopSrc();
          r.playing = false;
        }
        hold(false);
        setUi((u) => (u.state === 1 ? { ...u, state: 2 } : u));
      },
      ended: () => !r.playing && dur() > 0 && r.off >= dur() - 0.06,
      duration: () => dur(),
      title: () => r.name,
      setRate(x) {
        const pos = heard();
        r.rate = x;
        if (r.playing) startAt(pos);
        else r.node?.port.postMessage({ semis: total(), formant: fmt() });
      },
    };
  }

  // キー・声が変わったら、流したままその場で変える
  useEffect(() => {
    r.semis = semis;
    r.voice = voice;
    r.node?.port.postMessage({ semis: total(), formant: fmt() });
  }, [semis, voice]);

  // 音を読んで、流す部品(キーを変える部品 → 音量 → スピーカー)を用意する
  const fp = rec?.fp || null;
  useEffect(() => {
    if (!rec?.blob) return;
    let dead = false;
    r.name = (rec.name || '').replace(/\.[^.]+$/, '');
    setUi({ ready: false, state: -1, blocked: false, error: null });
    (async () => {
      try {
        const buf = await decodeOwn(rec.blob, rec.fp);
        const c = audioCtx();
        await workletReady(c);
        if (dead) return;
        const node = new AudioWorkletNode(c, 'keyshift', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { semis: total(), formant: fmt() },
        });
        const gain = c.createGain();
        node.connect(gain).connect(c.destination);
        Object.assign(r, { buf, ctx: c, node, gain, off: Math.min(r.off, buf.duration) });
        setUi((u) => ({ ...u, ready: true, state: 5 }));
        if (r.want) api.current.play();
      } catch (e) {
        if (!dead) setUi((u) => ({ ...u, error: e?.message === 'decode' ? 'decode' : 'load' }));
      }
    })();
    return () => {
      dead = true;
      stopSrc();
      r.playing = false;
      hold(false);
      try {
        r.node?.disconnect();
        r.gain?.disconnect();
      } catch {}
      Object.assign(r, { buf: null, node: null, gain: null, off: 0, want: false });
    };
  }, [fp]);

  return { ui, api: api.current };
}
