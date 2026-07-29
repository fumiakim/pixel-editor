// GET    /api/gallery      … 投稿一覧（新しい順）
// POST   /api/gallery      … 投稿
// DELETE /api/gallery?id=… … 削除
// いずれもログイン必須。
const crypto = require('node:crypto');
const { requireAuth, listWorks, saveWork, deleteWorks, PREFIX } = require('./_lib.js');

const MAX_ITEMS = 60;          // ギャラリーに残す件数（古いものから消える）
const MAX_DATA = 40000;        // 1件あたりの圧縮データ長（base64・約30KB）
const MAX_SIDE = 128;          // 投稿できるキャンバスの1辺の上限

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAuth(req, res)) return;

  try {
    /* ---------------- 一覧 ---------------- */
    if (req.method === 'GET') {
      const { items, blobs, errors } = await listWorks(MAX_ITEMS);
      // ?debug=1 は原因調査用（ログイン済みの人だけが見られる）
      if (req.query && req.query.debug) {
        return res.status(200).json({ items: items.length, found: blobs.length, errors });
      }
      return res.status(200).json({ items });
    }

    /* ---------------- 投稿 ---------------- */
    if (req.method === 'POST') {
      const b = req.body || {};
      const w = Number(b.w) | 0, h = Number(b.h) | 0, frames = Number(b.frames) | 0;
      const data = String(b.data || '');

      if (!w || !h || w > MAX_SIDE || h > MAX_SIDE) {
        return res.status(400).json({
          error: 'too_large',
          message: `ギャラリーに投稿できるのは ${MAX_SIDE}×${MAX_SIDE}px までです（いまの絵は ${w}×${h}px）。`,
        });
      }
      if (!data || data.length > MAX_DATA || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return res.status(400).json({ error: 'bad_data', message: 'データが大きすぎるか、こわれています。' });
      }

      const item = {
        id: crypto.randomUUID(),
        title: clean(b.title, 24) || 'むだい',
        author: clean(b.author, 16) || 'ななし',
        w, h, frames: Math.max(1, Math.min(10, frames)),
        createdAt: Date.now(),
        data,
      };
      await saveWork(item);

      // 上限を超えた古い投稿を掃除
      const { blobs } = await listWorks(0);
      const over = blobs.slice(MAX_ITEMS).map(x => x.url);
      if (over.length) await deleteWorks(over);

      return res.status(200).json({ ok: true, item: { ...item, data: undefined } });
    }

    /* ---------------- 削除 ---------------- */
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!/^[a-f0-9-]{10,64}$/i.test(id)) return res.status(400).json({ error: 'bad_id' });
      const { blobs } = await listWorks(0);
      const hit = blobs.filter(x => x.pathname === `${PREFIX}${id}.json`).map(x => x.url);
      if (!hit.length) return res.status(404).json({ error: 'not_found', message: '見つかりませんでした。' });
      await deleteWorks(hit);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(e.setup ? 503 : 500).json({
      error: e.setup ? 'no_storage' : 'server_error',
      message: e.message || 'サーバーでエラーが起きました。',
    });
  }
};
