// ホーム(お気に入り・最近ひらいた曲)と検索
import React, { useEffect, useMemo, useRef, useState } from 'react';
import htm from 'htm';
import { Icon, StarIcon, Logo } from './icons.js';
import { Artwork, Spinner, Empty, Segmented, toast } from './common.js';
import { lib, useLibrary, useSyncState } from '../lib/store.js';
import { api, lookupAppleMusic } from '../lib/api.js';
import { usePrefs } from '../lib/prefs.js';
import { go, back } from '../lib/router.js';
import { cx, norm, songIdFor, sourceName, formatAgo, baseTitle, sameArtist, signed, artworkUrl, tileColor } from '../lib/util.js';
import { TunerSheet, prepareTuner } from './tuner.js';
import { checkWatched } from '../lib/watch.js';

const earLink = (g) =>
  `/ear?title=${encodeURIComponent(baseTitle(g.title || ''))}&artist=${encodeURIComponent(g.artist || '')}${g.appleId ? `&appleId=${g.appleId}` : ''}`;
const html = htm.bind(React.createElement);

// ---------------------------------------------------------------- 最近の検索語(この端末だけ)

const RECENT_KEY = 'hk.recentQ';
function loadRecentQueries() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 8);
  } catch {
    return [];
  }
}
function saveRecentQueries(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {}
}
function rememberQuery(q) {
  const v = (q || '').trim();
  if (!v) return;
  saveRecentQueries([v, ...loadRecentQueries().filter((x) => norm(x) !== norm(v))]);
}

// ---------------------------------------------------------------- 検索結果を開く(ライブラリに入れて曲画面へ)

export async function openGroup(g, { replace = false } = {}) {
  const id = songIdFor(g.title, g.artist);
  const cur = lib.get(id);
  const first = g.sources[0];
  if (cur && !cur.deleted) {
    await lib.patch(id, {
      sources: g.sources,
      artwork: cur.artwork || g.artwork || null,
      appleId: cur.appleId || g.appleId || null,
      appleUrl: cur.appleUrl || g.appleUrl || null,
      durationMs: cur.durationMs || g.durationMs || null,
      ...(cur.sheet ? {} : { source: cur.source || first.source, sourceId: cur.sourceId || first.id, sourceUrl: cur.sourceUrl || first.url, sourceLabel: cur.sourceLabel ?? first.label }),
    });
  } else {
    await lib.put({
      id,
      title: baseTitle(g.title),
      artist: g.artist || '',
      artwork: g.artwork || null,
      appleId: g.appleId || null,
      appleUrl: g.appleUrl || null,
      durationMs: g.durationMs || null,
      source: first.source,
      sourceId: first.id,
      sourceUrl: first.url,
      sourceLabel: first.label || '',
      sources: g.sources,
      sheet: null,
      fav: false,
      settings: {},
      createdAt: Date.now(),
    });
  }
  go('/song/' + id, { replace });
}

// ---------------------------------------------------------------- 曲の行

function SongRow({ song, onOpen }) {
  const st = song.settings || {};
  const bits = [];
  if (st.instrument === 'piano') bits.push('ピアノ');
  if (typeof st.capo === 'number') bits.push(st.capo ? `カポ ${st.capo}` : 'カポなし');
  if (st.transpose) bits.push(`キー ${signed(st.transpose)}`);
  return html`<li className="song-row">
    <button className="song-row-main" onClick=${onOpen}>
      <${Artwork} song=${song} size=${48} />
      <span className="song-row-text">
        <span className="song-row-title">${song.title}</span>
        <span className="song-row-sub">${song.artist}${bits.length ? html`<span className="song-row-tags">${bits.join(' ・ ')}</span>` : null}</span>
      </span>
    </button>
    <button
      className=${cx('icon-btn fav-btn', song.fav && 'is-on')}
      onClick=${() => {
        const was = song.fav;
        lib.patch(song.id, { fav: !was, favAt: !was ? Date.now() : song.favAt });
        if (was) toast(`「${song.title}」をお気に入りから外しました`, { action: { label: '元に戻す', onClick: () => lib.patch(song.id, { fav: true }) } });
      }}
      aria-label=${song.fav ? 'お気に入りから外す' : 'お気に入りに入れる'}
      aria-pressed=${!!song.fav}
    >
      <${StarIcon} on=${song.fav} size=${20} />
    </button>
  </li>`;
}

