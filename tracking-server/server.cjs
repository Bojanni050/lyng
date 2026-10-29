#!/usr/bin/env node
/**
 * tracking-server — self-hosted replacement for link.getmailspring.com
 *
 * Endpoints the Mailspring client expects (see app/internal_packages/{open,link}-tracking):
 *   GET /o/<token>.png          tracking pixel; token = base64url(JSON{messageId,accountId,recipient})
 *   GET /link/<messageId>/<i>   link redirect; ?redirect=<url-encoded target>
 *   GET /api/tracked            aggregate counts the fork polls back into message metadata
 *
 * No dependencies: node:http + a JSON file. Node >= 18.
 *
 * Env: PORT (5199), BIND (127.0.0.1), DATA_FILE (./tracking-data.json), API_TOKEN (optional
 * bearer for /api/* writes — the client sends it as Authorization or ?token=), SHARE_TOKEN
 * (optional bearer that additionally unlocks /api/share/* writes so tracking can stay open),
 * SHARE_DIR (./shared-data) for thread-sharing uploads.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 5199);
const BIND = process.env.BIND || '127.0.0.1';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'tracking-data.json'));
const API_TOKEN = process.env.API_TOKEN || '';
/** Extra token for share uploads only. Without it, share access follows API_TOKEN. */
const SHARE_TOKEN = process.env.SHARE_TOKEN || '';
const SHARE_DIR = path.resolve(process.env.SHARE_DIR || path.join(__dirname, 'shared-data'));
fs.mkdirSync(SHARE_DIR, { recursive: true });

// 1x1 transparent GIF-sized PNG, the same shape every tracking pixel uses.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ---------------------------------------------------------------- persistence

let db = { messages: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db.messages) db.messages = {};
} catch {
  /* first boot */
}

let dirty = false;
function touch() {
  dirty = true;
}
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}, 1000).unref();

function entry(messageId, accountId) {
  let e = db.messages[messageId];
  if (!e) {
    e = { messageId, accountId: accountId || null, opens: {}, links: {}, createdAt: new Date().toISOString() };
    db.messages[messageId] = e;
  }
  if (accountId && !e.accountId) e.accountId = accountId;
  return e;
}

// ---------------------------------------------------------------- helpers

function decodeToken(token) {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function pixel(res) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': PIXEL.length,
    'cache-control': 'no-store, no-cache, must-revalidate, private',
    pragma: 'no-cache',
  });
  res.end(PIXEL);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function authorized(req, url) {
  if (!API_TOKEN) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === API_TOKEN || url.searchParams.get('token') === API_TOKEN;
}

/**
 * Share uploads carry full thread bodies and attachments, so they deserve their own key
 * even when anonymous open/click counting stays open: SHARE_TOKEN guards only the share
 * endpoints, and while it is set it is the ONLY key to them (the API_TOKEN is unaffected).
 * With no SHARE_TOKEN set the API_TOKEN rules apply unchanged, which keeps deployments
 * that already gate everything on API_TOKEN working.
 */
function shareAuthorized(req, url) {
  if (!SHARE_TOKEN) return authorized(req, url);
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === SHARE_TOKEN || url.searchParams.get('token') === SHARE_TOKEN;
}

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  ics: 'text/calendar',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

function contentTypeFor(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Gmail/Outlook proxy images through their own caches; those "opens" are not a human.
const PROXY_UA = /googleimageproxy|ggpht|outlook|microsoft office|yahoo|proofpoint|mimecast|barracuda/i;

// ---------------------------------------------------------------- thread sharing

// Keys come from the client as `${thread.id}-${Date.now()}`: safe as a filename and as a URL.
const KEY_RE = /^[\w-]{8,200}$/;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_THREAD_JSON_BYTES = 20 * 1024 * 1024;

const CLOSE_HTML = (title, detail) =>
  `<!doctype html><meta charset=utf-8><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:3rem;text-align:center;color:#374151}code{background:#eee;padding:.15rem .35rem;border-radius:4px}</style>
<h2>${esc(title)}</h2><p>${esc(detail)}</p>`;

/** One shared-thread filename segment: never trust the wire to stay inside its own directory. */
function safeSegment(raw, fallback) {
  let value = '';
  try {
    value = decodeURIComponent(String(raw));
  } catch {
    value = String(raw);
  }
  value = value.trim().replace(/[\\/\x00-\x1f]/g, '_').replace(/\s+/g, ' ');
  return value || fallback;
}

/** Turns an attachment link the client stored (`.../s/a/<id>/<name>`) back into a relative path. */
function pathFromShareLink(link) {
  try {
    return path.normalize(decodeURIComponent(String(link).split('/s/a/')[1] || ''));
  } catch {
    return '';
  }
}

/**
 * Streams a request body to disk (assets) or into a buffer (JSON), enforcing a size limit.
 * Files land as `.tmp` first so a killed upload can never leave a half-written shared asset
 * behind with its real name.
 */
function readBody(req, res, limit, outPath = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let handle = null;
    let bytes = 0;
    let ended = false;
    req.on('data', (chunk) => {
      if (ended) return;
      bytes += chunk.length;
      if (bytes > limit) {
        ended = true;
        req.removeAllListeners('data');
        req.resume();
        if (handle !== null) {
          fs.closeSync(handle);
          try {
            fs.unlinkSync(outPath);
          } catch {}
          handle = null;
        }
        json(res, 413, { error: 'payload too large' });
        reject(new Error('too large'));
        return;
      }
      if (outPath) fs.writeSync(handle, chunk);
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (ended) return;
      ended = true;
      if (handle !== null) fs.closeSync(handle);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (handle !== null) {
        fs.closeSync(handle);
        try {
          fs.unlinkSync(outPath);
        } catch {}
      }
      reject(err);
    });
    if (outPath) handle = fs.openSync(outPath, 'w');
  });
}

