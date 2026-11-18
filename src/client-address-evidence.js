import { normalizeAddress } from "./address.js";

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function canonicalAddress(value) {
  const normalized = normalizeAddress(value);
  return Object.keys(value).length === Object.keys(normalized).length
    && Object.keys(normalized).every((key) => value[key] === normalized[key]) ? normalized : null;
}

// Função pura também usada pelo trigger SQL. Não lê o banco nem infere culpa.
export function validAddressEvidence(snapshotJson, evidenceJson) {
  try {
    const snapshot = parseObject(snapshotJson);
    const evidence = parseObject(evidenceJson);
    const original = canonicalAddress(snapshot);
    const storedOriginal = canonicalAddress(evidence?.originalAddress);
    const presented = canonicalAddress(evidence?.presentedAddress);
    return Number(Boolean(original && storedOriginal && presented
      && Object.keys(evidence).length === 3
      && evidence.deliveryState === "awaiting_confirmation"
      && JSON.stringify(original) === JSON.stringify(storedOriginal)));
  } catch { return 0; }
}

const addressFields = ["postalCode", "state", "city", "neighborhood", "street", "number", "complement"];
const originalFieldMatches = addressFields.map((field) => `json_extract(o.destination_snapshot_json, '$.${field}')
  = json_extract(oc.evidence_json, '$.originalAddress.${field}')`).join(" AND ");
const addressShape = (path) => `json_type(oc.evidence_json, '${path}') = 'object'
  AND (SELECT COUNT(*) FROM json_each(oc.evidence_json, '${path}')) = 7
  AND json_type(oc.evidence_json, '${path}.postalCode') = 'text'
  AND length(json_extract(oc.evidence_json, '${path}.postalCode')) = 8
  AND json_extract(oc.evidence_json, '${path}.postalCode') NOT GLOB '*[^0-9]*'
  AND json_type(oc.evidence_json, '${path}.state') = 'text'
  AND length(json_extract(oc.evidence_json, '${path}.state')) = 2
  AND json_extract(oc.evidence_json, '${path}.state') = upper(json_extract(oc.evidence_json, '${path}.state'))
  AND json_extract(oc.evidence_json, '${path}.state') NOT GLOB '*[^A-Z]*'
  AND ${["city", "neighborhood", "street", "number"].map((field) => `
    json_type(oc.evidence_json, '${path}.${field}') = 'text'
    AND length(trim(json_extract(oc.evidence_json, '${path}.${field}'))) > 0
    AND json_extract(oc.evidence_json, '${path}.${field}') = trim(json_extract(oc.evidence_json, '${path}.${field}'))`).join(" AND ")}
  AND json_type(oc.evidence_json, '${path}.complement') = 'text'
  AND json_extract(oc.evidence_json, '${path}.complement') = trim(json_extract(oc.evidence_json, '${path}.complement'))`;
const SQL_ADDRESS_EVIDENCE = `CASE WHEN json_valid(o.destination_snapshot_json) = 1
  AND json_valid(oc.evidence_json) = 1 THEN
  json_type(o.destination_snapshot_json) = 'object'
  AND (SELECT COUNT(*) FROM json_each(o.destination_snapshot_json)) = 7
  AND (SELECT COUNT(*) FROM json_each(oc.evidence_json)) = 3
  AND json_extract(oc.evidence_json, '$.deliveryState') = 'awaiting_confirmation'
  AND ${addressShape("$.originalAddress")}
  AND ${addressShape("$.presentedAddress")}
  AND ${originalFieldMatches} ELSE 0 END`;

const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ordered = (values) => values.every((value, index) => timestamp.test(value)
  && (index === 0 || values[index - 1] <= value));