function SearchBox({ initial = '', autoFocus = false, onSubmit }) {
  const [q, setQ] = useState(initial);
  const ref = useRef(null);
  useEffect(() => setQ(initial), [initial]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  return html`<form
    className="searchbox"
    role="search"
    onSubmit=${(e) => {
      e.preventDefault();
      const v = q.trim();
      if (v) {
        ref.current?.blur();
        onSubmit(v);
      }
    }}
  >
    <${Icon} name="search" size=${20} />
    <input
      ref=${ref}
      type="search"
      enterKeyHint="search"
      placeholder="曲名・アーティスト名で探す"
      value=${q}
      onInput=${(e) => setQ(e.target.value)}
      aria-label="曲を探す"
    />
    ${q ? html`<button type="button" className="icon-btn clear-btn" onClick=${() => { setQ(''); ref.current?.focus(); }} aria-label="消す"><${Icon} name="close" size=${18} /></button>` : null}
  </form>`;
}

// ---------------------------------------------------------------- ホーム

export function Home() {
  const L = useLibrary();
  const [prefs, setPrefs] = usePrefs();
  const sync = useSyncState();
  const songs = L.all();
  const sortKey = prefs.homeSort;
  const favs = useMemo(() => {
    const f = songs.filter((s) => s.fav);
    if (sortKey === 'title') return f.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    if (sortKey === 'added') return f.sort((a, b) => (b.favAt || 0) - (a.favAt || 0));
    return f.sort((a, b) => (b.openedAt || b.favAt || 0) - (a.openedAt || a.favAt || 0));
  }, [songs, sortKey]);
  const recent = useMemo(
    () => songs.filter((s) => !s.fav && s.openedAt).sort((a, b) => b.openedAt - a.openedAt).slice(0, 12),
    [songs],
  );
  const [recentQ, setRecentQ] = useState(loadRecentQueries);
  const [tuner, setTuner] = useState(false);
  // 耳コピの下書きしか無い曲に、サイトの譜面が出ていないか調べる
  useEffect(() => {
    checkWatched();
  }, []);
  const found = songs.filter((s) => s.source === 'ear' && s.watchFound);
  // お気に入りが増えてきたら絞り込み欄を出す
  const [filter, setFilter] = useState('');
  const shownFavs = useMemo(() => {
    const w = norm(filter);
    return w ? favs.filter((s) => norm(s.title).includes(w) || norm(s.artist).includes(w)) : favs;
  }, [favs, filter]);

  return html`<div className="page home">
    <header className="home-top">
      <div className="brand"><${Logo} size=${30} /><span>ひきがたり</span></div>
      <div className="home-top-actions">
        <button className="icon-btn" onClick=${() => { prepareTuner(); setTuner(true); }} aria-label="チューナー" title="チューナー"><${Icon} name="tuner" /></button>
        <button className="icon-btn" onClick=${() => go('/settings')} aria-label="設定" title="設定"><${Icon} name="settings" /></button>
      </div>
    </header>
    <${TunerSheet} open=${tuner} onClose=${() => setTuner(false)} />

    <${SearchBox} onSubmit=${(q) => go('/search?q=' + encodeURIComponent(q))} />
    ${recentQ.length
      ? html`<div className="recent-q" role="group" aria-label="最近の検索">
          <span className="recent-q-icon" aria-hidden="true"><${Icon} name="clock" size=${15} /></span>
          <div className="recent-q-list">
            ${recentQ.map((q) => html`<button key=${q} className="chip chip-sm" onClick=${() => go('/search?q=' + encodeURIComponent(q))}>${q}</button>`)}
          </div>
          <button className="icon-btn recent-q-clear" onClick=${() => { saveRecentQueries([]); setRecentQ([]); }} aria-label="最近の検索を消す" title="最近の検索を消す"><${Icon} name="close" size=${15} /></button>
        </div>`
      : null}

    ${found.map(
      (s) => html`<button key=${s.id} className="watch-card" onClick=${() => go('/song/' + s.id)}>
        <${Icon} name="music" />
        <span><b>「${s.title}」の譜面が出ました</b><small>${sourceName(s.sources?.[0]?.source)} に載りました。タップして切り替えられます</small></span>
      </button>`,
    )}

    ${!prefs.appleCardDismissed
      ? html`<div className="apple-card">
          <div className="apple-card-text">
            <b>Apple Musicからワンタップで</b>
            <span>聴いている曲のコードを、ボタン1つでここに開けます。</span>
          </div>
          <div className="apple-card-actions">
            <button className="btn btn-primary btn-sm" onClick=${() => go('/apple')}>設定する</button>
            <button className="icon-btn" onClick=${() => setPrefs({ appleCardDismissed: true })} aria-label="閉じる"><${Icon} name="close" size=${18} /></button>
          </div>
        </div>`
      : null}

    <section className="home-section">
      <div className="section-head">
        <h2><${StarIcon} on=${true} size=${18} /> お気に入り <span className="count">${favs.length}</span></h2>
        ${favs.length > 1
          ? html`<${Segmented}
              size="sm"
              label="並べ替え"
              value=${sortKey}
              onChange=${(v) => setPrefs({ homeSort: v })}
              options=${[{ value: 'recent', label: '最近' }, { value: 'added', label: '追加順' }, { value: 'title', label: '曲名' }]}
            />`
          : null}
      </div>
      ${favs.length >= 8
        ? html`<input className="fav-filter" type="search" placeholder="お気に入りを絞り込む" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="お気に入りを絞り込む" />`
        : null}
      ${favs.length
        ? shownFavs.length
          ? html`<ul className="song-list">${shownFavs.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => go('/song/' + s.id)} />`)}</ul>`
          : html`<p className="muted small">「${filter}」に合うお気に入りはありません</p>`
        : html`<${Empty} icon="music" title="まだお気に入りはありません">
            曲を開いて右上の ☆ を押すと、ここに並びます。<br />よく弾く曲・練習中の曲を入れておきましょう。
          </${Empty}>`}
    </section>

    ${recent.length
      ? html`<section className="home-section">
          <div className="section-head"><h2><${Icon} name="clock" size=${17} className="icon-muted" /> 最近ひらいた曲</h2></div>
          <ul className="song-list">${recent.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => go('/song/' + s.id)} />`)}</ul>
        </section>`
      : null}

    <div className="home-actions is-two">
      <button className="btn" onClick=${() => go('/ear')}><${Icon} name="mic" size=${18} /> 耳コピで作る</button>
      <button className="btn" onClick=${() => go('/add')}><${Icon} name="plus" size=${18} /> 自分で入力する</button>
    </div>

    <footer className="home-foot">
      <${SyncBadge} sync=${sync} />
    </footer>
  </div>`;
}

