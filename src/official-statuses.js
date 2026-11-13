import { isCanonicalTimestamp } from "./finance.js";

// Projeções derivadas: status legado continua sendo a única fonte persistida.
export const ORDER_OFFICIAL_STATUSES = Object.freeze([
  "EM_MONTAGEM", "AGUARDANDO_CONFIRMACAO", "CONFIRMADO", "CONCLUIDO",
  "ENCERRADO", "CANCELADO", "RECUSADO",
]);
export const DELIVERY_OFFICIAL_STATUSES = Object.freeze([
  "DISPONIVEL", "EM_DESLOCAMENTO_PARA_COLETA", "AGUARDANDO_COLETA",
  "EM_TRANSPORTE", "AGUARDANDO_CONFIRMACAO", "RETORNO_AO_ESTABELECIMENTO",
  "AGUARDANDO_REVALIDACAO", "FINALIZADA", "CANCELADA", "NAO_REALIZADA",
]);
const deliveryStatuses = Object.freeze({
  available: "DISPONIVEL", heading_to_pickup: "EM_DESLOCAMENTO_PARA_COLETA",
  awaiting_pickup: "AGUARDANDO_COLETA", in_transit: "EM_TRANSPORTE",
  awaiting_confirmation: "AGUARDANDO_CONFIRMACAO", returning: "RETORNO_AO_ESTABELECIMENTO",
  awaiting_return_confirmation: "RETORNO_AO_ESTABELECIMENTO",
  awaiting_revalidation: "AGUARDANDO_REVALIDACAO", completed: "FINALIZADA", cancelled: "CANCELADA",
});
const cancelledReturnEvents = new Set(["client_cancelled_after_pickup"]);
const unsuccessfulReturnEvents = new Set(["recipient_absent", "recipient_refused", "confirmation_failed"]);

// Somente evidência persistida coerente autoriza a projeção de falha de código.
// O mesmo critério protege o fechamento e todos os consumidores de projeções.
export function hasConfirmationFailureEvidence(database, deliveryId, closed = false) {
  const delivery = database.prepare(`SELECT d.status, d.courier_id AS courierId,
    d.return_reason AS reason, d.return_reported_at AS reportedAt, d.returned_at AS returnedAt,
    o.status AS orderStatus FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`).get(deliveryId);
  const attempt = database.prepare(`SELECT id, courier_id AS courierId, status,
    invalid_code_attempts AS counter, started_at AS startedAt, ended_at AS endedAt, end_reason AS reason,
    end_nature AS nature FROM delivery_attempts WHERE delivery_id = ?
    ORDER BY attempt_number DESC LIMIT 1`).get(deliveryId);
  if (!delivery || !attempt || delivery.reason !== "confirmation_failed"
    || delivery.orderStatus !== "confirmed" || attempt.counter !== 3 || !delivery.reportedAt) return false;
  if (closed) {
    if (delivery.status !== "returned" || delivery.courierId !== null || !delivery.returnedAt
      || attempt.status !== "closed_unsuccessfully" || !attempt.endedAt
      || attempt.reason !== "confirmation_failed" || attempt.nature !== "terminal") return false;
  } else if (delivery.status !== "awaiting_return_confirmation"
    || attempt.status !== "returning" || attempt.courierId !== delivery.courierId
    || attempt.endedAt !== null || delivery.returnedAt !== null) return false;
  const occurrences = database.prepare(`SELECT id, delivery_attempt_id AS attemptId,
    reported_by_user_id AS reporter, reported_at AS reportedAt FROM delivery_occurrences
    WHERE delivery_id = ? AND type = 'confirmation_failed'`).all(deliveryId);
  if (occurrences.length !== 1 || occurrences[0].attemptId !== attempt.id
    || occurrences[0].reporter !== attempt.courierId) return false;
  const events = database.prepare(`SELECT e.id, e.event_type AS type,
    e.actor_user_id AS actorId, e.details_json AS details, e.occurred_at AS occurredAt,
    u.role, u.company_id AS companyId, o.company_id AS ownerCompanyId
    FROM delivery_events e JOIN deliveries d ON d.id = e.delivery_id
    JOIN orders o ON o.id = d.order_id LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.delivery_id = ? ORDER BY e.id`).all(deliveryId);
  if (events.some(({ type }) => ["recipient_absent", "recipient_refused",
    "client_cancelled_before_pickup", "client_cancelled_after_pickup", "delivery_completed"].includes(type))) return false;
  const failures = events.filter(({ type }) => type === "confirmation_failed");
  const reports = events.filter(({ type }) => type === "return_reported");
  const confirmations = events.filter(({ type }) => type === "return_confirmed");
  const collection = events.findLast(({ type }) => type === "order_collected");
  if (!collection || collection.actorId !== attempt.courierId || failures.length !== 1) return false;
  const arrivals = events.filter(({ id, type }) => id > collection.id
    && type === "courier_arrived_at_destination");
  if (arrivals.length !== 1 || arrivals[0].actorId !== attempt.courierId) return false;
  const validations = events.filter(({ id, type }) => id > collection.id
    && ["confirmation_code_invalid", "confirmation_failed"].includes(type));
  if (validations.length !== 3 || validations.some((event, index) => {
    try {
      const details = JSON.parse(event.details);
      return event.id <= arrivals[0].id || event.actorId !== attempt.courierId || details.attempt !== index + 1
        || details.remainingAttempts !== 2 - index
        || event.type !== (index === 2 ? "confirmation_failed" : "confirmation_code_invalid")
        || (index === 2 && details.occurrenceId !== occurrences[0].id);
    } catch { return true; }
  })) return false;
  const report = reports.filter(({ id }) => id > failures[0].id);
  if (report.length !== 1 || report[0].actorId !== attempt.courierId) return false;
  const confirmation = confirmations[0];
  if (closed) {
    if (confirmations.length !== 1 || confirmation.id <= report[0].id
      || confirmation.role !== "company" || confirmation.companyId !== confirmation.ownerCompanyId) return false;
    try {
      if (JSON.parse(confirmation.details).reason !== "confirmation_failed") return false;
    } catch { return false; }
  } else if (confirmations.length !== 0) return false;
  // Uma única cronologia para autorização e projeção. Antes do fechamento, o
  // limite é o relógio do banco; depois, os marcos finais entram na mesma cadeia.
  const { now } = database.prepare("SELECT CURRENT_TIMESTAMP AS now").get();
  const timestamps = [attempt.startedAt, collection.occurredAt, arrivals[0].occurredAt,
    validations[0].occurredAt, validations[1].occurredAt, occurrences[0].reportedAt,
    failures[0].occurredAt, delivery.reportedAt, report[0].occurredAt,
    ...(closed ? [attempt.endedAt, delivery.returnedAt, confirmation.occurredAt] : []), now];
  return timestamps.every((timestamp, index) => isCanonicalTimestamp(timestamp)
    && (index === 0 || timestamps[index - 1] <= timestamp));
}

