const express = require('express');
const { pool, init } = require('./db');
const app = express();
app.use(express.json());
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

app.get('/api/health', (q, r) => r.json({ ok: true }));

app.get('/api/drops', wrap(async (q, r) => {
  await sweep();
  const d = await pool.query('SELECT * FROM drops ORDER BY starts_at DESC');
  const p = await pool.query('SELECT * FROM products ORDER BY id');
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
  const { cartId, name, email } = q.body;
  if (!cartId || !name || !/^\S+@\S+$/.test(email || '')) throw httpErr(400, 'Enter your name and a valid email');
  const orderId = await tx(async c => {
    await releaseExpired(c);
    // Taking the holds and deleting them is one step, so an expiring hold cannot be sold twice.
    const held = (await c.query('DELETE FROM holds WHERE cart_id = $1 AND expires_at > now() RETURNING product_id', [cartId])).rows;
    if (!held.length) throw httpErr(400, 'Your cart is empty or the hold has expired');
    const qty = {}; held.forEach(h => qty[h.product_id] = (qty[h.product_id] || 0) + 1);
    const prices = (await c.query('SELECT id, price_cents FROM products WHERE id = ANY($1)', [Object.keys(qty).map(Number)])).rows;
    const total = prices.reduce((s, p) => s + p.price_cents * qty[p.id], 0);
    const cu = (await c.query('INSERT INTO customers(name, email) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id', [name, email])).rows[0].id;
    const o = (await c.query('INSERT INTO orders(customer_id, total_cents) VALUES ($1, $2) RETURNING id', [cu, total])).rows[0].id;
    for (const p of prices) await c.query('INSERT INTO order_items(order_id, product_id, qty, price_cents) VALUES ($1, $2, $3, $4)', [o, p.id, qty[p.id], p.price_cents]);
    return o;
  });
  r.json({ orderId });
}));

app.get('/api/orders/:id', wrap(async (q, r) => {
  const id = +q.params.id;
  if (!Number.isInteger(id)) throw httpErr(404, 'Order not found');
  const o = (await pool.query('SELECT o.id, o.status, o.total_cents, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [id])).rows[0];
  if (!o) throw httpErr(404, 'Order not found');
  o.items = (await pool.query('SELECT p.name, oi.qty, oi.price_cents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1', [id])).rows;
  r.json(o);
}));

app.get('/api/admin/summary', admin, wrap(async (q, r) => {
  await sweep();
  const drops = await pool.query(`SELECT d.id, d.name, COALESCE(SUM(oi.qty), 0)::int units, COALESCE(SUM(oi.qty * oi.price_cents), 0)::int revenue_cents
    FROM drops d LEFT JOIN products p ON p.drop_id = d.id LEFT JOIN order_items oi ON oi.product_id = p.id GROUP BY d.id ORDER BY d.starts_at DESC`);
  const products = await pool.query('SELECT p.id, p.name, p.stock, d.name AS drop FROM products p JOIN drops d ON d.id = p.drop_id ORDER BY d.starts_at DESC, p.id');
  const orders = await pool.query('SELECT o.id, o.status, o.total_cents, o.created_at, c.email FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 20');
  // Estimate only: monthly bill divided by drops per month. Set both on the server.
  const cost = (+process.env.MONTHLY_COST_USD || 86) / (+process.env.DROPS_PER_MONTH || 4);
  r.json({ drops: drops.rows, products: products.rows, orders: orders.rows, cost_per_drop_cents: Math.round(cost * 100) });
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

app.use((e, q, r, n) => {
  if (!e.status) console.error(e);
  r.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

init().then(async () => {
  if (process.env.RESET_DATA === '1') {
    console.log('RESET_DATA=1: clearing shop data');
    await pool.query('TRUNCATE order_items, orders, holds, products, drops, customers RESTART IDENTITY CASCADE');
  }
  // First start on an empty database: load the sample data from data/*.csv
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM drops');
  if (!n) await require('./import').run();
  setInterval(() => tx(releaseExpired).catch(console.error), 30000);
  app.listen(process.env.PORT || 3000, () => console.log('Shop running on port ' + (process.env.PORT || 3000)));
}).catch(e => { console.error('Database setup failed:', e.message); process.exit(1); });
