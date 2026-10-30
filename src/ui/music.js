// 曲と合わせる: 原曲の YouTube の動画をアプリの中で流し、譜面をその再生位置に合わせて動かす。
// 歌詞やコードを押すと、その場所の時刻へ動画を移して、そこから流す。
// ・動画は曲ごとに1回だけ読み込み、押すたびに読み直さない(再生位置を移すだけ)
// ・譜面の行 ↔ 曲の時刻は、コード進行メモ倉庫の曲データ(動画の時刻そのもの)か、時刻つき歌詞から作る(music/timing.js)
// ・動画と時刻がずれる曲は「歌に合わせる」(流しながら、いま歌っている歌詞をタップ)で直す
// ・流す音は YouTube の動画か、自分の音源ファイル(ownaudio.js。広告なし・好きなキーと速さで流せる)。
//   自分の音源があれば、そちらを先に使う(settings.musicSrc = 'yt' のときだけ YouTube)
import React, { useEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon } from './icons.js';
import { Sheet, Segmented, toast } from './common.js';
import { api } from '../lib/api.js';
import { YT_FN_URL } from '../config.js';
import { lib, local } from '../lib/store.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import { findLyrics, krcToSynced, krcCandidates } from '../lib/lyrics.js';
import { mcToSheet } from '../music/mcsheet.js';
import { alignLines, mcDirect, mcSyncedLines, syncedLines, vocalSpans, mcSpans, tapTime, rankVideos, parseYouTubeId } from '../music/timing.js';
import { cx, baseTitle, signed } from '../lib/util.js';
import { useOwnPlayer, mb, CLOUD_MAX } from './ownaudio.js';
const html = htm.bind(React.createElement);

const LEAD = 0.12; // 押した文字・コードの出だしが切れないよう、ほんの少しだけ手前から
const REACT = 0.2; // 「いまここ」と押すまでの、指の反応の遅れ
const RATES = [1, 0.75, 0.5]; // YouTube で選べる速さ(音程はそのまま)

// Chrome で開く: iPhone・iPad は googlechromes:// で Chrome アプリへ、ほかは新しいタブ
const UA = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IN_CHROME = /CriOS/.test(UA) || (!IOS && /Chrome\//.test(UA) && !/Edg|OPR|SamsungBrowser/.test(UA));
// このページ(譜面ごと)を Chrome に移せるのは iPhone・iPad で、いま Chrome でないときだけ
export const CAN_PAGE_CHROME = IOS && !IN_CHROME;
function openInChrome(url) {
  if (!IOS) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  location.href = url.replace(/^https:/, 'googlechromes:');
  // Chrome が入っていないと何も起きないので、画面が隠れなければ知らせる
  const t = setTimeout(() => !document.hidden && toast('Chrome が見つかりませんでした。App Store から Chrome を入れると開けます'), 1600);
  document.addEventListener('visibilitychange', () => clearTimeout(t), { once: true });
}

const mmss = (t) => (isFinite(t) && t > 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- YouTube のプレーヤー

let apiLoad = null;
function loadApi() {
  if (apiLoad) return apiLoad;
  apiLoad = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiLoad = null;
      s.remove();
      reject(new Error('YouTube を読み込めませんでした'));
    };
    document.head.appendChild(s);
  });
  return apiLoad;
}

// videoId の動画を、host(setHost で渡された場所)に置く。動画が変わっても置き直さず、中身だけ入れ替える。
// on: { onPlay, onPause, onError(code, videoId) }(動画の側のボタンで再生・一時停止されたときも呼ばれる)
// 戻り値の api は自動スクロールの時計として使う(time は「耳に聞こえている位置」をなめらかに返す)
export function useYouTube(videoId, on = {}) {
  const [host, setHost] = useState(null);
  const [ui, setUi] = useState({ ready: false, state: -1, blocked: false, error: null });
  const cb = useRef(on);
  cb.current = on;
  const r = useRef({ p: null, ready: false, vid: null, state: -1, raw: 0, base: 0, at: 0, rate: 1, want: null, wantAt: 0, retry: false, wantPlay: false, blockT: 0, pauseT: 0 }).current;

  // まだ流れていない(読み込んだだけ・最後まで流れた)。このとき位置を移すと再生が始まってしまうので、再生のときにまとめて移す
  const idle = () => r.state === 5 || r.state === -1 || r.state === 0;
  const api = useRef(null);
  if (!api.current) {
    api.current = {
      time() {
        const now = performance.now();
        if (r.ready && r.p?.getCurrentTime) {
          const raw = r.p.getCurrentTime() || 0;
          if (raw !== r.raw) {
            r.raw = raw;
            r.base = raw;
            r.at = now;
          }
        }
        // 頼んだ場所に着くまでは、頼んだ場所を今の位置として返す(読み込み中・広告のあいだに、譜面が曲の頭へ飛ばないように)
        if (r.want != null) {
          if (Math.abs(r.raw - r.want) < 1.2 || (r.state === 1 && now - r.wantAt > 6000)) r.want = null;
          else return r.want;
        }
        // プレーヤーが教えてくれる時刻は飛び飛びなので、流れている間は自分で進めてなめらかにする
        return r.state === 1 ? r.base + Math.min(0.6, (now - r.at) / 1000) * r.rate : r.base;
      },
      seek(t) {
        r.want = Math.max(0, t);
        r.wantAt = performance.now();
        r.retry = false;
        if (r.ready && !idle()) r.p.seekTo(r.want, true);
      },
      play() {
        r.wantPlay = true;
        if (!r.ready) return;
        if (r.want != null && idle()) r.p.seekTo(r.want, true);
        r.p.playVideo();
        // iPhone は、最初の1回だけ動画そのものを押さないと始まらない。始まらなければ案内を出す
        clearTimeout(r.blockT);
        r.blockT = setTimeout(() => {
          if (r.wantPlay && r.state !== 1 && r.state !== 3) setUi((u) => ({ ...u, blocked: true }));
        }, 1800);
      },
      pause() {
        r.wantPlay = false;
        clearTimeout(r.blockT);
        if (r.ready) r.p.pauseVideo?.();
        setUi((u) => (u.blocked ? { ...u, blocked: false } : u));
      },
      ended: () => r.state === 0,
      duration: () => (r.ready && r.p?.getDuration?.()) || 0,
      title: () => (r.ready && r.p?.getVideoData?.()?.title) || '',
      setRate(x) {
        r.rate = x;
        if (r.ready) r.p.setPlaybackRate?.(x);
      },
    };
  }

  const has = !!videoId;
  useEffect(() => {
    if (!host || !has) return;
    let dead = false;
    const slot = document.createElement('div');
    host.appendChild(slot);
    setUi({ ready: false, state: -1, blocked: false, error: null });
    const onState = (s) => {
      if (dead) return;
      r.state = s;
      if (s === 1) {
        clearTimeout(r.blockT);
        clearTimeout(r.pauseT);
        // 広告のあと・最初に動画を押したあとなど、頼んだ場所から始まっていなければ、もう一度そこへ
        if (r.want != null && !r.retry && Math.abs((r.p.getCurrentTime?.() || 0) - r.want) > 1.5) {
          r.retry = true;
          r.wantAt = performance.now();
          r.p.seekTo(r.want, true);
        }
        r.wantPlay = true;
        setUi((u) => ({ ...u, state: 1, blocked: false, error: null }));
        cb.current.onPlay?.();
      } else if (s === 2) {
        setUi((u) => ({ ...u, state: 2 }));
        // 位置を移した直後に一瞬だけ「一時停止」になることがあるので、少し待って本当に止まっていたら知らせる
        clearTimeout(r.pauseT);
        r.pauseT = setTimeout(() => !dead && r.state === 2 && cb.current.onPause?.(), 350);
      } else setUi((u) => (u.state === s ? u : { ...u, state: s }));
    };
    loadApi()
      .then((YT) => {
        if (dead) return;
        r.vid = videoId;
        r.p = new YT.Player(slot, {
          videoId,
          // 個人に合わせた広告を出さない読み込み方(YouTube の「プライバシー強化モード」)。広告そのものはアプリからは消せないが、出にくくなる
          host: 'https://www.youtube-nocookie.com',
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => {
              if (dead) return;
              r.ready = true;
              if (r.rate !== 1) r.p.setPlaybackRate?.(r.rate);
              setUi((u) => ({ ...u, ready: true }));
              if (r.wantPlay) api.current.play();
            },
            onStateChange: (e) => onState(e.data),
            onError: (e) => {
              if (dead) return;
              setUi((u) => ({ ...u, error: e.data || 1 }));
              cb.current.onError?.(e.data, r.vid);
            },
            onPlaybackRateChange: (e) => {
              r.rate = e.data || 1;
            },
          },
        });
      })
      .catch(() => !dead && setUi((u) => ({ ...u, error: 'load' })));
    return () => {
      dead = true;
      clearTimeout(r.blockT);
      clearTimeout(r.pauseT);
      try {
        r.p?.destroy?.();
      } catch {}
      Object.assign(r, { p: null, ready: false, vid: null, state: -1, raw: 0, base: 0, want: null, wantPlay: false });
      host.textContent = '';
    };
  }, [host, has]);

  // 別の動画に替える(プレーヤーはそのまま)
  useEffect(() => {
    if (!r.ready || !videoId || r.vid === videoId) return;
    r.vid = videoId;
    Object.assign(r, { raw: 0, base: 0, want: null, wantPlay: false, state: 5 });
    r.p.cueVideoById?.(videoId);
    setUi((u) => ({ ...u, state: 5, blocked: false, error: null }));
  }, [videoId, ui.ready]);

  return { setHost, ui, api: api.current };
}

