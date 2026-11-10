const express = require('express');
const { pool, init } = require('./db');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = f => (q, r, n) => f(q, r, n).catch(n);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

// Expired holds go back into stock. Runs inside add/checkout, on a timer, and (throttled) on reads.
const releaseExpired = c => c.query(`
  WITH e AS (DELETE FROM holds WHERE expires_at < now() RETURNING product_id)
  UPDATE products p SET stock = p.stock + s.n
  FROM (SELECT product_id, count(*)::int n FROM e GROUP BY 1) s WHERE p.id = s.product_id`);
let last = 0;
const sweep = async () => { if (Date.now() - last < 5000) return; last = Date.now(); await tx(releaseExpired); };

const admin = (q, r, n) => q.get('x-admin-key') === (process.env.ADMIN_KEY || 'admin') ? n() : r.status(401).json({ error: 'Wrong admin key' });

const A = require('./auth');
app.set('trust proxy', 1);
app.use(wrap(async (q, r, n) => {
  const t = A.cookies(q).sid;
  q.user = null;
  if (t) q.user = (await pool.query('SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [A.sha(t)])).rows[0] || null;
  n();
}));
const needUser = (q, r, n) => q.user ? n() : r.status(401).json({ error: 'Please sign in' });
// A signed-in shopper's cart is called u-<id>. Nobody else may open it.
app.param('cart', (q, r, n, v) => (v.startsWith('u-') && !(q.user && v === 'u-' + q.user.id)) ? r.status(403).json({ error: 'Please sign in to use this cart' }) : n());

async function startSession(q, r, userId, guestCart) {
  const t = require('crypto').randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '14 days')`, [A.sha(t), userId]);
  const secure = q.secure || q.get('x-forwarded-proto') === 'https';
  r.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${secure ? '; Secure' : ''}`);
  // Items added as a guest move into the account's cart
  if (typeof guestCart === 'string' && guestCart && !guestCart.startsWith('u-'))
    await pool.query('UPDATE holds SET cart_id = $1 WHERE cart_id = $2 AND expires_at > now()', ['u-' + userId, guestCart]);
}

app.post('/api/auth/signup', wrap(async (q, r) => {
  const name = String(q.body.name || '').trim().slice(0, 80), email = String(q.body.email || '').trim().toLowerCase().slice(0, 120), pw = String(q.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw httpErr(400, 'Enter your name and a valid email');
  if (pw.length < 8 || pw.length > 200) throw httpErr(400, 'Your password must be 8 to 200 characters');
  let u;
  try { u = (await pool.query('INSERT INTO users(name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email', [name, email, await A.hashPw(pw)])).rows[0]; }
  catch (e) { if (e.code === '23505') throw httpErr(409, 'An account with this email already exists'); throw e; }
  await startSession(q, r, u.id, q.body.cartId);
  r.json({ user: u });
}));

app.post('/api/auth/login', wrap(async (q, r) => {
  const email = String(q.body.email || '').trim().toLowerCase().slice(0, 120), pw = String(q.body.password || '').slice(0, 200), key = q.ip + '|' + email;
  if (A.limited(key)) throw httpErr(429, 'Too many attempts. Please try again in 15 minutes.');
  const u = (await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email])).rows[0];
  const ok = u ? await A.checkPw(pw, u.password_hash) : (await A.checkPw(pw, '00:00'), false);
  if (!ok) { A.fail(key); throw httpErr(401, 'Wrong email or password'); }
  await startSession(q, r, u.id, q.body.cartId);
  r.json({ user: { id: u.id, name: u.name, email: u.email } });
}));

app.post('/api/auth/logout', wrap(async (q, r) => {
  const t = A.cookies(q).sid;
  if (t) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [A.sha(t)]);
  r.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  r.json({ ok: true });
}));

app.get('/api/auth/me', (q, r) => r.json({ user: q.user }));

app.get('/api/me/orders', needUser, wrap(async (q, r) => {
  const o = (await pool.query('SELECT id, status, total_cents, created_at, payment_method, payment_status, card_brand, card_last4 FROM orders WHERE user_id = $1 ORDER BY id DESC', [q.user.id])).rows;
  const it = o.length ? (await pool.query('SELECT oi.order_id, p.name, oi.qty, oi.price_cents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1)', [o.map(x => x.id)])).rows : [];
  r.json(o.map(x => ({ ...x, items: it.filter(i => i.order_id === x.id) })));
}));

