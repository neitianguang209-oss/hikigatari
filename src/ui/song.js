// 曲の画面: 譜面表示・楽器切り替え・カポ/キー/テンポ・自動スクロール・コード図
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, StarIcon, PlayIcon, GuitarIcon, PianoIcon } from './icons.js';
import { Sheet, Segmented, Stepper, Switch, Spinner, Artwork, ChordText, toast } from './common.js';
import { GuitarDiagram, GuitarChordCard, PianoKeyboard, StaffDiagram, PianoChordCard, chosenVoicing } from './diagrams.js';
import { useAutoScroll, glideTo, glideHeading } from './autoscroll.js';
import { TunerSheet, prepareTuner } from './tuner.js';
import { audioCtx, holdPlayback, releasePlayback, click as clickSound } from '../lib/sound.js';
import { parseSheet, chordStats } from '../music/sheet.js';
import { parseChord, chordName, pretty, parseKey, detectKey, keyName, shiftKey, keyPrefersFlat, solfege, noteName } from '../music/chord.js';
import { rankCapos, shapeName, guitarVoicings, standardVoicing, planVoicings } from '../music/guitar.js';
import { pianoVoicing, spelledNamer } from '../music/piano.js';
import { detectModulation } from '../music/modulation.js';
import { lib, useSong, media } from '../lib/store.js';
import { api } from '../lib/api.js';
import { usePrefs, getPrefs, setPrefs } from '../lib/prefs.js';
import { go, back } from '../lib/router.js';
import { cx, sourceName, norm, baseTitle, sameArtist, signed, appleUrlOf } from '../lib/util.js';
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------- 入口: 譜面の読み込み

export function SongPage({ id }) {
  const song = useSong(id);
  const [state, setState] = useState({ loading: false, error: null });
  const tried = useRef(new Set());

  const load = useCallback(
    async (force = false) => {
      const cur = lib.get(id);
      if (!cur || cur.source === 'manual' || cur.source === 'ear') return;
      const tag = `${cur.source}:${cur.sourceId}`;
      setState({ loading: true, error: null });
      try {
        const r = await api('sheet', { source: cur.source, id: cur.sourceId, title: cur.title, artist: cur.artist, force });
        const parsed = parseSheet(r.text);
        if (!parsed.lines.some((l) => l.segs && l.segs.some((s) => s.c))) throw Object.assign(new Error('譜面にコードが見つかりませんでした'), { status: 404 });
        await lib.patch(id, {
          sheet: { text: r.text, key: r.key || parsed.meta.key || null, bpm: r.bpm || parsed.meta.bpm || null, beatsPerBar: parsed.meta.beatsPerBar || 4, fetchedAt: r.fetchedAt || new Date().toISOString() },
          sourceUrl: r.url || cur.sourceUrl,
          edited: false,
        });
        setState({ loading: false, error: null });
        if (force) toast('譜面を取り直しました');
      } catch (e) {
        tried.current.add(tag);
        // このサイトで開けなければ、ほかのサイトの版を自動で試す
        const next = (cur.sources || []).find((s) => !tried.current.has(`${s.source}:${s.id}`));
        if (!force && next && (e.status === 404 || e.status === 502)) {
          await lib.patch(id, { source: next.source, sourceId: next.id, sourceUrl: next.url, sourceLabel: next.label || '', sheet: null });
          toast(`${sourceName(cur.source)}で開けなかったので${sourceName(next.source)}に切り替えました`);
          return;
        }
        setState({ loading: false, error: e.message });
      }
    },
    [id],
  );

  useEffect(() => {
    if (song && !song.sheet && song.source !== 'manual' && song.source !== 'ear' && !state.loading && !state.error) load();
  }, [song?.source, song?.sourceId, !!song?.sheet]);

  // 開いた記録(最近ひらいた曲)
  useEffect(() => {
    if (lib.get(id)) lib.patch(id, (c) => ({ openedAt: Date.now(), openCount: (c.openCount || 0) + 1 }));
  }, [id]);

  if (!song || song.deleted)
    return html`<div className="page page-center">
      <p>この曲は見つかりませんでした。</p>
      <button className="btn" onClick=${() => go('/', { replace: true })}>ホームへ</button>
    </div>`;

  if (!song.sheet)
    return html`<div className="song">
      <${TopBar} song=${song} onApple=${() => openAppleMusic(song)} />
      <div className="page-center">
        ${state.error
          ? html`<div className="load-error">
              <p className="load-error-title">譜面を取り込めませんでした</p>
              <p className="muted">${state.error}</p>
              <div className="row-gap">
                <button className="btn btn-primary" onClick=${() => { tried.current.clear(); load(); }}>もう一度</button>
                <button className="btn" onClick=${() => go(`/ear?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}${song.appleId ? `&appleId=${song.appleId}` : ''}`)}>耳コピで作る</button>
                <button className="btn" onClick=${() => go('/edit/' + id)}>自分で入力する</button>
              </div>
              ${song.sourceUrl ? html`<a className="link" href=${song.sourceUrl} target="_blank" rel="noopener">元のページを開く</a>` : null}
            </div>`
          : html`<${Spinner} label=${`${sourceName(song.source)}から譜面を取り込んでいます…`} />`}
      </div>
    </div>`;

  return html`<${SongReady} key=${song.id} song=${song} reload=${load} />`;
}

// ---------------------------------------------------------------- 上のバー

function TopBar({ song, onMore, onApple }) {
  const toggleFav = () => {
    const on = !song.fav;
    lib.patch(song.id, { fav: on, favAt: on ? Date.now() : song.favAt });
    toast(on ? 'お気に入りに入れました' : 'お気に入りから外しました');
  };
  return html`<header className="song-top">
    <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
    <div className="song-title">
      <div className="t">${song.title || '無題'}</div>
      <div className="a">${song.artist || ''}</div>
    </div>
    ${onApple
      ? html`<button className="icon-btn apple-btn" onClick=${onApple} aria-label="Apple Music で原曲を聴く" title="Apple Music で原曲を聴く">
          <${Icon} name="music" size=${17} /><span>原曲</span>
        </button>`
      : null}
    <button className=${cx('icon-btn fav-btn', song.fav && 'is-on')} onClick=${toggleFav} aria-label=${song.fav ? 'お気に入りから外す' : 'お気に入りに入れる'} aria-pressed=${!!song.fav}>
      <${StarIcon} on=${song.fav} />
    </button>
    ${onMore ? html`<button className="icon-btn" onClick=${onMore} aria-label="その他"><${Icon} name="more" /></button>` : null}
  </header>`;
}

// ---------------------------------------------------------------- 本体