async function handleShareUpload(req, res, url) {
  const p = url.pathname;
  const assetMatch = p.match(/^\/api\/share\/asset\/(.+)$/);
  const threadMatch = p.match(/^\/api\/share\/thread\/(.+)$/);
  if (!assetMatch && !threadMatch) return json(res, 404, { error: 'not found' });

  if (threadMatch) {
    const key = safeSegment(threadMatch[1], '');
    if (!key || !KEY_RE.test(key)) return json(res, 400, { error: 'invalid share key' });
    let body;
    try {
      body = (await readBody(req, res, MAX_THREAD_JSON_BYTES)).toString('utf8');
    } catch {
      return; // readBody already answered
    }
    const file = path.join(SHARE_DIR, `${key}.json`);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'body is not valid JSON' });
    }
    if (payload && payload.shared !== true) {
      // Unsharing an unknown key is a no-op, not a write.
      if (!fs.existsSync(file)) return json(res, 404, { error: 'unknown share key' });
      // Unsharing: also clear the attachments this payload points at, then remove the page.
      try {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.values(old.fileURLs || {}).forEach((link) => {
          const rel = pathFromShareLink(link);
          if (!rel) return;
          const target = path.resolve(SHARE_DIR, 'a', rel);
          if (target.startsWith(path.join(SHARE_DIR, 'a') + path.sep) && fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
          }
        });
      } catch (err) {
        console.warn('could not clean attachments for %s: %s', key, err);
      }
      fs.rmSync(file, { force: true });
      return json(res, 200, { ok: true, unshared: true });
    }
    fs.writeFileSync(file, body);
    return json(res, 200, { ok: true });
  }

  // Attachment upload: /api/share/asset/<fileId>/<file name>
  const raw = assetMatch[1].split('/').map((seg) => safeSegment(seg, ''));
  if (raw.length !== 2 || !raw[0] || !raw[1]) return json(res, 400, { error: 'invalid asset path' });
  const rel = path.join('a', raw[0], raw[1]);
  const dest = path.resolve(SHARE_DIR, rel);
  if (!dest.startsWith(path.join(SHARE_DIR, 'a') + path.sep)) {
    return json(res, 400, { error: 'invalid asset path' });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await readBody(req, res, MAX_ATTACHMENT_BYTES, `${dest}.tmp`);
  } catch {
    return; // readBody already answered
  }
  fs.renameSync(`${dest}.tmp`, dest);
  return json(res, 200, { ok: true, link: `/s/${rel.replace(/\\/g, '/')}` });
}

function countSharedKeys() {
  return fs.readdirSync(SHARE_DIR).filter((f) => f.endsWith('.json')).length;
}

const SHARE_PAGE_CSS = `
:root{color-scheme:light}
body{font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;background:#f3f4f6;margin:0}
main{max-width:780px;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.4rem;margin:.25rem 0 .75rem;overflow-wrap:anywhere}
.byline{font-size:.9rem;color:#6b7280;margin-bottom:1.5rem}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1rem}
.meta{font-size:.85rem;color:#6b7280;border-bottom:1px solid #f1f3f5;padding-bottom:.5rem;margin-bottom:.75rem}
.meta b{color:#374151}
iframe{width:100%;height:65vh;border:0;display:block}
body.plaintext pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto}
.attachments{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}
.attachments a{display:inline-block;padding:.35rem .65rem;border:1px solid #d1d5db;border-radius:6px;text-decoration:none;font-size:.85rem;color:#374151;max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attachments a:hover{background:#f9fafb}
.byline .who{font-weight:600;color:#111827}
`;

function contactLabel(c) {
  if (!c) return '';
  return c.name || c.emailAddress || '';
}

function contactFull(c) {
  if (!c) return '';
  return c.name ? `${c.name} <${c.emailAddress || ''}>` : c.emailAddress || '';
}

