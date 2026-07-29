// ギャラリーAPI 共通処理。
//   ・合言葉によるログイン（署名付き HttpOnly Cookie）
//   ・Vercel Blob（private ストア）への読み書き
// ファイル名が _ 始まりなので Vercel のルーティング対象にはならない。
const crypto = require('node:crypto');
const { put, list, del, get } = require('@vercel/blob');

const COOKIE = 'dot-auth';
const SESSION_DAYS = 30;
const PREFIX = 'works/';

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

/* ---------------- 総当たり対策 ----------------
   実行インスタンス内のメモリで数える簡易版。インスタンスが入れ替わると
   リセットされるので万全ではないが、失敗のたびに待たせることで
   短時間に大量に試す行為を実質的に止める。                        */
const fails = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tooManyFailures(req) {
  const f = fails.get(clientIp(req));
  return !!(f && f.n >= 10 && Date.now() < f.until);
}
async function noteFailure(req) {
  const ip = clientIp(req);
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + 10 * 60 * 1000;
  fails.set(ip, f);
  if (fails.size > 500) fails.clear();          // 際限なく増えないように
  await sleep(700);                             // 失敗するたびに待たせる
}
const clearFailures = req => { fails.delete(clientIp(req)); };

/* ---------------- 保存先（Vercel Blob） ---------------- */
const storeReady = !!process.env.BLOB_READ_WRITE_TOKEN;
function ensureStore() {
  if (storeReady) return;
  const e = new Error('保存先が未設定です。Vercel のプロジェクトに Blob ストアを接続してください。');
  e.setup = true;
  throw e;
}

// SDK の戻り値の形は環境で差があるため、取り出せる経路を順に試す。
async function readBlobText(b) {
  const r = await get(b.pathname, { access: 'private', useCache: false });
  if (!r) throw new Error('get() が null を返しました');
  if (r.blob && typeof r.blob.text === 'function') return await r.blob.text();
  if (r.stream) return await new Response(r.stream).text();
  if (r.body) return await new Response(r.body).text();
  const res = await fetch(b.url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`直接取得も失敗 HTTP ${res.status}`);
  return await res.text();
}

async function listWorks(limit) {
  ensureStore();
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));   // 新しい順
  const take = blobs.slice(0, limit);
  const errors = [];
  const items = await Promise.all(take.map(async b => {
    try { return JSON.parse(await readBlobText(b)); }
    catch (e) { errors.push(`${b.pathname}: ${e.message}`); return null; }
  }));
  return { items: items.filter(Boolean), blobs, errors };
}
async function saveWork(item) {
  ensureStore();
  await put(`${PREFIX}${item.id}.json`, JSON.stringify(item), {
    access: 'private', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true,
  });
}
async function deleteWorks(urls) {
  ensureStore();
  if (urls.length) await del(urls);
}

module.exports = {
  COOKIE, sign, verify, sessionCookie, clearCookie, readCookie,
  isAuthed, requireAuth,
  tooManyFailures, noteFailure, clearFailures,
  storeReady, listWorks, saveWork, deleteWorks, PREFIX,
};