app.get('/api/health', (q, r) => r.json({ ok: true }));

app.get('/api/drops', wrap(async (q, r) => {
  await sweep();
  const d = await pool.query('SELECT * FROM drops ORDER BY starts_at DESC');
  const p = await pool.query('SELECT id, drop_id, name, artisan, price_cents, stock FROM products ORDER BY id');
  r.json(d.rows.map(x => ({ ...x, products: p.rows.filter(y => y.drop_id === x.id) })));
}));

// Add one unit to a cart. Stock drops atomically, so two buyers can never get the last item.
app.post('/api/cart/:cart/add', wrap(async (q, r) => {
  const productId = q.body.productId;
  if (!Number.isInteger(productId)) throw httpErr(400, 'Invalid product');
  await tx(async c => {
    await releaseExpired(c);
    const u = await c.query(`UPDATE products SET stock = stock - 1
      WHERE id = $1 AND stock > 0 AND drop_id IN (SELECT id FROM drops WHERE starts_at <= now())`, [productId]);
    if (!u.rowCount) throw httpErr(409, 'Sold out, or this drop has not opened yet');
    await c.query(`INSERT INTO holds(cart_id, product_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [q.params.cart, productId]);
  });
  r.json({ ok: true });
}));

app.get('/api/cart/:cart', wrap(async (q, r) => {
  await tx(releaseExpired);
  const x = await pool.query(`SELECT p.id product_id, p.name, p.price_cents, count(*)::int qty, min(h.expires_at) expires_at
    FROM holds h JOIN products p ON p.id = h.product_id WHERE h.cart_id = $1 GROUP BY p.id`, [q.params.cart]);
  r.json({ items: x.rows, total_cents: x.rows.reduce((s, i) => s + i.price_cents * i.qty, 0) });
}));

app.post('/api/checkout', wrap(async (q, r) => {
  const { cartId } = q.body;
  const name = q.user ? q.user.name : String(q.body.name || '').trim().slice(0, 80);
  const email = q.user ? q.user.email : String(q.body.email || '').trim().slice(0, 120);
  if (typeof cartId !== 'string' || !cartId || !name || !/^\S+@\S+$/.test(email)) throw httpErr(400, 'Enter your name and a valid email');
  if (cartId.startsWith('u-') && !(q.user && cartId === 'u-' + q.user.id)) throw httpErr(403, 'Please sign in to check out with this cart');
  const pay = A.parsePayment(q.body.payment);
  const orderId = await tx(async c => {
    await releaseExpired(c);
    // Taking the holds and deleting them is one step, so an expiring hold cannot be sold twice.
    const held = (await c.query('DELETE FROM holds WHERE cart_id = $1 AND expires_at > now() RETURNING product_id', [cartId])).rows;
    if (!held.length) throw httpErr(400, 'Your cart is empty or the hold has expired');
    const qty = {}; held.forEach(h => qty[h.product_id] = (qty[h.product_id] || 0) + 1);
    const prices = (await c.query('SELECT id, price_cents FROM products WHERE id = ANY($1)', [Object.keys(qty).map(Number)])).rows;
    const total = prices.reduce((s, p) => s + p.price_cents * qty[p.id], 0);
    const cu = (await c.query('INSERT INTO customers(name, email) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id', [name, email])).rows[0].id;
    const o = (await c.query('INSERT INTO orders(customer_id, total_cents, user_id, payment_method, payment_status, card_brand, card_last4) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [cu, total, q.user ? q.user.id : null, pay.method, pay.status, pay.brand, pay.last4])).rows[0].id;
    for (const p of prices) await c.query('INSERT INTO order_items(order_id, product_id, qty, price_cents) VALUES ($1, $2, $3, $4)', [o, p.id, qty[p.id], p.price_cents]);
    return o;
  });
  r.json({ orderId });
}));

app.get('/api/orders/:id', wrap(async (q, r) => {
  const id = +q.params.id;
  if (!Number.isInteger(id)) throw httpErr(404, 'Order not found');
  const o = (await pool.query('SELECT o.id, o.status, o.total_cents, o.user_id, o.payment_method, o.payment_status, o.card_brand, o.card_last4, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [id])).rows[0];
  if (!o || (o.user_id && (!q.user || q.user.id !== o.user_id))) throw httpErr(404, 'Order not found');
  delete o.user_id;
  o.items = (await pool.query('SELECT p.name, oi.qty, oi.price_cents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1', [id])).rows;
  r.json(o);
}));

app.get('/api/admin/summary', admin, wrap(async (q, r) => {
  await sweep();
  const drops = await pool.query(`SELECT d.id, d.name, d.starts_at, COALESCE(SUM(oi.qty), 0)::int units, COALESCE(SUM(oi.qty * oi.price_cents), 0)::int revenue_cents
    FROM drops d LEFT JOIN products p ON p.drop_id = d.id LEFT JOIN order_items oi ON oi.product_id = p.id GROUP BY d.id ORDER BY d.starts_at DESC`);
  const products = await pool.query('SELECT p.id, p.name, p.stock, p.price_cents, p.artisan AS category, d.name AS drop FROM products p JOIN drops d ON d.id = p.drop_id ORDER BY d.starts_at DESC, p.id');
  const orders = await pool.query('SELECT o.id, o.status, o.total_cents, o.created_at, o.payment_status, c.email FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 20');
  // Estimate only: monthly bill divided by drops per month. Set both on the server.
  const cost = (+process.env.MONTHLY_COST_USD || 86) / (+process.env.DROPS_PER_MONTH || 4);
  const categories = (await pool.query('SELECT c.name, count(p.id)::int AS products FROM (SELECT name FROM categories UNION SELECT artisan FROM products) c LEFT JOIN products p ON p.artisan = c.name GROUP BY c.name ORDER BY c.name')).rows;
  r.json({ drops: drops.rows, products: products.rows, categories, orders: orders.rows, cost_per_drop_cents: Math.round(cost * 100) });
}));

app.patch('/api/admin/products/:id', admin, wrap(async (q, r) => {
  const stock = q.body.stock;
  if (!Number.isInteger(stock) || stock < 0) throw httpErr(400, 'Stock must be 0 or more');
  await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, q.params.id]);
  r.json({ ok: true });
}));

app.patch('/api/admin/orders/:id', admin, wrap(async (q, r) => {
  if (!['confirmed', 'packed', 'shipped'].includes(q.body.status)) throw httpErr(400, 'Unknown status');
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [q.body.status, q.params.id]);
  r.json({ ok: true });
}));

// Product photos added in the admin are stored in the database and served from /img/<name>.jpg
// (photos that ship with the site are found by express.static first).
const SLUG = "trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))";
app.get('/img/:slug.jpg', wrap(async (q, r) => {
  const x = (await pool.query(`SELECT image, image_type FROM products WHERE image IS NOT NULL AND ${SLUG} = $1 LIMIT 1`, [q.params.slug])).rows[0];
  if (!x) return r.status(404).end();
  r.set({ 'Content-Type': x.image_type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  r.send(x.image);
}));

app.post('/api/admin/drops', admin, wrap(async (q, r) => {
  const name = String(q.body.name || '').trim().slice(0, 80), t = new Date(q.body.starts_at);
  if (!name || isNaN(t)) throw httpErr(400, 'Enter a launch name and when it opens');
  try { r.json({ id: (await pool.query('INSERT INTO drops(name, starts_at) VALUES ($1, $2) RETURNING id', [name, t.toISOString()])).rows[0].id }); }
  catch (e) { if (e.code === '23505') throw httpErr(409, 'A launch with this name already exists'); throw e; }
}));

app.post('/api/admin/products', admin, wrap(async (q, r) => {
  const name = String(q.body.name || '').trim().slice(0, 100), category0 = catName(q.body.category);
  const price = Math.round(parseFloat(q.body.price) * 100), stock = Number(q.body.stock), dropId = Number(q.body.drop_id);
  if (!A.slugOf(name)) throw httpErr(400, 'Enter a product title with letters or numbers');
  if (!category0) throw httpErr(400, 'Enter a category');
  const category = (await catNames()).find(n => n.toLowerCase() === category0.toLowerCase()) || category0;
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) throw httpErr(400, 'Enter a price above 0');
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw httpErr(400, 'Stock must be a whole number, 0 or more');
  if (!Number.isInteger(dropId)) throw httpErr(400, 'Choose a launch');
  const img = A.readImage(q.body.image);
  if ((await pool.query(`SELECT 1 FROM products WHERE ${SLUG} = $1`, [A.slugOf(name)])).rowCount) throw httpErr(409, 'A product with this title already exists');
  try {
    const x = await pool.query('INSERT INTO products(drop_id, name, artisan, price_cents, stock, image, image_type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [dropId, name, category, price, stock, img.buf, img.type]);
    await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT DO NOTHING', [category]);
    r.json({ id: x.rows[0].id });
  } catch (e) { if (e.code === '23503') throw httpErr(400, 'That launch does not exist'); throw e; }
}));

app.delete('/api/admin/products/:id', admin, wrap(async (q, r) => {
  const id = Number(q.params.id);
  if (!Number.isInteger(id)) throw httpErr(404, 'Product not found');
  try { await tx(async c => { await c.query('DELETE FROM holds WHERE product_id = $1', [id]); await c.query('DELETE FROM products WHERE id = $1', [id]); }); }
  catch (e) { if (e.code === '23503') throw httpErr(409, 'This product has orders, so it cannot be deleted. Set its stock to 0 instead.'); throw e; }
  r.json({ ok: true });
}));

// ---- categories (admin) ----
const catName = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const catNames = async c => (await (c || pool).query('SELECT name FROM categories UNION SELECT artisan FROM products')).rows.map(x => x.name);

app.post('/api/admin/categories', admin, wrap(async (q, r) => {
  const name = catName(q.body.name);
  if (!name) throw httpErr(400, 'Enter a category name');
  if ((await catNames()).some(n => n.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'This category already exists');
  await pool.query('INSERT INTO categories(name) VALUES ($1)', [name]);
  r.json({ ok: true });
}));

// Rename: products that use the old name move to the new one
app.patch('/api/admin/categories', admin, wrap(async (q, r) => {
  const from = String(q.body.from || ''), to = catName(q.body.to);
  if (!to) throw httpErr(400, 'Enter a category name');
  await tx(async c => {
    const all = await catNames(c);
    if (!all.includes(from)) throw httpErr(404, 'Category not found');
    if (all.some(n => n !== from && n.toLowerCase() === to.toLowerCase())) throw httpErr(409, 'Another category already has this name');
    await c.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT DO NOTHING', [to]);
    await c.query('UPDATE products SET artisan = $1 WHERE artisan = $2', [to, from]);
    if (to !== from) await c.query('DELETE FROM categories WHERE name = $1', [from]);
  });
  r.json({ ok: true });
}));

app.post('/api/admin/categories/delete', admin, wrap(async (q, r) => {
  const name = String(q.body.name || '');
  const n = (await pool.query('SELECT count(*)::int AS n FROM products WHERE artisan = $1', [name])).rows[0].n;
  if (n) throw httpErr(409, `${n} product${n > 1 ? 's use' : ' uses'} this category. Move ${n > 1 ? 'them' : 'it'} to another category first.`);
  await pool.query('DELETE FROM categories WHERE name = $1', [name]);
  r.json({ ok: true });
}));

app.patch('/api/admin/products/:id/category', admin, wrap(async (q, r) => {
  const cat = catName(q.body.category), id = Number(q.params.id);
  if (!cat || !Number.isInteger(id)) throw httpErr(400, 'Choose a category');
  if (!(await catNames()).includes(cat)) throw httpErr(400, 'That category does not exist');
  await pool.query('UPDATE products SET artisan = $1 WHERE id = $2', [cat, id]);
  r.json({ ok: true });
}));

app.use((e, q, r, n) => {
  if (!e.status) console.error(e);
  r.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

init().then(async () => {
  if (process.env.RESET_DATA === '1') {
    console.log('RESET_DATA=1: clearing shop data');
    await pool.query('TRUNCATE order_items, orders, holds, products, drops, customers, categories RESTART IDENTITY CASCADE');
  }
  // First start on an empty database: load the sample data from data/*.csv
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM drops');
  if (!n) await require('./import').run();
  setInterval(() => { tx(releaseExpired).catch(console.error); pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(console.error); }, 30000);
  app.listen(process.env.PORT || 3000, () => console.log('Shop running on port ' + (process.env.PORT || 3000)));
}).catch(e => { console.error('Database setup failed:', e.message); process.exit(1); });
