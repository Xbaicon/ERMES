import { AUTHORIZED_ADJUSTMENT_ENTRY, evolveOrderAdjustmentSchema } from "./order-adjustment-schema.js";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  checkConfirmationKeyAvailability, encryptConfirmationCode, hashConfirmationCode, hashPassword,
  newConfirmationCode,
} from "./security.js";
import {
  backfillFinancialEntries, isCanonicalTimestamp, CLIENT_CANCELLATION_BEFORE_PICKUP_EVIDENCE_SQL,
  EXTERNAL_OBSTRUCTION_CYCLE_SQL,
} from "./finance.js";
import { evolveRevalidationSchema } from "./revalidation-schema.js";
import { migrateLegacyInvalidCodeAttempts } from "./delivery-attempts.js";
import { CLIENT_ADDRESS_CLOSED_SQL } from "./client-address-evidence.js";
import {
  canonicalSystemAddress, evolveSystemAddressSchema, SYSTEM_ADDRESS_PERSISTENT_SQL,
} from "./system-address-evidence.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.ERMES_DB_PATH || resolve(projectRoot, "data", "ermes.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.function("is_canonical_timestamp", { deterministic: true }, (value) => (
  isCanonicalTimestamp(value) ? 1 : 0
));
db.function("canonical_system_address_json", { deterministic: true }, canonicalSystemAddress);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
checkConfirmationKeyAvailability(() => {
  const encryptedCodes = db.prepare("PRAGMA table_info(deliveries)").all()
    .some(({ name }) => name === "confirmation_code_ciphertext")
    && Boolean(db.prepare(`SELECT 1 FROM deliveries
      WHERE confirmation_code_ciphertext IS NOT NULL LIMIT 1`).get());
  const validationsTable = db.prepare(`SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'order_adjustment_validations'`).get();
  const signedAdjustments = Boolean(validationsTable && db.prepare(`SELECT 1
    FROM order_adjustment_validations LIMIT 1`).get());
  return encryptedCodes || signedAdjustments;
});
// A conversão inicial para WAL pode retornar BUSY ao disputar a promoção de lock,
// mesmo com busy_timeout. Aguarda o escritor pelo lock nativo e verifica o modo
// antes de tentar novamente; não repete nenhuma operação de domínio.
const walDeadline = Date.now() + 5000;
while (true) {
  try {
    db.exec("PRAGMA journal_mode = WAL");
    break;
  } catch (error) {
    if (error.code !== "ERR_SQLITE_ERROR" || (error.errcode & 0xff) !== 5
      || Date.now() >= walDeadline) throw error;
    transaction(() => {});
    if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal") break;
  }
}

