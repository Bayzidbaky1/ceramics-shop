// Helpers for accounts and payments. Uses only Node's built-in crypto.
const crypto = require('crypto');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Read the cookies of a request into a plain object.
const cookies = q => {
  const out = {};
  for (const part of (q.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ } }
  }
  return out;
};

// Passwords are stored as salt:scrypt-hash, never as plain text.
const scrypt = (p, salt) => new Promise((res, rej) => crypto.scrypt(p, salt, 64, (e, k) => e ? rej(e) : res(k)));
async function hashPw(p) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + (await scrypt(p, salt)).toString('hex'); }
async function checkPw(p, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const k = await scrypt(p, Buffer.from(s, 'hex')), hb = Buffer.from(h, 'hex');
  return hb.length === k.length && crypto.timingSafeEqual(hb, k);
}

// Slow down password guessing: 8 failed sign-ins per 15 minutes for each IP and email.
const tries = new Map();
const limited = key => { const now = Date.now(), a = (tries.get(key) || []).filter(t => now - t < 15 * 60e3); tries.set(key, a); return a.length >= 8; };
const fail = key => { if (tries.size > 5000) tries.clear(); const a = tries.get(key) || []; a.push(Date.now()); tries.set(key, a); };

// The server never sees a card number. The browser sends only the brand and the last 4 digits.
function parsePayment(p) {
  p = p || {};
  if (p.method === 'cod') return { method: 'cod', status: 'pay on delivery', brand: null, last4: null };
  if (p.method === 'card' && /^\d{4}$/.test(p.last4 || '') && ['Visa', 'Mastercard', 'American Express'].includes(p.brand))
    return { method: 'card', status: 'paid (test)', brand: p.brand, last4: p.last4 };
  throw bad('Choose a payment method');
}

// Product images arrive as a data URL. Only real JPEG, PNG or WebP files are accepted (never SVG or HTML).
function readImage(data) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(data || ''));
  if (!m) throw bad('Add a product image (JPG, PNG or WebP)');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 1.5e6) throw bad('The image is too large (maximum 1.5 MB)');
  const type = buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
    : buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
    : (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ? 'image/webp' : null;
  if (!type) throw bad('That file is not a valid image');
  return { buf, type };
}
const slugOf = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
module.exports = { sha, cookies, hashPw, checkPw, limited, fail, parsePayment, readImage, slugOf, bad };
