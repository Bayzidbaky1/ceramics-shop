CREATE TABLE IF NOT EXISTS drops(id serial PRIMARY KEY, name text UNIQUE NOT NULL, starts_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS products(id serial PRIMARY KEY, drop_id int NOT NULL REFERENCES drops(id), name text NOT NULL, artisan text NOT NULL, price_cents int NOT NULL, stock int NOT NULL CHECK (stock >= 0), UNIQUE(drop_id, name));
CREATE TABLE IF NOT EXISTS customers(id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), total_cents int NOT NULL, status text NOT NULL DEFAULT 'confirmed', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items(order_id int NOT NULL REFERENCES orders(id), product_id int NOT NULL REFERENCES products(id), qty int NOT NULL, price_cents int NOT NULL);
CREATE TABLE IF NOT EXISTS holds(id serial PRIMARY KEY, cart_id text NOT NULL, product_id int NOT NULL REFERENCES products(id), expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS holds_cart ON holds(cart_id);
