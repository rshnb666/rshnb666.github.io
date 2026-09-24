// ============================================================
//  rshnb666 视频 App 鉴权后端 (Cloudflare Worker) v1
//  接口：
//    POST /api/register  {u, p}           注册（密码 PBKDF2 加盐哈希）
//    POST /api/login     {u, p}           登录 -> 返回签名令牌
//    POST /api/me        {token}          校验令牌
//    GET  /api/health                      {"ok":true,"v":"v1"}
//  密钥（Settings -> Variables and Secrets）：
//    SESSIONKEY   任意长随机字符串（令牌签名用）
//    APPKEY       任意字符串（用户账本加密密钥）
//    GH_TOKEN     GitHub fine-grained token（仓库 Contents 读写）
//    REPO         rshnb666/rshnb666.github.io
//  用户账本：加密存于仓库 app/users.enc.json（git 管线写入）
// ============================================================

let SESSIONKEY = '', APPKEY = '', GH_TOKEN = '', REPO = '';

const CORS = {
  'Access-Control-Allow-Origin': 'https://rshnb666.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS),
  });
}

// ---- base64 工具（修复版：encode 一定过 btoa；decode 纯手写不依赖 atob）----
function b64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64decode(str) {
  const clean = String(str).replace(/\s+/g, '');
  let s = clean;
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = [];
  let bits = 0, acc = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '=') break;
    const v = tbl.indexOf(ch);
    if (v < 0) throw new Error('b64char[' + ch + ']@' + i);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xFF); }
  }
  return new Uint8Array(out);
}
function b64url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- 加密（AES-CBC + PBKDF2-SHA256）----
async function aesKey(pw, saltU8, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltU8.buffer, iterations: iter, hash: 'SHA-256' },
    km, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encText(plain, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const iter = 4096;
  const key = await aesKey(pw, salt, iter);
  const buf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv.buffer }, key, new TextEncoder().encode(plain));
  return JSON.stringify({ alg: 'AES-CBC', kdf: 'PBKDF2-SHA256', iter: iter, salt: b64encode(new Uint8Array(salt.br ?? salt)), iv: b64encode(new Uint8Array(iv.buffer)), data: b64encode(new Uint8Array(buf)) });
}
async function decText(encJson, pw) {
  const o = JSON.parse(encJson);
  const key = await aesKey(pw, b64decode(o.salt), o.iter);
  const buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: b64decode(o.iv).buffer }, key, b64decode(o.data).buffer);
  return new TextDecoder().decode(buf);
}

// ---- 密码哈希（PBKDF2-SHA256, 16B 随机盐）----
async function hashPw(password, saltU8) {
  const key = await aesKey(password, saltU8, 4096);
  return key;
}
async function pwDigest(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const raw = await crypto.subtle.exportKey('raw', await hashPw(password, salt));
  return { salt: b64encode(new Uint8Array(salt.buffer ?? salt)), hash: b64encode(new Uint8Array(raw)) };
}
async function pwVerify(password, saltB64, hashB64) {
  const raw = await crypto.subtle.exportKey('raw', await hashPw(password, b64decode(saltB64)));
  const got = b64encode(new Uint8Array(raw));
  const want = String(hashB64);
  return got === want;
}

