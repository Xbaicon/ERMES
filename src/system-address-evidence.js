import { normalizeAddress } from "./address.js";
import { SQL_ADDRESS_EVIDENCE, validAddressEvidence } from "./client-address-evidence.js";

const addressFields = ["postalCode", "state", "city", "neighborhood", "street", "number", "complement"];

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function canonicalAddressJson(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const normalized = normalizeAddress(parsed);
    if (Object.keys(parsed).length !== Object.keys(normalized).length
      || Object.keys(normalized).some((key) => parsed[key] !== normalized[key])) return null;
    return JSON.stringify(Object.fromEntries(addressFields.map((field) => [field, normalized[field]])));
  } catch { return null; }
}

export function isSystemAddressBlocked(database, address) {
  const canonical = canonicalAddressJson(address);
  if (!canonical) return false;
  return Boolean(database.prepare(`SELECT 1 FROM system_address_blocks
    WHERE canonical_address_json = ? AND cleared_at IS NULL LIMIT 1`).get(canonical));
}

export function canonicalSystemAddress(address) {
  return canonicalAddressJson(address);
}

function sqlCanonicalAddressShape(value) {
  return `json_type(${value}) = 'object'
    AND (SELECT COUNT(*) FROM json_each(${value})) = 7
    AND ${addressFields.map((field) => `json_type(${value}, '$.${field}') = 'text'
      AND json_extract(${value}, '$.${field}') = trim(json_extract(${value}, '$.${field}'))`).join(" AND ")}
    AND length(json_extract(${value}, '$.postalCode')) = 8
    AND json_extract(${value}, '$.postalCode') NOT GLOB '*[^0-9]*'
    AND length(json_extract(${value}, '$.state')) = 2
    AND json_extract(${value}, '$.state') NOT GLOB '*[^A-Z]*'
    AND ${["city", "neighborhood", "street", "number"].map((field) =>
    `length(json_extract(${value}, '$.${field}')) > 0`).join(" AND ")}`;
}

function sqlSameCanonicalAddress(left, right) {
  return `(CASE WHEN json_valid(${left}) = 1 AND json_valid(${right}) = 1 THEN
    (${sqlCanonicalAddressShape(left)} AND ${sqlCanonicalAddressShape(right)}
      AND ${addressFields.map((field) =>
    `json_extract(${left}, '$.${field}') = json_extract(${right}, '$.${field}')`).join(" AND ")})
    ELSE 0 END) = 1`;
}

const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ordered = (values) => values.every((value, index) => timestamp.test(value)
  && (index === 0 || values[index - 1] <= value));

