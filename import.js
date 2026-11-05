// Imports existing data from data/*.csv. Safe to run again (skips what exists).
const fs = require('fs');
const { pool, init } = require('./db');
const rows = f => {
  const [h, ...r] = fs.readFileSync(`data/${f}.csv`, 'utf8').trim().split(/\r?\n/);
  const k = h.split(',');
  return r.map(l => Object.fromEntries(l.split(',').map((v, i) => [k[i], v.trim()])));
};
(async () => {
  await init();
  for (const d of rows('drops'))
    await pool.query('INSERT INTO drops(name, starts_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [d.name, d.starts_at]);
  for (const p of rows('products'))
    await pool.query(`INSERT INTO products(drop_id, name, artisan, price_cents, stock)
      SELECT id, $2, $3, $4, $5 FROM drops WHERE name = $1 ON CONFLICT (drop_id, name) DO NOTHING`, [p.drop, p.name, p.artisan, +p.price_cents, +p.stock]);
  for (const c of rows('customers'))
    await pool.query('INSERT INTO customers(name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [c.name, c.email]);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM orders');
  if (!n) for (const o of rows('orders')) {
    const cu = (await pool.query('SELECT id FROM customers WHERE email = $1', [o.email])).rows[0];
    const pr = (await pool.query('SELECT id, price_cents FROM products WHERE name = $1', [o.product])).rows[0];
    if (!cu || !pr) { console.log('Skipped order row:', o); continue; }
    const id = (await pool.query(`INSERT INTO orders(customer_id, total_cents, status, created_at) VALUES ($1, $2, 'shipped', $3) RETURNING id`, [cu.id, pr.price_cents * +o.qty, o.created_at])).rows[0].id;
    await pool.query('INSERT INTO order_items(order_id, product_id, qty, price_cents) VALUES ($1, $2, $3, $4)', [id, pr.id, +o.qty, pr.price_cents]);
  }
  console.log('Import done');
  await pool.end();
})().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
