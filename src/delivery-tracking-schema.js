// Tracking is attached to the delivery. These triggers run inside the transaction
// that changes the operational state, including recovery and courier replacement.
export function evolveDeliveryTrackingSchema(database) {
  // A fixture legada mínima não tem a coluna status; o bootstrap não deve
  // pressupor que ela existe ao reconhecer atribuições históricas.
  const hasUserStatus = database.prepare("PRAGMA table_info(users)").all()
    .some(({ name }) => name === "status");
  const activeUserCondition = hasUserStatus ? "AND u.status = 'active'" : "";
  database.exec(`
    CREATE TABLE IF NOT EXISTS delivery_tracking_periods (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
      courier_id INTEGER NOT NULL REFERENCES users(id),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_kind TEXT CHECK(end_kind IN ('paused', 'ended')),
      CHECK((ended_at IS NULL AND end_kind IS NULL)
        OR (ended_at IS NOT NULL AND end_kind IS NOT NULL AND ended_at >= started_at))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_tracking_period_per_delivery
      ON delivery_tracking_periods(delivery_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS tracking_periods_delivery
      ON delivery_tracking_periods(delivery_id, id);
    CREATE TRIGGER IF NOT EXISTS tracking_period_identity_update
      BEFORE UPDATE ON delivery_tracking_periods
      WHEN NEW.id IS NOT OLD.id OR NEW.delivery_id IS NOT OLD.delivery_id
        OR NEW.courier_id IS NOT OLD.courier_id OR NEW.started_at IS NOT OLD.started_at
        OR (OLD.ended_at IS NOT NULL AND
          (NEW.ended_at IS NOT OLD.ended_at OR NEW.end_kind IS NOT OLD.end_kind))
      BEGIN SELECT RAISE(ABORT, 'tracking period identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS tracking_period_delete
      BEFORE DELETE ON delivery_tracking_periods
      BEGIN SELECT RAISE(ABORT, 'tracking periods are retained'); END;

    CREATE TABLE IF NOT EXISTS delivery_tracking_positions (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
      period_id INTEGER NOT NULL REFERENCES delivery_tracking_periods(id),
      courier_id INTEGER NOT NULL REFERENCES users(id),
      latitude REAL NOT NULL CHECK(typeof(latitude) IN ('real', 'integer') AND latitude BETWEEN -90 AND 90),
      longitude REAL NOT NULL CHECK(typeof(longitude) IN ('real', 'integer') AND longitude BETWEEN -180 AND 180),
      accuracy_meters REAL CHECK(accuracy_meters IS NULL OR
        (typeof(accuracy_meters) IN ('real', 'integer') AND accuracy_meters >= 0)),
      captured_at TEXT NOT NULL CHECK(COALESCE(
        captured_at = strftime('%Y-%m-%dT%H:%M:%fZ', captured_at), 0)),
      received_at TEXT NOT NULL CHECK(COALESCE(
        received_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at), 0)),
      UNIQUE(period_id, courier_id, captured_at, latitude, longitude)
    );
    CREATE INDEX IF NOT EXISTS tracking_positions_history
      ON delivery_tracking_positions(delivery_id, captured_at, id);
    CREATE INDEX IF NOT EXISTS tracking_positions_period
      ON delivery_tracking_positions(period_id, captured_at, id);

    CREATE TRIGGER IF NOT EXISTS tracking_period_authorized_insert
      BEFORE INSERT ON delivery_tracking_periods
      WHEN NOT EXISTS (
        SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
        JOIN users u ON u.id = NEW.courier_id
        WHERE d.id = NEW.delivery_id AND d.courier_id = NEW.courier_id
          AND d.status IN ('heading_to_pickup', 'in_transit', 'returning')
          AND (d.status = 'heading_to_pickup' OR EXISTS (
            SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id
              AND a.courier_id = NEW.courier_id
              AND a.status = CASE d.status WHEN 'in_transit' THEN 'active' ELSE 'returning' END
          ))
          AND u.role = 'courier' ${activeUserCondition} AND u.company_id = o.company_id
      )
      BEGIN SELECT RAISE(ABORT, 'tracking period requires current courier'); END;
    CREATE TRIGGER IF NOT EXISTS tracking_period_delivery_update
      AFTER UPDATE OF status, courier_id ON deliveries
      WHEN OLD.status IS NOT NEW.status OR OLD.courier_id IS NOT NEW.courier_id
      BEGIN
        UPDATE delivery_tracking_periods
          SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              end_kind = CASE WHEN NEW.courier_id IS OLD.courier_id
                AND NEW.status IN ('awaiting_pickup', 'awaiting_confirmation',
                  'awaiting_return_confirmation', 'awaiting_revalidation')
                THEN 'paused' ELSE 'ended' END
          WHERE delivery_id = NEW.id AND ended_at IS NULL
            AND (NEW.status NOT IN ('heading_to_pickup', 'in_transit', 'returning')
              OR NEW.courier_id IS NOT courier_id);
        INSERT INTO delivery_tracking_periods (delivery_id, courier_id, started_at)
          SELECT NEW.id, NEW.courier_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM orders o JOIN users u ON u.id = NEW.courier_id
          WHERE o.id = NEW.order_id AND u.role = 'courier'
            ${activeUserCondition} AND u.company_id = o.company_id
            AND NEW.status IN ('heading_to_pickup', 'in_transit', 'returning')
            AND (NEW.status = 'heading_to_pickup' OR EXISTS (
              SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = NEW.id
                AND a.courier_id = NEW.courier_id
                AND a.status = CASE NEW.status WHEN 'in_transit' THEN 'active' ELSE 'returning' END
            ))
            AND NOT EXISTS (SELECT 1 FROM delivery_tracking_periods
              WHERE delivery_id = NEW.id AND ended_at IS NULL);
      END;
    CREATE TRIGGER IF NOT EXISTS tracking_position_current_period_insert
      BEFORE INSERT ON delivery_tracking_positions
      WHEN NOT EXISTS (
        SELECT 1 FROM delivery_tracking_periods p
        JOIN deliveries d ON d.id = p.delivery_id
        JOIN orders o ON o.id = d.order_id
        JOIN users u ON u.id = p.courier_id
        WHERE p.id = NEW.period_id AND p.delivery_id = NEW.delivery_id
          AND p.courier_id = NEW.courier_id AND p.ended_at IS NULL
          AND NEW.captured_at >= p.started_at
          AND NEW.captured_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 seconds')
          AND d.id = NEW.delivery_id AND d.courier_id = NEW.courier_id
          AND d.status IN ('heading_to_pickup', 'in_transit', 'returning')
          AND (d.status = 'heading_to_pickup' OR EXISTS (
            SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id
              AND a.courier_id = NEW.courier_id
              AND a.status = CASE d.status WHEN 'in_transit' THEN 'active' ELSE 'returning' END
          ))
          AND u.role = 'courier' ${activeUserCondition} AND u.company_id = o.company_id
      )
      BEGIN SELECT RAISE(ABORT, 'tracking period is not currently authorized'); END;
    CREATE TRIGGER IF NOT EXISTS tracking_positions_append_only_update
      BEFORE UPDATE ON delivery_tracking_positions
      BEGIN SELECT RAISE(ABORT, 'tracking positions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS tracking_positions_append_only_delete
      BEFORE DELETE ON delivery_tracking_positions
      BEGIN SELECT RAISE(ABORT, 'tracking positions are append-only'); END;
  `);
  // Legacy in-progress deliveries gain a period from bootstrap time onward.
  // No earlier movement or position is inferred.
  database.prepare(`INSERT INTO delivery_tracking_periods (delivery_id, courier_id, started_at)
    SELECT d.id, d.courier_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM deliveries d JOIN orders o ON o.id = d.order_id
    JOIN users u ON u.id = d.courier_id AND u.role = 'courier'
      ${activeUserCondition} AND u.company_id = o.company_id
    WHERE d.status IN ('heading_to_pickup', 'in_transit', 'returning')
      AND (d.status = 'heading_to_pickup' OR EXISTS (
        SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id
          AND a.courier_id = d.courier_id
          AND a.status = CASE d.status WHEN 'in_transit' THEN 'active' ELSE 'returning' END
      ))
      AND NOT EXISTS (SELECT 1 FROM delivery_tracking_periods p
        WHERE p.delivery_id = d.id AND p.ended_at IS NULL)`).run();
}