export function systemAddressEvidence(database, deliveryId, stage) {
  const rows = database.prepare(`SELECT d.id, d.status, d.courier_id AS deliveryCourier,
      d.return_reason AS returnReason, d.collected_at AS collectedAt,
      d.return_reported_at AS returnReportedAt, d.returned_at AS returnedAt,
      d.accepted_at AS acceptedAt, o.status AS orderStatus, o.company_id AS companyId,
      o.destination_snapshot_json AS snapshotJson,
      a.id AS attemptId, a.attempt_number AS attemptNumber, a.courier_id AS courierId,
      a.status AS attemptStatus, a.started_at AS startedAt, a.ended_at AS endedAt,
      a.end_reason AS endReason, a.end_nature AS endNature,
      oc.id AS occurrenceId, oc.reported_by_user_id AS reporterId,
      oc.reported_at AS occurrenceAt, oc.evidence_json AS evidenceJson,
      oc.responsibility, oc.classified_at AS classifiedAt,
      classifier.role AS classifierRole, classifier.company_id AS classifierCompany
    FROM deliveries d JOIN orders o ON o.id = d.order_id
    JOIN delivery_attempts a ON a.delivery_id = d.id
      AND a.attempt_number = (SELECT MAX(latest.attempt_number) FROM delivery_attempts latest
        WHERE latest.delivery_id = d.id)
    JOIN delivery_occurrences oc ON oc.delivery_id = d.id
      AND oc.delivery_attempt_id = a.id AND oc.type = 'address_problem'
    LEFT JOIN users classifier ON classifier.id = oc.classified_by_user_id
    WHERE d.id = ?`).all(deliveryId);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row.orderStatus !== "confirmed" || row.reporterId !== row.courierId
    || !validAddressEvidence(row.snapshotJson, row.evidenceJson)) return null;

  const events = database.prepare(`SELECT e.id, e.event_type AS type,
      e.actor_user_id AS actorId, e.occurred_at AS at, e.details_json AS details,
      actor.role, actor.company_id AS actorCompany
    FROM delivery_events e LEFT JOIN users actor ON actor.id = e.actor_user_id
    WHERE e.delivery_id = ? ORDER BY e.id`).all(deliveryId);
  const collections = events.filter(({ type }) => type === "order_collected");
  const collection = collections.at(-1);
  if (!collection || collections.length !== row.attemptNumber) return null;
  const cycle = events.filter(({ id }) => id > collection.id);
  const one = (type) => {
    const matches = cycle.filter((event) => event.type === type);
    return matches.length === 1 ? matches[0] : null;
  };
  const address = one("address_problem");
  const classification = one("occurrence_classified");
  const arrivals = cycle.filter(({ type }) => type === "courier_arrived_at_destination");
  const arrival = arrivals.length === 1 ? arrivals[0] : null;
  const start = one("system_address_return_started");
  const report = one("return_reported");
  const confirmation = one("return_confirmed");
  const awaiting = one("system_address_awaiting_resolution");
  const corrected = one("system_address_corrected");
  const persistent = one("system_address_persistent");
  const details = (event) => parseObject(event?.details);
  const courierEvent = (event) => event?.actorId === row.courierId
    && event.role === "courier" && event.actorCompany === row.companyId;
  const companyEvent = (event) => event?.role === "company"
    && event.actorCompany === row.companyId;

  if (!arrival || !address || !courierEvent(collection) || !courierEvent(arrival)
    || !courierEvent(address) || details(address)?.occurrenceId !== row.occurrenceId
    || !(collection.id < arrival.id && arrival.id < address.id)
    || row.startedAt !== collection.at
    || (row.collectedAt !== null && row.collectedAt !== collection.at)
    || row.occurrenceAt !== address.at
    || !ordered([row.startedAt, collection.at, arrival.at, row.occurrenceAt, address.at])
    || cycle.some(({ type }) => ["recipient_absent", "recipient_refused",
      "client_cancelled_after_pickup", "temporary_external_obstruction",
      "courier_failed_after_pickup", "courier_failed_before_pickup"].includes(type))) return null;

  if (stage === "unclassified") {
    return row.status === "awaiting_confirmation" && row.attemptStatus === "active"
      && row.deliveryCourier === row.courierId && row.returnReason === null
      && row.responsibility === null && !classification && !start && !report && !confirmation
      && row.returnReportedAt === null && row.returnedAt === null && row.endedAt === null ? row : null;
  }

  if (row.responsibility !== "SISTEMA" || row.classifierRole !== "company"
    || row.classifierCompany !== row.companyId || !classification
    || details(classification)?.occurrenceId !== row.occurrenceId
    || details(classification)?.responsibility !== "SISTEMA"
    || !companyEvent(classification) || classification.id <= address.id
    || row.classifiedAt !== classification.at
    || !ordered([address.at, row.classifiedAt, classification.at])) return null;

  if (stage === "classified") {
    return row.status === "awaiting_confirmation" && row.attemptStatus === "active"
      && row.deliveryCourier === row.courierId && row.returnReason === null
      && !start && !report && !confirmation && row.returnReportedAt === null
      && row.returnedAt === null && row.endedAt === null ? row : null;
  }
  if (stage === "superseded") return row;

  if (!start || !courierEvent(start) || start.id <= classification.id
    || details(start)?.occurrenceId !== row.occurrenceId
    || !ordered([classification.at, start.at])) return null;
  if (stage === "returning") {
    return row.status === "returning" && row.attemptStatus === "returning"
      && row.deliveryCourier === row.courierId && row.returnReason === "address_problem"
      && !report && !confirmation && row.returnReportedAt === null
      && row.returnedAt === null && row.endedAt === null ? row : null;
  }

  if (!report || !courierEvent(report) || report.id <= start.id
    || (stage !== "corrected" && row.returnReportedAt !== report.at)
    || !ordered([start.at, report.at])) return null;
  if (stage === "reported") {
    return row.status === "awaiting_return_confirmation" && row.attemptStatus === "returning"
      && row.deliveryCourier === row.courierId && row.returnReason === "address_problem"
      && !confirmation && row.returnedAt === null && row.endedAt === null ? row : null;
  }

  if (!confirmation || !companyEvent(confirmation) || confirmation.id <= report.id
    || details(confirmation)?.reason !== "address_problem"
    || details(confirmation)?.responsibility !== "SISTEMA"
    || (stage !== "corrected" && row.returnedAt !== confirmation.at)
    || row.endedAt !== confirmation.at
    || !ordered([report.at, confirmation.at])) return null;
  const resolution = database.prepare(`SELECT r.*, resolver.role AS resolver_role,
      resolver.company_id AS resolver_company
    FROM system_address_resolutions r
    LEFT JOIN users resolver ON resolver.id = r.resolved_by_user_id
    WHERE r.delivery_id = ? AND r.delivery_attempt_id = ? AND r.occurrence_id = ?`)
    .get(deliveryId, row.attemptId, row.occurrenceId);
  if (!resolution || !awaiting || !companyEvent(awaiting)
    || details(awaiting)?.resolutionId !== resolution.id
    || details(awaiting)?.occurrenceId !== row.occurrenceId
    || awaiting.id <= confirmation.id || resolution.received_at !== awaiting.at
    || resolution.received_at !== confirmation.at
    || resolution.received_by_user_id !== awaiting.actorId) return null;

  if (stage === "received") {
    return row.status === "awaiting_revalidation" && row.deliveryCourier === null
      && row.attemptStatus === "closed_unsuccessfully" && row.endNature === "recoverable"
      && row.endReason === "address_problem" && resolution.resolution === "pending"
      && resolution.resolved_at === null && !corrected && !persistent ? { ...row, resolution } : null;
  }

  if (resolution.resolved_by_user_id === null || resolution.resolver_role !== "company"
    || resolution.resolver_company !== row.companyId || !resolution.resolved_at) return null;
  if (stage === "corrected") {
    return resolution.resolution === "corrected" && resolution.client_available === 1
      && corrected && companyEvent(corrected) && corrected.actorId === resolution.resolved_by_user_id
      && corrected.at === resolution.resolved_at && details(corrected)?.resolutionId === resolution.id
      && row.status === "available" && row.deliveryCourier === null && row.returnReason === null
      && row.returnReportedAt === null && row.returnedAt === null ? { ...row, resolution } : null;
  }
  if (stage === "persistent") {
    const block = database.prepare(`SELECT id FROM system_address_blocks
      WHERE source_resolution_id = ? AND canonical_address_json = ? AND cleared_at IS NULL`)
      .get(resolution.id, canonicalAddressJson(row.snapshotJson));
    return resolution.resolution === "persistent" && resolution.client_available === null
      && persistent && companyEvent(persistent) && persistent.actorId === resolution.resolved_by_user_id
      && persistent.at === resolution.resolved_at && details(persistent)?.resolutionId === resolution.id
      && row.status === "returned" && row.deliveryCourier === null && block
      ? { ...row, resolution, blockId: block.id } : null;
  }
  return null;
}