export function SyncBadge({ sync }) {
  const map = {
    idle: ['cloud', sync.lastSyncedAt ? `同期済み（${formatAgo(sync.lastSyncedAt)}）` : '同期済み'],
    syncing: ['refresh', '同期しています…'],
    offline: ['cloudOff', 'オフライン（この端末に保存しています）'],
    error: ['cloudOff', '同期できませんでした（この端末には保存済み）'],
    unpaired: ['cloudOff', 'この端末はつながっていません'],
  };
  const [icon, text] = map[sync.status] || map.idle;
  return html`<button className=${cx('sync-badge', 'is-' + sync.status)} onClick=${() => go('/settings')}>
    <${Icon} name=${icon} size=${16} /><span>${text}</span>
  </button>`;
}

// ---------------------------------------------------------------- 検索

const searchCache = new Map();

export function Search({ q }) {
  const L = useLibrary();
  const [state, setState] = useState({ loading: true, error: null, groups: [] });
  useEffect(() => {
    if (!q) return;
    rememberQuery(q);
    let alive = true;
    if (searchCache.has(q)) {
      setState({ loading: false, error: null, ...searchCache.get(q) });
      return;
    }
    setState({ loading: true, error: null, groups: [] });
    api('search', { q })
      .then((r) => {
        if (!alive) return;
        const res = { groups: r.groups || [], artists: r.artists || [], understood: r.understood || null };
        searchCache.set(q, res);
        setState({ loading: false, error: null, ...res });
      })
      .catch((e) => alive && setState({ loading: false, error: e.message, groups: [] }));
    return () => {
      alive = false;
    };
  }, [q]);

  // 保存済みの曲からも探す(オフラインでも出る)
  const local = useMemo(() => {
    const words = (q || '').split(/\s+/).map(norm).filter(Boolean);
    if (!words.length) return [];
    return L.all()
      .filter((s) => s.sheet || s.fav)
      .filter((s) => words.every((w) => norm(s.title).includes(w) || norm(s.artist).includes(w)))
      .slice(0, 5);
  }, [q, L.all().length]);

  const withSheets = state.groups.filter((g) => g.sources.length);
  // オルゴール・カラオケ・カバー集などは「譜面がまだ無い曲」にも出さない
  const JUNK = /オルゴール|orgel|music box|originally performed|karaoke|カラオケ|instrumental|インスト|relax|ヒーリング|α波|cover|カバー/i;
  const without = state.groups.filter((g) => !g.sources.length && !JUNK.test(g.title + ' ' + g.artist));

  return html`<div className="page search-page">
    <header className="search-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <${SearchBox} initial=${q} onSubmit=${(v) => go('/search?q=' + encodeURIComponent(v), { replace: true })} />
    </header>

    ${!state.loading && state.artists?.length
      ? html`<section className="artist-hits" aria-label="アーティスト">
          ${state.artists.map((a) => html`<${ArtistHit} key=${a.unId} a=${a} />`)}
        </section>`
      : null}

    ${local.length
      ? html`<section className="home-section">
          <div className="section-head"><h2>保存している曲</h2></div>
          <ul className="song-list">${local.map((s) => html`<${SongRow} key=${s.id} song=${s} onOpen=${() => go('/song/' + s.id)} />`)}</ul>
        </section>`
      : null}

    <section className="home-section">
      ${local.length ? html`<div className="section-head"><h2>見つかった譜面</h2></div>` : null}
      ${!state.loading && state.understood ? html`<p className="understood">「<b>${state.understood}</b>」として探しました</p>` : null}
      ${state.loading
        ? html`<div className="search-loading">
            <${Spinner} label="U-FRET・ChordWiki・歌ネットを探しています…" />
            <ul className="song-list skeleton">${[0, 1, 2, 3].map((i) => html`<li key=${i} className="song-row"><span className="sk-art"></span><span className="sk-lines"><i></i><i></i></span></li>`)}</ul>
          </div>`
        : state.error
          ? html`<${Empty} icon="cloudOff" title="探せませんでした">${state.error}</${Empty}>`
          : !withSheets.length
            ? html`<${Empty} icon="search" title="譜面が見つかりませんでした">
                曲名だけ・アーティスト名だけでも探してみてください。<br />
                まだどこにも譜面が無い新しい曲なら、音から聴き取って下書きを作れます。<br />
                <span className="row-gap center" style=${{ marginTop: 12 }}>
                  <button className="btn btn-sm btn-primary" onClick=${() => go(earLink({ title: q, artist: '' }))}><${Icon} name="mic" size=${16} /> 耳コピで作る</button>
                  <button className="btn btn-sm" onClick=${() => go('/add?title=' + encodeURIComponent(q))}>自分で入力する</button>
                </span>
              </${Empty}>`
            : html`<ul className="song-list results">
                ${withSheets.map((g, i) => html`<${ResultRow} key=${i} g=${g} />`)}
              </ul>`}
      ${!state.loading && without.length
        ? html`<div className="no-sheet">
            <div className="section-head"><h2 className="muted">譜面がまだ無い曲</h2><span className="muted small">タップすると耳コピで下書きを作れます</span></div>
            <ul className="song-list">
              ${without.map(
                (g, i) => html`<li key=${i} className="song-row is-dim">
                  <button className="song-row-main" onClick=${() => go(earLink(g))}>
                    <${Artwork} song=${g} size=${40} />
                    <span className="song-row-text">
                      <span className="song-row-title">${baseTitle(g.title)}</span>
                      <span className="song-row-sub">${g.artist} ・ <span className="ear-hint"><${Icon} name="mic" size=${13} /> 耳コピで作る</span></span>
                    </span>
                  </button>
                </li>`,
              )}
            </ul>
          </div>`
        : null}
    </section>
  </div>`;
}

