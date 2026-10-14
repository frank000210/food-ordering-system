'use strict';
/**
 * Tiny dependency-free HTTP router built on node:http.
 * Supports path params (/items/:id), JSON bodies, static files and middleware.
 */
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function compile(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
  return { re: new RegExp(`^${re}$`), keys };
}

function enhance(req, res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    const body = JSON.stringify(data);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
  };
  res.send = (body) => res.end(body);
  res.redirect = (location) => { res.statusCode = 302; res.setHeader('Location', location); res.end(); };
  req.is = (type) => String(req.headers['content-type'] || '').toLowerCase().startsWith(type);
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '請求內容過大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createRouter() {
  const routes = [];
  const middleware = [];

  const add = (method) => (pattern, handler) => routes.push({ method, ...compile(pattern), handler });

  function serveStatic(root, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel = decodeURIComponent(req.path);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) && file !== root) return false;
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    let stat;
    try { stat = fs.statSync(file); } catch { return false; }
    if (stat.isDirectory()) {
      res.redirect(req.path + '/');
      return true;
    }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
  }

  let staticRoot = null;
  let errorHandler = null;

  async function handle(req, res) {
    enhance(req, res);
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.params = {};
    req.body = {};
    try {
      for (const mw of middleware) {
        if (!req.path.startsWith(mw.prefix)) continue;
        let proceed = false;
        await mw.fn(req, res, () => { proceed = true; });
        if (!proceed || res.writableEnded) return;
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req);
        if (raw && req.is('application/json')) {
          try { req.body = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON 格式錯誤'); }
        }
      }
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
        await r.handler(req, res);
        return;
      }
      if (staticRoot && serveStatic(staticRoot, req, res)) return;
      if (pathMatched) throw new HttpError(405, '不支援此方法');
      throw new HttpError(404, req.path.startsWith('/api/') ? '找不到此 API' : '找不到頁面');
    } catch (err) {
      if (errorHandler) errorHandler(err, req, res);
      else { res.statusCode = err.status || 500; res.end(String(err.message)); }
    }
  }

  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    use(prefix, fn) { middleware.push({ prefix, fn }); },
    static(root) { staticRoot = path.resolve(root); },
    onError(fn) { errorHandler = fn; },
    handle,
  };
}

module.exports = { createRouter, HttpError };
