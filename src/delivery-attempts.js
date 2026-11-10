import { isCanonicalTimestamp } from "./finance.js";

export const DELIVERY_ATTEMPT_STATUSES = Object.freeze({
  ACTIVE: "active",
  RETURNING: "returning",
  COMPLETED: "completed",
  CLOSED_UNSUCCESSFULLY: "closed_unsuccessfully",
});

export const DELIVERY_ATTEMPT_END_NATURES = Object.freeze({
  RECOVERABLE: "recoverable",
  TERMINAL: "terminal",
});

const OPEN_ATTEMPT_STATUSES = Object.freeze([
  DELIVERY_ATTEMPT_STATUSES.ACTIVE,
  DELIVERY_ATTEMPT_STATUSES.RETURNING,
]);

function mapAttempt(row) {
  return row ? {
    id: row.id,
    deliveryId: row.deliveryId,
    attemptNumber: row.attemptNumber,
    courierId: row.courierId,
    status: row.status,
    invalidCodeAttempts: row.invalidCodeAttempts,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    endNature: row.endNature,
    courierName: row.courierName ?? null,
  } : null;
}

const attemptProjection = `SELECT a.id, a.delivery_id AS deliveryId,
  a.attempt_number AS attemptNumber, a.courier_id AS courierId, a.status,
  a.invalid_code_attempts AS invalidCodeAttempts,
  a.started_at AS startedAt, a.ended_at AS endedAt,
  a.end_reason AS endReason, a.end_nature AS endNature,
  courier.full_name AS courierName
  FROM delivery_attempts a
  JOIN users courier ON courier.id = a.courier_id`;

export function listDeliveryAttempts(database, deliveryId) {
  return database.prepare(`${attemptProjection}
    WHERE a.delivery_id = ? ORDER BY a.attempt_number`).all(deliveryId).map(mapAttempt);
}

export function findOpenDeliveryAttempt(database, deliveryId) {
  const placeholders = OPEN_ATTEMPT_STATUSES.map(() => "?").join(", ");
  return mapAttempt(database.prepare(`${attemptProjection}
    WHERE a.delivery_id = ? AND a.status IN (${placeholders})
    ORDER BY a.attempt_number DESC LIMIT 1`).get(deliveryId, ...OPEN_ATTEMPT_STATUSES));
}

export function createDeliveryAttemptInTransaction(database, deliveryId, courierId) {
  if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0
    || !Number.isSafeInteger(courierId) || courierId <= 0) {
    throw new TypeError("Entrega e motoboy devem possuir identificadores inteiros positivos.");
  }
  const assignment = database.prepare(`SELECT d.id
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN users courier ON courier.id = d.courier_id
      AND courier.role = 'courier' AND courier.company_id = o.company_id
    JOIN couriers profile ON profile.user_id = courier.id
    WHERE d.id = ? AND d.courier_id = ?`).get(deliveryId, courierId);
  if (!assignment) {
    throw Object.assign(new Error("O motoboy atribuído não é válido para esta Entrega."), { statusCode: 409 });
  }
  if (findOpenDeliveryAttempt(database, deliveryId)) {
    throw Object.assign(new Error("A entrega já possui uma tentativa ativa."), { statusCode: 409 });
  }
  const { attemptNumber } = database.prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attemptNumber
    FROM delivery_attempts WHERE delivery_id = ?`).get(deliveryId);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) {
    throw new RangeError("Não foi possível gerar um número inteiro válido para a tentativa.");
  }
  const result = database.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status)
    VALUES (?, ?, ?, ?)`)
    .run(deliveryId, attemptNumber, courierId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  return mapAttempt(database.prepare(`${attemptProjection} WHERE a.id = ?`).get(result.lastInsertRowid));
}

function legacyAttemptError() {
  return Object.assign(new Error(
    "A Entrega não possui TentativaEntrega aberta; é necessária reconciliação dos dados legados.",
  ), { statusCode: 409 });
}