// ---------------------------------------------------------------- Chrome で YouTube を流す

// アプリの中に動画を置かず、Chrome の YouTube(本物の動画ページ)で流す。歌詞を押すたびに、その時刻から Chrome で開き直す。
// ・パソコン: Chrome の小さい窓(いつも同じ窓)を開いて、そこで流す。止めると窓を閉じる
// ・iPhone・iPad: Chrome アプリで開く(googlechromes://)。アプリからは Chrome の動画を止められないので、止めるのは Chrome の側で
// Chrome の中の再生位置は読めないので、開いた時刻からこちらで数える(開いてから音が出るまでの待ち LAG を引く。ずれは「早く/遅く」で)
const CHROME_WIN = 'hikigatari-yt';
const LAG = IOS ? 2.5 : 2.0;
export function useChromePlayer(video, on = {}) {
  const [ui, setUi] = useState({ ready: false, state: -1, blocked: false, error: null });
  const cb = useRef(on);
  cb.current = on;
  const r = useRef({ playing: false, base: 0, at: 0, win: null, dur: 0 }).current;
  r.dur = video?.dur || 0;
  r.video = video;
  const elapsed = () => Math.max(0, (Date.now() - r.at) / 1000 - LAG);
  const open = (t) => {
    const url = `https://www.youtube.com/watch?v=${r.video.id}${t >= 1 ? `&t=${Math.floor(t)}s` : ''}`;
    // 秒より細かい位置は指定できないので、切り捨てたぶんを基準にする
    r.base = t >= 1 ? Math.floor(t) : 0;
    r.at = Date.now();
    if (IOS) {
      openInChrome(url);
      return;
    }
    const w = Math.min(560, screen.availWidth || 560);
    r.win = window.open(url, CHROME_WIN, `popup,width=${w},height=${Math.round((w * 9) / 16) + 80},left=${Math.max(0, (screen.availWidth || w) - w)},top=0`);
    if (!r.win) toast('Chrome の窓を開けませんでした（ポップアップを許可してください）', { kind: 'error', ms: 5000 });
  };
  const api = useRef(null);
  if (!api.current) {
    api.current = {
      time: () => (r.playing ? r.base + elapsed() : r.base),
      seek(t) {
        t = Math.max(0, t);
        if (r.playing) open(t);
        else r.base = t;
      },
      play() {
        if (r.playing) return;
        r.playing = true;
        open(r.base);
        setUi((u) => ({ ...u, state: 1 }));
      },
      pause() {
        if (!r.playing) return;
        r.base = r.base + elapsed();
        r.playing = false;
        try {
          r.win?.close();
        } catch {}
        r.win = null;
        setUi((u) => ({ ...u, state: 2 }));
      },
      ended: () => !!r.dur && r.base + (r.playing ? elapsed() : 0) >= r.dur - 0.5,
      duration: () => r.dur,
      title: () => r.video?.title || '',
      setRate() {},
    };
  }
  // パソコン: Chrome の窓を閉じたら、譜面も止める
  useEffect(() => {
    if (IOS) return;
    const id = setInterval(() => {
      if (r.playing && r.win && r.win.closed) {
        r.win = null;
        api.current.pause();
        cb.current.onPause?.();
      }
    }, 700);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setUi({ ready: !!video, state: video ? 5 : -1, blocked: false, error: null });
    Object.assign(r, { playing: false, base: 0 });
  }, [video?.id]);
  useEffect(
    () => () => {
      try {
        r.win?.close();
      } catch {}
    },
    [],
  );
  return { ui, api: api.current };
}

// ---------------------------------------------------------------- 譜面の行と曲の時刻を結びつける

