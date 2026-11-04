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
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    endNature: row.endNature,
    courierName: row.courierName ?? null,
  } : null;
}

const attemptProjection = `SELECT a.id, a.delivery_id AS deliveryId,
  a.attempt_number AS attemptNumber, a.courier_id AS courierId, a.status,
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
  if (findOpenDeliveryAttempt(database, deliveryId)) {
    throw Object.assign(new Error("A entrega já possui uma tentativa ativa."), { statusCode: 409 });
  }
  const { attemptNumber } = database.prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attemptNumber
    FROM delivery_attempts WHERE delivery_id = ?`).get(deliveryId);
  const result = database.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status)
    VALUES (?, ?, ?, ?)`)
    .run(deliveryId, attemptNumber, courierId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  return mapAttempt(database.prepare(`${attemptProjection} WHERE a.id = ?`).get(result.lastInsertRowid));
}

export function markOpenDeliveryAttemptReturningInTransaction(database, deliveryId) {
  const result = database.prepare(`UPDATE delivery_attempts SET status = ?
    WHERE delivery_id = ? AND status = ?`)
    .run(DELIVERY_ATTEMPT_STATUSES.RETURNING, deliveryId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  if (Number(result.changes) !== 1) {
    throw Object.assign(new Error("A entrega não possui uma tentativa ativa para retorno."), { statusCode: 409 });
  }
}

export function completeDeliveryAttemptInTransaction(database, deliveryId) {
  const result = database.prepare(`UPDATE delivery_attempts
    SET status = ?, ended_at = CURRENT_TIMESTAMP
    WHERE delivery_id = ? AND status = ?`)
    .run(DELIVERY_ATTEMPT_STATUSES.COMPLETED, deliveryId, DELIVERY_ATTEMPT_STATUSES.ACTIVE);
  if (Number(result.changes) !== 1) {
    throw Object.assign(new Error("A entrega não possui uma tentativa ativa para conclusão."), { statusCode: 409 });
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
    throw Object.assign(new Error("A entrega não possui uma tentativa aberta para encerramento."), { statusCode: 409 });
  }
}