function SongReady({ song, reload }) {
  const [prefs] = usePrefs();
  const scrollRef = useRef(null);
  const [panel, setPanel] = useState(null); // capo | key | tempo | text | more | chord
  const [chordTap, setChordTap] = useState(null);

  const st = song.settings || {};
  const instrument = st.instrument || prefs.instrument;
  const transpose = st.transpose || 0;
  // ギターのかんたんモード(オフ = 教本どおりの押さえ方)
  const easy = instrument === 'guitar' && !!(st.easy ?? prefs.easy);
  // 歌詞の上の図: ギターは押さえ方、ピアノは五線譜。楽器ごとに出す/出さないを覚える
  const inlineKey = instrument === 'guitar' ? 'inline' : 'inlineStaff';
  const inline = instrument === 'guitar' ? st.inline ?? prefs.inlineDiagrams : st.inlineStaff ?? prefs.inlineStaff;
  const fontScale = st.fontScale ?? prefs.fontScale;
  const setSt = (patch) => lib.patchSettings(song.id, patch);

  const parsed = useMemo(() => parseSheet(song.sheet.text), [song.sheet.text]);
  const stats = useMemo(() => chordStats(parsed.lines), [parsed]);
  const origKey = useMemo(() => {
    const k = parseKey(song.sheet.key || parsed.meta.key);
    if (k) return k;
    const seq = [];
    for (const l of parsed.lines) if (l.segs) for (const s of l.segs) if (s.c) seq.push(s.c);
    return detectKey(seq);
  }, [parsed, song.sheet.key]);
  const soundKey = shiftKey(origKey, transpose);
  const soundFlat = keyPrefersFlat(soundKey);

  // 実際に鳴るコード名(声に合わせた移調後)
  const sounding = useMemo(() => {
    const m = new Map();
    for (const c of stats.order) {
      const ch = parseChord(c);
      m.set(c, ch ? chordName(ch, transpose, soundFlat) : c);
    }
    return m;
  }, [stats, transpose, soundFlat]);

  // 転調(曲の途中でキーが変わるところ)。行ごとに、出だしから何半音ずれているか
  const modulation = useMemo(() => detectModulation(parsed.lines, origKey, parsed.meta.keyChanges), [parsed, origKey]);
  const shifts = modulation.shifts;
  const shiftSet = useMemo(() => [...new Set(shifts)], [modulation]);
  const hasMod = modulation.marks.length > 0;
  // ギター: 転調したらカポを付けかえて、押さえ方(コードの形)はそのまま弾く
  const follow = instrument === 'guitar' && hasMod && (st.capoFollow ?? true);
  const capoLimit = Math.max(prefs.maxCapo, 7) + 2;

  // ずれごとの、実際に鳴るコード名と回数
  const countsBy = useMemo(() => {
    const by = new Map(shiftSet.map((k) => [k, new Map()]));
    parsed.lines.forEach((l, i) => {
      if (!l.segs) return;
      const m = by.get(shifts[i]);
      for (const s of l.segs) {
        if (!s.c) continue;
        const ch = parseChord(s.c);
        if (!ch || ch.special || ch.bassOnly) continue;
        const n = sounding.get(s.c);
        m.set(n, (m.get(n) || 0) + 1);
      }
    });
    return by;
  }, [parsed, modulation, sounding]);

  const capoRank = useMemo(() => {
    if (instrument !== 'guitar') return null;
    // 転調でカポを付けかえるときは、出だしの調の部分だけでカポ位置を選ぶ
    let counts = follow && countsBy.get(0)?.size ? countsBy.get(0) : null;
    if (!counts) {
      counts = new Map();
      for (const [c, n] of stats.count) {
        const k = sounding.get(c);
        counts.set(k, (counts.get(k) || 0) + n);
      }
    }
    return rankCapos(counts, soundKey, { easy, maxCapo: prefs.maxCapo });
  }, [instrument, stats, sounding, countsBy, follow, easy, prefs.maxCapo, soundKey.pc, soundKey.minor]);

  const capo = instrument === 'guitar' ? (typeof st.capo === 'number' ? Math.min(st.capo, prefs.maxCapo) : capoRank.best) : 0;
  const shapeKey = shiftKey(soundKey, -capo);

  // ずれごとのカポ。付けかえれば同じ形で弾ける位置(上げる/下げる)があればそこ、
  // 届かないときは、その部分だけで一番弾きやすい位置
  const segCapo = useMemo(() => {
    const m = new Map();
    for (const k of shiftSet) {
      if (instrument !== 'guitar') m.set(k, 0);
      else if (k === 0 || !follow) m.set(k, capo);
      else {
        const s = k > 6 ? k - 12 : k;
        const same = [capo + s, capo + s - 12, capo + s + 12].find((c) => c >= 0 && c <= capoLimit);
        m.set(k, same ?? rankCapos(countsBy.get(k), shiftKey(soundKey, k), { easy, maxCapo: prefs.maxCapo }).best);
      }
    }
    return m;
  }, [shiftSet, instrument, follow, capo, capoLimit, countsBy, easy, prefs.maxCapo, soundKey.pc, soundKey.minor]);

  // 画面に出すコード名(ずれごと)。ギターはカポをつけて押さえる形、ピアノは実際に鳴る音
  const nameMaps = (withEasy) => {
    const out = new Map();
    for (const k of shiftSet) {
      const c = segCapo.get(k);
      const sk = shiftKey(soundKey, k - c);
      const m = new Map();
      for (const t of stats.order) {
        const snd = sounding.get(t);
        m.set(t, instrument === 'guitar' ? shapeName(snd, c, sk, withEasy) : snd);
      }
      out.set(k, m);
    }
    return out;
  };
  const displays = useMemo(() => nameMaps(easy), [shiftSet, segCapo, stats, sounding, instrument, easy, soundKey.pc, soundKey.minor]);
  const display = displays.get(0) || displays.values().next().value;
  // かんたんモードで置き換える前の形の名前(置き換えたコードの説明に使う)
  const plainDisplays = useMemo(() => (instrument === 'guitar' ? nameMaps(false) : new Map()), [shiftSet, segCapo, stats, sounding, instrument, soundKey.pc, soundKey.minor]);

  // コードごとに見せる押さえ方。通常は教本どおり、かんたんモードは曲の流れ(前後のコード)まで見て選ぶ。
  // 「いつもこの形」で自分で選んだ形があれば、それがいちばん優先
  const autoFrets = useMemo(() => {
    if (instrument !== 'guitar') return new Map();
    const seq = [];
    parsed.lines.forEach((l, i) => {
      if (!l.segs) return;
      const d = displays.get(shifts[i]);
      for (const s of l.segs) {
        const n = s.c && d.get(s.c);
        if (n && /^[A-G]/.test(n)) seq.push(n);
      }
    });
    return planVoicings(seq, easy);
  }, [parsed, displays, modulation, instrument, easy]);

  // かんたんモードで変わったところ(置き換えたコード・省略形にしたコード)
  const eased = useMemo(() => {
    if (!easy) return [];
    const out = [];
    const seen = new Set();
    for (const k of shiftSet) {
      for (const c of stats.order) {
        if (!countsBy.get(k)?.has(sounding.get(c))) continue;
        const from = plainDisplays.get(k)?.get(c);
        const to = displays.get(k).get(c);
        if (!from || !/^[A-G]/.test(to) || seen.has(from)) continue;
        seen.add(from);
        const std = standardVoicing(from);
        if (from !== to) out.push({ from, to, kind: 'name' });
        else if (std && autoFrets.get(to) && autoFrets.get(to) !== std.frets.join(',')) out.push({ from, to, kind: std.barre ? 'short' : 'form' });
      }
    }
    return out;
  }, [easy, shiftSet, stats, countsBy, sounding, plainDisplays, displays, autoFrets]);

  // 転調の印(行番号 → 中身)
  const modMarks = useMemo(() => {
    const m = new Map();
    for (const mk of modulation.marks) {
      const fromCapo = segCapo.get(mk.from);
      const toCapo = segCapo.get(mk.to);
      m.set(mk.at, {
        shift: mk.shift,
        fromKey: keyName(shiftKey(soundKey, mk.from)),
        toKey: keyName(shiftKey(soundKey, mk.to)),
        fromCapo,
        toCapo,
        sameShapes: (((toCapo - fromCapo - mk.shift) % 12) + 12) % 12 === 0,
        follow,
      });
    }
    return m;
  }, [modulation, segCapo, follow, soundKey.pc, soundKey.minor]);

  // ベース音だけの指定(/G# など)は一覧に出さない。転調したところのコードも含めて、出てくる順に
  const uniqueDisplay = useMemo(() => {
    const seen = new Set();
    parsed.lines.forEach((l, i) => {
      if (!l.segs) return;
      const d = displays.get(shifts[i]);
      for (const s of l.segs) if (s.c) seen.add(d.get(s.c));
    });
    return [...seen].filter((n) => n && /^[A-G]/.test(n));
  }, [parsed, displays, modulation]);

  const sheetBpm = song.sheet.bpm || parsed.meta.bpm || null; // 譜面に書かれたテンポ({tempo} など)
  const bpm = st.bpm || sheetBpm || 90;
  const bpmKnown = !!(st.bpm || sheetBpm);
  const hasBars = parsed.lines.some((l) => l.bars);
  const barsPerLine = st.barsPerLine ?? prefs.barsPerLine; // 0 = 自動で見積もる
  const fitSong = st.fitSong ?? true;
  const speed = st.speed ?? 1; // 自分で決めるスクロールの速さの微調整(曲ごと)
  const beatsPerBar = song.sheet.beatsPerBar || parsed.meta.beatsPerBar || 4;

  // ---- 自分の歌(動画・録音)に合わせる
  // rec: この端末に置いた録音 / recOn: 録音に合わせて流すか(曲ごとに覚える) / 行の時刻の目印は録音ごとに settings.recSync に
  const [rec, setRec] = useState(null); // { url, name, type, isVideo, fp, size, saved }
  const videoRef = useRef(null);
  const recFileRef = useRef(null);
  const recOn = !!rec && (st.recOn ?? true);
  const recAnchors = (rec && st.recSync?.[rec.fp]) || [];
  const [recSpeed, setRecSpeed] = useState(1);
  const [recVideo, setRecVideo] = useState('small'); // small | big | hidden
  const [recTime, setRecTime] = useState({ t: 0, d: 0 });
  useEffect(() => {
    let url = null;
    let alive = true;
    media.get(song.id).then((r) => {
      if (!alive || !r?.blob) return;
      url = URL.createObjectURL(r.blob);
      setRec({ url, name: r.name, type: r.type, isVideo: r.isVideo, fp: r.fp, size: r.size, saved: true });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [song.id]);
  const clock = recOn
    ? {
        time: () => videoRef.current?.currentTime || 0,
        seekTime: (t) => {
          if (videoRef.current) videoRef.current.currentTime = t;
        },
        play: () => videoRef.current?.play().catch(() => {}),
        pause: () => videoRef.current?.pause(),
        ended: () => !!videoRef.current?.ended,
        duration: () => videoRef.current?.duration || 0,
        anchors: recAnchors,
        bps: bpm / 60,
      }
    : null;

  const scroll = useAutoScroll({ scrollRef, lines: parsed.lines, bpm, barsPerLine, beatsPerBar, countIn: prefs.countIn, click: st.click ?? prefs.click, durationMs: song.durationMs, fitSong, clock, clickVolume: prefs.clickVolume ?? 1, speed });
  // 原曲を流しに Apple Music へ。流れている譜面は止めておく(戻ってきたら ▶ で続きから)
  const onApple = () => {
    if (scroll.playing) scroll.stop();
    openAppleMusic(song);
  };

  // 録音を選んだら、この端末に保存して(大きすぎるときは今回だけ)、録音に合わせるモードにする
  const attachRec = async (file) => {
    if (!file) return;
    scroll.stop();
    const fp = `${file.name}|${file.size}`;
    const isVideo = /^video\//.test(file.type) || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    let saved = false;
    if (file.size < 1.5e9) {
      try {
        await media.put(song.id, { blob: file, name: file.name, type: file.type, size: file.size, fp, isVideo, savedAt: Date.now() });
        saved = true;
      } catch {}
    }
    if (rec?.url) URL.revokeObjectURL(rec.url);
    setRec({ url: URL.createObjectURL(file), name: file.name, type: file.type, isVideo, fp, size: file.size, saved });
    setRecVideo('small');
    setSt({ recOn: true });
    toast(saved ? '録音をこの端末に保存しました。▶ で再生して、歌い出した行をタップしてください' : '録音が大きいので、今回だけ使います（次に開いたら選び直してください）', { ms: 4500 });
  };
  const removeRec = async () => {
    if (!confirm('この曲の録音を、この端末から消しますか？（行の時刻の目印も消えます）')) return;
    scroll.stop();
    await media.del(song.id);
    if (rec?.url) URL.revokeObjectURL(rec.url);
    const sync = { ...(st.recSync || {}) };
    if (rec) delete sync[rec.fp];
    setSt({ recSync: sync, recOn: false });
    setRec(null);
    setPanel(null);
  };
  const setRecOn = (on) => {
    scroll.stop();
    setSt({ recOn: on });
  };
  // 行の時刻の目印を足す(同じ行の目印は置きかえ、前後と順番が食い違う目印は外す)
  const addAnchor = (line) => {
    const t = +(videoRef.current?.currentTime || 0).toFixed(2);
    const next = recAnchors.filter((a) => a.line !== line && ((a.line < line && a.t < t) || (a.line > line && a.t > t)));
    next.push({ line, t });
    next.sort((a, b) => a.t - b.t);
    const all = { ...(st.recSync || {}) };
    all[rec.fp] = next;
    // 録音は曲ごとに3つぶんまで覚える
    const keys = Object.keys(all);
    if (keys.length > 3) for (const k of keys.slice(0, keys.length - 3)) if (k !== rec.fp) delete all[k];
    setSt({ recSync: all });
    toast(`この行を ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} に合わせました`, { ms: 1400 });
  };
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = recSpeed;
    v.preservesPitch = true;
    v.webkitPreservesPitch = true;
  }, [recSpeed, rec?.url, recOn]);
  // 録音が外から止まったとき(電話・ほかのアプリの音など)は、譜面も止める
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => scroll.playing && !v.ended && scroll.stop();
    const onTime = () => setRecTime({ t: v.currentTime, d: v.duration || 0 });
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onTime);
    v.addEventListener('seeked', onTime);
    return () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onTime);
      v.removeEventListener('seeked', onTime);
    };
  }, [rec?.url, recOn, scroll.playing]);

  // 曲の長さ(自動スクロールを曲に合わせるのに使う)と Apple Music の曲のページが分からない曲は、Apple の曲データから一度だけ探す
  useEffect(() => {
    const needLen = !song.durationMs && !song.durationTried;
    const needUrl = !song.appleUrl && !song.appleTried;
    if ((!needLen && !needUrl) || !song.title) return;
    let alive = true;
    (async () => {
      try {
        let hit = null;
        if (song.appleId) {
          const j = await (await fetch(`https://itunes.apple.com/lookup?id=${song.appleId}&country=jp&lang=ja_jp`)).json();
          hit = j.results?.[0] || null;
        }
        if (!hit) {
          const q = `${baseTitle(song.title)} ${song.artist || ''}`.trim();
          const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&entity=song&limit=10&lang=ja_jp`);
          const j = await r.json();
          hit = (j.results || []).find(
            (x) => norm(baseTitle(x.trackName)) === norm(baseTitle(song.title)) && (!song.artist || sameArtist(x.artistName, song.artist)),
          );
        }
        if (!alive) return;
        await lib.patch(
          song.id,
          hit
            ? {
                durationMs: song.durationMs || hit.trackTimeMillis,
                appleId: song.appleId || hit.trackId,
                appleUrl: song.appleUrl || appleUrlOf(hit) || null,
                artwork: song.artwork || hit.artworkUrl100,
                durationTried: true,
                appleTried: true,
              }
            : { durationTried: true, appleTried: true },
        );
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [song.id]);

  // 画面を消さない(演奏中に暗くならないように)
  useEffect(() => {
    let lock = null;
    const req = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
      } catch {}
    };
    req();
    const onVis = () => document.visibilityState === 'visible' && req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release?.().catch?.(() => {});
    };
  }, []);

  // 止まっているときの画面送り: 画面の6割ぶんを、なめらかに少しずつ(続けて押したら、前の行き先からさらに先へ)
  const pageTurn = (dir) => {
    const el = scrollRef.current;
    if (el) glideTo(el, glideHeading(el) + dir * el.clientHeight * 0.6);
  };

  // キーボード・フットペダル(PageDown/PageUp/矢印)
  useEffect(() => {
    const onKey = (e) => {
      if (panel || e.target.closest?.('input, textarea, select')) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        scroll.toggle();
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
        e.preventDefault();
        if (scroll.playing) scroll.step(1);
        else pageTurn(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        if (scroll.playing) scroll.step(-1);
        else pageTurn(-1);
      } else if (e.key === 'ArrowRight' || e.key === '+' || e.key === 'ArrowLeft' || e.key === '-') {
        // 速さの微調整(2%ずつ)。BPM を変えても「曲の長さに合わせる」では速さが変わらないため、こちらを動かす
        const up = e.key === 'ArrowRight' || e.key === '+';
        const p = Math.max(70, Math.min(130, Math.round(speed * 100) + (up ? 2 : -2)));
        setSt({ speed: p === 100 ? null : p / 100 });
        toast(`スクロールの速さ ${p}%`, { ms: 1000 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, scroll.playing, speed]);

  useEffect(() => {
    scroll.measure();
  }, [instrument, inline, fontScale, capo, easy, transpose]);

  // 区間リピートの区間選び: null → { step: 'from' } → { step: 'to', from }
  const [loopSel, setLoopSel] = useState(null);
  const onChord = useCallback((token, line) => setChordTap({ token, line }), []);
  // タップしたコードの名前(転調したところはそのカポでの形)・実際に鳴る音・置き換える前の名前
  const tapInfo = useMemo(() => {
    if (!chordTap) return null;
    if (chordTap.display) {
      const name = chordTap.display;
      let plain = null;
      if (easy)
        for (const [k, d] of displays) {
          for (const [t, n] of d) if (n === name) { plain = plainDisplays.get(k)?.get(t) || null; break; }
          if (plain) break;
        }
      return { name, snd: null, plain };
    }
    const k = shifts[chordTap.line] ?? 0;
    return { name: displays.get(k)?.get(chordTap.token) || chordTap.token, snd: sounding.get(chordTap.token), plain: easy ? plainDisplays.get(k)?.get(chordTap.token) || null : null };
  }, [chordTap, displays, plainDisplays, sounding, easy, modulation]);
  // onText: 歌詞・コードの上を押した(行の右の空いたところは「画面を送る」のほうで扱う)
  const onLineTap = useCallback(
    (i, onText = true) => {
      const line = parsed.lines[i];
      const timed = line && (line.type === 'lyric' || line.type === 'chords');
      if (loopSel) {
        if (!timed) return;
        if (loopSel.step === 'from') setLoopSel({ step: 'to', from: i });
        else {
          scroll.setLoop(loopSel.from, i);
          setLoopSel(null);
          toast('この区間をくり返します');
        }
        return;
      }
      if (recOn && scroll.playing) {
        if (timed) addAnchor(i);
        return;
      }
      // 歌詞を押すとその行へ(止まっているときは、そこから流し始められる位置へ)
      if (onText && timed) scroll.jumpToLine(i);
    },
    [loopSel, scroll.playing, parsed, recOn, rec, st.recSync],
  );
  // 何も無いところを押すと、画面を下へ送る(止まっているときは6割ぶん、流しているときは次の行へ)。設定で切れる
  const onSheetTap = (e) => {
    if (prefs.tapToTurn === false || loopSel || (recOn && scroll.playing)) return;
    if (e.target.closest('button, a, input, select, textarea, .seg, .ln-label, .song-head, .strip-top, .mod-mark, .ear-banner, .sheet-end')) return;
    if (scroll.playing) scroll.step(1);
    else pageTurn(1);
  };
  // 見出し(サビ・Aメロ など)をタップ: 区間選び中ならその段落まるごとをくり返す / 演奏中ならそこへ飛ぶ
  const hasLabels = useMemo(() => parsed.lines.some((l) => l.type === 'label'), [parsed]);
  const onLabelTap = useCallback(
    (i) => {
      const r = sectionOf(parsed.lines, i);
      if (!r) return;
      if (loopSel) {
        scroll.setLoop(r.from, r.to);
        setLoopSel(null);
        toast(`「${parsed.lines[i].text}」をくり返します`);
      } else if (scroll.playing) scroll.jumpToLine(r.from);
      else {
        const sc = scrollRef.current;
        const el = sc?.querySelector(`[data-i="${i}"]`);
        if (el) glideTo(sc, sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8);
      }
    },
    [loopSel, scroll.playing, parsed],
  );
  const toggleLoop = () => {
    if (scroll.loop || loopSel) {
      scroll.setLoop(null);
      setLoopSel(null);
    } else setLoopSel({ step: 'from' });
  };
  const loopRange = loopSel?.step === 'to' ? { from: loopSel.from, to: loopSel.from } : scroll.loop;

  // 「いつもこの押さえ方」で選んだ形(コード名 → フレット)
  const userPicks = prefs.voicingPick || {};
  const picks = useMemo(() => ({ ...Object.fromEntries(autoFrets), ...userPicks }), [autoFrets, userPicks]);

  const easyToggled = useRef(false);
  const toggleEasy = () => {
    easyToggled.current = true;
    setSt({ easy: !easy });
  };
  useEffect(() => {
    if (!easyToggled.current) return;
    easyToggled.current = false;
    if (!easy) toast('教本どおりの押さえ方にしました');
    else if (!eased.length) toast('この曲は、もとから押さえやすいコードばかりです');
    else {
      const say = eased.slice(0, 2).map((e) => (e.kind === 'name' ? `${pretty(e.from)}→${pretty(e.to)}` : `${pretty(e.from)}は${e.kind === 'short' ? '省略形' : '押さえやすい形'}`));
      toast(`かんたんモード: ${say.join('、')}${eased.length > 2 ? ` ほか${eased.length - 2}つ` : ''}`);
    }
  }, [easy, eased]);

  const capoLabel = instrument === 'guitar' ? (capo === 0 ? 'カポなし' : `カポ ${capo}`) : null;
  const flatForShape = keyPrefersFlat(shapeKey);

  return html`<div className=${cx('song', 'is-' + instrument, inline && 'has-inline', prefs.showCurrent === false && 'no-current')}>
    <${TopBar} song=${song} onMore=${() => setPanel('more')} onApple=${onApple} />
    <div className="song-controls" role="toolbar" aria-label="表示の設定">
      <${Segmented}
        label="楽器"
        value=${instrument}
        onChange=${(v) => setSt({ instrument: v })}
        options=${[
          { value: 'guitar', label: 'ギター', icon: html`<${GuitarIcon} />` },
          { value: 'piano', label: 'ピアノ', icon: html`<${PianoIcon} />` },
        ]}
      />
      ${instrument === 'guitar'
        ? html`<button className="chip" onClick=${() => setPanel('capo')} aria-label="弾き方とカポ">
            ${capoLabel}${typeof st.capo !== 'number' ? html`<small>自動</small>` : null}
          </button>`
        : null}
      <button className=${cx('chip', inline && 'is-on')} aria-pressed=${inline} onClick=${() => setSt({ [inlineKey]: !inline })}>図</button>
      <button className=${cx('chip', transpose !== 0 && 'is-on')} onClick=${() => setPanel('key')}>
        <span className="lbl-long">キー ${transpose === 0 ? '原曲' : signed(transpose)}</span>
        <span className="lbl-short">${transpose === 0 ? 'キー' : `キー ${signed(transpose)}`}</span>
      </button>
      ${instrument === 'guitar'
        ? html`<button className=${cx('chip mode-chip', easy && 'is-on')} aria-pressed=${easy} onClick=${toggleEasy} aria-label=${easy ? '押さえ方: かんたん（押すと教本どおり）' : '押さえ方: 教本どおり（押すとかんたん）'}>
            <span className="lbl-long">${easy ? 'かんたん' : '教本どおり'}</span>
            <span className="lbl-short">${easy ? '簡単' : '教本'}</span>
          </button>`
        : null}
    </div>

    <div className="song-body">
      <main className="sheet-scroll" ref=${scrollRef} onClick=${onSheetTap}>
        <div className="sheet-inner" style=${{ '--fs': fontScale }}>
          ${song.source === 'ear' ? html`<${EarBanner} song=${song} />` : null}
          <div className="song-head">
            <${Artwork} song=${song} size=${56} />
            <div className="sheet-meta">
              <div className="sheet-meta-key">
                ${instrument === 'guitar'
                  ? html`<b>${capo ? `Capo ${capo}` : 'カポなし'}</b><span>（${keyName(shapeKey)} の形で弾く）</span>${easy ? html`<button className="easy-tag" onClick=${() => setPanel('capo')}>かんたんモード</button>` : null}`
                  : html`<b>Key ${keyName(soundKey)}</b>`}
              </div>
              <div className="muted small">
                原曲キー ${keyName(origKey)}${transpose ? ` → ${keyName(soundKey)}` : ''}${hasMod ? ` ・ 転調あり${follow ? '（カポを付けかえ）' : ''}` : ''} ・ ♩=${bpm}${bpmKnown ? '' : '(仮)'} ・ ${sourceName(song.source)}${song.edited ? '(編集済み)' : ''}
              </div>
            </div>
          </div>

          <div className="strip-top">
            <${ChordStrip} names=${uniqueDisplay} instrument=${instrument} picks=${picks} onTap=${(n) => setChordTap({ display: n })} />
          </div>

          <${SheetLines}
            lines=${parsed.lines}
            display=${display}
            displays=${displays}
            shifts=${shifts}
            marks=${modMarks}
            onMark=${() => setSt({ capoFollow: !follow })}
            instrument=${instrument}
            inline=${inline}
            showBars=${prefs.showBars}
            onChord=${onChord}
            onLine=${onLineTap}
            onLabel=${onLabelTap}
            loop=${loopRange}
            selecting=${!!loopSel}
            picks=${picks}
          />

          <div className="sheet-end">
            ${song.sourceUrl
              ? html`<a href=${song.sourceUrl} target="_blank" rel="noopener" className="link">出典: ${sourceName(song.source)}${song.sourceLabel ? `（${song.sourceLabel}）` : ''}</a>`
              : html`<span className="muted">${song.source === 'ear' ? '耳コピで作った下書き（自動）' : '自分で入力した譜面'}</span>`}
          </div>
        </div>
      </main>
      <aside className="strip-side" aria-label="この曲のコード">
        <div className="strip-side-title">この曲のコード</div>
        <${ChordStrip} names=${uniqueDisplay} instrument=${instrument} vertical=${true} picks=${picks} onTap=${(n) => setChordTap({ display: n })} />
      </aside>
    </div>

    ${loopSel
      ? html`<div className="loop-banner" role="status">
          <span>
            ${loopSel.step === 'from' ? 'くり返したい区間の、最初の行をタップ' : '次に、最後の行をタップ（同じ行ならその1行だけ）'}
            ${loopSel.step === 'from' && hasLabels ? html`<small>「サビ」などの見出しをタップすると、その段落まるごと</small>` : null}
          </span>
          <button className="btn btn-sm" onClick=${() => setLoopSel(null)}>やめる</button>
        </div>`
      : null}

    ${scroll.countdown ? html`<div className="countdown" aria-live="assertive"><span key=${scroll.countdown}>${scroll.countdown}</span></div>` : null}

    ${recOn
      ? html`<${RecDock}
          rec=${rec}
          videoRef=${videoRef}
          mode=${recVideo}
          setMode=${setRecVideo}
          time=${recTime}
          anchors=${recAnchors.length}
          speed=${recSpeed}
          setSpeed=${setRecSpeed}
          onSeek=${(t) => {
            if (videoRef.current) videoRef.current.currentTime = t;
          }}
        />`
      : null}
    <input ref=${recFileRef} type="file" accept="video/*,audio/*" hidden onChange=${(e) => { attachRec(e.target.files?.[0]); e.target.value = ''; }} />

    <${Transport}
      rec=${recOn}
      onRec=${() => setPanel('rec')}
      scroll=${scroll}
      bpm=${bpm}
      bpmKnown=${bpmKnown}
      speed=${speed}
      beatsPerBar=${beatsPerBar}
      click=${st.click ?? prefs.click}
      onClick=${() => {
        const on = !(st.click ?? prefs.click);
        setSt({ click: on });
        // オンにしたら、その場で1回鳴らして音が出ることを知らせる(マナーモードでも鳴る)
        if (on) {
          holdPlayback();
          clickSound(true, 0, prefs.clickVolume ?? 1);
          setTimeout(releasePlayback, 600);
        }
        toast(on ? (scroll.playing ? 'クリック音を鳴らします' : 'クリック音オン（▶ で流すと拍に合わせて鳴ります）') : 'クリック音オフ', { ms: 1800 });
      }}
      onTempo=${() => setPanel('tempo')}
      looping=${!!scroll.loop || !!loopSel}
      onLoop=${toggleLoop}
    />

    <${CapoPanel} open=${panel === 'capo'} onClose=${() => setPanel(null)} rank=${capoRank} capo=${capo} auto=${typeof st.capo !== 'number'} setSt=${setSt} stats=${stats} sounding=${sounding} easy=${easy} eased=${eased} hasMod=${hasMod} follow=${follow} />
    <${KeyPanel} open=${panel === 'key'} onClose=${() => setPanel(null)} transpose=${transpose} origKey=${origKey} setSt=${setSt} instrument=${instrument} />
    <${TempoPanel}
      open=${panel === 'tempo'}
      onClose=${() => setPanel(null)}
      bpm=${bpm}
      origBpm=${sheetBpm}
      setSt=${setSt}
      hasBars=${hasBars}
      barsPerLine=${barsPerLine}
      custom=${!!st.bpm}
      fit=${scroll.fit}
      fitSong=${fitSong}
      durationMs=${song.durationMs}
      beatsPerBar=${beatsPerBar}
      clickVolume=${prefs.clickVolume ?? 1}
      setClickVolume=${(v) => setPrefs({ clickVolume: v })}
      clickOn=${!!(st.click ?? prefs.click)}
      speed=${speed}
      showCurrent=${prefs.showCurrent !== false}
      setShowCurrent=${(v) => setPrefs({ showCurrent: v })}
    />
    <${TextPanel} open=${panel === 'text'} onClose=${() => setPanel(null)} fontScale=${fontScale} setSt=${setSt} />
    <${MorePanel}
      open=${panel === 'more'}
      onClose=${() => setPanel(null)}
      song=${song}
      reload=${reload}
      onText=${() => setPanel('text')}
      onTuner=${() => { prepareTuner(); setPanel('tuner'); }}
      onApple=${onApple}
      rec=${rec}
      recOn=${recOn}
      onPickRec=${() => { setPanel(null); recFileRef.current?.click(); }}
      onRecOn=${() => { setRecOn(true); setPanel(null); }}
      onRecPanel=${() => setPanel('rec')}
    />
    <${RecPanel}
      open=${panel === 'rec'}
      onClose=${() => setPanel(null)}
      rec=${rec}
      recOn=${recOn}
      anchors=${recAnchors.length}
      speed=${recSpeed}
      setSpeed=${setRecSpeed}
      video=${recVideo}
      setVideo=${setRecVideo}
      onPick=${() => recFileRef.current?.click()}
      onReset=${() => {
        const all = { ...(st.recSync || {}) };
        delete all[rec.fp];
        setSt({ recSync: all });
        toast('行の時刻の目印を消しました');
      }}
      onOff=${() => { setRecOn(false); setPanel(null); }}
      onRemove=${removeRec}
    />
    <${TunerSheet} open=${panel === 'tuner'} onClose=${() => setPanel(null)} />
    <${ChordPanel}
      tap=${chordTap}
      info=${tapInfo}
      onClose=${() => setChordTap(null)}
      instrument=${instrument}
      noteStyle=${prefs.noteStyle}
      flat=${instrument === 'guitar' ? flatForShape : soundFlat}
      picks=${userPicks}
      shown=${picks}
      easy=${easy}
    />
  </div>`;
}

// ---------------------------------------------------------------- 譜面の行

// 1行は折り返さずに1行のまま見せる。はみ出す行だけ文字と図を少し縮め、縮めすぎになる行だけ折り返す
const FIT_MIN = { lyric: 0.72, chords: 0.5 };

function fitLines(root) {
  if (!root) return;
  const els = [...root.querySelectorAll('.ln-lyric, .ln-chords')];
  // まず全部を元の大きさに戻してから測る(書き込み→読み取り→書き込みの順でまとめて行う)
  for (const el of els) {
    el.style.removeProperty('--fit');
    el.style.removeProperty('grid-template-columns');
    el.classList.remove('is-wrap', 'is-grid');
  }
  const pad = els.length ? parseFloat(getComputedStyle(els[0]).paddingLeft) * 2 : 0;
  const sizes = els.map((el) => [el, el.scrollWidth - pad, el.clientWidth - pad]);
  const grids = [];
  for (const [el, need, have] of sizes) {
    if (need <= have + 1) continue;
    const r = Math.floor((have / need) * 1000) / 1000 - 0.005;
    const chords = el.classList.contains('ln-chords');
    if (r >= (chords ? FIT_MIN.chords : FIT_MIN.lyric)) el.style.setProperty('--fit', r);
    else if (chords) {
      // コードだけの行がどうしても1行に入らないときは、段ごとの数をそろえて折る(9個なら 5+4。4+4+1 にしない)
      const n = el.children.length;
      const rows = Math.max(2, Math.ceil((need * 0.8) / have));
      el.classList.add('is-grid');
      el.style.gridTemplateColumns = `repeat(${Math.ceil(n / rows)}, max-content)`;
      grids.push(el);
    } else el.classList.add('is-wrap');
  }
  // そろえて折った行も、まだはみ出すなら少しだけ縮める
  for (const el of grids) {
    const need = el.scrollWidth - pad;
    const have = el.clientWidth - pad;
    if (need > have + 1) el.style.setProperty('--fit', Math.max(0.6, Math.floor((have / need) * 1000) / 1000 - 0.005));
  }
}

// 見出しの次の行から、次の見出しの手前までのうち、歌詞・コードのある行の範囲
function sectionOf(lines, i) {
  let from = -1;
  let to = -1;
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k].type;
    if (t === 'label') break;
    if (t === 'lyric' || t === 'chords') {
      if (from < 0) from = k;
      to = k;
    }
  }
  return from < 0 ? null : { from, to };
}

const SheetLines = memo(function SheetLines({ lines, display, displays = null, shifts = null, marks = null, onMark = null, instrument, inline, showBars, onChord, onLine, onLabel = null, loop = null, selecting = false, picks = null }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    fitLines(ref.current);
  }, [lines, display, displays, marks, instrument, inline, showBars]);
  // 画面の幅や文字の大きさが変わったら測り直す(高さだけの変化では測り直さない)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = '';
    const ro = new ResizeObserver(() => {
      const key = el.clientWidth + '|' + getComputedStyle(el).fontSize;
      if (key === last) return;
      last = key;
      fitLines(el);
    });
    ro.observe(el);
    if (document.fonts?.ready) document.fonts.ready.then(() => fitLines(el));
    // 印刷するときは紙の幅で測り直し、終わったら画面の幅に戻す
    const refit = () => fitLines(el);
    window.addEventListener('beforeprint', refit);
    window.addEventListener('afterprint', refit);
    return () => {
      ro.disconnect();
      window.removeEventListener('beforeprint', refit);
      window.removeEventListener('afterprint', refit);
    };
  }, []);
  return html`<div className=${cx('sheet-lines', selecting && 'is-selecting')} ref=${ref}>
    ${lines.map((l, i) => {
      const mk = marks?.get(i);
      const d = (displays && shifts && displays.get(shifts[i])) || display;
      const row = html`<${Line} key=${i} i=${i} line=${l} display=${d} instrument=${instrument} inline=${inline} showBars=${showBars} onChord=${onChord} onLine=${onLine} onLabel=${onLabel} selecting=${selecting} picks=${picks} loopMark=${!loop || i < loop.from || i > loop.to ? '' : cx('in-loop', i === loop.from && 'loop-start', i === loop.to && 'loop-end')} />`;
      return mk ? [html`<${ModMark} key=${'m' + i} mark=${mk} instrument=${instrument} onToggle=${onMark} />`, row] : row;
    })}
  </div>`;
});

// サビの見出しは少し目立たせる
const SABI_RE = /サビ|chorus|ｻﾋﾞ/i;

const Line = memo(function Line({ line, i, display, instrument, inline, showBars, onChord, onLine, onLabel, selecting, picks, loopMark }) {
  if (line.type === 'blank') return html`<div className="ln ln-blank" data-i=${i}></div>`;
  if (line.type === 'label')
    return html`<div className=${cx('ln ln-label', SABI_RE.test(line.text) && 'is-sabi', loopMark)} data-i=${i}>
      ${onLabel ? html`<button className="label-btn" onClick=${() => onLabel(i)}>${line.text}</button>` : html`<span>${line.text}</span>`}
    </div>`;
  if (line.type === 'comment') return html`<div className="ln ln-comment" data-i=${i}>${line.text}</div>`;
  const hasChord = line.segs.some((s) => s.c);
  return html`<div className=${cx('ln', 'ln-' + line.type, line.chorus && 'is-chorus', !hasChord && 'ln-plain', loopMark)} data-i=${i} onClick=${(e) => onLine(i, !!e.target.closest('.seg'))}>
    ${line.segs.map((s, k) => {
      const name = s.c ? display.get(s.c) || s.c : null;
      return html`<span className=${cx('seg', s.c && 'has-chord')} key=${k}>
        ${hasChord
          ? html`<span className="ch">
              ${s.bar && showBars ? html`<i className="bar" aria-hidden="true"></i>` : null}
              ${s.c
                ? html`<button className="chord" onClick=${(e) => { if (selecting) return; e.stopPropagation(); onChord(s.c, i); }}>
                    <span className="chord-name"><${ChordText} name=${pretty(name)} /></span>
                    ${inline && /^[A-G]/.test(name) ? html`<${MiniDiagram} name=${name} instrument=${instrument} pick=${picks?.[name]} />` : null}
                  </button>`
                : html`<span className="chord-space"> </span>`}
            </span>`
          : null}
        ${line.type === 'lyric' ? html`<span className="ly">${s.t || (s.c ? ' ' : '')}</span>` : null}
      </span>`;
    })}
  </div>`;
});

// 耳コピの下書きの案内。サイトに譜面が出ていれば、そちらに切り替えられる
function EarBanner({ song }) {
  const found = song.watchFound && song.sources?.length ? song.sources[0] : null;
  const again = () => go(`/ear?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist || '')}${song.appleId ? `&appleId=${song.appleId}` : ''}`);
  if (found)
    return html`<div className="ear-banner is-found" role="status">
      <span><b>${sourceName(found.source)}</b> にこの曲の譜面が出ました</span>
      <button className="btn btn-sm btn-primary" onClick=${async () => {
        if (!confirm('耳コピの下書きから、サイトの譜面に切り替えますか？（下書きは消えます）')) return;
        await lib.patch(song.id, { source: found.source, sourceId: found.id, sourceUrl: found.url, sourceLabel: found.label || '', sheet: null, edited: false, watch: false, watchFound: null });
      }}>切り替える</button>
    </div>`;
  return html`<div className="ear-banner" role="note">
    <span>音から聴き取った、耳コピの下書きです。サイトに譜面が出たら、ホームでお知らせします。</span>
    <button className="btn btn-sm" onClick=${again}>聴き直す</button>
  </div>`;
}

// 転調の印: 「転調 +2（Key G → A）カポ 2 → 4 に付けかえ（押さえ方はそのまま）」
function ModMark({ mark, instrument, onToggle }) {
  const capoTxt = (c) => (c === 0 ? 'カポなし' : `カポ ${c}`);
  let body = null;
  if (instrument === 'guitar') {
    if (!mark.follow)
      body = html`<span>カポはそのまま（コードの形が変わります）</span>
        <button className="mod-mark-btn" onClick=${onToggle}>カポを付けかえる</button>`;
    else if (mark.toCapo === mark.fromCapo) body = html`<span>カポはそのまま（コードの形が変わります）</span>`;
    else
      body = html`<span><b>${capoTxt(mark.fromCapo)} → ${capoTxt(mark.toCapo)}</b> に付けかえ${mark.sameShapes ? '（押さえ方はそのまま）' : '（コードの形が少し変わります）'}</span>
        <button className="mod-mark-btn" onClick=${onToggle}>付けかえない</button>`;
  }
  return html`<div className=${cx('mod-mark', mark.shift > 0 ? 'is-up' : 'is-down')} role="note">
    <div className="mod-mark-head">
      <span className="mod-mark-arrow" aria-hidden="true">${mark.shift > 0 ? '↑' : '↓'}</span>
      転調 ${signed(mark.shift)}<small>（Key ${mark.fromKey} → ${mark.toKey}）</small>
    </div>
    ${body ? html`<div className="mod-mark-body">${body}</div>` : null}
  </div>`;
}

// 編集画面のプレビュー用(コード名はそのまま)
export function SheetPreview({ lines }) {
  const display = useMemo(() => {
    const m = new Map();
    for (const l of lines) if (l.segs) for (const s of l.segs) if (s.c) m.set(s.c, s.c);
    return m;
  }, [lines]);
  return html`<div className="sheet-inner preview"><${SheetLines} lines=${lines} display=${display} instrument="piano" inline=${false} showBars=${true} onChord=${() => {}} onLine=${() => {}} /></div>`;
}

const MiniDiagram = memo(function MiniDiagram({ name, instrument, pick }) {
  if (instrument === 'piano') return html`<span className="mini-diagram mini-staff"><${StaffDiagram} name=${name} width=${46} /></span>`;
  return html`<span className="mini-diagram"><${GuitarDiagram} voicing=${chosenVoicing(name, pick)} width=${52} fingers=${false} compact=${true} /></span>`;
});

function ChordStrip({ names, instrument, onTap, vertical = false, picks = null }) {
  if (!names.length) return null;
  if (instrument === 'guitar')
    return html`<div className=${cx('chord-strip', vertical && 'is-vertical')}>
      ${names.map((n) => html`<${GuitarChordCard} key=${n} name=${n} pick=${picks?.[n]} label=${html`<${ChordText} name=${pretty(n)} />`} onClick=${() => onTap(n)} />`)}
    </div>`;
  return html`<div className=${cx('chord-strip', vertical && 'is-vertical')}>
    ${names.map((n) => html`<${PianoChordCard} key=${n} name=${n} label=${html`<${ChordText} name=${pretty(n)} />`} onClick=${() => onTap(n)} />`)}
  </div>`;
}

// ---------------------------------------------------------------- 再生バー

// rec: 自分の録音に合わせているとき(テンポの代わりに「録音」、メトロノームは出さない)
function Transport({ scroll, bpm, bpmKnown, beatsPerBar, click, onClick, onTempo, looping, onLoop, rec = false, onRec, speed = 1 }) {
  return html`<div className=${cx('transport', rec && 'is-rec')}>
    ${rec ? null : html`<div className="transport-progress" style=${{ transform: `scaleX(${scroll.progress})` }}></div>`}
    ${rec
      ? null
      : html`<div className=${cx('beat-dots', scroll.playing && 'is-playing')} ref=${scroll.bindBeat} aria-hidden="true">
          ${Array.from({ length: Math.min(8, beatsPerBar || 4) }, (_, i) => html`<i key=${i}></i>`)}
        </div>`}
    <button className="icon-btn" onClick=${scroll.toStart} aria-label="最初に戻る"><${Icon} name="skipBack" /></button>
    ${rec
      ? html`<button className="tempo-btn rec-btn" onClick=${onRec} aria-label="録音の設定">
          <${Icon} name="mic" size=${18} /><span className="tempo-unit">録音</span>
        </button>`
      : html`<button className=${cx('tempo-btn', !bpmKnown && 'is-guess')} onClick=${onTempo} aria-label="テンポを変える">
          <span className="tempo-note">♩</span><span className="tempo-num">${bpm}</span><span className=${cx('tempo-unit', speed !== 1 && 'is-speed')}>${speed !== 1 ? `${Math.round(speed * 100)}%` : 'BPM'}</span>
        </button>`}
    <button className=${cx('play-btn', scroll.playing && 'is-playing')} onClick=${scroll.toggle} aria-label=${scroll.playing ? '止める' : rec ? '録音を再生' : '自動スクロール開始'}>
      <${PlayIcon} playing=${scroll.playing} size=${30} />
    </button>
    ${rec
      ? html`<span className="transport-space" aria-hidden="true"></span>`
      : html`<button className=${cx('icon-btn', click && 'is-on')} onClick=${onClick} aria-pressed=${click} aria-label="クリック音">
          <${Icon} name="metronome" />
        </button>`}
    <button className=${cx('icon-btn', looping && 'is-on')} onClick=${onLoop} aria-pressed=${looping} aria-label=${looping ? '区間リピートをやめる' : '区間リピート'}>
      <${Icon} name="repeat" />
    </button>
  </div>`;
}

// ---------------------------------------------------------------- 自分の録音

const mmssRec = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

// 動画の小窓(タップで大きく/小さく)と、再生位置のつまみ・速さ
function RecDock({ rec, videoRef, mode, setMode, time, anchors, speed, setSpeed, onSeek }) {
  const cycle = () => setSpeed(speed === 1 ? 0.9 : speed === 0.9 ? 0.8 : speed === 0.8 ? 0.7 : 1);
  return html`<${React.Fragment}>
    <div className=${cx('rec-video', rec.isVideo ? 'is-' + mode : 'is-audio')} onClick=${() => rec.isVideo && setMode(mode === 'small' ? 'big' : 'small')}>
      <video ref=${videoRef} src=${rec.url} playsInline preload="auto"></video>
      ${rec.isVideo && mode !== 'hidden'
        ? html`<button className="rec-video-hide" onClick=${(e) => { e.stopPropagation(); setMode('hidden'); }} aria-label="映像を隠す"><${Icon} name="close" size=${14} /></button>`
        : null}
    </div>
    <div className="rec-dock">
      ${!anchors
        ? html`<p className="rec-hint">▶ で再生して、<b>歌い出した行をタップ</b>すると、その行の時刻を覚えます。ずれてきたら、その都度タップで直せます。</p>`
        : null}
      <div className="rec-row">
        <span className="rec-time">${mmssRec(time.t)}</span>
        <input
          type="range"
          className="rec-seek"
          min="0"
          max=${time.d || 0}
          step="0.1"
          value=${time.t}
          onInput=${(e) => onSeek(Number(e.target.value))}
          aria-label="録音の再生位置"
        />
        <span className="rec-time">${mmssRec(time.d)}</span>
        <button className=${cx('chip chip-sm rec-speed', speed !== 1 && 'is-on')} onClick=${cycle} aria-label="再生の速さ">${speed === 1 ? '1×' : speed + '×'}</button>
        ${rec.isVideo && mode === 'hidden'
          ? html`<button className="icon-btn rec-mini" onClick=${() => setMode('small')} aria-label="映像を出す"><${Icon} name="video" size=${18} /></button>`
          : null}
      </div>
    </div>
  </${React.Fragment}>`;
}

function RecPanel({ open, onClose, rec, recOn, anchors, speed, setSpeed, video, setVideo, onPick, onReset, onOff, onRemove }) {
  if (!rec) return null;
  const mb = rec.size ? Math.round(rec.size / 1e6) : 0;
  return html`<${Sheet} open=${open} onClose=${onClose} title="自分の歌に合わせる">
    <div className="rec-info">
      <${Icon} name=${rec.isVideo ? 'video' : 'mic'} />
      <span><b>${rec.name}</b><small>${mb ? `${mb}MB ・ ` : ''}${rec.saved ? 'この端末に保存しています（ほかの端末には送りません）' : '大きいので今回だけ（次に開いたら選び直し）'}</small></span>
    </div>
    <p className="panel-lead">再生中に<b>歌っている行をタップ</b>すると、その行の時刻を覚え、次からは録音にぴったり合わせて譜面が流れます。全部の行でなくても、サビの頭など何か所かで十分です（あいだは自動でつなぎます）。</p>
    <div className="panel-field">
      <div className="panel-field-label">再生の速さ（音程はそのまま）</div>
      <${Segmented} label="再生の速さ" value=${speed} onChange=${setSpeed} options=${[1, 0.9, 0.8, 0.7].map((v) => ({ value: v, label: v === 1 ? 'そのまま' : `${v}×` }))} />
    </div>
    ${rec.isVideo
      ? html`<div className="panel-field">
          <div className="panel-field-label">映像</div>
          <${Segmented} label="映像" value=${video} onChange=${setVideo} options=${[{ value: 'small', label: '小さく' }, { value: 'big', label: '大きく' }, { value: 'hidden', label: '隠す（音だけ）' }]} />
        </div>`
      : null}
    <div className="menu-group">
      <button className="menu-item" onClick=${onReset} disabled=${!anchors}><${Icon} name="refresh" /><span className="menu-item-text">行の時刻をやり直す<small>${anchors ? `いま ${anchors}か所 合わせています` : 'まだ合わせていません'}</small></span></button>
      <button className="menu-item" onClick=${onPick}><${Icon} name="upload" /><span className="menu-item-text">別の動画・録音を選ぶ</span></button>
      ${recOn ? html`<button className="menu-item" onClick=${onOff}><${Icon} name="metronome" /><span className="menu-item-text">録音に合わせるのをやめる（BPMで流す）</span></button>` : null}
      <button className="menu-item is-danger" onClick=${onRemove}><${Icon} name="trash" /><span className="menu-item-text">この端末から録音を消す</span></button>
    </div>
  </${Sheet}>`;
}

// ---------------------------------------------------------------- パネル類

function CapoPanel({ open, onClose, rank, capo, auto, setSt, stats, sounding, easy, eased, hasMod = false, follow = false }) {
  if (!rank) return null;
  // 出てくる回数の多いコードから5つを見本として出す
  const top = [...stats.count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => sounding.get(c));
  const maxAvg = Math.max(...rank.rows.map((r) => r.avg));
  const minAvg = Math.min(...rank.rows.map((r) => r.avg));
  return html`<${Sheet} open=${open} onClose=${onClose} title="弾き方とカポ">
    <div className="mode-box">
      <${Segmented}
        label="弾き方"
        value=${easy ? 'easy' : 'normal'}
        onChange=${(v) => setSt({ easy: v === 'easy' })}
        options=${[
          { value: 'normal', label: '通常（教本どおり）' },
          { value: 'easy', label: 'かんたん' },
        ]}
      />
      <p className="mode-note">
        ${easy
          ? 'バレーコードなど、つっかえやすいところを省略形や響きの近いコードに置き換え、前後のコードへの持ちかえが少ない形を選んでいます。'
          : 'F や B もバレーコードのまま、教本どおりの押さえ方で出します。弾けるようになりたい形を、そのまま練習できます。'}
      </p>
      ${easy
        ? eased.length
          ? html`<div className="eased-list" aria-label="かんたんにしたコード">
              ${eased.map(
                (e) => html`<span className="eased-item" key=${e.from}>
                  <b><${ChordText} name=${pretty(e.from)} /></b>
                  ${e.kind === 'name'
                    ? html`<i>→</i><b className="to"><${ChordText} name=${pretty(e.to)} /></b>`
                    : html`<small>${e.kind === 'short' ? '省略形' : '押さえやすい形'}</small>`}
                </span>`,
              )}
            </div>`
          : html`<p className="mode-note is-quiet">この曲は、もとから押さえやすいコードばかりなので、置き換えるところはありません。</p>`
        : null}
    </div>
    ${hasMod
      ? html`<div className="panel-switch">
          <${Switch}
            label="転調したらカポを付けかえる"
            hint="転調のところでカポを上げ下げして、それまでと同じ押さえ方で弾けるようにします（譜面に印が出ます）"
            checked=${follow}
            onChange=${(v) => setSt({ capoFollow: v })}
          />
        </div>`
      : null}
    <p className="panel-lead">バーが長いほど押さえやすいカポ位置です。「自動」なら一番弾きやすい位置を選び続けます。</p>
    <button className=${cx('capo-row', auto && 'is-on')} onClick=${() => { setSt({ capo: null }); onClose(); }}>
      <span className="capo-name">自動</span>
      <span className="capo-shapes">いちばん押さえやすい位置（今は ${rank.best === 0 ? 'カポなし' : 'カポ ' + rank.best}）</span>
      ${auto ? html`<${Icon} name="check" />` : null}
    </button>
    ${rank.rows.map((r) => {
      const ease = maxAvg === minAvg ? 1 : 1 - (r.avg - minAvg) / (maxAvg - minAvg);
      const shapes = [...new Set(top.map((c) => r.shapes.get(c)))];
      return html`<button key=${r.capo} className=${cx('capo-row', !auto && capo === r.capo && 'is-on')} onClick=${() => { setSt({ capo: r.capo }); onClose(); }}>
        <span className="capo-name">${r.capo === 0 ? 'なし' : r.capo}${r.capo === rank.best ? html`<em>おすすめ</em>` : null}</span>
        <span className="capo-shapes">${shapes.map((s, i) => html`<span key=${i} className="capo-shape"><${ChordText} name=${pretty(s)} /></span>`)}</span>
        <span className="capo-ease" aria-label=${`押さえやすさ ${Math.round(ease * 100)}%`}><i style=${{ width: `${Math.max(8, ease * 100)}%` }}></i></span>
        ${!auto && capo === r.capo ? html`<${Icon} name="check" />` : null}
      </button>`;
    })}
  </${Sheet}>`;
}

function KeyPanel({ open, onClose, transpose, origKey, setSt, instrument }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="キー（曲の高さ）">
    <p className="panel-lead">自分の声に合わせて曲全体の高さを変えます。${instrument === 'guitar' ? 'ギターのカポ位置も自動で選び直します。' : ''}</p>
    <div className="key-big">
      <div className="key-now">${keyName(origKey, transpose)}</div>
      <div className="muted small">原曲 ${keyName(origKey)} から ${transpose === 0 ? '変更なし' : signed(transpose)}（半音）</div>
    </div>
    <${Stepper} label="キー" value=${transpose} min=${-6} max=${6} onChange=${(v) => setSt({ transpose: v })} format=${(v) => (v === 0 ? '原曲' : signed(v))} />
    <div className="row-gap center">
      <button className="btn" disabled=${transpose === 0} onClick=${() => setSt({ transpose: 0 })}>原曲キーに戻す</button>
    </div>
  </${Sheet}>`;
}

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// メトロノームだけを鳴らす(自動スクロールとは別に、テンポの確認・練習用)。先の拍を少し前もって予約するので、ずれにくい
function Metronome({ bpm, beatsPerBar = 4, volume, setVolume }) {
  const [on, setOn] = useState(false);
  const [beat, setBeat] = useState(-1);
  const live = useRef({ bpm, volume, beatsPerBar });
  live.current = { bpm, volume, beatsPerBar };
  const rt = useRef(null);
  const stop = () => {
    const r = rt.current;
    rt.current = null;
    if (!r) return;
    clearInterval(r.timer);
    r.timeouts.forEach(clearTimeout);
    releasePlayback();
    setOn(false);
    setBeat(-1);
  };
  const start = () => {
    holdPlayback();
    const c = audioCtx();
    const r = { next: c.currentTime + 0.08, n: 0, timeouts: [], timer: 0 };
    r.timer = setInterval(() => {
      if (c.state === 'suspended') c.resume().catch?.(() => {}); // 電話などで止まったら鳴らし直す
      const { bpm: B, volume: V, beatsPerBar: bpb } = live.current;
      while (r.next < c.currentTime + 0.12) {
        const k = r.n % bpb;
        clickSound(k === 0, r.next, V);
        const wait = Math.max(0, (r.next - c.currentTime) * 1000);
        r.timeouts.push(setTimeout(() => setBeat(k), wait));
        if (r.timeouts.length > 16) r.timeouts.splice(0, 8);
        r.next += 60 / B;
        r.n++;
      }
    }, 25);
    rt.current = r;
    setOn(true);
  };
  useEffect(() => stop, []);
  return html`<div className="metro">
    <div className="metro-row">
      <button className=${cx('btn metro-btn', on && 'is-on')} onClick=${() => (on ? stop() : start())}>
        <${Icon} name="metronome" size=${18} /> ${on ? '止める' : 'メトロノームを鳴らす'}
      </button>
      <div className="metro-dots" aria-hidden="true">
        ${Array.from({ length: Math.min(8, beatsPerBar) }, (_, i) => html`<i key=${i} className=${cx(i === beat && 'on', i === 0 && 'is-head')}></i>`)}
      </div>
    </div>
    <div className="metro-row">
      <span className="muted small">クリックの大きさ</span>
      <${Segmented} size="sm" label="クリックの大きさ" value=${volume} onChange=${setVolume} options=${[{ value: 0.6, label: '小' }, { value: 1, label: '中' }, { value: 1.5, label: '大' }]} />
    </div>
    <p className="panel-note">マナーモード（消音スイッチ）がオンでも鳴ります。自動スクロール中に鳴らしたいときは、下のバーのメトロノームのボタンをオンにしてください。</p>
  </div>`;
}

function TempoPanel({ open, onClose, bpm, origBpm, setSt, hasBars, barsPerLine, custom, fit, fitSong, durationMs, beatsPerBar = 4, clickVolume = 1, setClickVolume, clickOn = false, speed = 1, showCurrent = true, setShowCurrent }) {
  const pct = Math.round(speed * 100);
  const setPct = (p) => setSt({ speed: Math.abs(p - 100) < 0.5 ? null : Math.max(70, Math.min(130, p)) / 100 });
  const taps = useRef([]);
  const tap = () => {
    const now = performance.now();
    const t = taps.current.filter((x) => now - x < 2500);
    t.push(now);
    taps.current = t;
    if (t.length >= 3) {
      const iv = (t[t.length - 1] - t[0]) / (t.length - 1);
      setSt({ bpm: Math.round(60000 / iv) });
    }
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="テンポ（スクロールの速さ）">
    <div className="key-big">
      <div className="key-now">♩ = ${bpm}</div>
      <div className="muted small">${origBpm ? `元のテンポ ${origBpm}` : '元のテンポが分からない曲です。曲に合わせてタップしてください'}</div>
    </div>
    <div className="panel-field speed-field">
      <div className="panel-field-label">スクロールの速さ（自分で微調整）<b className=${cx('speed-now', pct !== 100 && 'is-on')}>${pct}%</b></div>
      <div className="speed-row">
        <button className="btn" onClick=${() => setPct(pct - 5)} aria-label="5%遅く">−5</button>
        <button className="btn" onClick=${() => setPct(pct - 1)} aria-label="1%遅く">−1</button>
        <input type="range" className="range" min="70" max="130" step="1" value=${pct} onInput=${(e) => setPct(Number(e.target.value))} aria-label="スクロールの速さ" />
        <button className="btn" onClick=${() => setPct(pct + 1)} aria-label="1%速く">+1</button>
        <button className="btn" onClick=${() => setPct(pct + 5)} aria-label="5%速く">+5</button>
      </div>
      <p className="panel-note">BPM・曲の長さに合わせた速さに、さらにかけ算します（この曲だけ）。クリック音も同じだけ変わるので、ずれません。${pct !== 100 ? html` <button className="link-btn" onClick=${() => setPct(100)}>100%に戻す</button>` : null}</p>
    </div>
    <${Stepper} label="BPM" value=${bpm} min=${30} max=${300} onChange=${(v) => setSt({ bpm: v })} format=${(v) => v} />
    <div className="row-gap center">
      <button className="btn" onClick=${() => setSt({ bpm: Math.max(30, Math.round(bpm / 2)) })}>×½</button>
      <button className="btn btn-tap" onPointerDown=${tap}>タップで合わせる</button>
      <button className="btn" onClick=${() => setSt({ bpm: Math.min(300, bpm * 2) })}>×2</button>
    </div>
    ${custom && origBpm ? html`<div className="row-gap center"><button className="btn btn-ghost" onClick=${() => setSt({ bpm: null })}>元のテンポ（${origBpm}）に戻す</button></div>` : null}
    <${Metronome} bpm=${bpm} beatsPerBar=${beatsPerBar} volume=${clickVolume} setVolume=${setClickVolume} />
    <div className="panel-field">
      <${Switch} label="今の行に色を付ける" hint="流しているあいだ、今の行を黄色くします（すべての曲で共通）" checked=${showCurrent} onChange=${setShowCurrent} />
    </div>
    <div className="panel-field">
      <${Switch}
        label=${durationMs ? `曲の長さ（${mmss(durationMs)}）に合わせる` : '曲の長さに合わせる'}
        hint=${!durationMs
          ? 'この曲は長さが分からないので、BPMどおりに進みます'
          : !fit
            ? ''
            : !fit.usable
              ? '譜面と曲の長さが離れすぎているので、BPMどおりに進みます'
              : !fitSong
                ? 'オフ: BPMと小節の数どおりに進みます'
                : clickOn
                  ? 'クリック音がオンの間は、クリックとコードの切り替わりがぴったり合うよう、BPMどおりに進みます（オフにすると曲の長さに合わせます）'
                  : `譜面がちょうど曲の長さで終わるよう、${fit.ratio > 1 ? 'ゆっくり' : '速め'}に進めています（×${(1 / fit.ratio).toFixed(2)}）。クリック音をオンにすると、BPMどおりに戻ります`}
        checked=${fitSong && !!fit?.usable}
        onChange=${(v) => setSt({ fitSong: v })}
      />
    </div>
    ${hasBars
      ? html`<p className="panel-note">この譜面には小節線があるので、小節どおりに進みます。</p>`
      : html`<div className="panel-field">
          <div className="panel-field-label">歌詞1行の長さ</div>
          <${Segmented}
            label="歌詞1行の長さ"
            value=${barsPerLine}
            onChange=${(v) => setSt({ barsPerLine: v })}
            options=${[{ value: 0, label: '自動' }, ...[1, 2, 3, 4].map((n) => ({ value: n, label: `${n}小節` }))]}
          />
          <p className="panel-note">「自動」は、コードの数と歌詞の長さから行ごとに小節数を見積もります。ずれるときは演奏中に行をタップするとそこへ飛びます。</p>
        </div>`}
  </${Sheet}>`;
}

function TextPanel({ open, onClose, fontScale, setSt }) {
  return html`<${Sheet} open=${open} onClose=${onClose} title="文字の大きさ">
    <div className="text-preview" style=${{ '--fs': fontScale }}>
      <span className="chord-name">C</span><span className="ly">あの日の</span><span className="chord-name">G</span><span className="ly">空は</span>
    </div>
    <input type="range" className="range" min="0.7" max="1.8" step="0.05" value=${fontScale} onInput=${(e) => setSt({ fontScale: Number(e.target.value) })} aria-label="文字の大きさ" />
    <div className="row-gap center"><button className="btn btn-ghost" onClick=${() => setSt({ fontScale: null })}>標準に戻す</button></div>
  </${Sheet}>`;
}

// 原曲を Apple Music で開く(曲が特定できていればその曲、分からなければ検索)
function appleMusicUrl(song) {
  if (song.appleUrl) return song.appleUrl;
  if (song.appleId) return `https://music.apple.com/jp/song/${song.appleId}`;
  return `https://music.apple.com/jp/search?term=${encodeURIComponent(`${baseTitle(song.title)} ${song.artist || ''}`.trim())}`;
}

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// iPhone・iPad は music:// で Music アプリを直接開く(ホーム画面のアプリから https で開くと、アプリ内のブラウザに Web 版が出てしまうため)。
// 開かなかったとき(アプリを消しているなど)だけ Web 版への道を出す
function openAppleMusic(song) {
  const web = appleMusicUrl(song);
  const known = !!(song.appleUrl || song.appleId);
  if (!IOS || !known) {
    window.open(web, '_blank', 'noopener');
    return;
  }
  let left = false;
  const onHide = () => {
    if (document.visibilityState === 'hidden') left = true;
  };
  document.addEventListener('visibilitychange', onHide);
  location.href = web.replace(/^https:/, 'music:');
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left && document.visibilityState === 'visible') {
      toast('Apple Music が開かなかったときは', { action: { label: 'Web で開く', onClick: () => window.open(web, '_blank', 'noopener') } });
    }
  }, 1500);
}

function MorePanel({ open, onClose, song, reload, onText, onTuner, onApple, rec = null, recOn = false, onPickRec, onRecOn, onRecPanel }) {
  const others = (song.sources || []).filter((s) => !(s.source === song.source && s.id === song.sourceId));
  const switchTo = async (s) => {
    if ((song.edited || song.source === 'ear') && !confirm(song.source === 'ear' ? '耳コピの下書きは消えます。切り替えますか？' : '編集した譜面は消えます。切り替えますか？')) return;
    await lib.patch(song.id, { source: s.source, sourceId: s.id, sourceUrl: s.url, sourceLabel: s.label || '', sheet: null, edited: false, watch: false, watchFound: null });
    onClose();
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="この曲">
    ${song.sources && song.sources.length > 1
      ? html`<div className="menu-group">
          <div className="menu-title">ほかの版に切り替える</div>
          ${song.sources.map((s) => {
            const on = s.source === song.source && s.id === song.sourceId;
            return html`<button key=${s.source + s.id} className=${cx('menu-item', on && 'is-on')} onClick=${() => !on && switchTo(s)}>
              <span className=${'src-badge src-' + s.source}>${sourceName(s.source)}</span>
              <span className="menu-item-text">${s.label || '通常版'}</span>
              ${on ? html`<${Icon} name="check" />` : null}
            </button>`;
          })}
        </div>`
      : null}
    <div className="menu-group">
      ${!rec
        ? html`<button className="menu-item is-accent" onClick=${onPickRec}>
            <${Icon} name="mic" />
            <span className="menu-item-text">自分の歌（動画・録音）に合わせる<small>アカペラで撮った動画などを流しながら、譜面をいっしょに見られます</small></span>
          </button>`
        : recOn
          ? html`<button className="menu-item is-accent" onClick=${onRecPanel}><${Icon} name="mic" /><span className="menu-item-text">録音の設定<small>${rec.name}</small></span></button>`
          : html`<button className="menu-item is-accent" onClick=${onRecOn}><${Icon} name="mic" /><span className="menu-item-text">録音に合わせる<small>${rec.name}</small></span></button>`}
    </div>
    <div className="menu-group">
      <button className="menu-item" onClick=${() => { onClose(); onApple(); }}><${Icon} name="headphones" /><span className="menu-item-text">Apple Music で原曲を聴く<small>上のバーの「原曲」ボタンからも開けます</small></span></button>
      <button className="menu-item" onClick=${onTuner}><${Icon} name="tuner" /><span className="menu-item-text">チューナー（ギターの音合わせ）</span></button>
    </div>
    <div className="menu-group">
      <button className="menu-item" onClick=${() => { onClose(); onText(); }}><${Icon} name="text" /><span className="menu-item-text">文字の大きさ</span></button>
      <button className="menu-item" onClick=${() => { onClose(); go('/edit/' + song.id); }}><${Icon} name="edit" /><span className="menu-item-text">譜面を直す・書き足す</span></button>
      ${song.source !== 'manual' && song.source !== 'ear'
        ? html`<button className="menu-item" onClick=${() => { onClose(); reload(true); }}><${Icon} name="refresh" /><span className="menu-item-text">譜面を取り直す（元サイトの最新にする）</span></button>`
        : null}
      ${song.sourceUrl
        ? html`<a className="menu-item" href=${song.sourceUrl} target="_blank" rel="noopener"><${Icon} name="link" /><span className="menu-item-text">元のページを開く</span></a>`
        : null}
      <button className="menu-item" onClick=${() => { onClose(); setTimeout(() => window.print(), 350); }}><${Icon} name="print" /><span className="menu-item-text">印刷する・PDFにする</span></button>
      <button className="menu-item is-danger" onClick=${async () => {
        if (!confirm(`「${song.title}」をこのアプリから消しますか？`)) return;
        const keep = lib.get(song.id);
        await lib.remove(song.id);
        onClose();
        back('/');
        toast('消しました', { action: { label: '元に戻す', onClick: async () => { await lib.put({ ...keep, deleted: false }); toast('元に戻しました'); } } });
      }}><${Icon} name="trash" /><span className="menu-item-text">この曲を消す</span></button>
    </div>
    ${others.length === 0 && song.source !== 'manual' ? html`<p className="panel-note">${song.source === 'ear' ? 'サイトに譜面が出たら、ホームでお知らせします。' : 'ほかのサイトの版は見つかっていません。'}</p>` : null}
  </${Sheet}>`;
}

// info: { name: 画面のコード名, snd: 実際に鳴る音, plain: かんたんモードで置き換える前の名前 }
function ChordPanel({ tap, info, onClose, instrument, noteStyle, flat, picks, shown = {}, easy = false }) {
  const [idx, setIdx] = useState(0);
  const name = info?.name || null;
  const snd = info?.snd || null;
  const plain = info?.plain || null;
  // 押さえ方の並び: 通常モードは教本の形を先頭に、かんたんモードは押さえやすい順
  const orderOf = (n) => {
    const a = guitarVoicings(n);
    return easy ? a : [...a.filter((v) => v.standard), ...a.filter((v) => !v.standard)];
  };
  // 開いたときは、譜面に出している形(自分で選んだ形 → モードの形)を最初に出す
  useEffect(() => {
    if (instrument === 'guitar' && name && shown?.[name]) {
      const i = orderOf(name).findIndex((v) => v.frets.join(',') === shown[name]);
      setIdx(i >= 0 ? i : 0);
    } else setIdx(0);
  }, [tap]);
  const togglePick = (v) => {
    const cur = { ...(getPrefs().voicingPick || {}) };
    const f = v.frets.join(',');
    if (cur[name] === f) {
      delete cur[name];
      toast(easy ? 'かんたんモードの形に戻しました' : '教本どおりの形に戻しました');
    } else {
      cur[name] = f;
      toast(`${pretty(name)} はいつもこの形で出します`);
    }
    setPrefs({ voicingPick: cur });
  };
  let body = null;
  if (name && name.startsWith('/') && instrument === 'guitar') {
    body = html`<p className="panel-lead center">いちばん低い音（ベース）だけを <b>${pretty(name.slice(1))}</b> に変える指示です。<br />ギターでは6弦・5弦のその音だけを鳴らすか、ひとつ前のコードのまま弾いてください。</p>`;
  } else if (name && instrument === 'guitar') {
    const vs = orderOf(name);
    const i = idx % Math.max(1, vs.length);
    const v = vs[i];
    const f = v ? v.frets.join(',') : '';
    const isPick = !!v && picks?.[name] === f;
    const isShown = !!v && shown?.[name] === f;
    const stdIdx = vs.findIndex((x) => x.standard);
    const what = !v
      ? ''
      : isPick
        ? 'いつもの形（自分で選んだ形）'
        : isShown && easy
          ? 'かんたんモードで出している形'
          : v.standard
            ? '標準の形（教本どおり）'
            : v === guitarVoicings(name)[0]
              ? 'いちばんやさしい形'
              : 'ほかの押さえ方';
    body = html`<div className="chord-detail">
      ${plain && plain !== name
        ? html`<p className="eased-note">元のコードは <b><${ChordText} name=${pretty(plain)} /></b>。かんたんモードで、響きの近い <b><${ChordText} name=${pretty(name)} /></b> に置き換えています。</p>`
        : null}
      <div className="chord-detail-diagram"><${GuitarDiagram} voicing=${v} width=${250} /></div>
      ${vs.length > 1
        ? html`<div className="row-gap center voicing-nav">
            <button className="btn" onClick=${() => setIdx((i - 1 + vs.length) % vs.length)} aria-label="前の押さえ方"><${Icon} name="back" /></button>
            <span className="voicing-count">
              <b>${i + 1} / ${vs.length}</b>
              <small>${what}</small>
            </span>
            <button className="btn" onClick=${() => setIdx((i + 1) % vs.length)} aria-label="次の押さえ方"><${Icon} name="back" className="rot-180" /></button>
          </div>
          ${v && ((!v.standard && stdIdx >= 0) || isPick || !isShown)
            ? html`<div className="row-gap center voicing-actions">
                ${!v.standard && stdIdx >= 0 ? html`<button className="btn btn-sm" onClick=${() => setIdx(stdIdx)}>教本の形を見る</button>` : null}
                ${isPick || !isShown
                  ? html`<button className=${cx('btn btn-sm', isPick ? 'btn-ghost' : 'btn-primary')} onClick=${() => togglePick(v)}>
                      ${isPick ? 'いつもの形をやめる' : 'いつもこの形で出す'}
                    </button>`
                  : null}
              </div>`
            : null}`
        : null}
      ${v ? html`<p className="muted small center">上が1弦・下が6弦。数字は指（1=人差し指 … 4=小指、T=親指）。○は開放弦、×は鳴らさない弦。</p>` : html`<p className="muted center">この形の図は用意できませんでした。</p>`}
    </div>`;
  } else if (name) {
    const pv = pianoVoicing(name, idx);
    const ch = parseChord(name);
    const spelled = spelledNamer(name, noteStyle);
    const nameOf = (m) => (spelled && spelled(m)) || (noteStyle === 'letter' ? pretty(noteName(m, flat)) : solfege(m, flat));
    const notes = pv ? pv.right.map(nameOf) : [];
    const bassName = pv ? nameOf(pv.left) : '';
    body = html`<div className="chord-detail">
      ${pv
        ? html`<div className="chord-detail-staff"><${StaffDiagram} name=${name} width=${120} big=${true} /></div>
            <${PianoKeyboard} right=${pv.right} left=${pv.left} noteStyle=${noteStyle} flat=${flat} nameOf=${nameOf} />
            <div className="piano-legend">
              <div><span className="dot dot-right"></span>右手 <b>${notes.join('・')}</b></div>
              <div><span className="dot dot-left"></span>左手 <b>${bassName}</b>${ch && ch.bass != null ? '（分数コードの下の音）' : '（ルート）'}</div>
              <div className="muted small">構成音: ${pv.labels.join(' ・ ')}</div>
            </div>
            ${pv.inversions > 1
              ? html`<div className="row-gap center">
                  <${Segmented}
                    label="転回形"
                    size="sm"
                    value=${idx % pv.inversions}
                    onChange=${setIdx}
                    options=${Array.from({ length: pv.inversions }, (_, k) => ({ value: k, label: k === 0 ? '基本形' : `第${k}転回` }))}
                  />
                </div>`
              : null}`
        : html`<p className="muted center">このコードは図にできませんでした。</p>`}
    </div>`;
  }
  const title = name ? pretty(name) : '';
  return html`<${Sheet} open=${!!tap} onClose=${onClose} title=${title} heading=${name ? html`<span className="sheet-chord-title"><${ChordText} name=${title} /></span>` : null}>
    ${instrument === 'guitar' && snd && snd !== (plain || name) ? html`<p className="panel-note center">実際に鳴る音は <b>${pretty(snd)}</b></p>` : null}
    ${body}
  </${Sheet}>`;
}