// 戻り値: { base: 'yt' | 'album', vid, src, lines, hit, act: 原曲で歌っている区間(自分の歌の録音を合わせるときの見本) } か { none: true, soft: 通信できなかった }
// lyricsFirst: 時刻つき歌詞を先に探す(自分の歌の録音を合わせるとき。動画の時刻である必要は無く、文字ごとの長さまで分かる歌詞のほうがよく合う)
async function buildTiming(song, lines, { lyricsFirst = false } = {}) {
  let soft = false;
  // この曲がコード進行メモ倉庫にもあれば、その曲データ(動画の時刻そのもの)を使う
  const fromMc = async () => {
    const mcSlug = song.source === 'mcmemo' ? song.sourceId : (song.sources || []).find((s) => s.source === 'mcmemo')?.id;
    if (!mcSlug) return null;
    try {
      const r = await api('sheet', { source: 'mcmemo', id: mcSlug, title: song.title, artist: song.artist });
      if (r?.mc?.sections?.length) {
        // 文字ごとの時刻つき歌詞は、候補の中からこの動画の時刻にいちばん合うものを使う(音源の版ごとに時刻が違う)
        let krcs = null;
        let krc = null;
        try {
          krcs = await krcCandidates({ title: song.title, artist: song.artist || '', durationMs: song.durationMs || 0 });
        } catch {}
        if (!krcs?.length) {
          try {
            krc = krcToSynced((await api('lyrics_krc', { title: song.title, artist: song.artist || '', durationMs: song.durationMs || 0 })).lines);
          } catch {}
        }
        const rows = mcToSheet(r.mc, { krc: krc?.length ? krc : null, krcs: krcs?.length ? krcs : null }).rows;
        const direct = song.source === 'mcmemo' ? mcDirect(rows, lines) : null;
        const res = direct ? { lines: direct, hit: 1 } : alignLines(lines, mcSyncedLines(rows));
        // offset: 曲データの時刻は「曲が鳴り始めたところ」が基準で、動画では曲の前に映像だけの場面があることがある(MV の冒頭のドラマなど)。
        // そのぶん(timeOffset 秒)動画の時刻は後ろにずれている。運命さがし(マカロニえんぴつ)は 16.9 秒
        if (res) return { base: 'yt', vid: r.mc.youtubeVideoId || null, offset: Number(r.mc.timeOffset) || 0, src: 'mc', lines: res.lines, hit: res.hit, act: mcSpans(rows) };
      }
    } catch {
      soft = true;
    }
    return null;
  };
  // 時刻つき歌詞(文字ごと → 行ごと)。時刻は原曲の音源のもの
  const fromLyrics = async () => {
    try {
      const f = await findLyrics({ title: song.title, artist: song.artist, durationMs: song.durationMs });
      if (f?.synced) {
        const res = alignLines(lines, syncedLines(f.synced));
        if (res) return { base: 'album', vid: null, src: f.wordTimed ? 'krc' : 'lrc', lines: res.lines, hit: res.hit, act: vocalSpans(f.synced) };
      }
    } catch {
      soft = true;
    }
    return null;
  };
  for (const from of lyricsFirst ? [fromLyrics, fromMc] : [fromMc, fromLyrics]) {
    const tm = await from();
    if (tm) return tm;
  }
  return { none: true, soft };
}

const timingSig = (song) => `${song.source}:${song.sourceId || ''}:${hash(song.sheet.text)}`;

// 譜面の行 ↔ 曲の時刻。作ったものは手元に置いておき、譜面が変わったら作り直す。
// voice: 自分の歌の録音を合わせるための時刻(時刻つき歌詞を先に探す。曲と合わせる用とは別に控える)
export async function loadTiming(song, lines, { voice = false } = {}) {
  const sig = timingSig(song);
  const key = (voice ? 'tv1:' : 'tm3:') + song.id; // tm3: 曲の頭のずれ(offset)を足した版
  let tm = await local.get(key);
  // 見つからなかった曲は3日、行ごとの時刻しか無かった曲は7日たったら、もう一度探す(歌詞のデータがあとから増えることがある)
  const age = Date.now() - (tm?.at || 0);
  if (!tm || tm.sig !== sig || (tm.none && age > 3 * 864e5) || (tm.src === 'lrc' && age > 7 * 864e5)) {
    tm = { ...(await buildTiming(song, lines, { lyricsFirst: voice })), sig, at: Date.now() };
    if (!tm.soft) local.set(key, tm);
  }
  return tm;
}

// ---------------------------------------------------------------- 曲の画面から使う

