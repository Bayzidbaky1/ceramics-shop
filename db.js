const { Pool } = require('pg');
const fs = require('fs'), path = require('path');
const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/shop';
// Render's external URL needs SSL; the internal URL and local Postgres do not.
const pool = new Pool({ connectionString: url, ssl: /render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 10 });
const init = () => pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
module.exports = { pool, init };
