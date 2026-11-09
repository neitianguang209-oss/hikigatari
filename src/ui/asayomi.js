// あさよみで聞いていた話を、思考メモに保存する画面。
// iPhone のロック画面・車の画面で「再生中」(あさよみ)を押すと、同じ住所にあるこのアプリが開いてしまう。
// そのときに「いま聞いていた話」を下から出して、1回押すだけで思考メモに保存できるようにする。
// あさよみは流している間、今の記事とひとつ前の記事をクラウド(asayomi_now)に置いている。
import React, { useEffect, useState } from 'react';
import htm from 'htm';
import { Sheet, toast } from './common.js';
const html = htm.bind(React.createElement);

const SB_URL = 'https://gzayrjlhruhvklsidraw.supabase.co';
const SB_KEY = 'sb_publishable_-sNQxpwsU7JxhPF9S2vn5A_-CCTqQZL';
const HEAD = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const FRESH_SEC = 180; // 3分以内に聞いていたら出す
const SEEN = 'hikigatari:asayomiSeen';

async function rpc(name, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(SB_URL + '/rest/v1/rpc/' + name, { method: 'POST', headers: HEAD, body: JSON.stringify(body || {}), signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const seenGet = () => { try { return localStorage.getItem(SEEN) || ''; } catch (e) { return ''; } };
const seenSet = (v) => { try { localStorage.setItem(SEEN, v); } catch (e) { /* 保存できない端末 */ } };

// 思考メモ本体と同じ入口。ID は記事ごとに固定なので、あさよみから送った分と重ならない(2回押しても増えない)
async function saveMemo(item, tag) {
  const now = new Date().toISOString();
  const res = await rpc('shikou_memo_sync', {
    p_changes: [{
      id: item.id, kind: 'note', deleted: false, updatedAt: now,
      data: { id: item.id, body: item.body, tagIds: tag ? [tag] : [], dateKey: todayJST(), createdAt: now, updatedAt: now },
    }],
    p_since: null,
    p_device: 'hikigatari',
  });
  if (!res || !(res.applied >= 1)) throw new Error('unconfirmed');
}

export function AsayomiNow() {
  const [now, setNow] = useState(null);
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      rpc('asayomi_now_get').then((d) => {
        if (!alive || !d || !d.cur || !(d.ago < FRESH_SEC)) return;
        // 同じ記事で一度閉じたら、もう出さない(記事が変われば また出す)
        if (seenGet() === d.cur.key) return;
        setSaved({});
        setNow(d);
      }).catch(() => {});
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => { alive = false; document.removeEventListener('visibilitychange', check); };
  }, []);

  if (!now) return null;
  const close = () => { seenSet(now.cur.key); setNow(null); };
  const save = async (item) => {
    setBusy(item.key);
    try {
      await saveMemo(item, now.tag);
      setSaved((s) => ({ ...s, [item.key]: true }));
      toast('思考メモに保存しました', { kind: 'success' });
      if (item.key === now.cur.key) setTimeout(close, 900);
    } catch (e) {
      toast(navigator.onLine === false ? '圏外のようです。つながってからもう一度どうぞ。' : '保存できませんでした。もう一度どうぞ。', { kind: 'error' });
    } finally {
      setBusy('');
    }
  };
  const row = (item, main) => html`<div className=${'asn-item' + (main ? ' is-main' : '')} key=${item.key}>
    <div className="asn-label">${main ? 'いま聞いていた話' : 'ひとつ前の話'} ・ ${item.name} ${item.n}本目</div>
    <div className="asn-title">${item.title}</div>
    <button className=${'btn ' + (main ? 'btn-primary btn-lg' : 'btn-sm')} disabled=${!!busy || saved[item.key]} onClick=${() => save(item)}>
      ${saved[item.key] ? '保存しました' : busy === item.key ? '保存しています…' : '思考メモに保存'}
    </button>
  </div>`;

  return html`<${Sheet} open=${true} onClose=${close} title="あさよみから">
    <div className="asn">
      ${row(now.cur, true)}
      ${now.prev && now.prev.key !== now.cur.key ? row(now.prev, false) : null}
      <button className="btn btn-ghost asn-close" onClick=${close}>ひきがたりを使う</button>
    </div>
  </${Sheet}>`;
}
