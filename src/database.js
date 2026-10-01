import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./security.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.ERMES_DB_PATH || resolve(projectRoot, "data", "ermes.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    cnpj TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    phone TEXT,
    address_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'blocked')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id),
    role TEXT NOT NULL CHECK(role IN ('client', 'company', 'courier', 'platform_admin')),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    cpf TEXT UNIQUE,
    birth_date TEXT,
    phone TEXT,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'blocked')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(role NOT IN ('company', 'courier') OR company_id IS NOT NULL)
  );

  CREATE TABLE IF NOT EXISTS couriers (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type TEXT NOT NULL,
    vehicle_identifier TEXT,
    plate TEXT,
    cnh TEXT,
    is_online INTEGER NOT NULL DEFAULT 0 CHECK(is_online IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS client_default_addresses (
    client_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    postal_code TEXT NOT NULL CHECK(length(postal_code) = 8 AND postal_code NOT GLOB '*[^0-9]*'),
    state TEXT NOT NULL CHECK(length(state) = 2 AND state = upper(state)),
    city TEXT NOT NULL CHECK(length(trim(city)) > 0),
    neighborhood TEXT NOT NULL CHECK(length(trim(neighborhood)) > 0),
    street TEXT NOT NULL CHECK(length(trim(street)) > 0),
    number TEXT NOT NULL CHECK(length(trim(number)) > 0),
    complement TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS freight_configs (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    under_1kg_cents INTEGER NOT NULL DEFAULT 300,
    from_1_to_3kg_cents INTEGER NOT NULL DEFAULT 500,
    from_3_to_8kg_cents INTEGER NOT NULL DEFAULT 900,
    from_8_to_12kg_cents INTEGER NOT NULL DEFAULT 1200,
    per_km_cents INTEGER NOT NULL DEFAULT 50,
    per_minute_cents INTEGER NOT NULL DEFAULT 30,
    max_weight_kg REAL NOT NULL DEFAULT 12,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    unit_weight_kg REAL NOT NULL CHECK(unit_weight_kg > 0),
    is_available INTEGER NOT NULL DEFAULT 1 CHECK(is_available IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES users(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
    destination_snapshot_json TEXT,
    route_snapshot_json TEXT,
    items_total_cents INTEGER NOT NULL DEFAULT 0,
    freight_total_cents INTEGER,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    payment_paid_at TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
    unit_weight_kg REAL NOT NULL CHECK(unit_weight_kg > 0)
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
    courier_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'available',
    confirmation_code_hash TEXT,
    invalid_code_attempts INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT,
    collected_at TEXT,
    completed_at TEXT,
    last_location_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_delivery_per_courier
    ON deliveries(courier_id)
    WHERE courier_id IS NOT NULL AND status NOT IN ('completed', 'cancelled', 'returned');

  CREATE TABLE IF NOT EXISTS delivery_events (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES users(id),
    event_type TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const orderColumns = new Set(db.prepare("PRAGMA table_info(orders)").all().map(({ name }) => name));
if (!orderColumns.has("version")) {
  db.exec("ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)");
}
if (!orderColumns.has("confirmed_at")) {
  db.exec("ALTER TABLE orders ADD COLUMN confirmed_at TEXT");
}
if (!orderColumns.has("payment_paid_at")) {
  db.exec("ALTER TABLE orders ADD COLUMN payment_paid_at TEXT");
}

export function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function seedDevelopmentData() {
  const exists = db.prepare("SELECT id FROM companies WHERE cnpj = ?").get("00000000000191");
  if (exists) return;
  transaction(() => {
    const company = db.prepare("INSERT INTO companies (name, cnpj, email, phone) VALUES (?, ?, ?, ?)")
      .run("Empresa Demonstrativa", "00000000000191", "empresa@ermes.local", "71999999999");
    const companyId = Number(company.lastInsertRowid);
    db.prepare("INSERT INTO freight_configs (company_id) VALUES (?)").run(companyId);
    db.prepare(`INSERT INTO users (company_id, role, full_name, email, cpf, password_hash)
                VALUES (?, 'company', ?, ?, ?, ?)`)
      .run(companyId, "Responsável Demonstrativo", "empresa@ermes.local", "52998224725", hashPassword("Ermes123!"));
    db.prepare(`INSERT INTO products (company_id, name, description, price_cents, unit_weight_kg)
                VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`)
      .run(companyId, "Produto demonstrativo", "Item cadastrado para validar o fluxo inicial.", 1990, 0.5,
        companyId, "Kit demonstrativo", "Segundo item da empresa de exemplo.", 4590, 1.25);
  });
}