export function terminalDeliveryEvent(database, deliveryId) {
  const events = database.prepare(`SELECT DISTINCT event_type AS type FROM delivery_events
    WHERE delivery_id = ? AND event_type IN ('client_cancelled_before_pickup',
      'client_cancelled_after_pickup', 'recipient_absent', 'recipient_refused', 'confirmation_failed')`)
    .all(deliveryId);
  if (events.length !== 1) return null;
  const type = events[0].type;
  return type === "confirmation_failed" && !hasConfirmationFailureEvidence(database, deliveryId, true)
    ? null : type;
}

export function officialDeliveryStatus(status, terminalEvent = null) {
  // returned não prova causa/semântica terminal suficiente para migração global.
  if (status === "returned" && cancelledReturnEvents.has(terminalEvent)) return "CANCELADA";
  if (status === "returned" && unsuccessfulReturnEvents.has(terminalEvent)) return "NAO_REALIZADA";
  return Object.hasOwn(deliveryStatuses, status) ? deliveryStatuses[status] : null;
}
export function officialOrderStatus(status, deliveryStatus = null, terminalEvent = null) {
  if (status === "draft") return "EM_MONTAGEM";
  if (status !== "confirmed") return null;
  if (deliveryStatus === "completed") return "CONCLUIDO";
  if ((deliveryStatus === "cancelled" && terminalEvent === "client_cancelled_before_pickup")
    || (deliveryStatus === "returned" && cancelledReturnEvents.has(terminalEvent))) return "CANCELADO";
  if (deliveryStatus === "returned" && unsuccessfulReturnEvents.has(terminalEvent)) return "ENCERRADO";
  if (deliveryStatus === "cancelled" || deliveryStatus === "returned") return null;
  if (deliveryStatus !== null && officialDeliveryStatus(deliveryStatus) === null) return null;
  return "CONFIRMADO";
}