const financialEntryKindTrigger = `
  CREATE TRIGGER financial_entry_valid_kind_insert
    BEFORE INSERT ON financial_entries
    WHEN NOT (
      (NEW.entry_type = 'payment' AND NEW.party_type = 'client'
        AND NEW.reason = 'simulated_payment')
      OR EXISTS (${AUTHORIZED_ADJUSTMENT_ENTRY.replaceAll('ENTRY.', 'NEW.')})
      OR (NEW.entry_type = 'refund' AND NEW.party_type = 'client'
        AND NEW.delivery_id IS NOT NULL
        AND (NEW.reason IN ('client_cancelled_after_pickup', 'product_unavailable')
          OR (NEW.reason = 'client_cancelled_before_pickup'
            AND NEW.component IN ('products', 'freight')
            AND EXISTS (${CLIENT_CANCELLATION_BEFORE_PICKUP_EVIDENCE_SQL}
              AND d.id = NEW.delivery_id AND o.id = NEW.order_id
              AND o.payment_status = 'paid'))
          OR (NEW.reason = 'client_cancelled_after_external_obstruction'
            AND NEW.component IN ('products', 'freight')
            AND EXISTS (${EXTERNAL_OBSTRUCTION_CYCLE_SQL.replace("d.status = ?", "d.status = 'cancelled'")}
              AND d.id = NEW.delivery_id AND o.id = NEW.order_id
              AND o.payment_status = 'paid'
              AND is_canonical_timestamp(d.cancelled_at) = 1
              AND d.cancelled_at >= d.returned_at AND d.cancelled_at <= CURRENT_TIMESTAMP
              AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
                AND e.event_type = 'client_cancelled_after_external_obstruction') = 1
              AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
                AND e.event_type = 'client_cancelled_after_external_obstruction'
                AND e.actor_user_id = o.client_id AND e.occurred_at = d.cancelled_at)))
          OR (NEW.component = 'products'
            AND NEW.reason IN ('recipient_absent', 'recipient_refused')
            AND EXISTS (SELECT 1 FROM deliveries d WHERE d.id = NEW.delivery_id
              AND d.status = 'returned' AND d.return_reason = NEW.reason
              AND d.returned_at IS NOT NULL))
          OR (NEW.reason = 'address_problem' AND NEW.component = 'products'
            AND EXISTS (${CLIENT_ADDRESS_CLOSED_SQL}
              AND d.id = NEW.delivery_id AND o.id = NEW.order_id AND o.payment_status = 'paid'))
          OR (NEW.reason = 'system_address_persistent'
            AND NEW.component IN ('products', 'freight')
            AND EXISTS (${SYSTEM_ADDRESS_PERSISTENT_SQL}
              AND d.id = NEW.delivery_id AND o.id = NEW.order_id AND o.payment_status = 'paid'))
          OR (NEW.reason = 'confirmation_failed' AND EXISTS (
            SELECT 1 FROM deliveries d
            JOIN delivery_attempts a ON a.delivery_id = d.id
              AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'terminal'
              AND a.end_reason = 'confirmation_failed'
            JOIN orders owner ON owner.id = d.order_id
            JOIN delivery_occurrences oc ON oc.delivery_id = d.id
              AND oc.delivery_attempt_id = a.id AND oc.type = 'confirmation_failed'
            JOIN users classifier ON classifier.id = oc.classified_by_user_id
              AND classifier.role = 'company' AND classifier.company_id = owner.company_id
            WHERE d.id = NEW.delivery_id AND d.status = 'returned'
              AND d.return_reason = 'confirmation_failed' AND d.returned_at IS NOT NULL
              AND (SELECT COUNT(*) FROM delivery_occurrences evidence
                WHERE evidence.delivery_id = d.id AND evidence.type = 'confirmation_failed') = 1
              AND NOT EXISTS (SELECT 1 FROM delivery_occurrences conflict
                WHERE conflict.delivery_attempt_id = a.id
                  AND (conflict.type IN ('recipient_absent', 'recipient_refused')
                    OR (conflict.type = 'address_problem' AND NOT (
                      conflict.responsibility = 'SISTEMA'
                      AND EXISTS (SELECT 1 FROM users address_classifier
                        WHERE address_classifier.id = conflict.classified_by_user_id
                          AND address_classifier.role = 'company'
                          AND address_classifier.company_id = owner.company_id)))))
              AND a.attempt_number = (SELECT MAX(latest.attempt_number)
                FROM delivery_attempts latest WHERE latest.delivery_id = d.id)
              AND is_canonical_timestamp(oc.classified_at) = 1
              AND oc.classified_at >= oc.reported_at AND oc.classified_at >= d.returned_at
              AND oc.classified_at <= CURRENT_TIMESTAMP
              AND oc.responsibility IN ('CLIENTE', 'MOTOBOY', 'SISTEMA', 'INDEFINIDO')
              AND (NEW.component = 'products' OR (NEW.component = 'freight'
                AND oc.responsibility IN ('MOTOBOY', 'SISTEMA', 'INDEFINIDO')))))))
      OR (NEW.entry_type = 'distribution' AND NEW.component = 'freight'
        AND NEW.delivery_id IS NOT NULL
        AND ((NEW.reason = 'delivery_completed'
              AND NEW.party_type IN ('courier', 'company', 'ermes'))
          OR (NEW.reason = 'client_cancelled_after_pickup' AND NEW.party_type = 'courier')
          OR (NEW.reason IN ('recipient_absent', 'recipient_refused')
            AND NEW.party_type IN ('courier', 'company', 'ermes'))
          OR (NEW.reason = 'address_problem'
            AND NEW.party_type IN ('courier', 'company', 'ermes')
            AND EXISTS (${CLIENT_ADDRESS_CLOSED_SQL}
              AND d.id = NEW.delivery_id AND o.id = NEW.order_id AND o.payment_status = 'paid'))))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid financial entry kind'); END;
`;

