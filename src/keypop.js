// 小さい窓(key.html): ひきがたりのタブで流れている原曲(YouTube)の音を取り込み、キーを変えてこの窓から流す。パソコンの Chrome・Edge だけ。
// ・取り込むときに「元の音はタブから出さない」(suppressLocalAudioPlayback)。キーを変えた音はこの窓から出るので、混ざらない・戻ってこない
// ・キーはひきがたりの曲の画面とやりとりする(BroadcastChannel 'hikigatari-key')。どちらで変えても同じ
// 音を保存したり送ったりはしない
const $ = (id) => document.getElementById(id);
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

const bc = new BroadcastChannel('hikigatari-key');
const st = { songId: null, title: '', semis: 0, label: '', compare: false };
let rt = null; // { ctx, stream, node }

function show() {
  $('song').textContent = st.title ? `「${st.title}」` : 'ひきがたりで曲を開いてください';
  $('key').textContent = st.semis ? signed(st.semis) : '原曲';
  $('keysub').textContent = st.label || ' ';
  $('down').disabled = st.semis <= -6;
  $('up').disabled = st.semis >= 6;
  $('idle').hidden = !!rt;
  $('live').hidden = !rt;
  $('ab').textContent = st.compare ? 'このキーに戻す' : '原曲キーと聴き比べ';
  $('ab').setAttribute('aria-pressed', String(st.compare));
  $('ab').disabled = !st.semis && !st.compare;
  $('livetext').textContent = st.compare ? 'いまは原曲キーで流しています' : st.semis ? `${signed(st.semis)} のキーで流しています` : '原曲キーのまま流しています（キーを変えるとその場で変わります）';
  document.title = rt ? `♪ ${st.semis ? signed(st.semis) : '原曲'} - キーを変えて流す` : 'キーを変えて流す - ひきがたり';
}
const apply = () => rt?.node.port.postMessage({ semis: st.compare ? 0 : st.semis });
const msg = (id, text) => {
  $(id).textContent = text || '';
  $(id).hidden = !text;
};

async function start() {
  msg('err', '');
  msg('note', '');
  // どちらも押した瞬間に始める(音の出口と、取り込みの許可)
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 1 },
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
  } catch (e) {
    ctx.close().catch(() => {});
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') msg('err', `取り込めませんでした（${e?.message || e}）`);
    return;
  }
  const audio = stream.getAudioTracks()[0];
  const video = stream.getVideoTracks()[0];
  const surface = video?.getSettings?.().displaySurface;
  if (!audio) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    msg('err', surface && surface !== 'browser' ? 'ウィンドウや画面全体だと音を取り込めません。もう一度押して「Chrome タブ」から ひきがたり を選んでください' : '音が取り込めていません。もう一度押して、「タブの音声も共有する」をオンにしてから「共有」を押してください');
    return;
  }
  try {
    await ctx.audioWorklet.addModule('src/music/keyshift-worklet.js');
    const node = new AudioWorkletNode(ctx, 'keyshift', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { semis: st.compare ? 0 : st.semis },
    });
    const src = ctx.createMediaStreamSource(new MediaStream([audio]));
    src.connect(node).connect(ctx.destination);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    rt = { ctx, stream, node };
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    msg('err', `キーを変える準備ができませんでした（${e?.message || e}）`);
    return;
  }
  audio.addEventListener('ended', () => stop());
  // 選んだのが ひきがたり 以外のタブなら、そのことを知らせる(そのタブの音のキーを変えて流す)
  const handle = video?.getCaptureHandle?.();
  const notes = [];
  if (handle && handle.handle !== 'hikigatari') notes.push('ひきがたり以外のタブを選んでいます。そのタブの音のキーを変えて流します。');
  if (audio.getSettings?.().suppressLocalAudioPlayback === false)
    notes.push('元の音も同時に聞こえるときは、ひきがたりのタブを右クリックして「サイトをミュート」にしてください（取り込む音は消えません）。');
  msg('note', notes.join(''));
  bc.postMessage({ type: 'state', on: true });
  show();
}

function stop() {
  if (!rt) return;
  const { ctx, stream } = rt;
  rt = null;
  stream.getTracks().forEach((t) => t.stop());
  ctx.close().catch(() => {});
  st.compare = false;
  bc.postMessage({ type: 'state', on: false });
  show();
}

function step(d) {
  const v = Math.max(-6, Math.min(6, st.semis + d));
  if (v === st.semis) return;
  st.compare = false;
  // 曲を開いていれば、曲の画面のキーを変える(変わったキーが送り返されてくる)。開いていなければ、この窓だけで
  if (st.songId) bc.postMessage({ type: 'setKey', songId: st.songId, semis: v });
  else {
    st.semis = v;
    st.label = '';
    apply();
    show();
  }
}

bc.onmessage = (e) => {
  const d = e.data || {};
  if (d.type === 'key') {
    const changed = d.semis !== st.semis;
    Object.assign(st, { songId: d.songId || null, title: d.title || '', semis: d.semis | 0, label: d.label || '' });
    if (changed) st.compare = false;
    apply();
    show();
  } else if (d.type === 'ping') bc.postMessage({ type: 'state', on: !!rt });
  else if (d.type === 'stop') {
    stop();
    window.close();
  }
};

$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => {
  stop();
  window.close();
});
$('down').addEventListener('click', () => step(-1));
$('up').addEventListener('click', () => step(1));
$('ab').addEventListener('click', () => {
  st.compare = !st.compare;
  apply();
  show();
});
window.addEventListener('pagehide', stop);

if (!navigator.mediaDevices?.getDisplayMedia || !navigator.mediaDevices.getSupportedConstraints?.().suppressLocalAudioPlayback) {
  $('start').disabled = true;
  msg('err', 'このブラウザでは使えません。パソコンの Chrome か Edge で開いてください');
}
show();
bc.postMessage({ type: 'hello' });
