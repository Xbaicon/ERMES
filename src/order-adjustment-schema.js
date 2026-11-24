export const PRODUCT_UNAVAILABLE_EVIDENCE = `
  EXISTS (SELECT 1 FROM product_unavailability_closures WHERE delivery_id = ?)
`;

export const AUTHORIZED_ADJUSTMENT_ENTRY = `
  SELECT 1 FROM order_adjustments a
  JOIN orders o ON o.id = a.order_id
  WHERE a.state = 'applied' AND a.decided_by = o.client_id
    AND a.order_id = ENTRY.order_id AND a.delivery_id = ENTRY.delivery_id
    AND ENTRY.party_type = 'client' AND ENTRY.party_user_id = o.client_id
    AND ENTRY.component = 'products' AND ENTRY.reason = 'order_adjustment'
    AND ENTRY.occurred_at = a.applied_at
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = a.delivery_id
      AND e.actor_user_id = a.decided_by AND e.event_type = 'order_adjustment_accepted'
      AND json_extract(e.details_json, '$.adjustmentId') = a.id AND e.occurred_at = a.decided_at)
    AND ENTRY.idempotency_key = 'order-adjustment:' || a.id || ':' || ENTRY.entry_type || '-products'
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = a.delivery_id
      AND e.actor_user_id = a.decided_by AND e.event_type = 'order_adjustment_applied'
      AND json_extract(e.details_json, '$.adjustmentId') = a.id AND e.occurred_at = a.applied_at)
    AND ((ENTRY.entry_type = 'payment' AND a.paid_at = a.applied_at
          AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = a.delivery_id
            AND e.actor_user_id = a.decided_by AND e.event_type = 'order_adjustment_paid'
            AND json_extract(e.details_json, '$.adjustmentId') = a.id AND e.occurred_at = a.paid_at)
          AND ENTRY.amount_cents = a.proposed_subtotal - a.original_subtotal)
      OR (ENTRY.entry_type = 'refund' AND a.paid_at IS NULL
          AND ENTRY.amount_cents = a.original_subtotal - a.proposed_subtotal))
    AND ENTRY.amount_cents > 0
`;

const adjustmentTable = `
  CREATE TABLE IF NOT EXISTS order_adjustments (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    proposed_by INTEGER NOT NULL REFERENCES users(id),
    base_version INTEGER NOT NULL CHECK(base_version BETWEEN 1 AND 9007199254740990),
    original_items TEXT NOT NULL CHECK(json_valid(original_items)),
    proposed_items TEXT NOT NULL CHECK(json_valid(proposed_items)),
    original_subtotal INTEGER NOT NULL CHECK(original_subtotal BETWEEN 0 AND 9007199254740991),
    proposed_subtotal INTEGER NOT NULL CHECK(proposed_subtotal BETWEEN 0 AND 9007199254740991),
    original_weight REAL NOT NULL CHECK(original_weight > 0 AND original_weight <= 12),
    proposed_weight REAL NOT NULL CHECK(proposed_weight > 0 AND proposed_weight <= 12),
    original_freight INTEGER CHECK(original_freight BETWEEN 0 AND 9007199254740991),
    proposed_freight INTEGER CHECK(proposed_freight BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'awaiting_payment', 'applied', 'rejected')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT,
    applied_at TEXT,
    paid_at TEXT,
    CHECK((state = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
       OR (state <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CHECK((state = 'applied') = (applied_at IS NOT NULL)),
    CHECK(paid_at IS NULL OR (state = 'applied' AND paid_at = applied_at
      AND proposed_subtotal > original_subtotal))
  );
`;

export function evolveOrderAdjustmentSchema(database) {
  database.exec(adjustmentTable);
  const columns = database.prepare("PRAGMA table_info(order_adjustments)").all();
  if (!columns.some(({ name }) => name === "cancelled_at")) {
    database.exec("ALTER TABLE order_adjustments ADD COLUMN cancelled_at TEXT");
  }
  database.exec(adjustmentConstraints);
}