// アーティストの候補(押すとその人の曲一覧へ)
function ArtistHit({ a }) {
  const [broken, setBroken] = useState(false);
  return html`<button className="artist-hit" onClick=${() => go(`/artist?name=${encodeURIComponent(a.name)}&un=${a.unId}`)}>
    <span className="artist-hit-art" style=${a.artwork && !broken ? null : { background: tileColor(a.name) }}>
      ${a.artwork && !broken
        ? html`<img src=${artworkUrl(a.artwork, 120)} alt="" width="48" height="48" loading="lazy" onError=${() => setBroken(true)} />`
        : a.name.trim().slice(0, 1)}
    </span>
    <span className="artist-hit-text">
      <span className="artist-hit-name">${a.name}</span>
      <span className="artist-hit-sub">アーティスト ・ ${a.count}曲</span>
    </span>
    <span className="artist-hit-go">曲一覧<${Icon} name="chevron" size=${16} /></span>
  </button>`;
}

function ResultRow({ g }) {
  const saved = lib.get(songIdFor(g.title, g.artist));
  const kinds = [...new Set(g.sources.map((s) => s.source))];
  const versions = g.sources.length;
  return html`<li className="song-row">
    <button className="song-row-main" onClick=${() => openGroup(g)}>
      <${Artwork} song=${g} size=${48} />
      <span className="song-row-text">
        <span className="song-row-title">${g.title}${saved && saved.fav ? html` <span className="fav-mark">★</span>` : null}</span>
        <span className="song-row-sub">${g.artist}</span>
        <span className="src-badges">
          ${kinds.map((k) => html`<span key=${k} className=${'src-badge src-' + k}>${sourceName(k)}</span>`)}
          ${versions > kinds.length ? html`<span className="muted small">${versions}版</span>` : null}
        </span>
      </span>
    </button>
  </li>`;
}

