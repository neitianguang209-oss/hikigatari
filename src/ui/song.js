// 曲の画面: 譜面表示・楽器切り替え・カポ/キー/テンポ・自動スクロール・コード図
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, StarIcon, PlayIcon, GuitarIcon, PianoIcon } from './icons.js';
import { Sheet, Segmented, Stepper, Switch, Spinner, Artwork, ChordText, toast } from './common.js';
import { GuitarDiagram, GuitarChordCard, PianoKeyboard, StaffDiagram, PianoChordCard, chosenVoicing } from './diagrams.js';
import { useAutoScroll, glideTo, glideHeading, timelineBeats, timelineOf, timeAtBeat } from './autoscroll.js';
import { useSongMusic, MusicDock, MusicPanel, loadTiming } from './music.js';
import { KeyHear } from './keyhear.js';
import { useOwnAudio, decodeOwn, mb, CLOUD_MAX } from './ownaudio.js';
import { findClipIn } from '../music/hook.js';
import { markUsed } from '../lib/mediastore.js';
import { segStart, tapBar } from '../music/timing.js';
import { listenVoice, refLines, alignRecording } from '../music/voice.js';
import { detectTempo, decodeAudio, toMonoHQ } from '../music/earcopy.js';
import { sheetFromFetched } from '../music/sources.js';
import { krcToSynced, krcCandidates } from '../lib/lyrics.js';
import { TunerSheet, prepareTuner } from './tuner.js';
import { audioCtx, holdPlayback, releasePlayback, click as clickSound } from '../lib/sound.js';
import { parseSheet, chordStats } from '../music/sheet.js';
import { parseChord, chordName, pretty, parseKey, detectKey, keyName, shiftKey, keyPrefersFlat, solfege, noteName } from '../music/chord.js';
import { rankCapos, shapeName, easyName, guitarVoicings, standardVoicing, planVoicings, voicingDifficulty, difficultyLabel, fingerSteps, pressTips, nearChords } from '../music/guitar.js';
import { pianoVoicing, spelledNamer } from '../music/piano.js';
import { detectModulation } from '../music/modulation.js';
import { lib, useSong, media, local } from '../lib/store.js';
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
        // サイトごとの書き方(カポつきの形・コードの行+歌詞の行・コードの時刻つきデータ)を、ふつうの譜面にそろえる
        const conv = await sheetFromFetched(r, {
          krc: async () => krcToSynced((await api('lyrics_krc', { title: cur.title, artist: cur.artist || '', durationMs: cur.durationMs || 0 })).lines),
          krcs: () => krcCandidates({ title: cur.title, artist: cur.artist || '', durationMs: cur.durationMs || 0 }),
        });
        const parsed = parseSheet(conv.text);
        if (!parsed.lines.some((l) => l.segs && l.segs.some((s) => s.c))) throw Object.assign(new Error('譜面にコードが見つかりませんでした'), { status: 404 });
        await lib.patch(id, {
          sheet: { text: conv.text, key: conv.key || parsed.meta.key || null, bpm: conv.bpm || parsed.meta.bpm || null, beatsPerBar: parsed.meta.beatsPerBar || 4, fetchedAt: r.fetchedAt || new Date().toISOString() },
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

// onMusic: 「原曲」ボタン = 曲と合わせる(原曲の動画をアプリの中で流す)の入り切り。譜面を読み込む前は Apple Music を開く(onApple)
function TopBar({ song, onMore, onApple, onMusic = null, musicOn = false }) {
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
    ${onMusic
      ? html`<button className=${cx('icon-btn apple-btn', musicOn && 'is-on')} onClick=${onMusic} aria-pressed=${musicOn} aria-label=${musicOn ? '曲と合わせるのをやめる' : '原曲を流して、曲と合わせる'} title=${musicOn ? '曲と合わせるのをやめる' : '原曲を流して、曲と合わせる'}>
          <${Icon} name="music" size=${17} /><span>原曲</span>
        </button>`
      : onApple
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

  // 画面に出すコード名(ずれごと)。ギターはカポをつけて押さえる形、ピアノは実際に鳴る音。
  // 押さえ方のパネルで「この曲ではこれで弾く」を選んだコード(st.subs: 形の名前 → 置き換えるコード)は、かんたんモードより優先
  const subs = instrument === 'guitar' ? st.subs || {} : {};
  const nameMaps = (withEasy, withSubs = true) => {
    const out = new Map();
    for (const k of shiftSet) {
      const c = segCapo.get(k);
      const sk = shiftKey(soundKey, k - c);
      const m = new Map();
      for (const t of stats.order) {
        const snd = sounding.get(t);
        if (instrument !== 'guitar') {
          m.set(t, snd);
          continue;
        }
        const shaped = shapeName(snd, c, sk, false);
        m.set(t, (withSubs && subs[shaped]) || (withEasy ? easyName(shaped, sk) : shaped));
      }
      out.set(k, m);
    }
    return out;
  };
  const subsKey = JSON.stringify(subs);
  const displays = useMemo(() => nameMaps(easy), [shiftSet, segCapo, stats, sounding, instrument, easy, soundKey.pc, soundKey.minor, subsKey]);
  const display = displays.get(0) || displays.values().next().value;
  // かんたんモード・自分で置き換える前の形の名前(置き換えたコードの説明に使う)
  const plainDisplays = useMemo(() => (instrument === 'guitar' ? nameMaps(false, false) : new Map()), [shiftSet, segCapo, stats, sounding, instrument, soundKey.pc, soundKey.minor]);

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
  const hasBars = parsed.lines.some((l) => l.bars);
  const barsPerLine = st.barsPerLine ?? prefs.barsPerLine; // 0 = 自動で見積もる
  const fitSong = st.fitSong ?? true;
  const speed = st.speed ?? 1; // 自分で決めるスクロールの速さの微調整(曲ごと)
  // 拍子: 譜面の {time:3/4} などから。曲ごとに選び直せる(メトロノームの強拍・カウント・1小節の長さが変わる)
  const sheetBpb = parsed.meta.beatsPerBar || song.sheet.beatsPerBar || 4;
  const beatsPerBar = st.beatsPerBar || sheetBpb;
  // テンポ: 自分で決めた値 → 譜面に書かれた値 → 原曲の試聴から測った値 → 曲の長さからの見積もり の順。
  // 試聴から測った値は倍・半分を取り違えることがあるので、曲の長さ(譜面の拍数 ÷ 曲の長さ)にいちばん近いものを選ぶ
  const durSec = song.durationMs ? song.durationMs / 1000 : null;
  const lenBpmAt = (b) => (durSec ? (timelineBeats(parsed.lines, barsPerLine, beatsPerBar, b) * 60) / durSec : null);
  const autoBpm = useMemo(() => {
    const x = song.tempo?.bpm;
    if (!x) return null;
    const len = lenBpmAt(x);
    if (!len) return Math.round(x);
    const cands = [x / 2, x, x * 2].filter((c) => c >= 45 && c <= 240);
    return Math.round(cands.reduce((a, c) => (Math.abs(Math.log(c / len)) < Math.abs(Math.log(a / len)) ? c : a), cands[0] || x));
  }, [song.tempo?.bpm, parsed, barsPerLine, beatsPerBar, durSec]);
  const lenBpm = useMemo(() => {
    const b = lenBpmAt(100);
    return b ? Math.round(Math.max(50, Math.min(200, lenBpmAt(b) || b))) : null;
  }, [parsed, barsPerLine, beatsPerBar, durSec]);
  const bpmFrom = st.bpm ? 'user' : sheetBpm ? 'sheet' : autoBpm ? 'auto' : lenBpm ? 'len' : 'guess';
  const bpm = st.bpm || sheetBpm || autoBpm || lenBpm || 90;
  const bpmKnown = bpmFrom === 'user' || bpmFrom === 'sheet';

  // ---- 自分の歌(動画・録音)に合わせる
  // rec: この端末に置いた録音 / recOn: 録音に合わせて流すか(曲ごとに覚える)
  // 合わせ方: 録音から歌っている区間を聴き取り(voice)、原曲の歌詞の時刻(recTiming)と重ねて、行ごとの時刻を自動で決める(music/voice.js)。
  // ずれていたら「合わせる」→ いま歌っている歌詞を1回タップ(目印 = fix.pins。録音ごとに settings.recSync に覚える)
  const [rec, setRec] = useState(null); // { url, blob, name, type, isVideo, fp, size, saved }
  const videoRef = useRef(null);
  const recFileRef = useRef(null);
  const recOn = !!rec && (st.recOn ?? true) && !st.ytOn;
  const [recSpeed, setRecSpeed] = useState(1);
  const [recVideo, setRecVideo] = useState('small'); // small | big | hidden
  const [recTime, setRecTime] = useState({ t: 0, d: 0 });
  const [voice, setVoice] = useState(null); // 聴き取った歌声 { fp, dur, segs, range, frac } か { fp, failed }。まだなら null
  const [recTiming, setRecTiming] = useState(null); // 原曲の歌詞の時刻(曲と合わせるのと同じもの)。調べている間は null
  const [recSyncing, setRecSyncing] = useState(false);
  const [recNote, setRecNote] = useState(0); // 合わせた直後だけ出す「少しだけ直すなら 早く・遅く」
  const listening = useRef(null);
  const justListened = useRef(false);
  useEffect(() => {
    let url = null;
    let alive = true;
    media.get(song.id).then(async (r) => {
      if (!alive || !r?.blob) return;
      const v = await local.get('voice:' + song.id);
      if (!alive) return;
      url = URL.createObjectURL(r.blob);
      setVoice(v?.fp === r.fp && v.v === 1 ? v : null);
      setRec({ url, blob: r.blob, name: r.name, type: r.type, isVideo: r.isVideo, fp: r.fp, size: r.size, saved: true });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [song.id]);
  // 録音を使った印(使わなくなった録音だけを自動で片づけるため)
  useEffect(() => {
    if (recOn && rec?.saved) markUsed(song.id);
  }, [recOn, rec?.fp]);
  // 録音から歌声を聴き取る(録音ごとに1回。結果は手元に置く)
  const recFp = useRef(null);
  recFp.current = rec?.fp || null;
  useEffect(() => () => (recFp.current = null), []);
  useEffect(() => {
    if (!recOn || !rec?.blob || voice?.fp === rec.fp || listening.current === rec.fp) return;
    const fp = rec.fp;
    listening.current = fp;
    listenVoice(rec.blob)
      .catch(() => ({ v: 1, failed: 'decode' }))
      .then((v) => {
        const got = { ...v, fp };
        local.set('voice:' + song.id, got);
        if (listening.current === fp) listening.current = null;
        // 聴き取っている間に、別の録音に替えた・この曲を閉じたときは、控えるだけ
        if (recFp.current !== fp) return;
        justListened.current = true;
        setVoice(got);
      });
  }, [recOn, rec?.fp, voice?.fp]);
  const recSig = `${song.source}:${song.sourceId || ''}:${song.sheet.text.length}`;
  useEffect(() => {
    if (!recOn) return;
    let alive = true;
    setRecTiming(null);
    loadTiming(song, parsed.lines, { voice: true })
      .catch(() => ({ none: true, soft: true }))
      .then((tm) => alive && setRecTiming(tm));
    return () => {
      alive = false;
    };
  }, [recOn, song.id, recSig]);
  // 録音ごとの合わせ方 { pins: [{ line, pos, t }], off: 全体の微調整(秒) }。前の版は [{ line, t }](行の頭の時刻)の並びだった
  const fix = useMemo(() => {
    const v = rec ? st.recSync?.[rec.fp] : null;
    return Array.isArray(v) ? { pins: v.map((a) => ({ line: a.line, pos: 0, t: a.t })), off: 0 } : { pins: v?.pins || [], off: v?.off || 0 };
  }, [rec?.fp, st.recSync]);
  const recTl = useMemo(() => timelineOf(parsed.lines, barsPerLine, beatsPerBar, bpm), [parsed, barsPerLine, beatsPerBar, bpm]);
  const recBusy = recOn && (!recTiming || voice?.fp !== rec.fp);
  // 合わせた結果(行ごとの時刻)。重ねる計算は0.5秒ほどかかるので、結果を手元に置いて、次に開いたときはそのまま使う
  const [recFit, setRecFit] = useState(null);
  const fitSig = recOn && !recBusy ? [rec.fp, voice.dur || 0, recTiming.sig || 'none', recTiming.at || 0, bpm, barsPerLine, beatsPerBar, JSON.stringify(fix.pins)].join('|') : null;
  useEffect(() => {
    if (!fitSig) {
      setRecFit(null);
      return;
    }
    let alive = true;
    (async () => {
      const kept = await local.get('fit:' + song.id);
      if (!alive) return;
      if (kept?.sig === fitSig) {
        setRecFit(kept.fit);
        return;
      }
      // 画面を先に書きかえてから計算する
      await new Promise((r) => setTimeout(r, 30));
      if (!alive) return;
      const ref = refLines({ lines: parsed.lines, starts: recTl.starts, durs: recTl.durs, bps: bpm / 60, timing: recTiming.lines || null, act: recTiming.act || null });
      const fit = alignRecording({ lines: parsed.lines, ...ref, voice: voice.segs ? voice : null, pins: fix.pins });
      local.set('fit:' + song.id, { sig: fitSig, fit });
      setRecFit(fit);
    })();
    return () => {
      alive = false;
    };
  }, [fitSig]);
  const recAnchors = useMemo(() => (recFit?.anchors || []).map((a) => ({ line: a.line, t: a.t + fix.off })), [recFit, fix.off]);
  const recClock = recOn
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
        sync: recSyncing,
      }
    : null;
  // 聴き取りが終わったら、どう合わせたかを知らせる
  useEffect(() => {
    if (!recFit || !justListened.current) return;
    justListened.current = false;
    if (recFit.mode === 'voice')
      toast(recFit.good ? `歌声を聴き取って、譜面を合わせました（${recFit.matched}行）。▶ で確かめてください` : '歌声を聴き取りました。▶ で流して、ずれていたら「合わせる」を押してください', { ms: 4500 });
    else if (recFit.mode === 'start') toast('歌い出しを合わせました。ずれてきたら、その場所で「合わせる」を押してください', { ms: 4500 });
  }, [recFit]);
  useEffect(() => {
    if (!recNote) return;
    const t = setTimeout(() => setRecNote(0), 12000);
    return () => clearTimeout(t);
  }, [recNote]);

  // ---- 曲と合わせる(原曲の動画をアプリの中で流す。歌詞やコードを押すと、そこから曲が流れる)
  const scrollApi = useRef(null);
  const totalBeats = useMemo(() => timelineBeats(parsed.lines, barsPerLine, beatsPerBar, bpm), [parsed, barsPerLine, beatsPerBar, bpm]);
  // 自分の音源(持っている原曲のファイル)。曲と合わせるで流すときに、この端末に無ければクラウドから取ってくる
  const own = useOwnAudio(song, { need: !!st.ytOn && !!st.own && st.musicSrc !== 'yt' });
  const music = useSongMusic({ song, st, setSt, lines: parsed.lines, bpm, totalBeats, scrollApi, own, semis: transpose, voice: prefs.voice || 'orig' });
  // 歌い始め(最初に歌う行)とサビの頭
  const textMarks = useMemo(() => songMarks(parsed.lines), [parsed]);
  // サビの場所: 譜面に書いてなければ、Apple の試聴(たいていサビ)が自分の音源のどこにあたるかを音で探す(曲と音源ごとに1回。手元に覚える)
  const [hookT, setHookT] = useState(null);
  const ownFp = own.rec?.fp || null;
  useEffect(() => {
    setHookT(null);
    if (textMarks.sure || !ownFp || !music.mine || !music.on) return;
    let alive = true;
    (async () => {
      const key = 'hook1:' + song.id;
      const saved = await local.get(key);
      if (saved?.fp === ownFp) {
        if (alive) setHookT(saved.t);
        return;
      }
      try {
        const it = await appleTrackOf(song);
        if (!it?.previewUrl) return;
        const [full, clip] = await Promise.all([decodeOwn(own.rec.blob, ownFp), (async () => decodeAudio(await (await fetch(it.previewUrl)).arrayBuffer()))()]);
        const hit = await findClipIn(full, clip);
        local.set(key, { fp: ownFp, t: hit?.t ?? null, at: Date.now() });
        if (alive) setHookT(hit?.t ?? null);
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [song.id, ownFp, music.mine, music.on, textMarks.sure]);
  const marks = useMemo(() => {
    if (hookT == null || !music.anchors.length) return textMarks;
    // 試聴の始まり(少し手前から始まることが多い)のすぐあとに歌い出す行
    const sung = new Set(parsed.lines.map((l, i) => (l.type === 'lyric' ? i : -1)).filter((i) => i >= 0));
    const a = music.anchors.find((x) => x.t >= hookT - 1 && sung.has(x.line));
    return a ? { ...textMarks, chorus: a.line } : textMarks;
  }, [textMarks, hookT, music.anchors]);
  const clock = music.clock || recClock;

  // スタート前のカウント(4・3・2・1)は、メトロノームを鳴らしているときだけ。鳴らしていないときは、押したらすぐ流れる
  const clickOn = !!(st.click ?? prefs.click);
  const scroll = useAutoScroll({ scrollRef, lines: parsed.lines, bpm, barsPerLine, beatsPerBar, countIn: prefs.countIn && clickOn, click: clickOn, durationMs: song.durationMs, fitSong, clock, clickVolume: prefs.clickVolume ?? 1, speed });
  scrollApi.current = scroll;
  // 原曲を流しに Apple Music へ。流れている譜面は止めておく(戻ってきたら ▶ で続きから)
  const onApple = () => {
    if (scroll.playing) scroll.stop();
    openAppleMusic(song);
  };
  // 上のバーの「原曲」: 曲と合わせるのを始める/やめる(曲ごとに覚える)。動画や合わせ方の設定は、下のバーの「曲」から
  const onMusic = () => music.toggle(!music.on);

  // 自分の音源のファイルを選んだ: この曲の原曲にする(この端末に置き、40MB までならクラウドにも置いて、ほかの端末でも流せるように)
  const ownFileRef = useRef(null);
  const pickOwn = () => ownFileRef.current?.click();
  const attachOwn = async (file) => {
    if (!file) return;
    scroll.stop();
    toast('音源を読み込んでいます…', { ms: 6000 });
    try {
      const m = await own.attach(file);
      const where = m.cloud ? 'ほかの端末でも使えるよう、クラウドにも置いています' : m.size > CLOUD_MAX ? `${mb(m.size)}あるので、この端末だけで使います` : 'この端末で使えます';
      const keep = getPrefs().mediaKeepDays ?? 30;
      toast(`音源を入れました（${mmssRec(m.dur)}）。歌詞を押すと、そこから流れます。${where}。使い終わったら「外す」で消せます${keep ? `（${keep}日使わないと自動で消えます）` : ''}`, { ms: 6500 });
      const songSec = song.durationMs ? song.durationMs / 1000 : 0;
      if (songSec && Math.abs(songSec - m.dur) > 20) toast(`原曲（${mmssRec(songSec)}）と長さがだいぶ違います。別の版（ライブ・短い版など）かもしれません`, { kind: 'error', ms: 6000 });
    } catch (e) {
      toast(
        e.code === 'big'
          ? 'ファイルが大きすぎます（音だけのファイル・400MBまで）'
          : e.code === 'short'
            ? '短すぎる音です。1曲まるごとのファイルを選んでください'
            : 'このファイルは読めませんでした（m4a・mp3・wav・aac などの音のファイルを選んでください）',
        { kind: 'error', ms: 5000 },
      );
    }
  };
  // キーのパネルから: 自分の音源を、このキーで流す(パネルを閉じて、いまの場所から)
  // from: 'start'(歌い始め) | 'chorus'(サビの頭) | 'bridge'(Cメロ) | null(止めたところから)。2秒手前から(前の部分の終わりから入れるように)
  // clip: その秒数だけ流して止める(30秒だけ聴く)
  const clipTimer = useRef(0);
  const playOwnFull = (from = null, { clip = 0 } = {}) => {
    audioCtx(); // iPhone は押した瞬間に音の出口を開ける
    setPanel(null);
    clearTimeout(clipTimer.current);
    const line = from === 'start' ? marks.start : from === 'chorus' ? marks.chorus : from === 'bridge' ? marks.bridge : null;
    const go = () => {
      if (line != null) playLineFrom(line);
      else if (!scroll.playing) scroll.start();
      if (clip) clipTimer.current = setTimeout(() => scroll.stop(), ((clip + 2) / (music.dock.speed || 1)) * 1000);
    };
    if (music.on && music.mine && music.clock) return go();
    if (!music.on) music.toggle(true);
    else music.panel.setSource('own');
    pendingStart.current = { go };
  };
  // 自分で止めた・ほかの場所を押したら、30秒の止めは取り消す
  useEffect(() => {
    if (!scroll.playing) clearTimeout(clipTimer.current);
  }, [scroll.playing]);
  const playLineFrom = (i) => {
    if (scroll.starts[i] == null) return scroll.start();
    flashLine(i);
    music.tap({ i, k: 0, pos: 0, onChord: false }, scroll.starts[i], { lead: 2 });
  };
  const pendingStart = useRef(null);
  useEffect(() => {
    const p = pendingStart.current;
    if (p && music.mine && music.clock) {
      pendingStart.current = null;
      p.go();
    }
  }, [music.mine, !!music.clock]);

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
    setVoice(null);
    setRecSyncing(false);
    setRecNote(0);
    setRec({ url: URL.createObjectURL(file), blob: file, name: file.name, type: file.type, isVideo, fp, size: file.size, saved });
    setRecVideo('small');
    setSt({ recOn: true, ytOn: false });
    toast(saved ? '録音をこの端末に保存しました。歌声を聴き取って、譜面を合わせます…' : '録音が大きいので、今回だけ使います（次に開いたら選び直してください）。歌声を聴き取ります…', { ms: 3500 });
  };
  const removeRec = async () => {
    if (!confirm('この曲の録音を、この端末から消しますか？（合わせた場所も消えます）')) return;
    scroll.stop();
    await media.del(song.id);
    local.set('voice:' + song.id, null);
    local.set('fit:' + song.id, null);
    if (rec?.url) URL.revokeObjectURL(rec.url);
    const sync = { ...(st.recSync || {}) };
    if (rec) delete sync[rec.fp];
    setSt({ recSync: sync, recOn: false });
    setRec(null);
    setVoice(null);
    setRecSyncing(false);
    setPanel(null);
  };
  const setRecOn = (on) => {
    scroll.stop();
    setRecSyncing(false);
    setSt(on ? { recOn: true, ytOn: false } : { recOn: false });
  };
  const saveFix = (next) => {
    const all = { ...(st.recSync || {}) };
    all[rec.fp] = next;
    // 録音は曲ごとに3つぶんまで覚える
    const keys = Object.keys(all);
    if (keys.length > 3) for (const k of keys.slice(0, keys.length - 3)) if (k !== rec.fp) delete all[k];
    setSt({ recSync: all });
  };
  // 合わせる: いま流れているところが、押した歌詞の行。同じ行・すぐ近くの目印は置きかえ、前後と順番が食い違う目印は外す
  const addPin = (hit) => {
    const i = hit.i;
    const t = +Math.max(0, (videoRef.current?.currentTime || 0) - 0.2 * recSpeed).toFixed(2);
    const pins = fix.pins.filter((p) => p.line !== i && Math.abs(p.t - t) > 4 && ((p.line < i && p.t < t) || (p.line > i && p.t > t)));
    pins.push({ line: i, pos: hit.pos || 0, t });
    pins.sort((a, b) => a.t - b.t);
    saveFix({ pins: pins.slice(-16), off: fix.off });
    setRecSyncing(false);
    setRecNote(Date.now());
  };
  // 全体を少しだけ早く・遅く
  const nudgeRec = (d) => {
    saveFix({ pins: fix.pins, off: Math.round((fix.off + d) * 100) / 100 });
    setRecNote(Date.now());
  };
  const startRecSync = () => {
    setRecNote(0);
    setRecSyncing(true);
    if (!scroll.playing) scroll.start();
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
  // 流すのをやめたら、「合わせる」もやめる
  useEffect(() => {
    if (!scroll.playing && recSyncing) setRecSyncing(false);
  }, [scroll.playing]);

  // 曲の長さ(自動スクロールを曲に合わせるのに使う)と Apple Music の曲のページが分からない曲は、Apple の曲データから一度だけ探す
  useEffect(() => {
    const needLen = !song.durationMs && !song.durationTried;
    const needUrl = !song.appleUrl && !song.appleTried;
    if ((!needLen && !needUrl) || !song.title) return;
    let alive = true;
    (async () => {
      try {
        const hit = await appleTrackOf(song);
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

  // テンポの分からない曲(U-FRET の譜面など)は、原曲の試聴(30秒)からテンポを測る。
  // 1曲に1回だけ(結果は曲に覚えて、ほかの端末にも同期)。測れなかったら3日後にもう一度
  useEffect(() => {
    if (st.bpm || sheetBpm || song.tempo || !song.title) return;
    if (song.tempoTriedAt && Date.now() - song.tempoTriedAt < 3 * 864e5) return;
    let alive = true;
    (async () => {
      let tempo = null;
      try {
        const it = await appleTrackOf(song);
        if (it?.previewUrl) {
          const buf = await decodeAudio(await (await fetch(it.previewUrl)).arrayBuffer());
          if (!alive) return;
          const t = await detectTempo(await toMonoHQ(buf));
          if (t && t.conf >= 1.4) tempo = { bpm: t.bpm, conf: t.conf, from: 'preview' };
        }
      } catch {}
      if (!alive) return;
      await lib.patch(song.id, tempo ? { tempo, tempoTriedAt: Date.now() } : { tempoTriedAt: Date.now() });
    })();
    return () => {
      alive = false;
    };
  }, [song.id, sheetBpm, !!st.bpm]);

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
        const p = Math.max(50, Math.min(150, Math.round(speed * 100) + (up ? 2 : -2)));
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
      if (instrument === 'guitar')
        for (const [k, d] of displays) {
          for (const [t, n] of d) if (n === name) { plain = plainDisplays.get(k)?.get(t) || null; break; }
          if (plain) break;
        }
      return { name, snd: null, plain };
    }
    const k = shifts[chordTap.line] ?? 0;
    return { name: displays.get(k)?.get(chordTap.token) || chordTap.token, snd: sounding.get(chordTap.token), plain: plainDisplays.get(k)?.get(chordTap.token) || null };
  }, [chordTap, displays, plainDisplays, sounding, easy, modulation]);
  // 押さえ方のパネルの「この曲ではこれで弾く」/「元に戻す」(to = null)
  const onSub = (from, to) => {
    const next = { ...subs };
    if (to) next[from] = to;
    else delete next[from];
    setSt({ subs: next });
    if (chordTap?.display) setChordTap({ display: to || from });
    // 置き換えた形と「元に戻す」が見えるよう、パネルを上へ
    document.querySelectorAll('.sheet, .sheet-body').forEach((el) => el.scrollTo?.({ top: 0, behavior: 'smooth' }));
    toast(to ? `この曲では ${pretty(from)} を ${pretty(to)} で弾きます` : `${pretty(from)} に戻しました`);
  };
  // 押した高さにある行(歌詞・コードの行)。行と行のあいだ・行の右の空いたところを押しても、いちばん近い行
  const lineAtY = (y) => {
    const sc = scrollRef.current;
    if (!sc) return null;
    let best = null;
    let bestD = Infinity;
    for (const el of sc.querySelectorAll('.ln-lyric[data-i], .ln-chords[data-i]')) {
      const r = el.getBoundingClientRect();
      if (r.top > y + 200) break;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bestD) {
        bestD = d;
        best = +el.dataset.i;
      }
    }
    return bestD <= 80 ? best : null;
  };
  // 「ここから流す」の印: 押した行を少しのあいだ光らせる(画面の上のほうの行は真ん中まで動けないので、どこから始まったか分かるように)
  const flashLine = (i) => {
    const el = scrollRef.current?.querySelector(`[data-i="${i}"]`);
    if (!el) return;
    el.classList.remove('is-start');
    void el.offsetWidth;
    el.classList.add('is-start');
    setTimeout(() => el.classList.remove('is-start'), 1400);
  };
  // 押した場所: 行 i・行の中のかたまり k・文字の位置 pos(コードを押したら onChord)。行のあいだや横の空きは、いちばん近い行の頭
  const hitAt = (e) => {
    const ln = e.target.closest?.('.ln-lyric[data-i], .ln-chords[data-i]');
    const seg = ln && e.target.closest('.seg');
    if (!seg) {
      const i = lineAtY(e.clientY);
      return i == null ? null : { i, k: 0, pos: 0, onChord: false };
    }
    const i = +ln.dataset.i;
    const line = parsed.lines[i];
    const k = Math.max(0, Array.prototype.indexOf.call(ln.children, seg));
    const onChord = !!e.target.closest('.chord');
    let pos = line.type === 'lyric' ? segStart(line, k) : 0;
    const ly = !onChord && line.type === 'lyric' && e.target.closest('.ly');
    if (ly) pos += charAt(ly, e.clientX, e.clientY);
    return { i, k, pos, onChord };
  };
  // 押した: 区間リピートの区間選び / 自分の歌に「合わせる」目印 / そこから流す(流していればそこへ移る)。
  // 曲と合わせているときは、押した文字・コードの時刻から曲が流れる。自分の歌に合わせているときは、押したところから録音が流れる。
  // BPM で流すときは、押したところを含む小節の頭から(メトロノームを鳴らしていれば 4・3・2・1 のあと、鳴らしていなければすぐ)
  const tapLine = (hit) => {
    clearTimeout(clipTimer.current); // 30秒だけ聴いている途中に押したら、そのまま流しつづける
    const i = hit.i;
    if (loopSel) {
      if (loopSel.step === 'from') setLoopSel({ step: 'to', from: i });
      else {
        scroll.setLoop(loopSel.from, i);
        setLoopSel(null);
        toast('この区間をくり返します');
      }
      return;
    }
    if (prefs.tapToStart === false && !music.syncing && !recSyncing) return;
    if (scroll.starts[i] == null || !scroll.durs[i]) return;
    // 自分の歌に「合わせる」: いま流れているところが、押した歌詞
    if (recOn && recSyncing) {
      flashLine(i);
      addPin(hit);
      return;
    }
    const beat = scroll.starts[i] + tapBar(parsed.lines[i], hit, scroll.durs[i] / beatsPerBar) * beatsPerBar;
    if (music.on) {
      if (!music.syncing) {
        if (scroll.loop && (i < scroll.loop.from || i > scroll.loop.to)) scroll.setLoop(null);
        flashLine(i);
      }
      music.tap(hit, beat);
      return;
    }
    // 区間リピート中に区間の外を押したら、リピートはやめてそこから
    if (scroll.loop && (i < scroll.loop.from || i > scroll.loop.to)) scroll.setLoop(null);
    flashLine(i);
    // 自分の歌: 押したところから録音が流れる(出だしが切れないよう、ほんの少し手前から)
    scroll.playFrom({ beat, time: recOn && recAnchors.length ? Math.max(0, timeAtBeat(beat, recAnchors, recTl.starts, bpm / 60) - 0.12) : null });
  };
  const onSheetTap = (e) => {
    // 見出しなどのボタンはそれぞれの動き。コード名は、歌詞と同じ「そこから流す」(押さえ方は長押し)
    const btn = e.target.closest('button, a, input, select, textarea, .song-head, .strip-top, .mod-mark, .ear-banner, .sheet-end');
    if (btn && !btn.classList.contains('chord')) return;
    const hit = hitAt(e);
    if (!hit) return;
    if (hit.onChord && !loopSel && !prefs.chordHoldSeen) {
      setPrefs({ chordHoldSeen: true });
      toast('コードの押さえ方は、コードを長押しすると見られます', { ms: 4200 });
    }
    tapLine(hit);
  };
  // 見出し(サビ・Aメロ など)をタップ: 区間選び中ならその段落まるごとをくり返す / それ以外は、その段落の頭の行を押したのと同じ
  const hasLabels = useMemo(() => parsed.lines.some((l) => l.type === 'label'), [parsed]);
  const labelTap = useRef(null);
  labelTap.current = (i) => {
    const r = sectionOf(parsed.lines, i);
    if (!r) return;
    if (loopSel) {
      scroll.setLoop(r.from, r.to);
      setLoopSel(null);
      toast(`「${parsed.lines[i].text}」をくり返します`);
    } else if (prefs.tapToStart === false && !scroll.playing) {
      const sc = scrollRef.current;
      const el = sc?.querySelector(`[data-i="${i}"]`);
      if (el) glideTo(sc, sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8);
    } else tapLine({ i: r.from, k: 0, pos: 0, onChord: false });
  };
  const onLabelTap = useCallback((i) => labelTap.current(i), []);
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

  // 自分の歌に合わせているとき、録音のつまみの上に出す一言
  const recStatus = !recOn
    ? null
    : recSyncing
      ? { kind: 'sync', text: 'いま歌っている歌詞を、1回タップしてください（その場所に合わせます）' }
      : recBusy || !recFit
        ? { kind: 'busy', text: voice?.fp !== rec.fp ? '歌声を聴き取っています…' : !recTiming ? '原曲の歌詞の時刻を調べています…' : '譜面を合わせています…' }
        : recNote
          ? { kind: 'tip', text: 'ここに合わせました。少しだけ直すなら →', nudge: true }
          : fix.pins.length || (recFit?.mode === 'voice' && recFit.good)
            ? null
            : recFit?.mode === 'voice' || recFit?.mode === 'start'
              ? { kind: 'warn', text: 'ずれているところがあったら、▶ で流しながら「合わせる」を押して、いま歌っている歌詞を1回タップしてください' }
              : { kind: 'warn', text: '▶ で流しながら「合わせる」を押して、いま歌っている歌詞を1回タップしてください' };

  const capoLabel = instrument === 'guitar' ? (capo === 0 ? 'カポなし' : `カポ ${capo}`) : null;
  const flatForShape = keyPrefersFlat(shapeKey);

  return html`<div className=${cx('song', 'is-' + instrument, inline && 'has-inline', !prefs.showCurrent && 'no-current')}>
    <${TopBar} song=${song} onMore=${() => setPanel('more')} onApple=${onApple} onMusic=${onMusic} musicOn=${music.on} />
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
                原曲キー ${keyName(origKey)}${transpose ? ` → ${keyName(soundKey)}` : ''}${hasMod ? ` ・ 転調あり${follow ? '（カポを付けかえ）' : ''}` : ''} ・ ♩=${bpm}${bpmFrom === 'auto' || bpmFrom === 'len' ? '(推定)' : bpmKnown ? '' : '(仮)'} ・ ${sourceName(song.source)}${song.edited ? '(編集済み)' : ''}
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
            onLabel=${onLabelTap}
            loop=${loopRange}
            selecting=${!!loopSel}
            picks=${picks}
            chordJump=${prefs.tapToStart !== false}
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
          status=${recStatus}
          syncing=${recSyncing}
          onSync=${startRecSync}
          onSyncEnd=${() => setRecSyncing(false)}
          onNudge=${nudgeRec}
          speed=${recSpeed}
          setSpeed=${setRecSpeed}
          onSeek=${(t) => {
            if (videoRef.current) videoRef.current.currentTime = t;
          }}
        />`
      : null}
    <input ref=${recFileRef} type="file" accept="video/*,audio/*" hidden onChange=${(e) => { attachRec(e.target.files?.[0]); e.target.value = ''; }} />
    <input ref=${ownFileRef} type="file" accept="audio/*,.m4a,.mp3,.aac,.wav,.flac,.aif,.aiff,video/mp4,video/quicktime" hidden onChange=${(e) => { attachOwn(e.target.files?.[0]); e.target.value = ''; }} />
    ${music.on ? html`<${MusicDock} ...${music.dock} onPanel=${() => setPanel('music')} onPickOwn=${pickOwn} onRetryOwn=${own.download} onKey=${() => setPanel('key')} />` : null}

    <${Transport}
      rec=${recOn}
      onRec=${() => setPanel('rec')}
      music=${music.on}
      onMusic=${() => setPanel('music')}
      scroll=${scroll}
      bpm=${bpm}
      bpmKnown=${bpmFrom !== 'guess'}
      speed=${speed}
      onSpeed=${(d) => {
        const p = Math.max(50, Math.min(150, Math.round(speed * 100) + d));
        setSt({ speed: p === 100 ? null : p / 100 });
      }}
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
    <${KeyPanel}
      open=${panel === 'key'}
      onClose=${() => setPanel(null)}
      transpose=${transpose}
      origKey=${origKey}
      setSt=${setSt}
      instrument=${instrument}
      song=${song}
      own=${own}
      mine=${music.on && music.mine}
      marks=${marks}
      voice=${prefs.voice || 'orig'}
      setVoice=${(v) => setPrefs({ voice: v })}
      onPickOwn=${() => { setPanel(null); pickOwn(); }}
      onUseOwn=${() => playOwnFull(null)}
      onPlayFull=${playOwnFull}
      onBeforePreview=${() => scroll.playing && scroll.stop()}
      onApple=${onApple}
    />
    <${TempoPanel}
      open=${panel === 'tempo'}
      onClose=${() => setPanel(null)}
      bpm=${bpm}
      origBpm=${sheetBpm}
      bpmFrom=${bpmFrom}
      autoTempo=${autoBpm || lenBpm}
      setSt=${setSt}
      hasBars=${hasBars}
      barsPerLine=${barsPerLine}
      custom=${!!st.bpm}
      fit=${scroll.fit}
      fitSong=${fitSong}
      durationMs=${song.durationMs}
      beatsPerBar=${beatsPerBar}
      sheetBpb=${sheetBpb}
      meter=${st.beatsPerBar || 0}
      clickVolume=${prefs.clickVolume ?? 1}
      setClickVolume=${(v) => setPrefs({ clickVolume: v })}
      clickOn=${!!(st.click ?? prefs.click)}
      speed=${speed}
      showCurrent=${!!prefs.showCurrent}
      setShowCurrent=${(v) => setPrefs({ showCurrent: v })}
    />
    <${TextPanel} open=${panel === 'text'} onClose=${() => setPanel(null)} fontScale=${fontScale} setSt=${setSt} />
    <${MorePanel}
      open=${panel === 'more'}
      onClose=${() => setPanel(null)}
      song=${song}
      reload=${reload}
      onText=${() => setPanel('text')}
      onTuner=${() => { prepareTuner(); scroll.stop(); setPanel('tuner'); }}
      onApple=${onApple}
      rec=${rec}
      recOn=${recOn}
      onPickRec=${() => { setPanel(null); recFileRef.current?.click(); }}
      onRecOn=${() => { setRecOn(true); setPanel(null); }}
      onRecPanel=${() => setPanel('rec')}
      musicOn=${music.on}
      onMusic=${() => { if (music.on) setPanel('music'); else { setPanel(null); music.toggle(true); } }}
    />
    <${MusicPanel} open=${panel === 'music'} onClose=${() => setPanel(null)} ...${music.panel} onPickOwn=${pickOwn} onOff=${() => music.toggle(false)} onApple=${onApple} />
    <${RecPanel}
      open=${panel === 'rec'}
      onClose=${() => setPanel(null)}
      rec=${rec}
      recOn=${recOn}
      fit=${recFit}
      voice=${voice}
      busy=${recBusy || !recFit}
      pins=${fix.pins.length}
      off=${fix.off}
      onSync=${() => { setPanel(null); startRecSync(); }}
      onNudge=${nudgeRec}
      speed=${recSpeed}
      setSpeed=${setRecSpeed}
      video=${recVideo}
      setVideo=${setRecVideo}
      onPick=${() => recFileRef.current?.click()}
      onReset=${() => {
        saveFix({ pins: [], off: 0 });
        toast('押して合わせた場所を消して、自動の合わせ方に戻しました');
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
      subs=${subs}
      onSub=${onSub}
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

// 歌詞(.ly)の中で、押した場所にいちばん近い文字が何文字目か
function charAt(ly, x, y) {
  const node = ly.firstChild;
  if (!node || node.nodeType !== 3) return 0;
  const text = node.textContent;
  const r = document.createRange();
  let best = 0;
  let bestD = Infinity;
  let n = 0;
  for (let o = 0; o < text.length; n++) {
    const step = text.codePointAt(o) > 0xffff ? 2 : 1;
    r.setStart(node, o);
    r.setEnd(node, o + step);
    o += step;
    const b = r.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    // 折り返した行では、同じ段の文字を優先する(上下のずれを重く数える)
    const d = (x < b.left ? b.left - x : x > b.right ? x - b.right : 0) + (y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0) * 3;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
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

// chordJump: コード名を押すと、歌詞と同じように「そこから流す」(押さえ方は長押し)。false なら、押すと押さえ方
const SheetLines = memo(function SheetLines({ lines, display, displays = null, shifts = null, marks = null, onMark = null, instrument, inline, showBars, onChord, onLabel = null, loop = null, selecting = false, picks = null, chordJump = false }) {
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
      const row = html`<${Line} key=${i} i=${i} line=${l} display=${d} instrument=${instrument} inline=${inline} showBars=${showBars} onChord=${onChord} onLabel=${onLabel} selecting=${selecting} picks=${picks} chordJump=${chordJump} loopMark=${!loop || i < loop.from || i > loop.to ? '' : cx('in-loop', i === loop.from && 'loop-start', i === loop.to && 'loop-end')} />`;
      return mk ? [html`<${ModMark} key=${'m' + i} mark=${mk} instrument=${instrument} onToggle=${onMark} />`, row] : row;
    })}
  </div>`;
});

// サビの見出しは少し目立たせる
const SABI_RE = /サビ|chorus|ｻﾋﾞ/i;

// コード名のボタン。jump のときは、押すと歌詞と同じ「そこから流す」(クリックは譜面全体の受け口へ流す)、
// 長押し(0.45秒)か右クリックで押さえ方。指を動かしたら(スクロール)長押しは取り消し
function ChordBtn({ token, i, jump, selecting, onChord, children }) {
  const h = useRef({ timer: 0, held: false, x: 0, y: 0 }).current;
  const clear = () => {
    clearTimeout(h.timer);
    h.timer = 0;
  };
  useEffect(() => clear, []);
  if (!jump)
    return html`<button className="chord" onClick=${(e) => { if (selecting) return; e.stopPropagation(); onChord(token, i); }}>${children}</button>`;
  const show = () => {
    h.timer = 0;
    h.held = true;
    try {
      navigator.vibrate?.(8);
    } catch {}
    onChord(token, i);
  };
  return html`<button
    className="chord"
    onPointerDown=${(e) => {
      h.held = false;
      clear();
      if (selecting || e.button > 0) return;
      h.x = e.clientX;
      h.y = e.clientY;
      h.timer = setTimeout(show, 450);
    }}
    onPointerMove=${(e) => h.timer && Math.abs(e.clientX - h.x) + Math.abs(e.clientY - h.y) > 10 && clear()}
    onPointerUp=${clear}
    onPointerLeave=${clear}
    onPointerCancel=${clear}
    onContextMenu=${(e) => {
      e.preventDefault();
      clear();
      if (!h.held && !selecting) show();
    }}
    onClick=${(e) => {
      // 長押しで押さえ方を出したあとの click は捨てる
      if (!h.held) return;
      h.held = false;
      e.stopPropagation();
    }}
  >${children}</button>`;
}

const Line = memo(function Line({ line, i, display, instrument, inline, showBars, onChord, onLabel, selecting, picks, loopMark, chordJump = false }) {
  if (line.type === 'blank') return html`<div className="ln ln-blank" data-i=${i}></div>`;
  if (line.type === 'label')
    return html`<div className=${cx('ln ln-label', SABI_RE.test(line.text) && 'is-sabi', loopMark)} data-i=${i}>
      ${onLabel ? html`<button className="label-btn" onClick=${() => onLabel(i)}>${line.text}</button>` : html`<span>${line.text}</span>`}
    </div>`;
  if (line.type === 'comment') return html`<div className="ln ln-comment" data-i=${i}>${line.text}</div>`;
  const hasChord = line.segs.some((s) => s.c);
  return html`<div className=${cx('ln', 'ln-' + line.type, line.chorus && 'is-chorus', !hasChord && 'ln-plain', loopMark)} data-i=${i}>
    ${line.segs.map((s, k) => {
      const name = s.c ? display.get(s.c) || s.c : null;
      return html`<span className=${cx('seg', s.c && 'has-chord')} key=${k}>
        ${hasChord
          ? html`<span className="ch">
              ${s.bar && showBars ? html`<i className="bar" aria-hidden="true"></i>` : null}
              ${s.c
                ? html`<${ChordBtn} token=${s.c} i=${i} jump=${chordJump} selecting=${selecting} onChord=${onChord}>
                    <span className="chord-name"><${ChordText} name=${pretty(name)} /></span>
                    ${inline && /^[A-G]/.test(name) ? html`<${MiniDiagram} name=${name} instrument=${instrument} pick=${picks?.[name]} />` : null}
                  </${ChordBtn}>`
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
  return html`<div className="sheet-inner preview"><${SheetLines} lines=${lines} display=${display} instrument="piano" inline=${false} showBars=${true} onChord=${() => {}} /></div>`;
}

const MiniDiagram = memo(function MiniDiagram({ name, instrument, pick }) {
  if (instrument === 'piano') return html`<span className="mini-diagram mini-staff"><${StaffDiagram} name=${name} width=${46} /></span>`;
  return html`<span className="mini-diagram"><${GuitarDiagram} voicing=${chosenVoicing(name, pick)} width=${52} fingers=${false} compact=${true} mini=${true} /></span>`;
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
// music: 原曲の動画に合わせているとき(テンポの代わりに「曲」。曲そのものがテンポなので、メトロノームもカウントも無し)
function Transport({ scroll, bpm, bpmKnown, click, onClick, onTempo, looping, onLoop, rec = false, onRec, music = false, onMusic, speed = 1, onSpeed }) {
  const clocked = rec || music;
  // 速さの −/＋: 流している間(と、変えた直後の少しのあいだ)だけ、再生バーのすぐ上に出す
  const [peek, setPeek] = useState(0);
  useEffect(() => {
    if (!peek) return;
    const t = setTimeout(() => setPeek(0), 2500);
    return () => clearTimeout(t);
  }, [peek]);
  const nudge = (d) => {
    onSpeed(d);
    setPeek(Date.now());
  };
  const pct = Math.round(speed * 100);
  const showSpeed = !clocked && !!onSpeed && (scroll.playing || !!scroll.countdown || !!peek);
  return html`<div className=${cx('transport', clocked && 'is-rec')}>
    ${clocked ? null : html`<div className="transport-progress" style=${{ transform: `scaleX(${scroll.progress})` }}></div>`}
    ${showSpeed
      ? html`<div className="speed-pill" role="group" aria-label="スクロールの速さ">
          <button onClick=${() => nudge(-5)} disabled=${pct <= 50} aria-label="5%遅く">−</button>
          <button className="speed-pill-now" onClick=${onTempo} aria-label="テンポと速さの設定"><small>速さ</small><b>${pct}%</b></button>
          <button onClick=${() => nudge(5)} disabled=${pct >= 150} aria-label="5%速く">＋</button>
        </div>`
      : null}
    <button className="icon-btn" onClick=${scroll.toStart} aria-label="最初に戻る"><${Icon} name="skipBack" /></button>
    ${music
      ? html`<button className="tempo-btn rec-btn" onClick=${onMusic} aria-label="曲と合わせる設定">
          <${Icon} name="music" size=${18} /><span className="tempo-unit">曲</span>
        </button>`
      : rec
      ? html`<button className="tempo-btn rec-btn" onClick=${onRec} aria-label="録音の設定">
          <${Icon} name="mic" size=${18} /><span className="tempo-unit">録音</span>
        </button>`
      : html`<button className=${cx('tempo-btn', !bpmKnown && 'is-guess')} onClick=${onTempo} aria-label="テンポを変える">
          <span className="tempo-note">♩</span><span className="tempo-num">${bpm}</span><span className=${cx('tempo-unit', speed !== 1 && 'is-speed')}>${speed !== 1 ? `${Math.round(speed * 100)}%` : 'BPM'}</span>
        </button>`}
    <button className=${cx('play-btn', scroll.playing && 'is-playing')} onClick=${scroll.toggle} aria-label=${scroll.playing ? '止める' : music ? '曲を流す' : rec ? '録音を再生' : '自動スクロール開始'}>
      <${PlayIcon} playing=${scroll.playing} size=${30} />
    </button>
    ${clocked
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

// 動画の小窓(タップで大きく/小さく)と、再生位置のつまみ・速さ・「合わせる」
// status: つまみの上に出す一言 { kind, text, nudge?: 「早く」「遅く」を出す }
function RecDock({ rec, videoRef, mode, setMode, time, speed, setSpeed, onSeek, status, syncing, onSync, onSyncEnd, onNudge }) {
  const cycle = () => setSpeed(speed === 1 ? 0.9 : speed === 0.9 ? 0.8 : speed === 0.8 ? 0.7 : 1);
  return html`<${React.Fragment}>
    <div className=${cx('rec-video', rec.isVideo ? 'is-' + mode : 'is-audio')} onClick=${() => rec.isVideo && setMode(mode === 'small' ? 'big' : 'small')}>
      <video ref=${videoRef} src=${rec.url} playsInline preload="auto"></video>
      ${rec.isVideo && mode !== 'hidden'
        ? html`<button className="rec-video-hide" onClick=${(e) => { e.stopPropagation(); setMode('hidden'); }} aria-label="映像を隠す"><${Icon} name="close" size=${14} /></button>`
        : null}
    </div>
    <div className="rec-dock">
      ${status
        ? html`<div className=${cx('yt-status', 'is-' + status.kind)} role="status">
            <span>${status.text}</span>
            ${status.nudge
              ? html`<${React.Fragment}>
                  <button className="btn btn-sm" onClick=${() => onNudge(-0.2)} aria-label="譜面を0.2秒早く">早く</button>
                  <button className="btn btn-sm" onClick=${() => onNudge(0.2)} aria-label="譜面を0.2秒遅く">遅く</button>
                </${React.Fragment}>`
              : null}
          </div>`
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
        <button className=${cx('chip chip-sm rec-sync', syncing && 'is-on')} aria-pressed=${syncing} onClick=${syncing ? onSyncEnd : onSync} aria-label=${syncing ? '合わせるのをやめる' : '譜面を歌に合わせる'}>
          ${syncing ? 'やめる' : '合わせる'}
        </button>
        ${rec.isVideo && mode === 'hidden'
          ? html`<button className="icon-btn rec-mini" onClick=${() => setMode('small')} aria-label="映像を出す"><${Icon} name="video" size=${18} /></button>`
          : null}
      </div>
    </div>
  </${React.Fragment}>`;
}

// fit: 合わせた結果(music/voice.js の alignRecording)。voice: 聴き取った歌声。pins: 押して合わせた場所の数。off: 全体の微調整(秒)
function RecPanel({ open, onClose, rec, recOn, fit, voice, busy, pins, off, speed, setSpeed, video, setVideo, onSync, onNudge, onPick, onReset, onOff, onRemove }) {
  if (!rec) return null;
  const mb = rec.size ? Math.round(rec.size / 1e6) : 0;
  const how = busy
    ? '歌声を聴き取っています…'
    : fit?.mode === 'voice'
      ? `歌声を聴き取って、${fit.matched}行を自動で合わせています${pins ? `（押した${pins}か所も使っています）` : ''}`
      : fit?.mode === 'start'
        ? 'この曲は原曲の歌詞の時刻が見つからなかったので、歌い出しだけ自動で合わせています'
        : fit?.mode === 'pins'
          ? `押した${pins}か所に合わせています`
          : 'まだ合わせていません';
  // 歌声を自動で使えなかったわけ
  const why =
    busy || fit?.mode === 'voice'
      ? ''
      : voice?.failed === 'big'
        ? '動画が大きすぎて、歌声を聴き取れませんでした。'
        : voice?.failed
          ? 'この録音からは、歌声を聴き取れませんでした。'
          : voice?.segs && fit?.mode === 'pins'
            ? '伴奏や物音が入っていると、歌の切れ目が分からないので、押した場所だけで合わせます。'
            : '';
  const offTxt = Math.abs(off) < 0.05 ? '' : `${off > 0 ? '譜面を遅く' : '譜面を早く'} ${Math.abs(off).toFixed(1)}秒`;
  return html`<${Sheet} open=${open} onClose=${onClose} title="自分の歌に合わせる">
    <div className="rec-info">
      <${Icon} name=${rec.isVideo ? 'video' : 'mic'} />
      <span><b>${rec.name}</b><small>${mb ? `${mb}MB ・ ` : ''}${rec.saved ? 'この端末に保存しています（ほかの端末には送りません）' : '大きいので今回だけ（次に開いたら選び直し）'}</small></span>
    </div>
    <p className="panel-lead">録音の歌声を聴き取って、<b>譜面を自動で合わせます</b>。歌詞やコードを押すと、そこから録音が流れます。</p>
    <div className="panel-field">
      <div className="panel-field-label">譜面と歌がずれるとき<b className=${cx('speed-now', !!offTxt && 'is-on')}>${offTxt}</b></div>
      <div className="row-gap">
        <button className="btn btn-primary" onClick=${onSync}>歌に合わせる</button>
        <button className="btn" onClick=${() => onNudge(-0.2)} aria-label="譜面を0.2秒早く">早く</button>
        <button className="btn" onClick=${() => onNudge(0.2)} aria-label="譜面を0.2秒遅く">遅く</button>
        ${pins || offTxt ? html`<button className="btn btn-ghost" onClick=${onReset}>元に戻す</button>` : null}
      </div>
      <p className="panel-note">
        「歌に合わせる」を押すと録音が流れるので、<b>いま歌っている歌詞を1回タップ</b>してください。行のどこを押しても、押すのが少し遅れても大丈夫です（細かい位置は歌声から決めます）。探している間、譜面は手で動かしたところに止まります。まだずれているところがあれば、そこでもう一度。全体を少しだけ直すときは「早く」「遅く」（0.2秒ずつ）。
      </p>
      <p className="panel-note">いま: ${how}。${why}</p>
    </div>
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

// 歌い始め(最初に歌詞を歌う行)と、サビの頭の行。サビは「サビ」の見出しがあればそこ、無ければ、
// くり返し出てくる歌詞が2行以上つづくかたまり(長いものほどサビらしい。同じくらいなら先に出てくるもの)の頭。
// Cメロ: 「Cメロ」「ブリッジ」の見出し → 無ければ、2回目のサビのあとに出てくる、ほかに出てこない歌詞の頭(最後のサビより前)
export function songMarks(lines) {
  const text = (l) => (l.segs || []).map((s) => s.t || '').join('');
  const sung = (l) => l.type === 'lyric' && text(l).replace(/[\s　\-=>|・.○●ー－~()（）]/g, '').length > 1;
  const afterLabel = (re) => {
    const lab = lines.findIndex((l) => l.type === 'label' && re.test(l.text || ''));
    return lab >= 0 ? lines.findIndex((l, i) => i > lab && sung(l)) : -1;
  };
  const start = lines.findIndex(sung);
  let chorus = lines.findIndex((l) => l.chorus && sung(l));
  // 「サビ」「Chorus」などの見出しのすぐあとの歌詞(「大サビ」は除く)
  if (chorus < 0) chorus = afterLabel(/^(?!.*大).*(サビ|ｻﾋﾞ|chorus|hook)/i);
  const sure = chorus >= 0; // 譜面にサビと書いてある
  let bridge = afterLabel(/Cメロ|Ｃメロ|C\s*melo|bridge|ブリッジ|ｃメロ/i);
  // くり返しの歌詞のかたまり
  const idx = [];
  lines.forEach((l, i) => sung(l) && idx.push(i));
  const keys = idx.map((i) => norm(text(lines[i])));
  const count = new Map();
  for (const k of keys) count.set(k, (count.get(k) || 0) + 1);
  const runs = [];
  let from = -1;
  for (let j = 0; j <= keys.length; j++) {
    const rep = j < keys.length && keys[j].length >= 4 && count.get(keys[j]) >= 2;
    if (rep && from < 0) from = j;
    if (!rep && from >= 0) {
      if (j - from >= 2) runs.push({ at: from, len: j - from });
      from = -1;
    }
  }
  const longest = Math.max(0, ...runs.map((r) => r.len));
  const big = runs.filter((r) => r.len >= Math.max(2, longest * 0.6));
  if (chorus < 0 && big.length) chorus = idx[big[0].at];
  if (bridge < 0 && big.length >= 2) {
    const end2 = big[1].at + big[1].len;
    const last = big.length >= 3 ? big[big.length - 1].at : keys.length;
    for (let j = end2; j < last; j++) {
      if (count.get(keys[j]) === 1 && keys[j].length >= 4) {
        bridge = idx[j];
        break;
      }
    }
  }
  return { start: start >= 0 ? start : null, chorus: chorus >= 0 ? chorus : null, bridge: bridge >= 0 ? bridge : null, sure };
}

function KeyPanel({ open, onClose, transpose, origKey, setSt, instrument, song, own, mine, marks, voice, setVoice, onPickOwn, onUseOwn, onPlayFull, onBeforePreview, onApple }) {
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
    <${KeyHear}
      songId=${song.id}
      active=${open}
      semis=${transpose}
      keyLabel=${keyName(origKey, transpose)}
      origLabel=${keyName(origKey)}
      getTrack=${() => appleTrackOf(song)}
      onApple=${() => { onClose(); onApple(); }}
      own=${own}
      mine=${mine}
      marks=${marks}
      voice=${voice}
      setVoice=${setVoice}
      onPickOwn=${onPickOwn}
      onUseOwn=${onUseOwn}
      onPlayFull=${onPlayFull}
      onBeforePreview=${onBeforePreview}
    />
  </${Sheet}>`;
}

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// テンポがどこから来たか
function tempoNote(from, orig, auto) {
  if (from === 'sheet') return `譜面に書かれたテンポです`;
  if (from === 'user') return orig ? `元のテンポ ${orig}（自分で変えています）` : auto ? `自動のテンポ ${auto}（自分で変えています）` : '自分で決めたテンポです';
  if (from === 'auto') return '原曲の試聴から自動で測ったテンポです。ずれていたら、曲に合わせて「タップで合わせる」を押してください';
  if (from === 'len') return '曲の長さから見積もったテンポです。曲に合わせて「タップで合わせる」を押すと正確になります';
  return '元のテンポが分からない曲です。曲に合わせてタップしてください';
}

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

function TempoPanel({ open, onClose, bpm, origBpm, bpmFrom = 'sheet', autoTempo = null, setSt, hasBars, barsPerLine, custom, fit, fitSong, durationMs, beatsPerBar = 4, sheetBpb = 4, meter = 0, clickVolume = 1, setClickVolume, clickOn = false, speed = 1, showCurrent = true, setShowCurrent }) {
  const pct = Math.round(speed * 100);
  const setPct = (p) => setSt({ speed: Math.abs(p - 100) < 0.5 ? null : Math.max(50, Math.min(150, p)) / 100 });
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
      <div className="muted small">${tempoNote(bpmFrom, origBpm, autoTempo)}</div>
    </div>
    <div className="panel-field speed-field">
      <div className="panel-field-label">スクロールの速さ（自分で微調整）<b className=${cx('speed-now', pct !== 100 && 'is-on')}>${pct}%</b></div>
      <div className="speed-row">
        <button className="btn" onClick=${() => setPct(pct - 5)} aria-label="5%遅く">−5</button>
        <button className="btn" onClick=${() => setPct(pct - 1)} aria-label="1%遅く">−1</button>
        <input type="range" className="range" min="50" max="150" step="1" value=${pct} onInput=${(e) => setPct(Number(e.target.value))} aria-label="スクロールの速さ" />
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
    ${custom && (origBpm || autoTempo) ? html`<div className="row-gap center"><button className="btn btn-ghost" onClick=${() => setSt({ bpm: null })}>${origBpm ? `元のテンポ（${origBpm}）` : `自動のテンポ（${autoTempo}）`}に戻す</button></div>` : null}
    <div className="panel-field">
      <div className="panel-field-label">拍子</div>
      <${Segmented}
        label="拍子"
        value=${meter}
        onChange=${(v) => setSt({ beatsPerBar: v || null })}
        options=${[{ value: 0, label: `自動（${sheetBpb}）` }, ...[2, 3, 4, 6].map((n) => ({ value: n, label: `${n}拍子` }))]}
      />
      <p className="panel-note">メトロノームの強い拍(1拍目)・スタート前のカウント・1小節の長さが変わります。ワルツなど3拍子の曲は「3拍子」に。</p>
    </div>
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
          <p className="panel-note">「自動」は、コードの数と歌詞の長さから行ごとに小節数を見積もります。ずれてきたら、いま弾いている行をタップすると、その行が真ん中に来て続きから流れます。</p>
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

// Apple の曲データ(曲の長さ・試聴・曲のページ)。曲の番号が分かっていればそれ、無ければ曲名とアーティスト名で探す
async function appleTrackOf(song) {
  if (song.appleId) {
    const j = await (await fetch(`https://itunes.apple.com/lookup?id=${song.appleId}&country=jp&lang=ja_jp`)).json();
    if (j.results?.[0]) return j.results[0];
  }
  const q = `${baseTitle(song.title)} ${song.artist || ''}`.trim();
  const j = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&entity=song&limit=10&lang=ja_jp`)).json();
  return (j.results || []).find((x) => norm(baseTitle(x.trackName)) === norm(baseTitle(song.title)) && (!song.artist || sameArtist(x.artistName, song.artist))) || null;
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

function MorePanel({ open, onClose, song, reload, onText, onTuner, onApple, rec = null, recOn = false, onPickRec, onRecOn, onRecPanel, musicOn = false, onMusic }) {
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
      <button className="menu-item is-accent" onClick=${onMusic}>
        <${Icon} name="music" />
        <span className="menu-item-text">${musicOn ? '曲と合わせる設定' : '原曲を流して、曲と合わせる'}<small>${musicOn ? '動画を替える・ずれを直す・速さ（下のバーの「曲」と同じ）' : '歌詞やコードを押すと、そこから曲が流れます（上のバーの「原曲」ボタンと同じ）'}</small></span>
      </button>
      ${!rec
        ? html`<button className="menu-item is-accent" onClick=${onPickRec}>
            <${Icon} name="mic" />
            <span className="menu-item-text">自分の歌（動画・録音）に合わせる<small>アカペラで撮った動画・録音を選ぶと、歌声を聴き取って、譜面を自動で合わせます</small></span>
          </button>`
        : recOn
          ? html`<button className="menu-item is-accent" onClick=${onRecPanel}><${Icon} name="mic" /><span className="menu-item-text">録音の設定<small>${rec.name}</small></span></button>`
          : html`<button className="menu-item is-accent" onClick=${onRecOn}><${Icon} name="mic" /><span className="menu-item-text">録音に合わせる<small>${rec.name}</small></span></button>`}
    </div>
    <div className="menu-group">
      <button className="menu-item" onClick=${() => { onClose(); onApple(); }}><${Icon} name="headphones" /><span className="menu-item-text">Apple Music で原曲を聴く<small>Music アプリで開きます（譜面とは連動しません）</small></span></button>
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
// 押さえ方を言葉で: 指ごとにどの弦の何フレットか＋その形のコツ
function HowToPress({ voicing }) {
  const steps = fingerSteps(voicing);
  const tips = pressTips(voicing);
  const d = voicingDifficulty(voicing);
  return html`<section className="how-press">
    <h3 className="how-head">押さえ方 <span className=${cx('diff-chip', d >= 3.6 && 'is-hard')}>${difficultyLabel(d)}</span></h3>
    <ol className="finger-steps">
      ${steps.map((s, k) => html`<li key=${k}>
        <span className=${cx('fs-num', (s.finger === 'o' || s.finger === 'x') && 'is-plain')}>${s.finger === 'o' ? '○' : s.finger === 'x' ? '×' : s.finger || '・'}</span>
        <span><b>${s.name}</b> ${s.text}</span>
      </li>`)}
    </ol>
    ${tips.length ? html`<ul className="press-tips">${tips.map((t, k) => html`<li key=${k}>${t}</li>`)}</ul>` : null}
  </section>`;
}

// 押さえにくいとき: 同じコードのやさしい形 / 響きの近い押さえやすいコード(この曲ではそれで弾ける)。
// plain = 置き換えてよい元の名前(すでに置き換えているときは null)
function EasierWays({ name, plain, voicing, vs, onPick, onSub }) {
  const cur = voicingDifficulty(voicing);
  if (cur < 2.5) return null;
  const shapes = vs
    .map((x, i) => ({ x, i, d: voicingDifficulty(x) }))
    .filter((o) => o.x !== voicing && o.d < cur - 0.4 && o.d < 3.6)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  const near = plain ? nearChords(name, cur) : [];
  if (!shapes.length && !near.length) return null;
  return html`<section className="easier-ways">
    <h3 className="how-head">もっと押さえやすくするなら</h3>
    ${shapes.length
      ? html`<p className="ew-lead">同じ <b><${ChordText} name=${pretty(name)} /></b> のまま、やさしい形</p>
          <div className="ew-row">
            ${shapes.map((o) => html`<button key=${o.i} className="ew-card" onClick=${() => onPick(o.i)}>
              <${GuitarDiagram} voicing=${o.x} width=${88} fingers=${false} compact=${true} />
              <small>${difficultyLabel(o.d)}</small>
            </button>`)}
          </div>`
      : null}
    ${near.length
      ? html`<p className="ew-lead">響きの近い、押さえやすいコード</p>
          <div className="ew-near">
            ${near.map((c) => html`<div key=${c.name} className="ew-near-item">
              <div className="ew-near-fig">
                <b><${ChordText} name=${pretty(c.name)} /></b>
                <${GuitarDiagram} voicing=${guitarVoicings(c.name)[0]} width=${80} fingers=${false} compact=${true} />
              </div>
              <div className="ew-near-text">
                <span>${c.why}（${difficultyLabel(c.diff)}）</span>
                ${onSub ? html`<button className="btn btn-sm btn-primary" onClick=${() => onSub(plain, c.name)}>この曲ではこれで弾く</button>` : null}
              </div>
            </div>`)}
          </div>`
      : null}
  </section>`;
}

function ChordPanel({ tap, info, onClose, instrument, noteStyle, flat, picks, shown = {}, easy = false, subs = {}, onSub = null }) {
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
    const userSub = !!plain && plain !== name && subs[plain] === name;
    body = html`<div className="chord-detail">
      ${userSub
        ? html`<p className="eased-note">元のコードは <b><${ChordText} name=${pretty(plain)} /></b>。この曲では、響きの近い <b><${ChordText} name=${pretty(name)} /></b> で弾いています。
            <button className="btn btn-sm" onClick=${() => onSub?.(plain, null)}>元に戻す</button></p>`
        : plain && plain !== name
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
      ${v ? html`<${HowToPress} voicing=${v} />` : null}
      ${v ? html`<${EasierWays} name=${name} plain=${userSub ? null : plain || name} voicing=${v} vs=${vs} onPick=${setIdx} onSub=${onSub} />` : null}
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
