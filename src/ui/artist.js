// アーティストの曲一覧(歌ネットの人気順 + U-FRET にだけある曲)。曲をタップすると、その曲の譜面をまとめて探して開く
import React, { useEffect, useMemo, useState } from 'react';
import htm from 'htm';
import { Icon, StarIcon } from './icons.js';
import { Artwork, Spinner, Empty, Segmented, toast } from './common.js';
import { useLibrary } from '../lib/store.js';
import { api } from '../lib/api.js';
import { go, back } from '../lib/router.js';
import { cx, norm, baseTitle, sameArtist } from '../lib/util.js';
import { openGroup } from './home.js';
const html = htm.bind(React.createElement);

const cache = new Map();

export function ArtistPage({ params }) {
  const name = (params.name || '').trim();
  const L = useLibrary();
  const [state, setState] = useState(() => (cache.has(name) ? { loading: false, ...cache.get(name) } : { loading: true, songs: [] }));
  const [sort, setSort] = useState('pop');
  const [filter, setFilter] = useState('');
  const [opening, setOpening] = useState(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!name || cache.has(name)) return;
    let alive = true;
    setState({ loading: true, songs: [] });
    api('artist', { name, unId: params.un || '' })
      .then((r) => {
        if (r.songs?.length) cache.set(name, r);
        if (alive) setState({ loading: false, ...r });
      })
      .catch((e) => alive && setState({ loading: false, error: e.message, songs: [] }));
    return () => {
      alive = false;
    };
  }, [name, tries]);

  const artist = state.name || name;
  // このアーティストの、保存している曲(曲名 → 曲)
  const all = L.all();
  const mine = useMemo(() => {
    const m = new Map();
    for (const s of all) if (s.artist && sameArtist(s.artist, artist)) m.set(norm(baseTitle(s.title)), s);
    return m;
  }, [all, artist]);

  const shown = useMemo(() => {
    let list = state.songs || [];
    const w = norm(filter);
    if (w) list = list.filter((s) => norm(s.title).includes(w));
    // 新しい順: 発売日が分からない曲は後ろに(人気順のまま)
    if (sort === 'new') list = [...list].sort((a, b) => (b.released || '').localeCompare(a.released || ''));
    else if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    return list;
  }, [state.songs, filter, sort]);

  const open = async (s) => {
    if (opening) return;
    const saved = mine.get(norm(s.title));
    if (saved) {
      go('/song/' + saved.id);
      return;
    }
    setOpening(s.title);
    try {
      // 同じ曲の譜面(U-FRET・ChordWiki・歌ネット)をまとめて探し、いつもの検索と同じ形で開く
      const q = `${s.title} ${artist}`;
      let g = null;
      try {
        const r = await api('search', { q });
        g = (r.groups || []).find((x) => x.sources.length && norm(baseTitle(x.title)) === norm(s.title) && sameArtist(x.artist, artist));
      } catch (e) {
        if (!s.uf?.length) throw e;
      }
      if (!g && s.uf?.length) {
        g = { title: s.title, artist, sources: s.uf.map((u) => ({ source: 'ufret', id: u.id, label: u.label, url: `https://www.ufret.jp/song.php?data=${u.id}` })) };
      }
      if (!g) {
        go('/search?q=' + encodeURIComponent(q));
        return;
      }
      await openGroup({
        ...g,
        artwork: s.artwork || g.artwork,
        appleId: s.appleId || g.appleId,
        appleUrl: s.appleUrl || g.appleUrl,
        durationMs: s.durationMs || g.durationMs,
      });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      setOpening(null);
    }
  };

  const songs = state.songs || [];
  return html`<div className="page artist-page">
    <header className="page-top">
      <button className="icon-btn" onClick=${() => back('/')} aria-label="戻る"><${Icon} name="back" /></button>
      <h1>${artist}</h1>
      <span className="page-top-spacer"></span>
    </header>

    ${state.loading
      ? html`<div className="search-loading">
          <${Spinner} label="曲の一覧を集めています…" />
          <ul className="song-list skeleton">${[0, 1, 2, 3, 4].map((i) => html`<li key=${i} className="song-row"><span className="sk-art"></span><span className="sk-lines"><i></i><i></i></span></li>`)}</ul>
        </div>`
      : state.error
        ? html`<${Empty} icon="cloudOff" title="曲の一覧を出せませんでした">
            ${state.error}<br />
            <span className="row-gap center" style=${{ marginTop: 12 }}>
              <button className="btn btn-sm btn-primary" onClick=${() => setTries((n) => n + 1)}>もう一度</button>
              <button className="btn btn-sm" onClick=${() => go('/search?q=' + encodeURIComponent(artist))}>「${artist}」で検索</button>
            </span>
          </${Empty}>`
        : !songs.length
          ? html`<${Empty} icon="search" title="曲が見つかりませんでした">
              <button className="btn btn-sm" onClick=${() => go('/search?q=' + encodeURIComponent(artist))}>「${artist}」で検索する</button>
            </${Empty}>`
          : html`<div className="artist-tools">
                <p className="artist-count">${songs.length}曲${state.withChords ? html` ・ U-FRET の譜面 ${state.withChords}曲` : null}</p>
                <${Segmented}
                  size="sm"
                  label="並べ替え"
                  value=${sort}
                  onChange=${setSort}
                  options=${[{ value: 'pop', label: '人気順' }, { value: 'new', label: '新しい順' }, { value: 'title', label: '曲名順' }]}
                />
              </div>
              ${songs.length >= 12
                ? html`<input className="fav-filter" type="search" placeholder="曲名で絞り込む" value=${filter} onInput=${(e) => setFilter(e.target.value)} aria-label="曲名で絞り込む" />`
                : null}
              ${shown.length
                ? html`<ul className="song-list artist-songs">
                    ${shown.map((s) => {
                      const saved = mine.get(norm(s.title));
                      const busy = opening === s.title;
                      return html`<li key=${s.title} className="song-row">
                        <button className=${cx('song-row-main', busy && 'is-busy')} onClick=${() => open(s)} disabled=${!!opening && !busy} aria-busy=${busy}>
                          <${Artwork} song=${s} size=${44} />
                          <span className="song-row-text">
                            <span className="song-row-title">${s.title}${saved?.fav ? html` <${StarIcon} on=${true} size=${13} />` : null}</span>
                            <span className="song-row-sub">
                              ${s.released ? html`<span>${s.released.slice(0, 4)}年</span>` : null}
                              ${s.uf?.length ? html`<span className="src-badge src-ufret">U-FRET</span>` : null}
                              ${saved ? html`<span className="saved-tag">保存済み</span>` : null}
                            </span>
                          </span>
                          ${busy ? html`<span className="spinner spinner-sm" aria-label="開いています"></span>` : html`<${Icon} name="chevron" size=${18} className="row-chevron" />`}
                        </button>
                      </li>`;
                    })}
                  </ul>`
                : html`<p className="muted small">「${filter}」に合う曲はありません</p>`}
              <p className="muted small artist-foot">並びは歌ネットの人気順（歌詞の閲覧数）。U-FRET の印が無い曲も、開くと ChordWiki・歌ネットの譜面を探します。</p>`}
  </div>`;
}