export const SYSTEM_ADDRESS_PERSISTENT_SQL = `SELECT 1
  FROM system_address_resolutions r
  JOIN deliveries d ON d.id = r.delivery_id
  JOIN orders o ON o.id = d.order_id AND o.status = 'confirmed'
  JOIN delivery_attempts a ON a.id = r.delivery_attempt_id AND a.delivery_id = d.id
    AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'recoverable'
    AND a.end_reason = 'address_problem'
    AND a.id = (SELECT latest.id FROM delivery_attempts latest
      WHERE latest.delivery_id = d.id ORDER BY latest.attempt_number DESC LIMIT 1)
  JOIN delivery_occurrences oc ON oc.id = r.occurrence_id AND oc.delivery_id = d.id
    AND oc.delivery_attempt_id = a.id AND oc.type = 'address_problem'
    AND oc.responsibility = 'SISTEMA' AND oc.reported_by_user_id = a.courier_id
  JOIN users classifier ON classifier.id = oc.classified_by_user_id
    AND classifier.role = 'company' AND classifier.company_id = o.company_id
  JOIN users courier ON courier.id = a.courier_id
    AND courier.role = 'courier' AND courier.company_id = o.company_id
  JOIN users receiver ON receiver.id = r.received_by_user_id
    AND receiver.role = 'company' AND receiver.company_id = o.company_id
  JOIN users resolver ON resolver.id = r.resolved_by_user_id
    AND resolver.role = 'company' AND resolver.company_id = o.company_id
  JOIN delivery_events collected ON collected.delivery_id = d.id
    AND collected.event_type = 'order_collected' AND collected.actor_user_id = a.courier_id
    AND collected.occurred_at = a.started_at
  JOIN delivery_events arrived ON arrived.delivery_id = d.id
    AND arrived.event_type = 'courier_arrived_at_destination'
    AND arrived.actor_user_id = a.courier_id
  JOIN delivery_events problem ON problem.delivery_id = d.id
    AND problem.event_type = 'address_problem' AND problem.actor_user_id = a.courier_id
    AND json_extract(problem.details_json, '$.occurrenceId') = oc.id
    AND problem.occurred_at = oc.reported_at
  JOIN delivery_events classified ON classified.delivery_id = d.id
    AND classified.event_type = 'occurrence_classified'
    AND classified.actor_user_id = oc.classified_by_user_id
    AND json_extract(classified.details_json, '$.occurrenceId') = oc.id
    AND json_extract(classified.details_json, '$.responsibility') = 'SISTEMA'
    AND classified.occurred_at = oc.classified_at
  JOIN delivery_events started ON started.delivery_id = d.id
    AND started.event_type = 'system_address_return_started'
    AND started.actor_user_id = a.courier_id
    AND json_extract(started.details_json, '$.occurrenceId') = oc.id
  JOIN delivery_events reported ON reported.delivery_id = d.id
    AND reported.event_type = 'return_reported' AND reported.actor_user_id = a.courier_id
    AND reported.occurred_at = d.return_reported_at
  JOIN delivery_events confirmed ON confirmed.delivery_id = d.id
    AND confirmed.event_type = 'return_confirmed'
    AND confirmed.actor_user_id = r.received_by_user_id
    AND confirmed.occurred_at = r.received_at
    AND json_extract(confirmed.details_json, '$.reason') = 'address_problem'
    AND json_extract(confirmed.details_json, '$.responsibility') = 'SISTEMA'
  JOIN delivery_events awaiting ON awaiting.delivery_id = d.id
    AND awaiting.event_type = 'system_address_awaiting_resolution'
    AND awaiting.actor_user_id = r.received_by_user_id
    AND awaiting.occurred_at = r.received_at
    AND json_extract(awaiting.details_json, '$.resolutionId') = r.id
    AND json_extract(awaiting.details_json, '$.occurrenceId') = oc.id
  JOIN delivery_events terminal ON terminal.delivery_id = d.id
    AND terminal.event_type = 'system_address_persistent'
    AND terminal.actor_user_id = r.resolved_by_user_id
    AND terminal.occurred_at = r.resolved_at
    AND json_extract(terminal.details_json, '$.resolutionId') = r.id
    AND json_extract(terminal.details_json, '$.occurrenceId') = oc.id
  JOIN system_address_blocks block ON block.source_resolution_id = r.id
    AND ${sqlSameCanonicalAddress("block.canonical_address_json", "o.destination_snapshot_json")}
    AND block.cleared_at IS NULL
  WHERE r.resolution = 'persistent' AND r.client_available IS NULL
    AND is_canonical_timestamp(r.received_at) = 1 AND is_canonical_timestamp(r.resolved_at) = 1
    AND r.received_at <= r.resolved_at AND r.resolved_at <= CURRENT_TIMESTAMP
    AND d.status = 'returned' AND d.courier_id IS NULL AND d.return_reason = 'address_problem'
    AND d.return_reported_at IS NOT NULL AND d.returned_at = r.received_at
    AND a.ended_at = r.received_at AND (${SQL_ADDRESS_EVIDENCE}) = 1
    AND (SELECT COUNT(*) FROM delivery_events same WHERE same.delivery_id = d.id
      AND same.event_type = 'order_collected') = a.attempt_number
    AND (SELECT COUNT(*) FROM delivery_occurrences same
      WHERE same.delivery_attempt_id = a.id) = 1
    AND ${["courier_arrived_at_destination", "address_problem", "occurrence_classified", "system_address_return_started",
    "return_reported", "return_confirmed", "system_address_awaiting_resolution",
    "system_address_persistent"].map((type) => `(SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.id > collected.id
        AND same.event_type = '${type}') = 1`).join(" AND ")}
    AND collected.id < arrived.id AND arrived.id < problem.id AND problem.id < classified.id
    AND classified.id < started.id AND started.id < reported.id AND reported.id < confirmed.id
    AND confirmed.id < awaiting.id AND awaiting.id < terminal.id
    AND collected.occurred_at <= arrived.occurred_at
    AND arrived.occurred_at <= problem.occurred_at
    AND problem.occurred_at <= classified.occurred_at
    AND classified.occurred_at <= started.occurred_at
    AND started.occurred_at <= reported.occurred_at
    AND reported.occurred_at <= confirmed.occurred_at
    AND confirmed.occurred_at <= awaiting.occurred_at
    AND awaiting.occurred_at <= terminal.occurred_at
    AND NOT EXISTS (SELECT 1 FROM delivery_events conflict
      WHERE conflict.delivery_id = d.id AND conflict.id > collected.id
        AND conflict.event_type IN ('recipient_absent', 'recipient_refused', 'confirmation_failed',
          'delivery_completed', 'client_cancelled_after_pickup', 'temporary_external_obstruction',
          'courier_failed_after_pickup', 'courier_failed_before_pickup'))`;