export function clientAddressEvidence(database, deliveryId, stage) {
  const row = database.prepare(`SELECT d.id, d.status, d.courier_id AS deliveryCourier,
      d.return_reason AS returnReason, d.collected_at AS collectedAt,
      d.return_reported_at AS returnReportedAt, d.returned_at AS returnedAt,
      o.status AS orderStatus, o.company_id AS companyId,
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
  if (row.length !== 1) return null;
  const r = row[0];
  if (r.orderStatus !== "confirmed" || r.reporterId !== r.courierId
    || !validAddressEvidence(r.snapshotJson, r.evidenceJson)
    || database.prepare(`SELECT COUNT(*) AS total FROM delivery_occurrences
      WHERE delivery_attempt_id = ?`).get(r.attemptId).total !== 1) return null;
  const events = database.prepare(`SELECT e.id, e.event_type AS type, e.actor_user_id AS actorId,
      e.occurred_at AS at, e.details_json AS details, u.role, u.company_id AS companyId
    FROM delivery_events e LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.delivery_id = ? ORDER BY e.id`).all(deliveryId);
  const collection = events.filter((event) => event.type === "order_collected").at(-1);
  const cycle = events.filter((event) => collection && event.id > collection.id);
  const cycleOne = (type) => {
    const found = cycle.filter((event) => event.type === type);
    return found.length === 1 ? found[0] : null;
  };
  const address = cycleOne("address_problem");
  const classification = cycleOne("occurrence_classified");
  const arrival = events.filter((event) => event.type === "courier_arrived_at_destination"
    && collection && event.id > collection.id).at(-1);
  const report = cycleOne("return_reported");
  const confirmation = cycleOne("return_confirmed");
  const detailId = (event) => parseObject(event?.details)?.occurrenceId;
  const courierEvent = (event) => event?.actorId === r.courierId
    && event.role === "courier" && event.companyId === r.companyId;
  const companyEvent = (event) => event?.role === "company" && event.companyId === r.companyId;
  if (!collection || !arrival || !address
    || events.filter((event) => event.type === "order_collected").length !== r.attemptNumber
    || !(collection.id < arrival.id && arrival.id < address.id)
    || ![collection, arrival, address].every(courierEvent)
    || detailId(address) !== r.occurrenceId
    || !ordered([r.startedAt, r.collectedAt, collection.at, arrival.at,
      r.occurrenceAt, address.at])
    || r.collectedAt !== collection.at || r.occurrenceAt !== address.at
    || events.some((event) => event.id > collection.id && [
      "recipient_absent", "recipient_refused", "confirmation_failed", "delivery_completed",
      "client_cancelled_after_pickup", "temporary_external_obstruction",
      "courier_failed_after_pickup", "courier_failed_before_pickup",
    ].includes(event.type))) return null;
  if (stage === "unclassified") {
    return r.status === "awaiting_confirmation" && r.attemptStatus === "active"
      && r.deliveryCourier === r.courierId && r.returnReason === null
      && r.returnReportedAt === null && r.returnedAt === null && r.endedAt === null
      && r.responsibility === null && !classification && !report && !confirmation ? r : null;
  }
  if (r.responsibility !== "CLIENTE" || r.classifierRole !== "company"
    || r.classifierCompany !== r.companyId || !classification
    || detailId(classification) !== r.occurrenceId
    || parseObject(classification.details)?.responsibility !== "CLIENTE"
    || !companyEvent(classification) || classification.id <= address.id
    || !ordered([address.at, r.classifiedAt, classification.at,
      database.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now])
    || r.classifiedAt !== classification.at) return null;
  if (stage === "classified") return r.status === "awaiting_confirmation"
    && r.attemptStatus === "active" && r.deliveryCourier === r.courierId
    && r.returnReason === null && !report && !confirmation && r.endedAt === null ? r : null;
  if (stage === "returning") return r.status === "returning" && r.attemptStatus === "returning"
    && r.deliveryCourier === r.courierId && r.returnReason === "address_problem"
    && r.returnReportedAt === null && r.returnedAt === null && r.endedAt === null
    && !report && !confirmation ? r : null;
  if (r.returnReason !== "address_problem" || r.deliveryCourier !== (stage === "closed" ? null : r.courierId)
    || r.returnReportedAt === null || !report || !courierEvent(report)
    || report.id <= classification.id || r.returnReportedAt !== report.at
    || !ordered([classification.at, report.at])) return null;
  if (stage === "reported") return r.status === "awaiting_return_confirmation"
    && r.attemptStatus === "returning" && r.endedAt === null
    && r.returnedAt === null && !confirmation ? r : null;
  if (stage === "closed") return r.status === "returned" && r.attemptStatus === "closed_unsuccessfully"
    && r.endNature === "terminal" && r.endReason === "address_problem"
    && confirmation && companyEvent(confirmation) && confirmation.id > report.id
    && parseObject(confirmation.details)?.reason === "address_problem"
    && r.returnedAt === confirmation.at && r.endedAt === confirmation.at
    && ordered([report.at, r.endedAt, r.returnedAt, confirmation.at])
    && database.prepare(`${CLIENT_ADDRESS_CLOSED_SQL} AND d.id = ?`).get(deliveryId) ? r : null;
  return null;
}

// A mesma consulta limita os lançamentos por SQL direto ao ciclo terminal fechado.
export const CLIENT_ADDRESS_CLOSED_SQL = `SELECT 1 FROM deliveries d
  JOIN orders o ON o.id = d.order_id AND o.status = 'confirmed'
  JOIN delivery_attempts a ON a.delivery_id = d.id
    AND a.id = (SELECT latest.id FROM delivery_attempts latest WHERE latest.delivery_id = d.id
      ORDER BY latest.attempt_number DESC LIMIT 1)
    AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'terminal'
    AND a.end_reason = 'address_problem' AND a.courier_id IS NOT NULL
  JOIN delivery_occurrences oc ON oc.delivery_id = d.id AND oc.delivery_attempt_id = a.id
    AND oc.type = 'address_problem' AND oc.responsibility = 'CLIENTE'
    AND oc.reported_by_user_id = a.courier_id
  JOIN users courier ON courier.id = a.courier_id AND courier.role = 'courier'
    AND courier.company_id = o.company_id
  JOIN users classifier ON classifier.id = oc.classified_by_user_id
    AND classifier.role = 'company' AND classifier.company_id = o.company_id
  JOIN delivery_events collected ON collected.delivery_id = d.id
    AND collected.event_type = 'order_collected' AND collected.actor_user_id = a.courier_id
    AND collected.occurred_at = d.collected_at
  JOIN delivery_events arrived ON arrived.delivery_id = d.id
    AND arrived.event_type = 'courier_arrived_at_destination' AND arrived.actor_user_id = a.courier_id
  JOIN delivery_events problem ON problem.delivery_id = d.id
    AND problem.event_type = 'address_problem' AND problem.actor_user_id = a.courier_id
    AND json_extract(problem.details_json, '$.occurrenceId') = oc.id
    AND problem.occurred_at = oc.reported_at
  JOIN delivery_events classified ON classified.delivery_id = d.id
    AND classified.event_type = 'occurrence_classified' AND classified.actor_user_id = classifier.id
    AND json_extract(classified.details_json, '$.occurrenceId') = oc.id
    AND json_extract(classified.details_json, '$.responsibility') = 'CLIENTE'
    AND classified.occurred_at = oc.classified_at
  JOIN delivery_events reported ON reported.delivery_id = d.id
    AND reported.event_type = 'return_reported' AND reported.actor_user_id = a.courier_id
    AND reported.occurred_at = d.return_reported_at
  JOIN delivery_events confirmed ON confirmed.delivery_id = d.id
    AND confirmed.event_type = 'return_confirmed' AND json_extract(confirmed.details_json, '$.reason') = 'address_problem'
    AND confirmed.occurred_at = d.returned_at
  JOIN users receiver ON receiver.id = confirmed.actor_user_id
    AND receiver.role = 'company' AND receiver.company_id = o.company_id
  WHERE d.status = 'returned' AND d.courier_id IS NULL AND d.return_reason = 'address_problem'
    AND a.ended_at = d.returned_at AND (${SQL_ADDRESS_EVIDENCE}) = 1
    AND is_canonical_timestamp(a.started_at) = 1
    AND is_canonical_timestamp(d.returned_at) = 1
    AND is_canonical_timestamp(oc.classified_at) = 1
    AND oc.classified_at <= CURRENT_TIMESTAMP
    AND (SELECT COUNT(*) FROM delivery_occurrences same
      WHERE same.delivery_attempt_id = a.id AND same.type = 'address_problem') = 1
    AND (SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.event_type = 'order_collected') = a.attempt_number
    AND (SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.id > collected.id
        AND same.event_type = 'address_problem') = 1
    AND (SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.id > collected.id
        AND same.event_type = 'occurrence_classified') = 1
    AND (SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.id > collected.id
        AND same.event_type = 'return_reported') = 1
    AND (SELECT COUNT(*) FROM delivery_events same
      WHERE same.delivery_id = d.id AND same.id > collected.id
        AND same.event_type = 'return_confirmed') = 1
    AND a.started_at <= collected.occurred_at AND collected.id < arrived.id
    AND collected.occurred_at <= arrived.occurred_at AND arrived.id < problem.id
    AND arrived.occurred_at <= problem.occurred_at AND problem.id < classified.id
    AND problem.occurred_at <= classified.occurred_at AND classified.id < reported.id
    AND classified.occurred_at <= reported.occurred_at AND reported.id < confirmed.id
    AND reported.occurred_at <= confirmed.occurred_at
    AND NOT EXISTS (SELECT 1 FROM delivery_occurrences conflict
      WHERE conflict.delivery_attempt_id = a.id AND conflict.id <> oc.id)
    AND NOT EXISTS (SELECT 1 FROM delivery_events conflict
      WHERE conflict.delivery_id = d.id AND conflict.id > collected.id
        AND conflict.event_type IN ('recipient_absent', 'recipient_refused', 'confirmation_failed',
          'delivery_completed', 'client_cancelled_after_pickup', 'temporary_external_obstruction',
          'courier_failed_after_pickup', 'courier_failed_before_pickup'))`;