// ---------------------------------------------------------------- Apple Music などから開く(#/open?np=曲名\nアーティスト)

export function OpenFrom({ params }) {
  const [msg, setMsg] = useState('曲を探しています…');
  useEffect(() => {
    (async () => {
      let title = params.t || '';
      let artist = params.a || '';
      if (params.np) {
        const parts = params.np.split(/\r?\n|\s+[\/／]\s+/);
        title = parts[0] || '';
        artist = parts[1] || '';
      }
      if (params.am) {
        try {
          const info = await lookupAppleMusic(params.am);
          if (info) ({ title, artist } = info);
        } catch {}
      }
      if (params.q && !title) {
        go('/search?q=' + encodeURIComponent(params.q), { replace: true });
        return;
      }
      title = (title || '').trim();
      artist = (artist || '').trim();
      if (!title) {
        setMsg('曲名を受け取れませんでした');
        setTimeout(() => go('/', { replace: true }), 1500);
        return;
      }
      setMsg(`「${title}」のコードを探しています…`);
      // 1) 保存済みならすぐ開く(オフラインでも)
      const mine = lib.all().find((s) => norm(s.title) === norm(baseTitle(title)) && (!artist || sameArtist(s.artist, artist)));
      if (mine) {
        go('/song/' + mine.id, { replace: true });
        return;
      }
      // 2) 検索して、曲名とアーティストが一致する譜面があれば直接開く
      const q = `${baseTitle(title)} ${artist}`.trim();
      try {
        const r = await api('search', { q });
        const hit = (r.groups || []).find((g) => g.sources.length && norm(g.title) === norm(baseTitle(title)) && (!artist || sameArtist(g.artist, artist)));
        if (hit) {
          await openGroup(hit, { replace: true });
          return;
        }
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
      go('/search?q=' + encodeURIComponent(q), { replace: true });
    })();
  }, []);
  return html`<div className="page page-center"><${Spinner} label=${msg} /></div>`;
}