// scrollApi: useAutoScroll の戻り値を入れておく ref(このフックの時計を自動スクロールに渡すので、順番の都合で ref 経由)
// own: useOwnAudio の戻り値(自分の音源)。semis: いまのキー(自分の音源はそのキーで流す)
export function useSongMusic({ song, st, setSt, lines, bpm, totalBeats, scrollApi, own, semis = 0, voice = 'orig' }) {
  const on = !!st.ytOn;
  // 自分の音源があれば、それを流す(YouTube にしたいときは settings.musicSrc = 'yt')
  const mine = !!own?.own && st.musicSrc !== 'yt';
  const video = !mine && st.yt?.id ? st.yt : null;
  // YouTube をどこで流すか: 'chrome'(Chrome の YouTube で。標準) | 'app'(アプリの中の小さい動画で)
  const [where, setWhereState] = useState(() => getPrefs().ytWhere || 'chrome');
  const viaChrome = !mine && where === 'chrome';
  // 動画(音源)ごとの合わせ込み: pts = 「譜面の時刻 t のところは、動画では off 秒ずれている」の目印(歌に合わせるで作る)。
  // 1か所なら全体を同じだけずらし、何か所かあれば、あいだはなめらかにつなぐ(前奏や間奏の長さが違う動画・テンポの揺れる曲でも合う)
  // Chrome で流すときは、開いてから音が出るまでの待ちが入るので、アプリの中の動画とは別に覚える
  const fixKey = mine ? 'own:' + own.own.fp : video ? (viaChrome ? 'cr:' : '') + video.id : null;
  const fix = (fixKey && st.ytFix?.[fixKey]) || null;
  const pts = fix?.pts || [];
  const offAt = (t) => {
    if (!pts.length) return 0;
    if (t <= pts[0].t) return pts[0].off;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (t <= b.t) return a.off + ((t - a.t) / Math.max(0.01, b.t - a.t)) * (b.off - a.off);
    }
    return pts[pts.length - 1].off;
  };
  const [timing, setTiming] = useState(null);
  const [cands, setCands] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState('small'); // 動画の窓: small | big | hidden
  const [speed, setSpeedState] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [tip, setTip] = useState(() => !getPrefs().musicTapSeen);
  const bad = useRef(new Set()); // この端末で流せなかった動画
  const live = useRef({});

  const yt = useYouTube(on && !mine && !viaChrome ? video?.id : null, {
    onPlay: () => {
      const s = scrollApi.current;
      if (s && !s.isPlaying()) s.start();
    },
    onPause: () => {
      const s = scrollApi.current;
      if (s?.isPlaying()) s.stop();
    },
    onError: (code, vid) => {
      scrollApi.current?.stop();
      bad.current.add(vid);
      const v = live.current.video;
      if (v?.id === vid && v.by === 'auto') {
        toast('この動画はアプリの中では流せないので、別の動画を探します');
        live.current.findVideo({ skip: vid });
      } else
        setErr(
          code === 101 || code === 150
            ? 'この動画は、アプリの中では流せませんでした（持ち主がほかのサイトでの再生を止めています）。別の動画を選んでください'
            : code === 100
              ? 'この動画は見つかりませんでした（消されたか、非公開です）。別の動画を選んでください'
              : 'この動画を流せませんでした。別の動画を選んでください',
        );
    },
  });

  // 自分の音源(流し終わったら譜面も止める)
  const mp = useOwnPlayer(on && mine ? own.rec : null, { semis, voice, onEnd: () => scrollApi.current?.stop() });
  // Chrome の YouTube(パソコンは Chrome の窓を閉じたら譜面も止める)
  const cp = useChromePlayer(on && viaChrome ? video : null, {
    onPause: () => {
      const s = scrollApi.current;
      if (s?.isPlaying()) s.stop();
    },
  });
  const player = mine ? mp : viaChrome ? cp : yt;

  // 譜面の行 ↔ 曲の時刻。作ったものは手元に置いておき、譜面が変わったら作り直す。
  // 自分の音源は原曲(アルバム)の音なので、時刻つき歌詞(原曲の時刻)を先に探す
  const sig = useMemo(() => timingSig(song), [song.source, song.sourceId, song.sheet.text]);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    setTiming(null);
    loadTiming(song, lines, { voice: mine })
      .catch(() => ({ none: true, soft: true }))
      .then((tm) => alive && setTiming(tm));
    return () => {
      alive = false;
    };
  }, [on, song.id, sig, mine]);

  // 動画の候補を探して、並べ直す
  const loadCands = async (tm = timing) => {
    const r = await api('yt_search', { title: baseTitle(song.title), artist: song.artist || '' }, { url: YT_FN_URL });
    const ranked = rankVideos(r.items || [], {
      title: baseTitle(song.title),
      artist: song.artist || '',
      durSec: song.durationMs ? song.durationMs / 1000 : null,
      exact: tm?.base === 'album',
    }).filter((v) => v.score > -20);
    // コード進行メモ倉庫の時刻は、その動画の時刻。いちばん上に置く
    const mine = tm?.vid ? ranked.find((v) => v.id === tm.vid) || { id: tm.vid, title: song.title, channel: '', dur: 0, score: 1 } : null;
    const all = mine ? [{ ...mine, timed: true }, ...ranked.filter((v) => v.id !== mine.id)] : ranked;
    setCands(all);
    return all;
  };
  const finding = useRef(false);
  const findVideo = async ({ skip = null } = {}) => {
    if (finding.current) return;
    finding.current = true;
    setBusy(true);
    setErr(null);
    try {
      const tm = live.current.timing;
      let pick = null;
      if (tm?.vid && tm.vid !== skip && !bad.current.has(tm.vid)) {
        // コード進行メモ倉庫の動画も、検索の候補にあれば本当の題名・チャンネルを使う(確かめてもらうときに出す)
        let all = live.current.cands;
        if (!all) all = await loadCands(tm).catch(() => null);
        const hit = all?.find((v) => v.id === tm.vid && v.channel);
        pick = hit || { id: tm.vid, title: song.title, channel: '', dur: 0 };
      }
      else {
        const all = live.current.cands || (await loadCands(tm));
        pick = all.find((v) => v.id !== skip && !bad.current.has(v.id) && (v.timed || v.score > 0)) || null;
      }
      if (pick) setSt({ yt: { id: pick.id, title: pick.title || song.title, channel: pick.channel || '', dur: pick.dur || 0, by: 'auto' } });
      else {
        if (lib.get(song.id)?.settings?.yt) setSt({ yt: null });
        setErr('原曲の動画が見つかりませんでした。YouTube のリンクを貼ると、その動画で流せます');
      }
    } catch (e) {
      setErr(`動画を探せませんでした（${e.message}）`);
    } finally {
      finding.current = false;
      setBusy(false);
    }
  };
  live.current = { video, timing, cands, findVideo };

  useEffect(() => {
    if (on && !mine && timing && !video && !err) findVideo();
  }, [on, mine, timing, video?.id]);

  // リンクで選んだ動画などは、流れ始めてから長さと題名が分かる
  useEffect(() => {
    if (!on || !video || viaChrome || yt.ui.state !== 1) return;
    const d = Math.round(yt.api.duration());
    const title = yt.api.title();
    const patch = {};
    if (d && !video.dur) patch.dur = d;
    if (title && (!video.title || video.by === 'url') && video.title !== title) patch.title = title;
    if (Object.keys(patch).length) setSt({ yt: { ...video, ...patch } });
  }, [on, video?.id, yt.ui.state]);

  const saveFix = (patch) => {
    if (!fixKey) return;
    const all = { ...(st.ytFix || {}) };
    all[fixKey] = { ...(all[fixKey] || {}), ...patch };
    // 動画(音源)ごとの合わせ込みは、曲ごとに3つぶんまで覚える
    const keys = Object.keys(all);
    if (keys.length > 3) for (const k of keys.slice(0, keys.length - 3)) if (k !== fixKey) delete all[k];
    setSt({ ytFix: all });
  };

  // 自動スクロールの時計: 行の頭の時刻(ずれの直しを足したもの)を目印にする
  const anchors = useMemo(() => {
    if (timing?.lines) return timing.lines.map((L, i) => (L ? { line: i, t: L.t + offAt(L.t) } : null)).filter(Boolean);
    return fix?.anchors || [];
  }, [timing, fix?.pts, fix?.anchors]);
  const dur = mine ? own.own.dur || 0 : video?.dur || (song.durationMs ? song.durationMs / 1000 : 0);
  // 時刻が何も分からない曲は、譜面全体を動画の長さに割り振る(大きく外れるときは BPM どおり)
  const even = dur && totalBeats ? totalBeats / dur : 0;
  const bps = !anchors.length && even && even > (bpm / 60) * 0.6 && even < (bpm / 60) * 1.7 ? even : bpm / 60;
  const pa = player.api;
  const ready = mine ? !!own.rec : !!video;
  // 曲の頭のずれ: その動画で曲が鳴り始める時刻。譜面の時計は「曲の時刻」(= 動画の時刻 − intro)で動かす。
  // 曲の前の映像だけの場面のあいだ、譜面は1行目で待つ。自分の音源(原曲そのもの)と、ほかの動画では 0
  const intro = !mine && timing?.base === 'yt' && timing.offset && video?.id === timing.vid ? timing.offset : 0;
  const songTime = () => pa.time() - intro;
  const clock =
    on && ready
      ? { time: songTime, seekTime: (t) => pa.seek(t + intro), play: pa.play, pause: pa.pause, ended: pa.ended, duration: () => (pa.duration() || dur) - intro, anchors, bps, sync: syncing }
      : null;

  const nextT = (i) => {
    const ls = timing?.lines;
    if (!ls) return null;
    for (let j = i + 1; j < ls.length; j++) if (ls[j]) return ls[j].t;
    return null;
  };

  // 譜面を押した。hit: { i, k, pos, onChord }。beat: その場所の拍(時刻の分からない行で使う)
  // opt.lead: 押した場所の何秒前から流すか(歌い始め・サビの頭から聴くときは、少し手前から)
  const tap = (hit, beat, opt = {}) => {
    const s = scrollApi.current;
    if (!ready) {
      if (mine)
        toast(own.status === 'missing' ? 'この曲の音源は、まだこの端末にありません。下の「曲」から音源のファイルを選んでください' : '音源を準備しています。少し待ってから押してください');
      else toast(err ? '動画がまだ決まっていません。下の「曲」から動画を選んでください' : '動画を準備しています。少し待ってから押してください');
      return;
    }
    const L = timing?.lines?.[hit.i] || null;
    const t = L ? tapTime(L, lines[hit.i], hit, nextT(hit.i)) : null;
    if (syncing) {
      // 歌に合わせる: いま流れている位置が、押した歌詞の位置
      const now = songTime() - REACT * speed;
      if (timing?.lines) {
        if (t == null) {
          toast('この行は時刻が分からないので、歌詞のある行を押してください');
          return;
        }
        // 近く(10秒以内)の目印は置きかえ、前後と順番が食い違う目印は外す
        const next = pts.filter((q) => Math.abs(q.t - t) > 10 && ((q.t < t && q.t + q.off < now) || (q.t > t && q.t + q.off > now)));
        next.push({ t: Math.round(t * 100) / 100, off: Math.round((now - t) * 100) / 100 });
        next.sort((a, b) => a.t - b.t);
        saveFix({ pts: next.slice(-12) });
        setSyncing(false);
        toast(next.length > 1 ? `ここに合わせました（${next.length}か所め。あいだは自動でつなぎます）` : 'ここに合わせました。ずれてきたら、その場所でもう一度「合わせる」');
      } else {
        const i = hit.i;
        const next = (fix?.anchors || []).filter((a) => a.line !== i && ((a.line < i && a.t < now) || (a.line > i && a.t > now)));
        next.push({ line: i, t: +now.toFixed(2) });
        next.sort((a, b) => a.t - b.t);
        saveFix({ anchors: next });
        toast(`この行を ${mmss(now)} に合わせました`, { ms: 1400 });
      }
      return;
    }
    if (tip) {
      setTip(false);
      setPrefs({ musicTapSeen: true });
    }
    s?.playFrom({ beat, time: t != null ? Math.max(0, t + offAt(t) - (opt.lead ?? LEAD)) : null });
  };
  // 全体を少しだけ早く・遅く(目印が無ければ、全体をずらす目印を1つ置く)
  const nudge = (d) => {
    const r = (x) => Math.round(x * 100) / 100;
    saveFix({ pts: pts.length ? pts.map((q) => ({ t: q.t, off: r(q.off + d) })) : [{ t: 0, off: r(d) }] });
  };

  const toggle = (want = !on) => {
    scrollApi.current?.stop();
    setSyncing(false);
    setErr(null);
    setSt(want ? { ytOn: true, recOn: false } : { ytOn: false });
  };
  // 流す音を選ぶ: 'own'(自分の音源) | 'yt'(YouTube)
  const setSource = (src) => {
    if ((src === 'own') === mine) return;
    scrollApi.current?.stop();
    setSyncing(false);
    setErr(null);
    setSt({ musicSrc: src === 'yt' ? 'yt' : null, ytOn: true, recOn: false });
  };
  const pick = (v, by = 'user') => {
    scrollApi.current?.stop();
    setSyncing(false);
    setErr(null);
    setSt({ yt: { id: v.id, title: v.title || '', channel: v.channel || '', dur: v.dur || 0, by } });
  };
  // 自動で選んだ動画を「これで合っている」にする
  const okVideo = () => video && setSt({ yt: { ...video, ok: true } });
  const setWhere = (w) => {
    if (w === where) return;
    scrollApi.current?.stop();
    setSyncing(false);
    setWhereState(w);
    setPrefs({ ytWhere: w });
  };
  const pickUrl = (text) => {
    const id = parseYouTubeId(text);
    if (!id) {
      toast('YouTube のリンクを読み取れませんでした', { kind: 'error' });
      return false;
    }
    pick({ id, title: '', channel: '', dur: 0 }, 'url');
    return true;
  };
  const setSpeed = (v) => {
    if (viaChrome && v !== 1) {
      toast('Chrome で流しているときは、速さは YouTube の側（⚙ → 再生速度）で変えてください');
      return;
    }
    setSpeedState(v);
    player.api.setRate(v);
  };
  // 流す音を切りかえたら、選んでいた速さをそのまま使う
  useEffect(() => {
    if (mine && speed !== 1) mp.api.setRate(speed);
  }, [mine]);
  // MV を Chrome で: page = このページごと(譜面と連動したまま、Chrome の中で流す) / video = 動画だけを YouTube で(いまの位置から)
  const toChrome = (what) => {
    scrollApi.current?.stop();
    if (what === 'page') return openInChrome(location.href);
    if (!video) return;
    const t = Math.floor(pa.time());
    openInChrome(`https://www.youtube.com/watch?v=${video.id}${t > 1 ? `&t=${t}s` : ''}`);
  };
  const startSync = () => {
    setSyncing(true);
    const s = scrollApi.current;
    if (s && !s.isPlaying()) s.start();
  };

  // 動画(音源)と時刻の出どころが食い違うとき(別の動画・長さの違う版)は、ずれているかもしれない
  const albumDur = song.durationMs ? song.durationMs / 1000 : 0;
  const srcDur = mine ? own.own.dur || 0 : video?.dur || 0;
  const mismatch =
    !!timing?.lines &&
    ready &&
    !pts.length &&
    ((timing.base === 'yt' && (mine || timing.vid !== video.id)) || (timing.base === 'album' && albumDur > 0 && srcDur > 0 && Math.abs(srcDur - albumDur) > 2.5));
  const ownStatus = !mine
    ? null
    : own.status === 'check'
      ? { kind: 'busy', text: '音源を確かめています…' }
      : own.status === 'down'
        ? { kind: 'busy', text: `音源をこの端末に持ってきています… ${Math.round(own.prog * 100)}%（はじめの1回だけ）` }
        : own.status === 'missing'
          ? { kind: 'error', text: 'この曲の音源は、まだこの端末にありません（ほかの端末から送れていません）。ここでも使うときは、ファイルを選んでください', action: 'own' }
          : own.status === 'error'
            ? { kind: 'error', text: `音源を取ってこられませんでした（${own.err}）`, action: 'retryOwn' }
            : mp.ui.error
              ? { kind: 'error', text: 'この音源のファイルを読めませんでした。別のファイルを選んでください', action: 'own' }
              : !mp.ui.ready
                ? { kind: 'busy', text: '音源を読み込んでいます…' }
                : null;
  const status = ownStatus
    ? ownStatus
    : busy
    ? { kind: 'busy', text: '原曲の動画を探しています…' }
    : err && !mine
      ? { kind: 'error', text: err, action: 'pick' }
      : !mine && !viaChrome && yt.ui.error === 'load'
        ? { kind: 'error', text: 'YouTube を読み込めませんでした。通信を確かめてください' }
        : !ready
          ? { kind: 'busy', text: '歌詞の時刻を調べています…' }
          : syncing
            ? { kind: 'sync', text: timing?.lines ? '曲を流しながら、いま歌っている歌詞をタップ（その場所に合わせます）' : '曲を流しながら、歌い出した行をタップ（何か所か押すと、その時刻を覚えます）', action: 'syncEnd' }
            : !mine && !viaChrome && yt.ui.blocked
              ? { kind: 'warn', text: '動画が始まらないときは、動画の ▶ を押してください（iPhone・iPad は最初の1回だけ必要です）' }
              : !mine && video?.by === 'auto' && !video.ok
                ? { kind: 'tip', text: `流す動画:「${video.title || song.title}」${video.channel ? `（${video.channel}）` : ''}`, action: 'confirm' }
              : !timing
                ? { kind: 'busy', text: '歌詞の時刻を調べています…' }
                : timing.none && !anchors.length
                  ? { kind: 'warn', text: 'この曲は歌詞の時刻が見つかりませんでした。「合わせる」を押して、歌い出した行をタップすると覚えます', action: 'sync' }
                  : mismatch
                    ? { kind: 'warn', text: `${mine ? '音源' : '動画'}と譜面がずれるときは「合わせる」を押して、いま歌っている歌詞をタップしてください`, action: 'sync' }
                    : tip
                      ? { kind: 'tip', text: mine ? `歌詞やコードを押すと、そこから自分の音源が流れます${semis ? `（キー ${signed(semis)} の高さで）` : ''}` : viaChrome ? (IOS ? '歌詞やコードを押すと、Chrome の YouTube でそこから流れます（流れたら、このアプリに戻ってください）' : '歌詞やコードを押すと、Chrome の小さい窓の YouTube でそこから流れます') : '歌詞やコードを押すと、そこから曲が流れます' }
                      : null;

  return {
    on,
    video,
    mine,
    anchors, // 行の頭の時刻(ずれの直しを足したもの) [{ line, t }]
    clock,
    tap,
    toggle,
    syncing,
    dock: {
      yt,
      player,
      mine,
      viaChrome,
      onOk: okVideo,
      ownName: mine ? own.own.name : '',
      semis,
      video,
      mode: !mine && yt.ui.blocked && mode === 'hidden' ? 'small' : mode,
      setMode,
      speed,
      setSpeed,
      status,
      onSync: startSync,
      onSyncEnd: () => setSyncing(false),
      toChrome,
    },
    panel: {
      video,
      mine,
      own,
      setSource,
      cands,
      loadCands: () => (cands ? null : loadCands().catch((e) => setErr(`動画を探せませんでした（${e.message}）`))),
      pick,
      pickUrl,
      pts,
      nudge,
      hasTiming: !!timing?.lines,
      anchors: fix?.anchors?.length || 0,
      resetFix: () => saveFix({ pts: [], anchors: [] }),
      onSync: startSync,
      speed,
      setSpeed,
      mode,
      setMode,
      src: timing?.lines ? timing.src : null,
      toChrome,
      where,
      setWhere,
    },
  };
}

