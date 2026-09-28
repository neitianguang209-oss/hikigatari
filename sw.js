// ひきがたり Service Worker(オフラインでもアプリを開けるように)
// アプリを更新してデプロイするたびに、CACHE_NAME の番号を必ず上げる。
// 上げないとブラウザが sw.js の変更を検知できず、古い画面を配信し続ける。
const CACHE_NAME = 'hikigatari-v2';
const RUNTIME = 'hikigatari-runtime';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './src/main.js',
  './src/config.js',
  './src/lib/api.js',
  './src/lib/prefs.js',
  './src/lib/router.js',
  './src/lib/store.js',
  './src/lib/util.js',
  './src/music/chord.js',
  './src/music/guitar.js',
  './src/music/piano.js',
  './src/music/sheet.js',
  './src/ui/apple.js',
  './src/ui/autoscroll.js',
  './src/ui/common.js',
  './src/ui/diagrams.js',
  './src/ui/editor.js',
  './src/ui/home.js',
  './src/ui/icons.js',
  './src/ui/settings.js',
  './src/ui/song.js',
  './src/ui/welcome.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/favicon-32.png',
].map((p) => new URL(p, self.registration.scope).toString());

const INDEX_URL = new URL('./index.html', self.registration.scope).toString();
// ライブラリ(esm.sh)・フォント・ジャケット画像は、一度読んだら手元に置いておく
const RUNTIME_HOSTS = ['esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // Edge Function(POST)は素通し
  const url = new URL(req.url);

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // アプリ本体: キャッシュをすぐ返しつつ、裏で新しいものを取りに行く
  event.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match(INDEX_URL) : cached));
      return cached || net;
    }),
  );
});