const adjustmentConstraints = `
  CREATE TABLE IF NOT EXISTS order_adjustment_validations (
    adjustment_id INTEGER PRIMARY KEY REFERENCES order_adjustments(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    proposed_items TEXT NOT NULL CHECK(json_valid(proposed_items)),
    proposed_subtotal INTEGER NOT NULL,
    proposed_weight REAL NOT NULL,
    seal TEXT NOT NULL CHECK(length(seal) = 64)
  );
  DROP TRIGGER IF EXISTS adjustment_validation_insert;
  CREATE TRIGGER adjustment_validation_insert BEFORE INSERT ON order_adjustment_validations
    WHEN NOT EXISTS (
      SELECT 1 FROM order_adjustments a
      WHERE a.id = NEW.adjustment_id AND a.order_id = NEW.order_id
        AND a.company_id = NEW.company_id AND a.state = 'pending'
        AND a.proposed_items = NEW.proposed_items
        AND a.proposed_subtotal = NEW.proposed_subtotal
        AND a.proposed_weight = NEW.proposed_weight
    )
    BEGIN SELECT RAISE(ABORT, 'invalid adjustment validation'); END;
  CREATE TRIGGER IF NOT EXISTS adjustment_validation_no_update
    BEFORE UPDATE ON order_adjustment_validations
    BEGIN SELECT RAISE(ABORT, 'adjustment validation is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS adjustment_validation_no_delete
    BEFORE DELETE ON order_adjustment_validations
    BEGIN SELECT RAISE(ABORT, 'adjustment validation is immutable'); END;

  DROP INDEX IF EXISTS order_adjustments_open;
  CREATE UNIQUE INDEX order_adjustments_open
    ON order_adjustments(delivery_id) WHERE state IN ('pending', 'awaiting_payment') AND cancelled_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS order_adjustments_applied_version
    ON order_adjustments(order_id, base_version) WHERE state = 'applied';

  CREATE TABLE IF NOT EXISTS product_unavailability_closures (
    delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    adjustment_id INTEGER UNIQUE REFERENCES order_adjustments(id),
    reason TEXT NOT NULL DEFAULT 'PRODUTO_INDISPONIVEL' CHECK(reason = 'PRODUTO_INDISPONIVEL'),
    responsibility TEXT NOT NULL DEFAULT 'EMPRESA' CHECK(responsibility = 'EMPRESA'),
    origin TEXT NOT NULL CHECK(origin IN ('company_no_adjustment', 'client_rejected')),
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK((origin = 'client_rejected') = (adjustment_id IS NOT NULL))
  );
  DROP TRIGGER IF EXISTS adjustment_validate_insert;
  CREATE TRIGGER adjustment_validate_insert BEFORE INSERT ON order_adjustments
    WHEN NEW.state <> 'pending' OR NEW.cancelled_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
      JOIN users u ON u.id = NEW.proposed_by AND u.role = 'company' AND u.company_id = o.company_id
      WHERE d.id = NEW.delivery_id AND o.id = NEW.order_id AND o.company_id = NEW.company_id
        AND o.status = 'confirmed' AND o.payment_status = 'paid'
        AND is_canonical_timestamp(NEW.created_at) = 1 AND NEW.created_at <= CURRENT_TIMESTAMP
        AND o.version = NEW.base_version AND o.items_total_cents = NEW.original_subtotal
        AND o.freight_total_cents IS NEW.original_freight
        AND d.status IN ('available', 'heading_to_pickup', 'awaiting_pickup') AND d.collected_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM delivery_attempts at WHERE at.delivery_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
          AND e.event_type = 'order_collected'))
    BEGIN SELECT RAISE(ABORT, 'invalid adjustment evidence'); END;

  DROP TRIGGER IF EXISTS adjustment_validate_update;
  CREATE TRIGGER adjustment_validate_update BEFORE UPDATE ON order_adjustments
    WHEN NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id
      OR NEW.delivery_id IS NOT OLD.delivery_id OR NEW.company_id IS NOT OLD.company_id
      OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.base_version IS NOT OLD.base_version
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.original_items IS NOT OLD.original_items OR NEW.proposed_items IS NOT OLD.proposed_items
      OR NEW.original_subtotal IS NOT OLD.original_subtotal OR NEW.proposed_subtotal IS NOT OLD.proposed_subtotal
      OR NEW.original_weight IS NOT OLD.original_weight OR NEW.proposed_weight IS NOT OLD.proposed_weight
      OR NEW.original_freight IS NOT OLD.original_freight OR NEW.proposed_freight IS NOT OLD.proposed_freight
      OR OLD.cancelled_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
        WHERE d.id = OLD.delivery_id AND o.id = OLD.order_id
          AND (NEW.cancelled_at IS NOT NULL OR o.client_id = NEW.decided_by)
          AND d.status IN ('available', 'heading_to_pickup', 'awaiting_pickup') AND d.collected_at IS NULL
          AND o.status = 'confirmed' AND o.payment_status = 'paid'
          AND ((NEW.state = 'applied' AND o.version = OLD.base_version + 1
                AND o.items_total_cents = OLD.proposed_subtotal AND o.freight_total_cents IS OLD.proposed_freight)
            OR (NEW.state <> 'applied' AND (NEW.cancelled_at IS NOT NULL
                OR (o.version = OLD.base_version AND o.items_total_cents = OLD.original_subtotal
                  AND o.freight_total_cents IS OLD.original_freight))))
          AND NOT EXISTS (SELECT 1 FROM delivery_attempts at WHERE at.delivery_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
            AND e.event_type = 'order_collected'))
      OR NOT (
        (NEW.cancelled_at IS NOT NULL AND OLD.state IN ('pending', 'awaiting_payment')
          AND NEW.state = OLD.state AND NEW.decided_by IS OLD.decided_by
          AND NEW.decided_at IS OLD.decided_at AND NEW.applied_at IS OLD.applied_at
          AND NEW.paid_at IS OLD.paid_at AND is_canonical_timestamp(NEW.cancelled_at) = 1
          AND NEW.cancelled_at BETWEEN COALESCE(OLD.decided_at, OLD.created_at) AND CURRENT_TIMESTAMP)
        OR (NEW.cancelled_at IS NULL AND is_canonical_timestamp(NEW.decided_at) = 1
          AND NEW.decided_at BETWEEN OLD.created_at AND CURRENT_TIMESTAMP
          AND (NEW.applied_at IS NULL OR (is_canonical_timestamp(NEW.applied_at) = 1
            AND NEW.applied_at BETWEEN NEW.decided_at AND CURRENT_TIMESTAMP))
          AND ((OLD.state = 'pending' AND NEW.state = 'rejected')
            OR (OLD.state = 'pending' AND NEW.state = 'awaiting_payment'
              AND OLD.proposed_subtotal > OLD.original_subtotal)
            OR (OLD.state = 'pending' AND NEW.state = 'applied'
              AND OLD.proposed_subtotal <= OLD.original_subtotal AND NEW.paid_at IS NULL)
            OR (OLD.state = 'awaiting_payment' AND NEW.state = 'applied'
              AND NEW.decided_at IS OLD.decided_at AND NEW.paid_at IS NOT NULL))))
    BEGIN SELECT RAISE(ABORT, 'invalid adjustment transition'); END;

  CREATE TRIGGER IF NOT EXISTS adjustment_no_delete BEFORE DELETE ON order_adjustments
    BEGIN SELECT RAISE(ABORT, 'adjustment history is retained'); END;

  DROP TRIGGER IF EXISTS adjustment_blocks_attempt;
  CREATE TRIGGER adjustment_blocks_attempt BEFORE INSERT ON delivery_attempts
    WHEN EXISTS (SELECT 1 FROM order_adjustments a WHERE a.delivery_id = NEW.delivery_id
      AND a.state IN ('pending', 'awaiting_payment') AND a.cancelled_at IS NULL)
      OR EXISTS (SELECT 1 FROM product_unavailability_closures c WHERE c.delivery_id = NEW.delivery_id)
    BEGIN SELECT RAISE(ABORT, 'adjustment blocks delivery attempt'); END;

  DROP TRIGGER IF EXISTS adjustment_blocks_delivery_progress;
  CREATE TRIGGER adjustment_blocks_delivery_progress BEFORE UPDATE OF status, collected_at, courier_id, accepted_at ON deliveries
    WHEN (NEW.status IS NOT OLD.status OR NEW.collected_at IS NOT OLD.collected_at
        OR NEW.courier_id IS NOT OLD.courier_id OR NEW.accepted_at IS NOT OLD.accepted_at)
      AND EXISTS (SELECT 1 FROM order_adjustments a WHERE a.delivery_id = OLD.id
        AND a.state IN ('pending', 'awaiting_payment') AND a.cancelled_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'adjustment blocks delivery progress'); END;

  DROP TRIGGER IF EXISTS adjustment_blocks_collection_event;
  CREATE TRIGGER adjustment_blocks_collection_event BEFORE INSERT ON delivery_events
    WHEN NEW.event_type = 'order_collected' AND (
      EXISTS (SELECT 1 FROM order_adjustments a WHERE a.delivery_id = NEW.delivery_id
        AND a.state IN ('pending', 'awaiting_payment') AND a.cancelled_at IS NULL)
      OR EXISTS (SELECT 1 FROM product_unavailability_closures c WHERE c.delivery_id = NEW.delivery_id))
    BEGIN SELECT RAISE(ABORT, 'adjustment blocks collection'); END;

  DROP TRIGGER IF EXISTS product_closure_validate;
  CREATE TRIGGER product_closure_validate BEFORE INSERT ON product_unavailability_closures
    WHEN NOT EXISTS (
      SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
      JOIN users u ON u.id = NEW.actor_id
      WHERE d.id = NEW.delivery_id AND d.status = 'cancelled' AND d.courier_id IS NULL
        AND d.collected_at IS NULL AND d.completed_at IS NULL AND d.return_reason IS NULL
        AND d.return_reported_at IS NULL AND d.returned_at IS NULL AND o.status = 'confirmed'
        AND d.cancelled_at = NEW.occurred_at AND is_canonical_timestamp(NEW.occurred_at) = 1
        AND NOT EXISTS (SELECT 1 FROM order_adjustments a WHERE a.delivery_id = d.id
          AND a.state IN ('pending', 'awaiting_payment') AND a.cancelled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM delivery_attempts at WHERE at.delivery_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
          AND e.event_type = 'order_collected')
        AND ((NEW.origin = 'company_no_adjustment' AND u.role = 'company' AND u.company_id = o.company_id)
          OR (NEW.origin = 'client_rejected' AND u.id = o.client_id AND EXISTS (
            SELECT 1 FROM order_adjustments a WHERE a.id = NEW.adjustment_id AND a.delivery_id = d.id
              AND a.state = 'rejected' AND a.decided_by = u.id AND a.decided_at = NEW.occurred_at))))
    BEGIN SELECT RAISE(ABORT, 'invalid product unavailability closure'); END;
  CREATE TRIGGER IF NOT EXISTS adjustment_events_no_update BEFORE UPDATE ON delivery_events
    WHEN OLD.event_type GLOB 'order_adjustment_*' OR NEW.event_type GLOB 'order_adjustment_*'
      OR (OLD.event_type = 'product_unavailable' AND EXISTS (
        SELECT 1 FROM product_unavailability_closures c WHERE c.delivery_id = OLD.delivery_id))
    BEGIN SELECT RAISE(ABORT, 'adjustment evidence is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS adjustment_events_no_delete BEFORE DELETE ON delivery_events
    WHEN OLD.event_type GLOB 'order_adjustment_*'
      OR (OLD.event_type = 'product_unavailable' AND EXISTS (
        SELECT 1 FROM product_unavailability_closures c WHERE c.delivery_id = OLD.delivery_id))
    BEGIN SELECT RAISE(ABORT, 'adjustment evidence is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS product_closure_final
    BEFORE UPDATE OF status, collected_at, courier_id, cancelled_at ON deliveries
    WHEN (NEW.status <> 'cancelled' OR NEW.collected_at IS NOT NULL
        OR NEW.courier_id IS NOT NULL OR NEW.cancelled_at IS NOT OLD.cancelled_at)
      AND EXISTS (SELECT 1 FROM product_unavailability_closures c WHERE c.delivery_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'product unavailability closure is final'); END;

  CREATE TRIGGER IF NOT EXISTS product_closure_no_update BEFORE UPDATE ON product_unavailability_closures
    BEGIN SELECT RAISE(ABORT, 'closure evidence is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS product_closure_no_delete BEFORE DELETE ON product_unavailability_closures
    BEGIN SELECT RAISE(ABORT, 'closure evidence is append-only'); END;
`;
