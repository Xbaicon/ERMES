import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  encryptConfirmationCode, hashConfirmationCode, hashPassword, newConfirmationCode,
} from "./security.js";
import { backfillFinancialEntries, isCanonicalTimestamp } from "./finance.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.ERMES_DB_PATH || resolve(projectRoot, "data", "ermes.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.function("is_canonical_timestamp", { deterministic: true }, (value) => (
  isCanonicalTimestamp(value) ? 1 : 0
));
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
    order_blocked_until TEXT,
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
    recipient_snapshot_json TEXT,
    route_snapshot_json TEXT,
    items_total_cents INTEGER NOT NULL DEFAULT 0,
    freight_total_cents INTEGER,
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending', 'paid')),
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
    confirmation_code_ciphertext TEXT,
    invalid_code_attempts INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT,
    collected_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    return_reason TEXT,
    return_reported_at TEXT,
    returned_at TEXT,
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

  CREATE TABLE IF NOT EXISTS order_chat_messages (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    sender_user_id INTEGER NOT NULL REFERENCES users(id),
    sender_role TEXT NOT NULL CHECK(sender_role IN ('client', 'company')),
    content TEXT NOT NULL CHECK(
      typeof(content) = 'text'
      AND length(trim(content)) BETWEEN 1 AND 2000
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS order_chat_messages_order
    ON order_chat_messages(order_id, id);

  CREATE TRIGGER IF NOT EXISTS order_chat_message_participant_insert
    BEFORE INSERT ON order_chat_messages
    WHEN NOT EXISTS (
      SELECT 1 FROM orders o JOIN users sender ON sender.id = NEW.sender_user_id
      WHERE o.id = NEW.order_id AND (
        (NEW.sender_role = 'client' AND sender.role = 'client'
          AND sender.id = o.client_id)
        OR (NEW.sender_role = 'company' AND sender.role = 'company'
          AND sender.company_id = o.company_id)
      )
    )
    BEGIN SELECT RAISE(ABORT, 'chat sender does not belong to order'); END;

  CREATE TRIGGER IF NOT EXISTS order_chat_message_open_order_insert
    BEFORE INSERT ON order_chat_messages
    WHEN EXISTS (
      SELECT 1 FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
      WHERE o.id = NEW.order_id AND (
        o.status NOT IN ('draft', 'confirmed')
        OR d.status IN ('completed', 'cancelled', 'returned')
      )
    )
    BEGIN SELECT RAISE(ABORT, 'order chat is read-only'); END;

  CREATE TRIGGER IF NOT EXISTS order_chat_messages_append_only_update
    BEFORE UPDATE ON order_chat_messages
    BEGIN SELECT RAISE(ABORT, 'chat messages are append-only'); END;

  CREATE TRIGGER IF NOT EXISTS order_chat_messages_append_only_delete
    BEFORE DELETE ON order_chat_messages
    BEGIN SELECT RAISE(ABORT, 'chat messages are append-only'); END;

  CREATE TABLE IF NOT EXISTS financial_entries (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    delivery_id INTEGER REFERENCES deliveries(id),
    entry_type TEXT NOT NULL CHECK(entry_type IN ('payment', 'refund', 'distribution')),
    component TEXT NOT NULL CHECK(component IN ('products', 'freight')),
    party_type TEXT NOT NULL CHECK(party_type IN ('client', 'courier', 'company', 'ermes')),
    party_user_id INTEGER REFERENCES users(id),
    party_company_id INTEGER REFERENCES companies(id),
    amount_cents INTEGER NOT NULL CHECK(
      typeof(amount_cents) = 'integer'
      AND amount_cents >= 0
      AND amount_cents <= 9007199254740991
    ),
    reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
    idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(
      (entry_type = 'payment' AND party_type = 'client')
      OR (entry_type = 'refund' AND party_type = 'client')
      OR (entry_type = 'distribution' AND component = 'freight'
          AND party_type IN ('courier', 'company', 'ermes'))
    ),
    CHECK(
      (party_type IN ('client', 'courier') AND party_user_id IS NOT NULL AND party_company_id IS NULL)
      OR (party_type = 'company' AND party_user_id IS NULL AND party_company_id IS NOT NULL)
      OR (party_type = 'ermes' AND party_user_id IS NULL AND party_company_id IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS financial_entries_order ON financial_entries(order_id, id);
  CREATE INDEX IF NOT EXISTS financial_entries_delivery ON financial_entries(delivery_id, id);
  CREATE INDEX IF NOT EXISTS financial_entries_party_user
    ON financial_entries(party_type, party_user_id, id);
  CREATE INDEX IF NOT EXISTS financial_entries_party_company
    ON financial_entries(party_type, party_company_id, id);

  CREATE TRIGGER IF NOT EXISTS order_payment_status_insert
    BEFORE INSERT ON orders
    WHEN NEW.payment_status NOT IN ('pending', 'paid')
    BEGIN SELECT RAISE(ABORT, 'invalid payment status'); END;

  CREATE TRIGGER IF NOT EXISTS order_payment_status_update
    BEFORE UPDATE OF payment_status ON orders
    WHEN NEW.payment_status NOT IN ('pending', 'paid')
    BEGIN SELECT RAISE(ABORT, 'invalid payment status'); END;

  CREATE TRIGGER IF NOT EXISTS order_payment_ledger_regression_update
    BEFORE UPDATE OF payment_status ON orders
    WHEN OLD.payment_status = 'paid' AND NEW.payment_status = 'pending'
      AND EXISTS (
        SELECT 1 FROM financial_entries payment
        WHERE payment.order_id = OLD.id AND payment.entry_type = 'payment'
      )
    BEGIN SELECT RAISE(ABORT, 'paid order with financial evidence cannot return to pending'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_delivery_order_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.delivery_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deliveries d WHERE d.id = NEW.delivery_id AND d.order_id = NEW.order_id
    )
    BEGIN SELECT RAISE(ABORT, 'financial entry delivery does not belong to order'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_valid_amount_insert
    BEFORE INSERT ON financial_entries
    WHEN typeof(NEW.amount_cents) <> 'integer'
      OR NEW.amount_cents < 0 OR NEW.amount_cents > 9007199254740991
    BEGIN SELECT RAISE(ABORT, 'financial amount must be safe integer cents'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_valid_kind_insert
    BEFORE INSERT ON financial_entries
    WHEN NOT (
      (NEW.entry_type = 'payment' AND NEW.party_type = 'client'
        AND NEW.reason = 'simulated_payment')
      OR (NEW.entry_type = 'refund' AND NEW.party_type = 'client'
        AND NEW.delivery_id IS NOT NULL
        AND NEW.reason IN ('client_cancelled_after_pickup', 'product_unavailable'))
      OR (NEW.entry_type = 'distribution' AND NEW.component = 'freight'
        AND NEW.delivery_id IS NOT NULL
        AND ((NEW.reason = 'delivery_completed'
              AND NEW.party_type IN ('courier', 'company', 'ermes'))
          OR (NEW.reason = 'client_cancelled_after_pickup' AND NEW.party_type = 'courier')))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid financial entry kind'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_payment_owner_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'payment' AND NOT EXISTS (
      SELECT 1 FROM orders o JOIN users client ON client.id = o.client_id
      WHERE o.id = NEW.order_id AND client.role = 'client'
        AND NEW.party_user_id = o.client_id AND NEW.party_company_id IS NULL
        AND ((NEW.component = 'products' AND NEW.amount_cents = o.items_total_cents)
          OR (NEW.component = 'freight' AND o.freight_total_cents IS NOT NULL
              AND NEW.amount_cents = o.freight_total_cents))
    )
    BEGIN SELECT RAISE(ABORT, 'payment does not match order and client'); END;

  DROP TRIGGER IF EXISTS financial_entry_payment_state_insert;
  CREATE TRIGGER financial_entry_payment_state_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'payment' AND NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = NEW.order_id AND o.payment_status = 'paid'
        AND is_canonical_timestamp(o.payment_paid_at) = 1
    )
    BEGIN SELECT RAISE(ABORT, 'payment requires paid order with valid timestamp'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_one_payment_component_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'payment' AND EXISTS (
      SELECT 1 FROM financial_entries existing
      WHERE existing.order_id = NEW.order_id AND existing.entry_type = 'payment'
        AND existing.component = NEW.component
    )
    BEGIN SELECT RAISE(ABORT, 'payment component already recorded'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_refund_owner_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'refund' AND NOT EXISTS (
      SELECT 1 FROM orders o JOIN users client ON client.id = o.client_id
      JOIN financial_entries payment ON payment.order_id = o.id
        AND payment.entry_type = 'payment' AND payment.component = NEW.component
      WHERE o.id = NEW.order_id AND client.role = 'client'
        AND NEW.party_user_id = o.client_id AND NEW.party_company_id IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'refund does not match paid order component and client'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_over_refund_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'refund' AND (
      COALESCE((SELECT SUM(amount_cents) FROM financial_entries
        WHERE order_id = NEW.order_id AND entry_type = 'refund'
          AND component = NEW.component), 0) + NEW.amount_cents
    ) > COALESCE((SELECT SUM(amount_cents) FROM financial_entries
      WHERE order_id = NEW.order_id AND entry_type = 'payment'
        AND component = NEW.component), 0)
    BEGIN SELECT RAISE(ABORT, 'refund exceeds effectively paid component'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_distribution_owner_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'distribution' AND NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
      WHERE d.id = NEW.delivery_id AND o.id = NEW.order_id
        AND EXISTS (SELECT 1 FROM financial_entries payment
          WHERE payment.order_id = o.id AND payment.entry_type = 'payment'
            AND payment.component = 'freight')
        AND (
          (NEW.party_type = 'company' AND NEW.reason = 'delivery_completed'
            AND d.status = 'completed' AND NEW.party_company_id = o.company_id)
          OR (NEW.party_type = 'ermes' AND NEW.reason = 'delivery_completed'
            AND d.status = 'completed')
          OR (NEW.party_type = 'courier' AND EXISTS (
            SELECT 1 FROM users courier
            WHERE courier.id = NEW.party_user_id AND courier.role = 'courier'
              AND courier.company_id = o.company_id
              AND (
                (NEW.reason = 'delivery_completed' AND d.status = 'completed'
                  AND (d.courier_id = courier.id OR EXISTS (
                    SELECT 1 FROM delivery_events completed
                    WHERE completed.delivery_id = d.id
                      AND completed.event_type = 'delivery_completed'
                      AND completed.actor_user_id = courier.id)))
                OR (NEW.reason = 'client_cancelled_after_pickup'
                  AND d.status IN ('returning', 'awaiting_return_confirmation', 'returned')
                  AND (d.courier_id = courier.id OR EXISTS (
                    SELECT 1 FROM delivery_events operated
                    WHERE operated.delivery_id = d.id AND operated.actor_user_id = courier.id
                      AND operated.event_type IN ('order_collected', 'return_reported'))))
              )
          ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'distribution beneficiary does not match delivery'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_one_distribution_party_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'distribution' AND EXISTS (
      SELECT 1 FROM financial_entries existing
      WHERE existing.delivery_id = NEW.delivery_id AND existing.entry_type = 'distribution'
        AND existing.reason = NEW.reason AND existing.party_type = NEW.party_type
        AND COALESCE(existing.party_user_id, -1) = COALESCE(NEW.party_user_id, -1)
        AND COALESCE(existing.party_company_id, -1) = COALESCE(NEW.party_company_id, -1)
    )
    BEGIN SELECT RAISE(ABORT, 'distribution for beneficiary already recorded'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entry_distribution_limit_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'distribution' AND (
      COALESCE((SELECT SUM(amount_cents) FROM financial_entries
        WHERE delivery_id = NEW.delivery_id AND entry_type = 'distribution'
          AND reason = NEW.reason), 0) + NEW.amount_cents
    ) > COALESCE((SELECT SUM(amount_cents) FROM financial_entries
      WHERE order_id = NEW.order_id AND entry_type = 'payment'
        AND component = 'freight'), 0)
    BEGIN SELECT RAISE(ABORT, 'distribution exceeds effectively paid freight'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entries_append_only_update
    BEFORE UPDATE ON financial_entries
    BEGIN SELECT RAISE(ABORT, 'financial entries are append-only'); END;

  CREATE TRIGGER IF NOT EXISTS financial_entries_append_only_delete
    BEFORE DELETE ON financial_entries
    BEGIN SELECT RAISE(ABORT, 'financial entries are append-only'); END;

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
if (!orderColumns.has("recipient_snapshot_json")) {
  db.exec("ALTER TABLE orders ADD COLUMN recipient_snapshot_json TEXT");
}

const ordersWithoutRecipientSnapshot = db.prepare(`SELECT o.id, u.full_name AS recipientName
  FROM orders o JOIN users u ON u.id = o.client_id
  WHERE o.recipient_snapshot_json IS NULL`).all();
if (ordersWithoutRecipientSnapshot.length) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const updateRecipient = db.prepare("UPDATE orders SET recipient_snapshot_json = ? WHERE id = ?");
    for (const { id, recipientName } of ordersWithoutRecipientSnapshot) {
      if (typeof recipientName !== "string" || !recipientName.trim()) {
        throw new Error(`Pedido legado ${id} não possui nome de cliente válido para migrar o destinatário.`);
      }
      updateRecipient.run(JSON.stringify({ type: "self", name: recipientName.trim() }), id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map(({ name }) => name));
if (!userColumns.has("order_blocked_until")) {
  db.exec("ALTER TABLE users ADD COLUMN order_blocked_until TEXT");
}

const deliveryColumns = new Set(db.prepare("PRAGMA table_info(deliveries)").all().map(({ name }) => name));
for (const [name, definition] of [
  ["cancelled_at", "TEXT"],
  ["return_reason", "TEXT"],
  ["return_reported_at", "TEXT"],
  ["returned_at", "TEXT"],
  ["confirmation_code_ciphertext", "TEXT"],
]) {
  if (!deliveryColumns.has(name)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${definition}`);
}

const deliveriesWithoutRecoverableCode = db.prepare(`SELECT id FROM deliveries
  WHERE confirmation_code_ciphertext IS NULL
    AND status IN ('available', 'heading_to_pickup', 'awaiting_pickup', 'in_transit', 'awaiting_confirmation')`).all();
if (deliveriesWithoutRecoverableCode.length) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const updateCode = db.prepare(`UPDATE deliveries
      SET confirmation_code_hash = ?, confirmation_code_ciphertext = ? WHERE id = ?`);
    for (const { id } of deliveriesWithoutRecoverableCode) {
      const code = newConfirmationCode();
      updateCode.run(hashConfirmationCode(code), encryptConfirmationCode(code), id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

transaction(() => backfillFinancialEntries(db));

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