/** timestamp comes through as unix ms (client) — tolerate seconds too */
const shareDate = (value) => {
  if (!value) return '';
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB');
};

function renderMessages(key, payload) {
  const fileURLs = payload.fileURLs || {};
  return (payload.messages || [])
    .map((m) => {
      const from = (m.from || []).map(contactFull).join(', ');
      const to = (m.to || []).map(contactLabel).filter(Boolean).join(', ');
      const cc = (m.cc || []).map(contactLabel).filter(Boolean).join(', ');
      const ccLine = cc ? `<div>Cc: ${esc(cc)}</div>` : '';
      const toLine = to ? `<div>To: ${esc(to)}</div>` : '';
      const bodyHtml = m.plaintext
        ? `<pre>${esc(m.body)}</pre>`
        : `<iframe sandbox srcdoc="${esc(
            (m.body || '').replace(/^<!doctype [\s\S]*?>/i, '')
          )}"></iframe>`;
      const attachments = (m.files || [])
        .filter((f) => f && f.id && fileURLs[f.id])
        .map((f) => {
          const link = pathFromShareLink(fileURLs[f.id]) || `${f.id}/${f.filename || f.id}`;
          const label = f.filename || f.displayName || f.name || f.id;
          return `<a href="/s/a/${link.replace(/\\/g, '/')}" download>${esc(label)}</a>`;
        })
        .join('');
      const attachmentRow = attachments ? `<div class="attachments">${attachments}</div>` : '';
      return `<section class="card">
<div class="meta"><b>${esc(from)}</b>${toLine}${ccLine}<div>${esc(shareDate(m.date))}</div></div>
${bodyHtml}
${attachmentRow}
</section>`;
    })
    .join('\n');
}

