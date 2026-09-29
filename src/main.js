// ひきがたり: 入口(画面の切り替え・起動処理)
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';
import { useRoute, go } from './lib/router.js';
import { initStore, startAutoSync, lib } from './lib/store.js';
import { deviceKey, onUnpaired } from './lib/api.js';
import { applyTheme } from './lib/prefs.js';
import { Home, Search, OpenFrom } from './ui/home.js';
import { SongPage } from './ui/song.js';
import { Editor } from './ui/editor.js';
import { Settings } from './ui/settings.js';
import { AppleGuide } from './ui/apple.js';
import { EarCopy } from './ui/ear.js';
import { Welcome } from './ui/welcome.js';
import { ToastHost, Spinner } from './ui/common.js';
const html = htm.bind(React.createElement);

// ショートカットから ?np=曲名%0Aアーティスト / ?am=AppleMusicのURL / ?q=検索語 で開かれたら、#/open に付け替える
(function redirectQuery() {
  const sp = new URLSearchParams(location.search);
  if (['np', 'am', 'q', 't'].some((k) => sp.has(k))) {
    history.replaceState(null, '', location.pathname + '#/open?' + sp.toString());
  }
})();

function App() {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(!!deviceKey.get());
  const [lost, setLost] = useState(false);
  const [updated, setUpdated] = useState(false);

  // 新しい版が公開されて裏で入れ替わったら、再読み込みを案内する(はじめての登録のときは出さない)
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const hadController = !!sw.controller;
    const onChange = () => hadController && setUpdated(true);
    sw.addEventListener('controllerchange', onChange);
    return () => sw.removeEventListener('controllerchange', onChange);
  }, []);

  useEffect(() => {
    applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', applyTheme);
    initStore().then(() => setReady(true));
    const off = onUnpaired(() => setLost(true));
    if (paired) startAutoSync();
    return off;
  }, []);

  if (!ready) return html`<div className="boot"><${Spinner} /></div>`;

  const onPaired = () => {
    setPaired(true);
    setLost(false);
    startAutoSync();
    if (route.path === '/pair') go('/', { replace: true });
  };

  // まだどの端末ともつないでいない(端末内にも曲が無い)ときは、はじめの画面
  if (!paired && !lib.all().length) return html`<${Welcome} onDone=${onPaired} /><${ToastHost} />`;

  const { path, params } = route;
  let page;
  let m;
  if (path === '/' || path === '') page = html`<${Home} />`;
  else if (path === '/search') page = html`<${Search} q=${params.q || ''} />`;
  else if ((m = path.match(/^\/song\/(.+)$/))) page = html`<${SongPage} id=${decodeURIComponent(m[1])} />`;
  else if (path === '/add') page = html`<${Editor} params=${params} />`;
  else if ((m = path.match(/^\/edit\/(.+)$/))) page = html`<${Editor} key=${m[1]} id=${decodeURIComponent(m[1])} />`;
  else if (path === '/settings') page = html`<${Settings} />`;
  else if (path === '/apple') page = html`<${AppleGuide} />`;
  else if (path === '/ear') page = html`<${EarCopy} key=${JSON.stringify(params)} params=${params} />`;
  else if (path === '/open') page = html`<${OpenFrom} key=${JSON.stringify(params)} params=${params} />`;
  else if (path === '/pair') page = html`<${Welcome} onDone=${onPaired} initialMode="code" />`;
  else page = html`<${Home} />`;

  return html`<${React.Fragment}>
    ${lost && path !== '/pair'
      ? html`<div className="banner" role="alert">
          <span>この端末の接続が切れています（保存した曲はそのまま見られます）</span>
          <button className="btn btn-sm" onClick=${() => { deviceKey.clear(); go('/pair'); }}>つなぎ直す</button>
        </div>`
      : null}
    ${page}
    ${updated
      ? html`<div className="update-banner" role="status">
          <span>新しい版があります</span>
          <button className="btn btn-sm" onClick=${() => location.reload()}>更新する</button>
        </div>`
      : null}
    <${ToastHost} />
  </${React.Fragment}>`;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