// ---------------------------------------------------------------- 動画の窓と、再生位置のつまみ

export function MusicDock({ yt, player, mine, viaChrome, onOk, semis, video, mode, setMode, speed, setSpeed, status, onSync, onSyncEnd, onPanel, onPickOwn, onRetryOwn, onKey, toChrome }) {
  const [time, setTime] = useState({ t: 0, d: 0 });
  useEffect(() => {
    const id = setInterval(() => setTime({ t: player.api.time(), d: player.api.duration() || video?.dur || 0 }), 250);
    return () => clearInterval(id);
  }, [video?.id, mine]);
  const cycle = () => setSpeed(RATES[(RATES.indexOf(speed) + 1) % RATES.length]);
  const can = mine ? player.ui.ready : !!video;
  const act =
    status?.action === 'sync'
      ? html`<button className="btn btn-sm btn-primary" onClick=${onSync}>合わせる</button>`
      : status?.action === 'syncEnd'
        ? html`<button className="btn btn-sm" onClick=${onSyncEnd}>おわる</button>`
        : status?.action === 'confirm'
          ? html`<span className="yt-confirm"><button className="btn btn-sm btn-primary" onClick=${onOk}>これでOK</button><button className="btn btn-sm" onClick=${onPanel}>ちがう</button></span>`
        : status?.action === 'pick'
          ? html`<button className="btn btn-sm btn-primary" onClick=${onPanel}>動画を選ぶ</button>`
          : status?.action === 'own'
            ? html`<button className="btn btn-sm btn-primary" onClick=${onPickOwn}>ファイルを選ぶ</button>`
            : status?.action === 'retryOwn'
              ? html`<button className="btn btn-sm btn-primary" onClick=${onRetryOwn}>もう一度</button>`
              : null;
  return html`<${React.Fragment}>
    ${mine || viaChrome
      ? null
      : html`<div className=${cx('yt-video', 'is-' + mode, !video && 'is-empty')}>
          <div className="yt-frame" ref=${yt.setHost}></div>
          ${video
            ? html`<div className="yt-video-bar">
                <button onClick=${() => setMode(mode === 'big' ? 'small' : 'big')}>${mode === 'big' ? '小さく' : '大きく'}</button>
                <button onClick=${() => setMode('hidden')} aria-label="動画をしまう（音だけ）">しまう</button>
                ${CAN_PAGE_CHROME ? html`<button onClick=${() => toChrome('page')} aria-label="このページを Chrome で開く（譜面と連動したまま）">Chromeで</button>` : null}
              </div>`
            : null}
        </div>`}
    <div className="rec-dock yt-dock">
      ${status ? html`<div className=${cx('yt-status', 'is-' + status.kind)} role="status"><span>${status.text}</span>${act}</div>` : null}
      <div className="rec-row">
        ${mine ? html`<span className="own-badge" title="自分の音源（広告なし）" aria-label="自分の音源で流しています"><${Icon} name="music" size=${15} /></span>` : null}
        ${viaChrome ? html`<span className="own-badge" title="Chrome の YouTube で流しています" aria-label="Chrome の YouTube で流しています"><${Icon} name="video" size=${15} /></span>` : null}
        <span className="rec-time">${mmss(time.t)}</span>
        <input type="range" className="rec-seek" min="0" max=${time.d || 0} step="0.5" value=${Math.min(time.t, time.d || 0)} disabled=${!can} onInput=${(e) => player.api.seek(Number(e.target.value))} aria-label="曲の再生位置" />
        <span className="rec-time">${mmss(time.d)}</span>
        ${mine && semis
          ? html`<button className="chip chip-sm rec-speed is-on" onClick=${onKey} aria-label=${`キー ${signed(semis)} の高さで流しています（押すとキーを変える）`}>${signed(semis)}</button>`
          : null}
        <button className=${cx('chip chip-sm rec-speed', speed !== 1 && 'is-on')} onClick=${cycle} disabled=${!can} hidden=${viaChrome} aria-label="曲の速さ">${speed === 1 ? '1×' : speed + '×'}</button>
        ${!mine && !viaChrome && video && mode === 'hidden'
          ? html`<button className="icon-btn rec-mini" onClick=${() => setMode('small')} aria-label="動画を出す"><${Icon} name="video" size=${18} /></button>`
          : null}
      </div>
    </div>
  </${React.Fragment}>`;
}