export function evolveSystemAddressSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS system_address_resolutions (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
      delivery_attempt_id INTEGER NOT NULL UNIQUE REFERENCES delivery_attempts(id),
      occurrence_id INTEGER NOT NULL UNIQUE REFERENCES delivery_occurrences(id),
      received_by_user_id INTEGER NOT NULL REFERENCES users(id),
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolution TEXT NOT NULL DEFAULT 'pending'
        CHECK(resolution IN ('pending', 'corrected', 'persistent')),
      resolved_by_user_id INTEGER REFERENCES users(id),
      resolved_at TEXT,
      verification_result TEXT CHECK(verification_result IS NULL
        OR length(trim(verification_result)) BETWEEN 1 AND 2000),
      client_available INTEGER CHECK(client_available IS NULL OR client_available = 1),
      CHECK((resolution = 'pending' AND resolved_by_user_id IS NULL AND resolved_at IS NULL
          AND verification_result IS NULL AND client_available IS NULL)
        OR (resolution = 'corrected' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL
          AND verification_result IS NOT NULL AND client_available = 1)
        OR (resolution = 'persistent' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL
          AND verification_result IS NOT NULL AND client_available IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_system_address_per_delivery
      ON system_address_resolutions(delivery_id) WHERE resolution = 'pending';
    CREATE TABLE IF NOT EXISTS system_address_blocks (
      id INTEGER PRIMARY KEY,
      source_resolution_id INTEGER NOT NULL UNIQUE REFERENCES system_address_resolutions(id),
      canonical_address_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleared_at TEXT
    );
    CREATE INDEX IF NOT EXISTS system_address_blocks_canonical
      ON system_address_blocks(canonical_address_json) WHERE cleared_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS system_address_resolution_insert
      BEFORE INSERT ON system_address_resolutions
      WHEN NOT EXISTS (SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
        JOIN delivery_attempts a ON a.id = NEW.delivery_attempt_id AND a.delivery_id = d.id
        JOIN delivery_occurrences oc ON oc.id = NEW.occurrence_id AND oc.delivery_id = d.id
          AND oc.delivery_attempt_id = a.id AND oc.type = 'address_problem'
          AND oc.responsibility = 'SISTEMA'
        JOIN users receiver ON receiver.id = NEW.received_by_user_id
          AND receiver.role = 'company' AND receiver.company_id = o.company_id
        WHERE d.id = NEW.delivery_id AND d.status = 'awaiting_revalidation'
          AND d.courier_id IS NULL AND d.return_reason = 'address_problem'
          AND d.returned_at IS NOT NULL AND d.return_reported_at IS NOT NULL
          AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'recoverable'
          AND a.end_reason = 'address_problem'
          AND NOT EXISTS (SELECT 1 FROM delivery_attempts open WHERE open.delivery_id = d.id
            AND open.status IN ('active', 'returning')))
      BEGIN SELECT RAISE(ABORT, 'invalid system address resolution cycle'); END;
    CREATE TRIGGER IF NOT EXISTS system_address_resolution_update
      BEFORE UPDATE ON system_address_resolutions
      WHEN OLD.resolution <> 'pending' OR NEW.id IS NOT OLD.id
        OR NEW.delivery_id IS NOT OLD.delivery_id
        OR NEW.delivery_attempt_id IS NOT OLD.delivery_attempt_id
        OR NEW.occurrence_id IS NOT OLD.occurrence_id
        OR NEW.received_by_user_id IS NOT OLD.received_by_user_id
        OR NEW.received_at IS NOT OLD.received_at
        OR NEW.resolution NOT IN ('corrected', 'persistent')
        OR NOT EXISTS (SELECT 1 FROM deliveries d JOIN orders o ON o.id = d.order_id
          JOIN users resolver ON resolver.id = NEW.resolved_by_user_id
            AND resolver.role = 'company' AND resolver.company_id = o.company_id
          WHERE d.id = NEW.delivery_id AND d.status = 'awaiting_revalidation'
            AND d.courier_id IS NULL AND o.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM delivery_attempts open WHERE open.delivery_id = d.id
              AND open.status IN ('active', 'returning')))
      BEGIN SELECT RAISE(ABORT, 'invalid system address resolution'); END;
    CREATE TRIGGER IF NOT EXISTS system_address_resolution_delete
      BEFORE DELETE ON system_address_resolutions
      BEGIN SELECT RAISE(ABORT, 'system address resolution cannot be deleted'); END;
    DROP TRIGGER IF EXISTS system_address_block_insert;
    CREATE TRIGGER system_address_block_insert
      BEFORE INSERT ON system_address_blocks
      WHEN NEW.canonical_address_json IS NOT canonical_system_address_json(NEW.canonical_address_json)
        OR NOT EXISTS (SELECT 1 FROM system_address_resolutions r
        JOIN deliveries d ON d.id = r.delivery_id JOIN orders o ON o.id = d.order_id
        WHERE r.id = NEW.source_resolution_id AND r.resolution = 'persistent'
          AND d.status = 'returned' AND d.return_reason = 'address_problem'
          AND ${sqlSameCanonicalAddress("NEW.canonical_address_json", "o.destination_snapshot_json")})
      BEGIN SELECT RAISE(ABORT, 'invalid persistent system address block'); END;
    CREATE TRIGGER IF NOT EXISTS system_address_block_update
      BEFORE UPDATE ON system_address_blocks
      BEGIN SELECT RAISE(ABORT, 'system address block is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS system_address_block_delete
      BEFORE DELETE ON system_address_blocks
      BEGIN SELECT RAISE(ABORT, 'system address block cannot be deleted'); END;
    DROP TRIGGER IF EXISTS system_address_block_order_confirmation;
    CREATE TRIGGER system_address_block_order_confirmation
      BEFORE UPDATE OF status ON orders
      WHEN NEW.status = 'confirmed' AND EXISTS (SELECT 1 FROM system_address_blocks block
        WHERE ${sqlSameCanonicalAddress("block.canonical_address_json", "NEW.destination_snapshot_json")}
          AND block.cleared_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'system cannot process blocked address'); END;
    DROP TRIGGER IF EXISTS system_address_block_order_payment;
    CREATE TRIGGER system_address_block_order_payment
      BEFORE UPDATE OF payment_status ON orders
      WHEN NEW.payment_status = 'paid' AND EXISTS (SELECT 1 FROM system_address_blocks block
        WHERE ${sqlSameCanonicalAddress("block.canonical_address_json", "NEW.destination_snapshot_json")}
          AND block.cleared_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'system cannot process blocked address'); END;
    DROP TRIGGER IF EXISTS system_address_block_delivery_insert;
    CREATE TRIGGER system_address_block_delivery_insert
      BEFORE INSERT ON deliveries
      WHEN EXISTS (SELECT 1 FROM orders o JOIN system_address_blocks block
        ON ${sqlSameCanonicalAddress("block.canonical_address_json", "o.destination_snapshot_json")}
          AND block.cleared_at IS NULL WHERE o.id = NEW.order_id)
      BEGIN SELECT RAISE(ABORT, 'system cannot process blocked address'); END;
  `);
  const invalidBlock = database.prepare(`SELECT id FROM system_address_blocks
    WHERE canonical_address_json IS NOT canonical_system_address_json(canonical_address_json)
    LIMIT 1`).get();
  if (invalidBlock) throw new Error(`System address block ${invalidBlock.id} requires reconciliation.`);
}
