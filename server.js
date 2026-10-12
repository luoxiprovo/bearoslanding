// Landing page server. No dependencies.
// Copy .env.example to .env, then run: node server.js
//
// RESEND_API_KEY   key from resend.com
// MAIL_TO          inbox that receives the form
// MAIL_FROM        sender on a domain verified in Resend
// MAIL_FROM_NAME   optional display name, default BearMail
// PORT             optional, default 3000
// TRUST_PROXY      optional, set to 1 behind a proxy

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const BODY_LIMIT = 32_768;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_HITS = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

loadEnv(path.join(root, '.env'));

const hits = new Map();

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, html) {
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function notFound(res) {
  sendText(
    res,
    404,
    '<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Not found</title><p>That page is not here.</p><p><a href="/">BearMail</a></p></html>',
  );
}

function resolvePublic(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const file = path.resolve(publicDir, rel);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return null;
  return file;
}

function serveStatic(req, res) {
  const file = resolvePublic(req.url || '/');
  if (!file) {
    notFound(res);
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      notFound(res);
      return;
    }
    const ext = path.extname(file);
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        failed = true;
        const error = new Error('too large');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim().slice(0, 80);
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((time) => now - time >= WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function stripControls(value) {
  return value.replace(/[\u0000-\u001F\u007F]/g, '');
}

function cleanLine(value, max) {
  return stripControls(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isEmail(value) {
  return value.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function validate(data) {
  const company = cleanLine(asText(data.company), 120);
  const contact = cleanLine(asText(data.contact), 120);
  const email = cleanLine(asText(data.email), 320);
  const phone = cleanLine(asText(data.phone), 40);
  const message = asText(data.message).replace(/\r\n/g, '\n').trim();

  if (!company) return { error: 'Enter your company name.' };
  if (!contact) return { error: 'Enter the contact name.' };
  if (!isEmail(email)) return { error: 'Enter a valid email address.' };
  if (!phone) return { error: 'Enter a phone number.' };
  if (!/^[0-9+().\-\s]+$/.test(phone) || (phone.match(/\d/g) || []).length < 7) {
    return { error: 'Enter a phone number with at least 7 digits.' };
  }
  const cleanMessage = message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (!cleanMessage) return { error: 'Enter a message.' };
  if (cleanMessage.length > 5000) return { error: 'Keep the message under 5000 characters.' };

  return { company, contact, email, phone, message: cleanMessage };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseAddress(raw) {
  const trimmed = String(raw || '').trim();
  const wrapped = trimmed.match(/^(.*)<([^>]+)>$/);
  if (wrapped) {
    return { name: cleanLine(wrapped[1], 70), email: cleanLine(wrapped[2], 320) };
  }
  return { name: '', email: cleanLine(trimmed, 320) };
}

function mailConfig() {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const to = parseAddress(process.env.MAIL_TO).email;
  const from = parseAddress(process.env.MAIL_FROM);
  const fromName = (from.name || cleanLine(process.env.MAIL_FROM_NAME || 'BearMail', 70) || 'BearMail')
    .replace(/[<>"]/g, '')
    .trim();
  if (!apiKey || !isEmail(to) || !isEmail(from.email) || !fromName) return null;
  return {
    apiKey,
    to,
    from: `${fromName} <${from.email}>`,
  };
}

function buildMail(fields) {
  const text = [
    'New inquiry from the BearMail landing page',
    '',
    `Company: ${fields.company}`,
    `Contact: ${fields.contact}`,
    `Email: ${fields.email}`,
    `Phone: ${fields.phone}`,
    '',
    'Message:',
    fields.message,
  ].join('\n');

  const html = [
    '<p>New inquiry from the BearMail landing page</p>',
    `<p><strong>Company</strong><br>${escapeHtml(fields.company)}</p>`,
    `<p><strong>Contact</strong><br>${escapeHtml(fields.contact)}</p>`,
    `<p><strong>Email</strong><br>${escapeHtml(fields.email)}</p>`,
    `<p><strong>Phone</strong><br>${escapeHtml(fields.phone)}</p>`,
    `<p><strong>Message</strong><br>${escapeHtml(fields.message).replaceAll('\n', '<br>')}</p>`,
  ].join('');

  const subject = `BearMail inquiry from ${fields.company}`.slice(0, 150);
  return { text, html, subject };
}

async function sendWithResend(fields) {
  const config = mailConfig();
  if (!config) {
    const error = new Error('mail is not configured');
    error.status = 503;
    throw error;
  }
  const mail = buildMail(fields);
  const response = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      reply_to: fields.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      tags: [{ name: 'source', value: 'landing' }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    console.error('Resend rejected the message', response.status, payload.message || payload.name || '');
    const error = new Error('resend failed');
    error.status = 502;
    throw error;
  }
}

async function handleContact(req, res) {
  const type = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'Send the form as JSON.' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    const status = error.status || 400;
    sendJson(res, status, {
      ok: false,
      error: status === 413 ? 'That message is too large.' : 'The form could not be read.',
    });
    return;
  }

  if (limited(clientIp(req))) {
    sendJson(res, 429, { ok: false, error: 'Too many messages. Try again in a few minutes.' });
    return;
  }

  let data;
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    sendJson(res, 400, { ok: false, error: 'The form could not be read.' });
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    sendJson(res, 400, { ok: false, error: 'The form could not be read.' });
    return;
  }

  if (asText(data.website).trim()) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const fields = validate(data);
  if (fields.error) {
    sendJson(res, 400, { ok: false, error: fields.error });
    return;
  }

  try {
    await sendWithResend(fields);
  } catch (error) {
    if (error.status === 503) {
      console.error('Contact form is missing RESEND_API_KEY, MAIL_TO, or MAIL_FROM');
      sendJson(res, 503, { ok: false, error: 'The contact form is not ready yet.' });
      return;
    }
    if (!error.status) console.error('Contact form failed', error.message);
    sendJson(res, error.status || 502, {
      ok: false,
      error: 'We could not send your message. Try again in a moment.',
    });
    return;
  }

  sendJson(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && pathname === '/api/contact') {
    handleContact(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'We could not send your message. Try again in a moment.' });
      }
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.method === 'HEAD') {
      const file = resolvePublic(req.url || '/');
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        notFound(res);
        return;
      }
      res.writeHead(200, {
        ...securityHeaders(),
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end();
      return;
    }
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders() });
  res.end();
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Landing page at http://localhost:${port}`);
});
