// GET    /api/login … いまログイン済みかを返す
// POST   /api/login … { password } を照合してセッションCookieを発行
// DELETE /api/login … ログアウト
const crypto = require('node:crypto');
const {
  sessionCookie, clearCookie, isAuthed,
  tooManyFailures, noteFailure, clearFailures, storeReady,
} = require('./_lib.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ authed: isAuthed(req), storage: storeReady });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ authed: false });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const expected = process.env.APP_PASSWORD;
  if (!expected || !process.env.APP_AUTH_SECRET) {
    return res.status(500).json({
      error: 'not_configured',
      message: 'サーバーに APP_PASSWORD / APP_AUTH_SECRET が設定されていません。',
    });
  }
  if (tooManyFailures(req)) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: '入力をまちがえた回数が多すぎます。10分ほど待ってからやり直してください。',
    });
  }

  const given = String((req.body && req.body.password) || '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    await noteFailure(req);
    return res.status(401).json({ error: 'bad_password', message: 'パスワードがちがいます。' });
  }

  clearFailures(req);
  res.setHeader('Set-Cookie', sessionCookie());
  return res.status(200).json({ authed: true, storage: storeReady });
};