// Serializa o bootstrap, inclusive a substituição de triggers de versões anteriores.
transaction(() => {
  db.exec("DROP TRIGGER IF EXISTS financial_entry_valid_kind_insert");
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
    company_profile TEXT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    cpf TEXT UNIQUE,
    birth_date TEXT,
    phone TEXT,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'blocked')),
    order_blocked_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(role NOT IN ('company', 'courier') OR company_id IS NOT NULL),
    CHECK(COALESCE((role = 'company' AND company_profile IN ('RESPONSAVEL', 'ATENDENTE'))
      OR (role <> 'company' AND company_profile IS NULL), 0))
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

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    courier_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK(
      status IN ('active', 'returning', 'completed', 'closed_unsuccessfully')
    ),
    invalid_code_attempts INTEGER NOT NULL DEFAULT 0
      CHECK(invalid_code_attempts IN (0, 1, 2, 3)),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    end_reason TEXT,
    end_nature TEXT CHECK(end_nature IS NULL OR end_nature IN ('recoverable', 'terminal')),
    UNIQUE(delivery_id, attempt_number),
    CHECK(
      (status IN ('active', 'returning') AND ended_at IS NULL
        AND end_reason IS NULL AND end_nature IS NULL)
      OR (status = 'completed' AND ended_at IS NOT NULL
        AND end_reason IS NULL AND end_nature IS NULL)
      OR (status = 'closed_unsuccessfully' AND ended_at IS NOT NULL
        AND end_reason IS NOT NULL AND length(trim(end_reason)) > 0
        AND end_nature IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS delivery_attempts_delivery
    ON delivery_attempts(delivery_id, attempt_number);

  CREATE INDEX IF NOT EXISTS delivery_attempts_courier
    ON delivery_attempts(courier_id, id);

  CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt_per_delivery
    ON delivery_attempts(delivery_id)
    WHERE status IN ('active', 'returning');

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

  DROP TRIGGER IF EXISTS financial_entry_payment_owner_insert;
  CREATE TRIGGER financial_entry_payment_owner_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'payment' AND NEW.reason <> 'order_adjustment' AND NOT EXISTS (
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

  DROP TRIGGER IF EXISTS financial_entry_one_payment_component_insert;
  CREATE TRIGGER financial_entry_one_payment_component_insert
    BEFORE INSERT ON financial_entries
    WHEN NEW.entry_type = 'payment' AND NEW.reason <> 'order_adjustment' AND EXISTS (
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

  DROP TRIGGER IF EXISTS financial_entry_distribution_owner_insert;
  CREATE TRIGGER financial_entry_distribution_owner_insert
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
          OR (NEW.reason IN ('recipient_absent', 'recipient_refused', 'address_problem')
            AND d.status = 'returned' AND d.return_reason = NEW.reason
            AND d.returned_at IS NOT NULL
            AND ((NEW.party_type = 'company' AND NEW.party_company_id = o.company_id)
              OR (NEW.party_type = 'ermes')
              OR (NEW.party_type = 'courier' AND EXISTS (
                SELECT 1 FROM delivery_attempts a
                JOIN users courier ON courier.id = a.courier_id
                  AND courier.role = 'courier' AND courier.company_id = o.company_id
                JOIN couriers profile ON profile.user_id = courier.id
                WHERE a.delivery_id = d.id AND a.courier_id = NEW.party_user_id
                  AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'terminal'
                  AND a.end_reason = NEW.reason
                  AND a.id = (SELECT latest.id FROM delivery_attempts latest
                    WHERE latest.delivery_id = d.id ORDER BY latest.attempt_number DESC LIMIT 1)))))
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
  // Bancos anteriores recebem o perfil do usuário responsável original sem mudar sua identidade.
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map(({ name }) => name));
  if (!columns.has("company_profile")) db.exec("ALTER TABLE users ADD COLUMN company_profile TEXT");
  db.prepare(`UPDATE users SET company_profile = 'RESPONSAVEL'
    WHERE role = 'company' AND company_profile IS NULL`).run();
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS users_company_profile_insert
      BEFORE INSERT ON users
      WHEN NOT COALESCE(((NEW.role = 'company' AND NEW.company_id IS NOT NULL
        AND NEW.company_profile IN ('RESPONSAVEL', 'ATENDENTE'))
        OR (NEW.role <> 'company' AND NEW.company_profile IS NULL)), 0)
      BEGIN SELECT RAISE(ABORT, 'invalid company profile'); END;
    CREATE TRIGGER IF NOT EXISTS users_company_profile_update
      BEFORE UPDATE OF role, company_id, company_profile ON users
      WHEN NOT COALESCE(((NEW.role = 'company' AND NEW.company_id IS NOT NULL
        AND NEW.company_profile IN ('RESPONSAVEL', 'ATENDENTE'))
        OR (NEW.role <> 'company' AND NEW.company_profile IS NULL)), 0)
      BEGIN SELECT RAISE(ABORT, 'invalid company profile'); END;

    CREATE TABLE IF NOT EXISTS company_audit_events (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK(action IN ('company_user_created', 'order_confirmed',
        'product_created', 'product_availability_changed', 'courier_created', 'freight_config_changed')),
      entity_type TEXT NOT NULL CHECK(entity_type IN ('user', 'order', 'product', 'freight_config')),
      entity_id INTEGER NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS company_audit_events_company_id_id
      ON company_audit_events(company_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS company_audit_one_order_confirmation
      ON company_audit_events(entity_id) WHERE action = 'order_confirmed';
    CREATE TRIGGER IF NOT EXISTS company_audit_events_actor_insert
      BEFORE INSERT ON company_audit_events
      WHEN NOT EXISTS (SELECT 1 FROM users actor WHERE actor.id = NEW.actor_user_id
        AND actor.role = 'company' AND actor.company_id = NEW.company_id
        AND actor.company_profile IN ('RESPONSAVEL', 'ATENDENTE')
        AND (NEW.action = 'order_confirmed' OR actor.company_profile = 'RESPONSAVEL'))
      BEGIN SELECT RAISE(ABORT, 'invalid company audit actor'); END;
    CREATE TRIGGER IF NOT EXISTS company_audit_events_entity_insert
      BEFORE INSERT ON company_audit_events
      WHEN NOT (
        (NEW.action = 'company_user_created' AND NEW.entity_type = 'user'
          AND EXISTS (SELECT 1 FROM users target WHERE target.id = NEW.entity_id
            AND target.role = 'company' AND target.company_id = NEW.company_id))
        OR (NEW.action = 'courier_created' AND NEW.entity_type = 'user'
          AND EXISTS (SELECT 1 FROM users target JOIN couriers c ON c.user_id = target.id
            WHERE target.id = NEW.entity_id AND target.role = 'courier'
              AND target.company_id = NEW.company_id))
        OR (NEW.action = 'order_confirmed' AND NEW.entity_type = 'order'
          AND EXISTS (SELECT 1 FROM orders target WHERE target.id = NEW.entity_id
            AND target.company_id = NEW.company_id AND target.status = 'confirmed'))
        OR (NEW.action IN ('product_created', 'product_availability_changed')
          AND NEW.entity_type = 'product'
          AND EXISTS (SELECT 1 FROM products target WHERE target.id = NEW.entity_id
            AND target.company_id = NEW.company_id))
        OR (NEW.action = 'freight_config_changed' AND NEW.entity_type = 'freight_config'
          AND NEW.entity_id = NEW.company_id AND EXISTS
            (SELECT 1 FROM freight_configs target WHERE target.company_id = NEW.company_id))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid company audit entity'); END;
    CREATE TRIGGER IF NOT EXISTS company_audit_events_append_only_update
      BEFORE UPDATE ON company_audit_events
      BEGIN SELECT RAISE(ABORT, 'company audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS company_audit_events_append_only_delete
      BEFORE DELETE ON company_audit_events
      BEGIN SELECT RAISE(ABORT, 'company audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS company_audit_actor_identity_update
      BEFORE UPDATE OF role, company_id ON users
      WHEN EXISTS (SELECT 1 FROM company_audit_events audit
        WHERE audit.actor_user_id = OLD.id
          AND (NEW.role <> 'company' OR NEW.company_id IS NOT audit.company_id))
      BEGIN SELECT RAISE(ABORT, 'company audit actor identity is immutable'); END;
  `);
  evolveRevalidationSchema(db, { inTransaction: true });
  evolveSystemAddressSchema(db);
  evolveOrderAdjustmentSchema(db);
  db.exec(financialEntryKindTrigger);
});

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

db.exec("BEGIN IMMEDIATE");
try {
  const attemptColumns = new Set(db.prepare("PRAGMA table_info(delivery_attempts)").all()
    .map(({ name }) => name));
  if (!attemptColumns.has("invalid_code_attempts")) {
    db.exec(`ALTER TABLE delivery_attempts ADD COLUMN invalid_code_attempts INTEGER NOT NULL DEFAULT 0
      CHECK(invalid_code_attempts IN (0, 1, 2, 3))`);
    migrateLegacyInvalidCodeAttempts(db);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
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

export function recordCompanyAuditInTransaction(companyId, actorUserId, action, entityType, entityId, details = {}) {
  db.prepare(`INSERT INTO company_audit_events
    (company_id, actor_user_id, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(companyId, actorUserId, action, entityType, entityId,
    JSON.stringify(details));
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
    db.prepare(`INSERT INTO users (company_id, role, company_profile, full_name, email, cpf, password_hash)
                VALUES (?, 'company', 'RESPONSAVEL', ?, ?, ?, ?)`)
      .run(companyId, "Responsável Demonstrativo", "empresa@ermes.local", "52998224725", hashPassword("Ermes123!"));
    db.prepare(`INSERT INTO products (company_id, name, description, price_cents, unit_weight_kg)
                VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`)
      .run(companyId, "Produto demonstrativo", "Item cadastrado para validar o fluxo inicial.", 1990, 0.5,
        companyId, "Kit demonstrativo", "Segundo item da empresa de exemplo.", 4590, 1.25);
  });
}