// ---- GitHub 读写（contents 读 + git 管线写）----
async function ghGetText(path) {
  const r = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    headers: { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'rshnb-app-worker', Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
  });
  if (!r.ok) { const e = new Error('APIGET-' + path + '-' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return new TextDecoder().decode(b64decode(String(j.content || '')));
}
async function ghWriteFile(path, text, message) {
  const hd = { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'rshnb-app-worker', 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' };
  const br = await fetch('https://api.github.com/repos/' + REPO + '/git/blobs', { method: 'POST', headers: hd, body: JSON.stringify({ content: text, encoding: 'utf-8' }) });
  if (!br.ok) throw new Error('git blob -> ' + br.status);
  const blobSha = (await br.json()).sha;
  let baseTree = null, head = null;
  const rr = await fetch('https://api.github.com/repos/' + REPO + '/git/ref/heads/main', { method: 'GET', headers: hd });
  if (rr.ok) {
    head = (await rr.json()).object.sha;
    const cr = await fetch('https://api.github.com/repos/' + REPO + '/git/commits/' + head, { method: 'GET', headers: hd });
    if (cr.ok) baseTree = (await cr.json()).tree.sha;
  }
  const tr = await fetch('https://api.github.com/repos/' + REPO + '/git/trees', { method: 'POST', headers: hd, body: JSON.stringify({ base_tree: baseTree, tree: [{ path: path, mode: '100644', type: 'blob', sha: blobSha }] }) });
  if (!tr.ok) throw new Error('git tree -> ' + tr.status);
  const treeSha = (await tr.json()).sha;
  const cm = await fetch('https://api.github.com/repos/' + REPO + '/git/commits', { method: 'POST', headers: hd, body: JSON.stringify({ message: message, tree: treeSha, parents: head ? [head] : [] }) });
  if (!cm.ok) throw new Error('git commit -> ' + cm.status);
  const commitSha = (await cm.json()).sha;
  const up = await fetch('https://api.github.com/repos/' + REPO + '/git/refs/heads/main', { method: 'PATCH', headers: hd, body: JSON.stringify({ sha: commitSha, force: true }) });
  if (!up.ok) throw new Error('git ref -> ' + up.status);
  return true;
}

// ---- 用户账本 ----
const USERS_PATH = 'app/users.enc.json';
async function loadUsers() {
  try { return JSON.parse(await decText(await ghGetText(USERS_PATH), APPKEY)); }
  catch (e) { return {}; }
}
async function saveUsers(users, msg) {
  await ghWriteFile(USERS_PATH, await encText(JSON.stringify(users), APPKEY), msg || 'update users');
}

// ---- 令牌 ----
async function makeToken(user) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: user, e: Date.now() + 7 * 24 * 3600 * 1000 })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSIONKEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return payload + '.' + b64url(new Uint8Array(sig));
}
async function verifyToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSIONKEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
    if (b64url(new Uint8Array(sig)) !== parts[1]) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64decode(parts[0].replace(/-/g, '+').replace(/_/g, '/'))));
    if (!payload.u || payload.e < Date.now()) return null;
    return payload.u;
  } catch (e) { return null; }
}

// ---- 限流（内存）----
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < 60000; });
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

export default {
  async fetch(request, env) {
    SESSIONKEY = String(env.SESSIONKEY || '');
    APPKEY = String(env.APPKEY || '');
    GH_TOKEN = String(env.GH_TOKEN || '');
    REPO = String(env.REPO || 'rshnb666/rshnb666.github.io');

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip)) return jsonRes({ error: '请求太频繁，请稍后再试' }, 429);

    try {
      if (path === '/api/health') return jsonRes({ ok: true, v: 'v1' });

      if (path === '/api/register' && request.method === 'POST') {
        const b = await request.json();
        const u = String(b.u || '').trim();
        const p = String(b.p || '');
        if (u.length < 2 || u.length > 20) return jsonRes({ error: '用户名需 2-20 个字符' }, 400);
        if (p.length < 6) return jsonRes({ error: '密码至少 6 位' }, 400);
        const users = await loadUsers();
        if (users[u]) return jsonRes({ error: '用户名已存在' }, 409);
        const d = await pwDigest(p);
        users[u] = { name: u, ts: Date.now(), salt: d.salt, hash: d.hash };
        await saveUsers(users, 'register user ' + u);
        const token = await makeToken(u);
        return jsonRes({ ok: true, user: u, token: token });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const b = await request.json();
        const u = String(b.u || '').trim();
        const p = String(b.p || '');
        const users = await loadUsers();
        const rec = users[u];
        if (!rec) return jsonRes({ error: '用户不存在' }, 404);
        if (!(await pwVerify(p, rec.salt, rec.hash))) return jsonRes({ error: '密码错误' }, 403);
        const token = await makeToken(u);
        return jsonRes({ ok: true, user: u, token: token });
      }

      if (path === '/api/me' && request.method === 'POST') {
        const b = await request.json();
        const u = await verifyToken(b && b.token);
        if (!u) return jsonRes({ error: '令牌无效或已过期' }, 401);
        return jsonRes({ ok: true, user: u });
      }

      return jsonRes({ error: '接口不存在: ' + path }, 404);
    } catch (e) {
      return jsonRes({ error: '服务错误: ' + String(e && e.message || e).slice(0, 180) }, 500);
    }
  },
};