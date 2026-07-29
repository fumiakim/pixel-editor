// ギャラリーAPI 共通処理。
//   ・パスワード認証（署名付きCookie）
//   ・Upstash Redis(REST) への読み書き
// ファイル名が _ 始まりなので Vercel のルーティング対象にはならない。
const crypto = require('node:crypto');

const COOKIE = 'dot-auth';
const SESSION_DAYS = 30;

/* ---------------- 署名付きセッション ---------------- */
function secret() {
  const s = process.env.APP_AUTH_SECRET;
  if (!s) throw new Error('APP_AUTH_SECRET が未設定です');
  return s;
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot), mac = token.slice(dot + 1);
  let expect;
  try { expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }
  catch { return null; }
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
function sessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return `${COOKIE}=${sign({ exp })}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const isAuthed = req => !!verify(readCookie(req, COOKIE));

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: 'unauthorized', message: 'パスワードを入力してください。' });
  return false;
}

/* ---------------- Upstash Redis (REST) ---------------- */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const kvReady = !!(KV_URL && KV_TOKEN);

async function redis(...cmd) {
  if (!kvReady) {
    const e = new Error('保存先が未設定です。Vercel に KV_REST_API_URL / KV_REST_API_TOKEN を設定してください。');
    e.setup = true;
    throw e;
  }
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(v => String(v))),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `KV error ${r.status}`);
  return j.result;
}

/* ---------------- 総当たり対策（IPごとの失敗回数） ---------------- */
const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

async function tooManyFailures(req) {
  if (!kvReady) return false;                      // 保存先が無いときは素通り
  try { return Number(await redis('GET', `dot:fail:${clientIp(req)}`)) >= 10; }
  catch { return false; }
}
async function noteFailure(req) {
  if (!kvReady) return;
  try {
    const key = `dot:fail:${clientIp(req)}`;
    await redis('INCR', key);
    await redis('EXPIRE', key, 600);               // 10分で解除
  } catch { /* 記録できなくてもログイン処理は続ける */ }
}
async function clearFailures(req) {
  if (!kvReady) return;
  try { await redis('DEL', `dot:fail:${clientIp(req)}`); } catch { /* noop */ }
}

module.exports = {
  COOKIE, sign, verify, sessionCookie, clearCookie, readCookie,
  isAuthed, requireAuth, redis, kvReady,
  tooManyFailures, noteFailure, clearFailures,
};