export function markOpenDeliveryAttemptReturningInTransaction(database, deliveryId) {
  const result = database.prepare(`UPDATE delivery_attempts SET status = ?
    WHERE delivery_id = ? AND status = ?`)
    .run(DELIVERY_ATTEMPT_STATUSES.RETURNING, deliveryId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  if (Number(result.changes) !== 1) {
    throw legacyAttemptError();
  }
}

export function completeDeliveryAttemptInTransaction(database, deliveryId) {
  const result = database.prepare(`UPDATE delivery_attempts
    SET status = ?, ended_at = CURRENT_TIMESTAMP
    WHERE delivery_id = ? AND status = ?`)
    .run(DELIVERY_ATTEMPT_STATUSES.COMPLETED, deliveryId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  if (Number(result.changes) !== 1) {
    throw legacyAttemptError();
  }
}

export function closeDeliveryAttemptWithoutSuccessInTransaction(
  database, deliveryId, endReason, endNature,
) {
  if (!Object.values(DELIVERY_ATTEMPT_END_NATURES).includes(endNature)) {
    throw new RangeError("Natureza de encerramento da tentativa inválida.");
  }
  const result = database.prepare(`UPDATE delivery_attempts
    SET status = ?, ended_at = CURRENT_TIMESTAMP, end_reason = ?, end_nature = ?
    WHERE delivery_id = ? AND status IN (?, ?)`)
    .run(DELIVERY_ATTEMPT_STATUSES.CLOSED_UNSUCCESSFULLY, endReason, endNature, deliveryId,
      DELIVERY_ATTEMPT_STATUSES.ACTIVE, DELIVERY_ATTEMPT_STATUSES.RETURNING);
  if (Number(result.changes) !== 1) {
    throw legacyAttemptError();
  }
}

export function incrementInvalidCodeAttemptsInTransaction(database, deliveryId) {
  const attempt = findOpenDeliveryAttempt(database, deliveryId);
  if (!attempt || attempt.status !== DELIVERY_ATTEMPT_STATUSES.ACTIVE) throw legacyAttemptError();
  if (!Number.isSafeInteger(attempt.invalidCodeAttempts)
    || attempt.invalidCodeAttempts < 0 || attempt.invalidCodeAttempts >= 3) {
    throw Object.assign(new Error("O limite de três validações inválidas foi atingido."), { statusCode: 409 });
  }
  const nextValue = attempt.invalidCodeAttempts + 1;
  const update = database.prepare(`UPDATE delivery_attempts SET invalid_code_attempts = ?
    WHERE id = ? AND status = ? AND invalid_code_attempts = ?`)
    .run(nextValue, attempt.id, DELIVERY_ATTEMPT_STATUSES.ACTIVE, attempt.invalidCodeAttempts);
  if (Number(update.changes) !== 1) {
    throw Object.assign(new Error("A tentativa foi alterada. Recarregue o estado atual."), { statusCode: 409 });
  }
  return nextValue;
}

function parseEventDetails(value) {
  try {
    const details = JSON.parse(value);
    return details !== null && typeof details === "object" && !Array.isArray(details) ? details : null;
  } catch {
    return null;
  }
}

function hasUnambiguousLegacyCounterEvidence(database, attempt, delivery, counter) {
  if (!Number.isSafeInteger(counter) || counter < 1 || counter > 3
    || !isCanonicalTimestamp(attempt.startedAt)
    || (attempt.endedAt !== null && (!isCanonicalTimestamp(attempt.endedAt)
      || attempt.endedAt < attempt.startedAt))
    || (counter === 3 && (delivery.returnReason !== "confirmation_failed"
      || !((attempt.status === DELIVERY_ATTEMPT_STATUSES.RETURNING
        && delivery.status === "returning")
        || (attempt.status === DELIVERY_ATTEMPT_STATUSES.CLOSED_UNSUCCESSFULLY
          && attempt.endReason === "confirmation_failed"
          && attempt.endNature === DELIVERY_ATTEMPT_END_NATURES.TERMINAL
          && delivery.status === "returned"))))) return false;
  const events = database.prepare(`SELECT event_type AS eventType, details_json AS detailsJson,
    occurred_at AS occurredAt, actor_user_id AS actorUserId
    FROM delivery_events
    WHERE delivery_id = ? AND event_type IN ('confirmation_code_invalid', 'confirmation_failed')
    ORDER BY id`).all(attempt.deliveryId);
  if (events.length !== counter) return false;
  let previousTimestamp = attempt.startedAt;
  return events.every((event, index) => {
    const validationNumber = index + 1;
    const expectedType = validationNumber === 3
      ? "confirmation_failed" : "confirmation_code_invalid";
    const details = parseEventDetails(event.detailsJson);
    const coherent = event.eventType === expectedType
      && event.actorUserId === attempt.courierId
      && isCanonicalTimestamp(event.occurredAt)
      && event.occurredAt >= previousTimestamp
      && (attempt.endedAt === null || event.occurredAt <= attempt.endedAt)
      && details?.attempt === validationNumber
      && details?.remainingAttempts === 3 - validationNumber;
    if (coherent) previousTimestamp = event.occurredAt;
    return coherent;
  });
}

export function migrateLegacyInvalidCodeAttempts(database) {
  const candidates = database.prepare(`SELECT id AS deliveryId,
    invalid_code_attempts AS invalidCodeAttempts,
    status, return_reason AS returnReason
    FROM deliveries WHERE invalid_code_attempts BETWEEN 1 AND 3`).all();
  const attemptsForDelivery = database.prepare(`SELECT id, delivery_id AS deliveryId,
    attempt_number AS attemptNumber, courier_id AS courierId,
    status, started_at AS startedAt, ended_at AS endedAt,
    end_reason AS endReason, end_nature AS endNature
    FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number`);
  const update = database.prepare(`UPDATE delivery_attempts SET invalid_code_attempts = ?
    WHERE id = ? AND invalid_code_attempts = 0`);
  for (const candidate of candidates) {
    const attempts = attemptsForDelivery.all(candidate.deliveryId);
    if (attempts.length !== 1
      || !hasUnambiguousLegacyCounterEvidence(
        database, attempts[0], candidate, candidate.invalidCodeAttempts,
      )) continue;
    update.run(candidate.invalidCodeAttempts, attempts[0].id);
  }
}
