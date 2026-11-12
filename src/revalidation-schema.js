// SQLite exige reconstrução para ampliar o CHECK de tipos. Nenhum dado é inferido.
const occurrenceTable = `  CREATE TABLE IF NOT EXISTS delivery_occurrences (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    delivery_attempt_id INTEGER REFERENCES delivery_attempts(id),
    type TEXT NOT NULL CHECK(type IN (
      'courier_failure_before_pickup',
      'courier_failure_after_pickup',
      'recipient_absent',
      'recipient_refused',
      'confirmation_failed',
      'address_problem',
      'temporary_external_obstruction'
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

`;
const occurrenceObjects = `  CREATE INDEX IF NOT EXISTS delivery_occurrences_delivery
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

`;

export function evolveRevalidationSchema(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delivery_occurrences'").get();
    if (existing && !existing.sql.includes("'temporary_external_obstruction'")) {
      const objects = database.prepare(`SELECT sql FROM sqlite_master
        WHERE tbl_name = 'delivery_occurrences' AND type IN ('index', 'trigger') AND sql IS NOT NULL
        ORDER BY type, name`).all();
      database.exec(occurrenceTable.replace('IF NOT EXISTS delivery_occurrences', 'delivery_occurrences_next'));
      database.exec(`INSERT INTO delivery_occurrences_next
        SELECT * FROM delivery_occurrences;
        DROP TABLE delivery_occurrences;
        ALTER TABLE delivery_occurrences_next RENAME TO delivery_occurrences;`);
      for (const { sql } of objects) database.exec(sql);
    } else {
      database.exec(occurrenceTable);
    }
    database.exec(occurrenceObjects);
    database.exec(revalidationSchema);
    if (database.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error("A evolução de revalidação encontrou vínculos inválidos; reconciliação necessária.");
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const revalidationSchema = `
  CREATE TABLE IF NOT EXISTS delivery_revalidations (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
    delivery_attempt_id INTEGER NOT NULL UNIQUE REFERENCES delivery_attempts(id),
    occurrence_id INTEGER NOT NULL UNIQUE REFERENCES delivery_occurrences(id),
    received_by_user_id INTEGER NOT NULL REFERENCES users(id),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_by_user_id INTEGER REFERENCES users(id),
    verified_at TEXT,
    verification_result TEXT CHECK(verification_result IS NULL OR length(trim(verification_result)) BETWEEN 1 AND 2000),
    CHECK((verified_by_user_id IS NULL AND verified_at IS NULL AND verification_result IS NULL)
      OR (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_result IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_revalidation_per_delivery
    ON delivery_revalidations(delivery_id) WHERE verified_at IS NULL;
  CREATE TRIGGER IF NOT EXISTS revalidation_cycle_insert BEFORE INSERT ON delivery_revalidations
    WHEN NOT EXISTS (
      SELECT 1 FROM deliveries d
      JOIN orders o ON o.id = d.order_id
      JOIN delivery_attempts a ON a.id = NEW.delivery_attempt_id AND a.delivery_id = d.id
      JOIN delivery_occurrences oc ON oc.id = NEW.occurrence_id AND oc.delivery_id = d.id
        AND oc.delivery_attempt_id = a.id AND oc.type = 'temporary_external_obstruction'
      JOIN users receiver ON receiver.id = NEW.received_by_user_id
        AND receiver.role = 'company' AND receiver.company_id = o.company_id
      WHERE d.id = NEW.delivery_id AND d.status = 'awaiting_revalidation' AND d.courier_id IS NULL
        AND d.returned_at IS NOT NULL AND d.return_reported_at IS NOT NULL
        AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'recoverable'
        AND a.end_reason = 'temporary_external_obstruction'
        AND a.attempt_number = (SELECT MAX(latest.attempt_number) FROM delivery_attempts latest
          WHERE latest.delivery_id = d.id)
        AND NOT EXISTS(SELECT 1 FROM delivery_attempts open WHERE open.delivery_id = d.id
          AND open.status IN ('active', 'returning'))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid revalidation cycle or receiver'); END;
  CREATE TRIGGER IF NOT EXISTS revalidation_receipt_immutable BEFORE UPDATE ON delivery_revalidations
    WHEN NEW.id IS NOT OLD.id OR NEW.delivery_id IS NOT OLD.delivery_id
      OR NEW.delivery_attempt_id IS NOT OLD.delivery_attempt_id OR NEW.occurrence_id IS NOT OLD.occurrence_id
      OR NEW.received_by_user_id IS NOT OLD.received_by_user_id OR NEW.received_at IS NOT OLD.received_at
      OR OLD.verified_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'revalidation receipt and completed verification are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revalidation_verifier_insert BEFORE INSERT ON delivery_revalidations
    WHEN NEW.verified_by_user_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'revalidation must start pending'); END;
  CREATE TRIGGER IF NOT EXISTS revalidation_verifier_update BEFORE UPDATE ON delivery_revalidations
    WHEN NEW.verified_by_user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
      JOIN users u ON u.id = NEW.verified_by_user_id AND u.role = 'company' AND u.company_id = o.company_id
      WHERE d.id = NEW.delivery_id AND d.status = 'awaiting_revalidation'
        AND NOT EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id AND a.status IN ('active','returning'))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid revalidation verifier'); END;
  CREATE TRIGGER IF NOT EXISTS revalidation_delete_forbidden BEFORE DELETE ON delivery_revalidations
    BEGIN SELECT RAISE(ABORT, 'revalidation cannot be deleted'); END;
`;
