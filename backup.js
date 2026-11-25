// Backup and restore of the whole store (used to move to a new database without losing anything).
const { bad } = require('./auth');

// Fixed lists of tables and columns: nothing from an uploaded file is ever used as an SQL name.
const TABLES = [
  ['drops', ['id', 'name', 'starts_at']],
  ['categories', ['name']],
  ['products', ['id', 'drop_id', 'name', 'artisan', 'price_cents', 'stock', 'image', 'image_type']],
  ['customers', ['id', 'name', 'email']],
  ['users', ['id', 'name', 'email', 'password_hash', 'created_at']],
  ['orders', ['id', 'customer_id', 'total_cents', 'status', 'created_at', 'user_id', 'payment_method', 'payment_status', 'card_brand', 'card_last4']],
  ['order_items', ['order_id', 'product_id', 'qty', 'price_cents']]
];
const SERIAL = ['drops', 'products', 'customers', 'users', 'orders'];
const ORDER = { categories: 'name', order_items: 'order_id, product_id' };

async function makeBackup(pool) {
  const out = { format: 'fasco-backup', version: 1, created_at: new Date().toISOString(), tables: {} };
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent snapshot
    for (const [t, cols] of TABLES) {
      const rows = (await c.query(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY ${ORDER[t] || 'id'}`)).rows;
      out.tables[t] = rows.map(r => Object.fromEntries(cols.map(k => [k, Buffer.isBuffer(r[k]) ? r[k].toString('base64') : r[k]])));
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  return out;
}

// Replaces everything in one transaction. If anything fails, the old data stays untouched.
async function restoreBackup(pool, data) {
  if (!data || data.format !== 'fasco-backup' || data.version !== 1 || typeof data.tables !== 'object' || !data.tables) throw bad('This is not a FASCO backup file');
  for (const [t] of TABLES) if (!Array.isArray(data.tables[t])) throw bad(`The backup file is missing the "${t}" table`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE order_items, orders, holds, products, drops, customers, categories, sessions, users RESTART IDENTITY CASCADE');
    for (const [t, cols] of TABLES) {
      const sql = `INSERT INTO ${t}(${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`;
      for (const row of data.tables[t]) {
        if (!row || typeof row !== 'object') throw bad(`A row in "${t}" is not valid`);
        await c.query(sql, cols.map(k => row[k] === undefined || row[k] === null ? null : (k === 'image' ? Buffer.from(row[k], 'base64') : row[k])));
      }
    }
    for (const t of SERIAL) await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) IS NOT NULL FROM ${t}))`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e.status ? e : bad('Restore failed and nothing was changed: ' + e.message);
  } finally { c.release(); }
  return Object.fromEntries(TABLES.map(([t]) => [t, data.tables[t].length]));
}
module.exports = { makeBackup, restoreBackup, TABLES };
