-- Schema relevante do checkpoint 188f9dc (PR #22), sem simplificar ocorrências.
PRAGMA foreign_keys = ON;
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

  CREATE TABLE IF NOT EXISTS delivery_occurrences (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    delivery_attempt_id INTEGER REFERENCES delivery_attempts(id),
    type TEXT NOT NULL CHECK(type IN (
      'courier_failure_before_pickup',
      'courier_failure_after_pickup',
      'recipient_absent',
      'recipient_refused',
      'confirmation_failed',
      'address_problem'
    )),
    description TEXT CHECK(
      description IS NULL OR length(trim(description)) BETWEEN 1 AND 500
    ),
    reported_by_user_id INTEGER NOT NULL REFERENCES users(id),
    reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    responsibility TEXT CHECK(
      responsibility IS NULL OR responsibility IN ('CLIENTE', 'EMPRESA', 'MOTOBOY', 'SISTEMA', 'INDEFINIDO')
    ),
    classified_by_user_id INTEGER REFERENCES users(id),
    classified_at TEXT,
    analysis_result TEXT CHECK(
      analysis_result IS NULL OR length(trim(analysis_result)) BETWEEN 1 AND 2000
    ),
    CHECK(
      (responsibility IS NULL AND classified_by_user_id IS NULL
        AND classified_at IS NULL AND analysis_result IS NULL)
      OR (responsibility IS NOT NULL AND classified_by_user_id IS NOT NULL
        AND classified_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS delivery_occurrences_delivery
    ON delivery_occurrences(delivery_id, reported_at, id);

  CREATE INDEX IF NOT EXISTS delivery_occurrences_attempt
    ON delivery_occurrences(delivery_attempt_id, id);

  CREATE TRIGGER IF NOT EXISTS delivery_occurrences_attempt_insert
    BEFORE INSERT ON delivery_occurrences
    WHEN NEW.delivery_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM delivery_attempts attempt
      WHERE attempt.id = NEW.delivery_attempt_id AND attempt.delivery_id = NEW.delivery_id
    )
    BEGIN SELECT RAISE(ABORT, 'delivery occurrence attempt does not belong to delivery'); END;

  CREATE TRIGGER IF NOT EXISTS delivery_occurrences_attempt_update
    BEFORE UPDATE ON delivery_occurrences
    WHEN NEW.delivery_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM delivery_attempts attempt
      WHERE attempt.id = NEW.delivery_attempt_id AND attempt.delivery_id = NEW.delivery_id
    )
    BEGIN SELECT RAISE(ABORT, 'delivery occurrence attempt does not belong to delivery'); END;

  CREATE TRIGGER IF NOT EXISTS delivery_occurrences_report_immutable
    BEFORE UPDATE ON delivery_occurrences
    WHEN NEW.delivery_id IS NOT OLD.delivery_id
      OR NEW.delivery_attempt_id IS NOT OLD.delivery_attempt_id
      OR NEW.type IS NOT OLD.type
      OR NEW.description IS NOT OLD.description
      OR NEW.reported_by_user_id IS NOT OLD.reported_by_user_id
      OR NEW.reported_at IS NOT OLD.reported_at
      OR NEW.evidence_json IS NOT OLD.evidence_json
    BEGIN SELECT RAISE(ABORT, 'delivery occurrence report is immutable'); END;

  CREATE TRIGGER IF NOT EXISTS delivery_occurrences_classification_final
    BEFORE UPDATE ON delivery_occurrences
    WHEN OLD.responsibility IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'delivery occurrence classification is final'); END;

  CREATE TRIGGER IF NOT EXISTS delivery_occurrences_delete_forbidden
    BEFORE DELETE ON delivery_occurrences
    BEGIN SELECT RAISE(ABORT, 'delivery occurrence cannot be deleted'); END;
