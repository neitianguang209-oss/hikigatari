// 曲のライブラリ(お気に入り・履歴・取り込んだ譜面)。
// 端末内(IndexedDB)が正で、Edge Function 経由でほかの端末と同期する。
// 決めごと: クラウドが空でも端末のデータは消さない / 通信できなくてもアプリは開ける
import { useEffect, useState } from 'react';
import { api, deviceKey } from './api.js';

const DB_NAME = 'hikigatari';
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idb = {
  all: () => run('songs', 'readonly', (s) => s.getAll()),
  put: (v) => run('songs', 'readwrite', (s) => s.put(v)),
  putMany: (vs) => run('songs', 'readwrite', (s) => { vs.forEach((v) => s.put(v)); return null; }),
  del: (id) => run('songs', 'readwrite', (s) => s.delete(id)),
  kvGet: async (k) => (await run('kv', 'readonly', (s) => s.get(k)))?.v,
  kvSet: (k, v) => run('kv', 'readwrite', (s) => s.put({ k, v })),
};

// ---------------------------------------------------------------- メモリ上のライブラリ

const mem = new Map();
let version = 0;
let ready = null;
const subs = new Set();
let dirty = new Set();

function notify() {
  version++;
  subs.forEach((f) => f(version));
}

export function initStore() {
  if (ready) return ready;
  ready = (async () => {
    try {
      const rows = await idb.all();
      rows.forEach((r) => mem.set(r.id, r));
      dirty = new Set((await idb.kvGet('dirty')) || []);
    } catch (e) {
      console.warn('IndexedDB を開けませんでした', e);
    }
    notify();
  })();
  return ready;
}

export const lib = {
  get: (id) => mem.get(id) || null,
  all: () => [...mem.values()].filter((s) => !s.deleted),
  // 変更して保存(updatedAt を進めて同期キューへ)
  async put(song) {
    const v = { ...song, updatedAt: Math.max(Date.now(), (song.updatedAt || 0) + 1) };
    if (!v.createdAt) v.createdAt = v.updatedAt;
    mem.set(v.id, v);
    notify();
    await idb.put(v).catch(() => {});
    markDirty(v.id);
    return v;
  },
  async patch(id, patch) {
    const cur = mem.get(id);
    if (!cur) return null;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    return lib.put({ ...cur, ...p });
  },
  async patchSettings(id, patch) {
    return lib.patch(id, (cur) => ({ settings: { ...(cur.settings || {}), ...patch } }));
  },
  async remove(id) {
    const cur = mem.get(id);
    if (!cur) return;
    // 同期のため墓標(deleted)を残す。譜面本文は消す
    await lib.put({ ...cur, deleted: true, sheet: null, fav: false });
  },
  // 取り込み(JSON読み込み)。新しいものだけ上書き
  async importMany(items) {
    let n = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const cur = mem.get(it.id);
      if (cur && (cur.updatedAt || 0) >= (it.updatedAt || 0)) continue;
      await lib.put({ ...it, updatedAt: Math.max(it.updatedAt || 0, Date.now()) });
      n++;
    }
    return n;
  },
};

export function useLibrary() {
  const [, setV] = useState(version);
  useEffect(() => {
    subs.add(setV);
    return () => subs.delete(setV);
  }, []);
  return lib;
}

export function useSong(id) {
  useLibrary();
  return lib.get(id);
}

// ---------------------------------------------------------------- 同期

const syncState = { status: 'idle', lastSyncedAt: null, error: null };
const syncSubs = new Set();
function setSync(p) {
  Object.assign(syncState, p);
  syncSubs.forEach((f) => f({ ...syncState }));
}
export function useSyncState() {
  const [s, setS] = useState({ ...syncState });
  useEffect(() => {
    syncSubs.add(setS);
    return () => syncSubs.delete(setS);
  }, []);
  return s;
}

let pushTimer = null;
function markDirty(id) {
  dirty.add(id);
  idb.kvSet('dirty', [...dirty]).catch(() => {});
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ pull: false }), 1500);
}

async function applyRemote(row) {
  const remote = { ...row.data, deleted: !!row.deleted };
  const local = mem.get(row.id);
  if (local && (local.updatedAt || 0) >= (remote.updatedAt || 0)) return false;
  mem.set(row.id, remote);
  await idb.put(remote).catch(() => {});
  return true;
}

async function push() {
  const ids = [...dirty];
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const items = chunk.map((id) => mem.get(id)).filter(Boolean).map((s) => ({ id: s.id, data: s, deleted: !!s.deleted }));
    const r = await api('lib_push', { items });
    for (const id of r.accepted || []) dirty.delete(id);
    let changed = false;
    for (const row of r.newer || []) {
      dirty.delete(row.id);
      if (await applyRemote(row)) changed = true;
    }
    if (changed) notify();
  }
  await idb.kvSet('dirty', [...dirty]).catch(() => {});
}

async function pull() {
  const since = await idb.kvGet('lastPull').catch(() => null);
  const r = await api('lib_pull', { since: since || null });
  let changed = false;
  for (const row of r.items || []) {
    if (dirty.has(row.id)) {
      const local = mem.get(row.id);
      if (local && (local.updatedAt || 0) >= (row.data?.updatedAt || 0)) continue;
    }
    if (await applyRemote(row)) changed = true;
  }
  // 安全弁: はじめての取得でクラウドが空、端末にはデータがある → 端末側を送る(消さない)
  if (!since && !(r.items || []).length && mem.size) {
    for (const id of mem.keys()) dirty.add(id);
  }
  // 時計のずれに備えて少し前から取り直す
  const t = new Date(new Date(r.serverTime).getTime() - 30000).toISOString();
  await idb.kvSet('lastPull', t).catch(() => {});
  if (changed) notify();
}

let syncing = null;
export function syncNow({ pull: doPull = true } = {}) {
  if (!deviceKey.get()) {
    setSync({ status: 'unpaired' });
    return Promise.resolve();
  }
  if (!navigator.onLine) {
    setSync({ status: 'offline' });
    return Promise.resolve();
  }
  if (syncing) return syncing.then(() => (dirty.size ? syncNow({ pull: false }) : null));
  setSync({ status: 'syncing', error: null });
  syncing = (async () => {
    try {
      await initStore();
      if (doPull) await pull();
      await push();
      setSync({ status: 'idle', lastSyncedAt: Date.now() });
    } catch (e) {
      setSync({ status: e.code === 'unpaired' ? 'unpaired' : 'error', error: e.message });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export function pendingCount() {
  return dirty.size;
}

export function startAutoSync() {
  syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('online', () => syncNow());
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, 90000);
}

export async function resetSyncCursor() {
  await idb.kvSet('lastPull', null).catch(() => {});
}

export async function exportAll() {
  await initStore();
  return { app: 'hikigatari', exportedAt: new Date().toISOString(), songs: [...mem.values()].filter((s) => !s.deleted) };
}