function serveShare(req, res, rawPath) {
  // Attachment download: /s/a/<fileId>/<file name>
  if (rawPath.startsWith('/s/a/')) {
    const rest = rawPath.slice(5).split('/').map((seg) => safeSegment(seg, '')).filter(Boolean);
    if (rest.length !== 2) return json(res, 404, { error: 'not found' });
    const rel = ['a', ...rest];
    const dest = path.resolve(SHARE_DIR, path.join(...rel));
    if (!dest.startsWith(path.join(SHARE_DIR, 'a') + path.sep) || !fs.existsSync(dest)) {
      return json(res, 404, { error: 'not found' });
    }
    const name = rel[rel.length - 1];
    const stat = fs.statSync(dest);
    res.writeHead(200, {
      'content-type': contentTypeFor(name),
      'content-length': stat.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(dest).pipe(res);
    return;
  }

  // Shared thread page: /s/<key>
  const key = decodeURIComponent(rawPath.slice(3));
  const file = path.join(SHARE_DIR, `${KEY_RE.test(key) ? key : ''}.json`);
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* fall through to the "no longer shared" page */
  }
  if (!payload || payload.shared !== true) {
    return sendHtml(
      res,
      CLOSE_HTML('No longer shared', 'The person who shared this thread has removed it.'),
      404
    );
  }
  const subject = payload.thread?.subject || 'Shared thread';
  const by = payload.sharedBy || {};
  const caller = [by.firstName, by.lastName].filter(Boolean).join(' ') || by.emailAddress || 'Someone';
  sendHtml(res, `<!doctype html><meta charset=utf-8><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title>
<style>${SHARE_PAGE_CSS}</style>
<main><h1>${esc(subject)}</h1>
<p class="byline">Shared on ${esc(shareDate(Date.now()))} by <span class="who">${esc(caller)}</span>${
    caller !== by.emailAddress && by.emailAddress ? ` (${esc(by.emailAddress)})` : ''
  }</p>
${renderMessages(key, payload)}
</main>`);
}

function sendHtml(res, html, code = 200) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "frame-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

// ---------------------------------------------------------------- routes

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/health') return json(res, 200, { ok: true, tracked: Object.keys(db.messages).length, sharedKeys: countSharedKeys() });

  // ---- thread-sharing viewer
  if (p.startsWith('/s/')) {
    return serveShare(req, res, p);
  }

  if (p.startsWith('/api/share/') && req.method === 'POST') {
    if (!shareAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
    handleShareUpload(req, res, url).catch((err) =>
      json(res, 500, { error: err && err.message ? err.message : 'upload failed' })
    );
    return;
  }

  // ---- tracking pixel
  if (p.startsWith('/o/')) {
    const token = p.slice(3).replace(/\.png$/i, '');
    const t = decodeToken(token);
    if (!t || !t.messageId) return pixel(res);
    const e = entry(t.messageId, t.accountId);
    const key = (t.recipient || 'unknown').toLowerCase();
    const o = (e.opens[key] ||= { count: 0, first: null, last: null, proxyHits: 0, uas: [] });
    const ua = String(req.headers['user-agent'] || '');
    const proxy = PROXY_UA.test(ua);
    o.count += 1;
    if (proxy) o.proxyHits += 1;
    o.first ||= new Date().toISOString();
    o.last = new Date().toISOString();
    if (ua && !o.uas.includes(ua.slice(0, 120))) o.uas = [...o.uas.slice(-4), ua.slice(0, 120)];
    touch();
    if (process.env.VERBOSE) console.log(`open ${t.messageId} ${key}${proxy ? ' (proxy)' : ''}`);
    return pixel(res);
  }

  // ---- link redirect: /link/<messageId>/<index>?redirect=<url>
  if (p.startsWith('/link/')) {
    // The client interpolates the raw Message-ID into the path (`<id@host>`), so the
    // segments arrive percent-encoded — decode them or clicks land under a different
    // key than the opens for the same message.
    const seg = p.split('/').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    const messageId = seg[2] || '';
    const idxRaw = seg[3] || '0';
    const target = url.searchParams.get('redirect');
    let ok = false;
    try {
      const u = new URL(target);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) return json(res, 400, { error: 'missing or invalid redirect target' });

    const e = entry(messageId);
    const idx = Number(idxRaw);
    const l = (e.links[idx] ||= { url: target, clicks: [] });
    // The composer appends `&recipient=<base64(email)>` to each per-recipient link.
    let rcpt = '';
    const rawRcpt = url.searchParams.get('recipient');
    if (rawRcpt) {
      try {
        rcpt = Buffer.from(rawRcpt, 'base64').toString('utf8').trim().toLowerCase();
      } catch {
        rcpt = '';
      }
    }
    l.clicks.push({
      at: new Date().toISOString(),
      recipient: rcpt || null,
      ua: String(req.headers['user-agent'] || '').slice(0, 120),
    });
    if (l.clicks.length > 200) l.clicks = l.clicks.slice(-200);
    touch();
    res.writeHead(302, { location: target, 'cache-control': 'no-store' });
    return res.end();
  }

  // ---- aggregate for the client poller
  if (p === '/api/tracked') {
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
    const accountId = url.searchParams.get('accountId');
    const messages = Object.values(db.messages)
      .filter((e) => !accountId || e.accountId === accountId)
      .map((e) => {
        const recipients = Object.entries(e.opens).map(([email, o]) => ({
          email,
          count: o.count,
          proxyHits: o.proxyHits || 0,
          firstOpenAt: o.first,
          lastOpenAt: o.last,
        }));
        const opens = recipients.reduce((n, r) => n + r.count, 0);
        const lastOpenAt = recipients.map((r) => r.lastOpenAt).filter(Boolean).sort().pop() || null;
        // open_data: [{recipient, timestamp(unix seconds)}] — the shape the popover renders.
        const openData = Object.entries(e.opens)
          .flatMap(([email, o]) =>
            Array.from({ length: o.count }, () => ({
              recipient: email,
              timestamp: Math.round(new Date(o.last).getTime() / 1000),
            }))
          )
          .slice(-50);
        return {
          messageId: e.messageId,
          accountId: e.accountId,
          opens,
          lastOpenAt,
          recipients,
          openData,
          links: Object.entries(e.links).map(([index, l]) => ({
            index: Number(index),
            url: l.url,
            clickCount: l.clicks.length,
            lastClickAt: l.clicks.length ? l.clicks[l.clicks.length - 1].at : null,
            clickData: l.clicks.slice(-50).map((c) => ({
              recipient: c.recipient || 'unknown',
              timestamp: Math.round(new Date(c.at).getTime() / 1000),
            })),
          })),
        };
      });
    return json(res, 200, { messages });
  }

  if (p === '/') {
    const rows = Object.values(db.messages)
      .map((e) => {
        const opens = Object.values(e.opens).reduce((n, o) => n + o.count, 0);
        const clicks = Object.values(e.links).reduce((n, l) => n + l.clicks.length, 0);
        return `<tr><td><code>${e.messageId}</code></td><td>${opens}</td><td>${clicks}</td></tr>`;
      })
      .join('');
    const html = `<!doctype html><meta charset=utf-8><title>tracking</title>
<style>body{font:14px system-ui;margin:2rem}td,th{padding:.25rem .75rem;text-align:left;border-bottom:1px solid #ddd}</style>
<h1>Tracking</h1><p>${Object.keys(db.messages).length} berichten gevolgd.</p>
<table><tr><th>message-id</th><th>opens</th><th>clicks</th></tr>${rows}</table>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, BIND, () => {
  console.log(
    `tracking-server on http://${BIND}:${PORT}  data=${DATA_FILE}` +
      `${API_TOKEN ? '  (api token required)' : ''}${SHARE_TOKEN ? '  (share token required)' : ''}`
  );
});