// ---------------------------------------------------------------- 設定のパネル

// 自分の音源の置き場所
function ownWhere(own) {
  const o = own.own;
  if (o.path) return 'この端末とクラウド（ほかの端末でも流せます）';
  if (own.up?.prog != null) return `ほかの端末でも使えるよう、クラウドに送っています… ${Math.round(own.up.prog * 100)}%`;
  if (own.up?.err) return 'この端末だけ（クラウドに送れませんでした）';
  if (o.size > CLOUD_MAX) return 'この端末だけ（40MBより大きいので、クラウドには置けません）';
  if (own.status === 'missing') return 'ほかの端末にだけあります';
  return 'この端末だけ';
}

export function MusicPanel({ open, onClose, video, mine, own, setSource, onPickOwn, cands, loadCands, pick, pickUrl, pts, nudge, hasTiming, anchors, resetFix, onSync, speed, setSpeed, mode, setMode, src, onOff, onApple, toChrome, where, setWhere }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (open && !mine) loadCands();
  }, [open, mine]);
  const list = (cands || []).slice(0, 8);
  const off = pts.length === 1 ? pts[0].off : 0;
  const fixed = pts.length > 0 || anchors > 0;
  const offTxt = pts.length > 1 ? `${pts.length}か所で合わせています` : Math.abs(off) < 0.05 ? '' : `${off > 0 ? '譜面を遅く' : '譜面を早く'} ${Math.abs(off).toFixed(1)}秒`;
  const o = own?.own || null;
  const removeOwn = () => {
    if (!confirm('この曲の音源を外しますか？（この端末とクラウドから消えます。元のファイルはそのままです）')) return;
    own.remove();
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="曲と合わせる">
    <p className="panel-lead">原曲を流しながら弾きます。<b>歌詞やコードを押すと、そこから曲が流れ</b>、譜面もいっしょに進みます。コードの押さえ方は、コードを<b>長押し</b>で見られます。</p>

    <div className="panel-field">
      <div className="panel-field-label">流す音</div>
      ${o
        ? html`<${Segmented}
            label="流す音"
            value=${mine ? 'own' : 'yt'}
            onChange=${setSource}
            options=${[
              { value: 'own', label: '自分の音源（広告なし）' },
              { value: 'yt', label: 'YouTube' },
            ]}
          />`
        : null}
      ${o && mine
        ? html`<div className="own-now">
              <span className="own-icon"><${Icon} name="music" size=${20} /></span>
              <span className="own-text">
                <b>${o.name.replace(/\.[^.]+$/, '')}</b>
                <small>${[o.dur ? mmss(o.dur) : '', o.size ? mb(o.size) : ''].filter(Boolean).join(' ・ ')}</small>
                <small>${ownWhere(own)}</small>
              </span>
            </div>
            <div className="row-gap">
              <button className="btn btn-sm" onClick=${onPickOwn}>別のファイルにする</button>
              ${own.up?.err && o.size <= CLOUD_MAX ? html`<button className="btn btn-sm" onClick=${own.retryUpload}>クラウドにもう一度送る</button>` : null}
              <button className="btn btn-sm btn-ghost" onClick=${removeOwn}>外す</button>
            </div>
            <p className="panel-note">キーを変えると、その高さで流れます（上の「キー」）。ゆっくりにしても音程は変わりません。広告は入りません。</p>`
        : !o
          ? html`<div className="own-cta">
              <b>広告なしで、1曲まるごと好きなキーで</b>
              <p>自分で持っている原曲のファイル（買った曲・CD から取り込んだ曲など）を入れると、広告なしで流せます。キーを変えればその高さで、ゆっくりにしても音程はそのままです。iPhone・iPad・パソコンのどれで入れても、ほかの端末でもそのまま流せます。</p>
              <button className="btn btn-primary" onClick=${onPickOwn}><${Icon} name="upload" size=${18} />音源ファイルを選ぶ</button>
              <small>Apple Music で聴いている曲は保護されていて使えません。iTunes Store で買った曲は、パソコンの Apple Music アプリ（または iTunes）でダウンロードすると、ファイルとして選べます。</small>
            </div>`
          : null}
    </div>

    <div className="panel-field">
      <div className="panel-field-label">曲と譜面がずれるとき<b className=${cx('speed-now', fixed && 'is-on')}>${hasTiming ? offTxt : anchors ? `${anchors}か所で合わせています` : ''}</b></div>
      <div className="row-gap">
        <button className="btn btn-primary" disabled=${mine ? !own?.rec : !video} onClick=${() => { onClose(); onSync(); }}>歌に合わせる</button>
        ${hasTiming
          ? html`<${React.Fragment}>
              <button className="btn" onClick=${() => nudge(-0.1)} aria-label="譜面を0.1秒早く">早く</button>
              <button className="btn" onClick=${() => nudge(0.1)} aria-label="譜面を0.1秒遅く">遅く</button>
            </${React.Fragment}>`
          : null}
        ${fixed ? html`<button className="btn btn-ghost" onClick=${resetFix}>元に戻す</button>` : null}
      </div>
      <p className="panel-note">
        「歌に合わせる」を押すと曲が流れるので、<b>いま歌っている歌詞をタップ</b>してください。${hasTiming ? '1回で全体が合います。曲の後ろのほうでまたずれてきたら、そこでもう一度（あいだは自動でつなぎます）。少しだけ直すときは「早く」「遅く」（0.1秒ずつ）。' : '歌い出しやサビの頭など何か所か押すと、あいだは自動でつなぎます。'}
        ${src === 'mc' ? 'この曲は、コードの鳴る時刻までデータがあるので、押したコードの瞬間から流れます。' : src === 'krc' ? 'この曲は、歌詞の1文字ずつの時刻があるので、押した文字から流れます。' : src === 'lrc' ? 'この曲は、歌詞の行ごとの時刻で合わせています（行の途中は見積もり）。' : ''}
      </p>
    </div>

    ${mine
      ? null
      : html`<div className="panel-field">
          <div className="panel-field-label">YouTube を流す場所</div>
          <${Segmented} label="YouTube を流す場所" value=${where} onChange=${setWhere} options=${[{ value: 'chrome', label: 'Chrome で' }, { value: 'app', label: 'アプリの中で' }]} />
          <p className="panel-note">${where === 'chrome'
            ? IOS
              ? 'Chrome アプリの YouTube で流します。歌詞を押すたびに、その時刻から Chrome で開き直します（流れ始めたら、このアプリに戻ってください）。止めるのは Chrome の側で。Chrome が後ろに回ると YouTube が止まる場合は、iPad の画面分割で横に並べると流れつづけます。'
              : 'Chrome の小さい窓の YouTube で流します。歌詞を押すたびに、その時刻から開き直します。■ で止めると窓も閉じます。開いてから音が出るまでの待ちは見込んでいますが、ずれたら下の「早く」「遅く」で。'
            : 'アプリの中の小さい動画で流します。'}</p>
        </div>`}
    ${mine || where !== 'chrome'
      ? html`<div className="panel-field">
          <div className="panel-field-label">曲の速さ（音程はそのまま）</div>
          <${Segmented} label="曲の速さ" value=${speed} onChange=${setSpeed} options=${RATES.map((v) => ({ value: v, label: v === 1 ? 'そのまま' : `${v}×` }))} />
        </div>`
      : null}
    ${mine
      ? null
      : html`<${React.Fragment}>
          <div className="panel-field" hidden=${where === 'chrome'}>
            <div className="panel-field-label">動画の窓</div>
            <${Segmented} label="動画の窓" value=${mode} onChange=${setMode} options=${[{ value: 'small', label: '小さく' }, { value: 'big', label: '大きく' }, { value: 'hidden', label: 'しまう（音だけ）' }]} />
          </div>
          ${video
            ? html`<div className="yt-now">
                <img src=${thumb(video.id)} alt="" width="96" height="54" />
                <span><b>${video.title || '（題名は流すと出ます）'}</b><small>${[video.channel, video.dur ? mmss(video.dur) : ''].filter(Boolean).join(' ・ ')}</small></span>
              </div>`
            : null}
          <div className="menu-group">
            <div className="menu-title">別の動画にする</div>
            ${!cands ? html`<p className="panel-note">動画を探しています…</p>` : null}
            ${list.map(
              (v) => html`<button key=${v.id} className=${cx('menu-item yt-cand', video?.id === v.id && 'is-on')} onClick=${() => video?.id !== v.id && pick(v)}>
                <img src=${thumb(v.id)} alt="" width="64" height="36" loading="lazy" />
                <span className="menu-item-text">${v.title}<small>${[v.channel, v.dur ? mmss(v.dur) : '', v.timed ? 'コードの時刻つき' : ''].filter(Boolean).join(' ・ ')}</small></span>
                ${video?.id === v.id ? html`<${Icon} name="check" />` : null}
              </button>`,
            )}
            <form className="yt-url" onSubmit=${(e) => { e.preventDefault(); if (pickUrl(url)) setUrl(''); }}>
              <input type="url" inputMode="url" placeholder="YouTube のリンクを貼る" value=${url} onInput=${(e) => setUrl(e.target.value)} aria-label="YouTube のリンク" />
              <button className="btn" type="submit" disabled=${!url.trim()}>この動画にする</button>
            </form>
          </div>
        </${React.Fragment}>`}

    ${mine || !video
      ? null
      : html`<div className="menu-group">
          <div className="menu-title">MV を Chrome で流す</div>
          ${CAN_PAGE_CHROME
            ? html`<button className="menu-item" onClick=${() => { onClose(); toChrome('page'); }}><${Icon} name="video" /><span className="menu-item-text">このページを Chrome で開く<small>譜面と連動したまま、Chrome の中で MV を流します（Chrome で初めて開くときだけ、6桁の数字でつなぎます）</small></span></button>`
            : null}
          <button className="menu-item" onClick=${() => { onClose(); toChrome('video'); }}><${Icon} name="video" /><span className="menu-item-text">MV だけを${IOS ? ' Chrome' : '新しいタブ'}で開く<small>いま流れている位置から（譜面とは連動しません）</small></span></button>
        </div>`}
    <div className="menu-group">
      <button className="menu-item" onClick=${() => { onClose(); onApple(); }}><${Icon} name="headphones" /><span className="menu-item-text">Apple Music で原曲を開く<small>Music アプリで聴くとき（譜面とは連動しません）</small></span></button>
      <button className="menu-item" onClick=${() => { onClose(); onOff(); }}><${Icon} name="metronome" /><span className="menu-item-text">曲と合わせるのをやめる（BPMで流す）</span></button>
    </div>
    ${mine
      ? null
      : html`<p className="panel-note">YouTube の広告は、YouTube が動画に入れるものです。消したり飛ばしたりすることは YouTube の決まりで禁じられているので、アプリからはできません（出にくくなる読み込み方にはしています）。広告なしで流したいときは、上の「音源ファイルを選ぶ」で自分の音源を使ってください。</p>`}
  </${Sheet}>`;
}
