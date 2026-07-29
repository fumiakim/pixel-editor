// GET    /api/gallery      … 投稿一覧（新しい順）
// POST   /api/gallery      … 投稿（本文は圧縮済みのプロジェクトデータ）
// DELETE /api/gallery?id=… … 削除
// いずれもログイン必須。
const crypto = require('node:crypto');
const { requireAuth, redis } = require('./_lib.js');

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
      const ids = (await redis('ZRANGE', 'dot:gallery', 0, MAX_ITEMS - 1, 'REV')) || [];
      if (!ids.length) return res.status(200).json({ items: [] });
      const raw = await redis('MGET', ...ids.map(id => `dot:work:${id}`));
      const items = (raw || [])
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);
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
      await redis('SET', `dot:work:${item.id}`, JSON.stringify(item));
      await redis('ZADD', 'dot:gallery', item.createdAt, item.id);

      // 上限を超えた古い投稿を掃除
      const over = (await redis('ZRANGE', 'dot:gallery', 0, -MAX_ITEMS - 1)) || [];
      for (const id of over) {
        await redis('DEL', `dot:work:${id}`);
        await redis('ZREM', 'dot:gallery', id);
      }
      return res.status(200).json({ ok: true, item });
    }

    /* ---------------- 削除 ---------------- */
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!id) return res.status(400).json({ error: 'missing_id' });
      await redis('DEL', `dot:work:${id}`);
      await redis('ZREM', 'dot:gallery', id);
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
