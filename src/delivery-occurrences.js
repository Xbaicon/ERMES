import { db, transaction } from "./database.js";
import { DELIVERY_EVENT_TYPES } from "./deliveries.js";

export const DELIVERY_OCCURRENCE_TYPES = Object.freeze({
  COURIER_FAILURE_BEFORE_PICKUP: "courier_failure_before_pickup",
  COURIER_FAILURE_AFTER_PICKUP: "courier_failure_after_pickup",
  RECIPIENT_ABSENT: "recipient_absent",
  RECIPIENT_REFUSED: "recipient_refused",
  CONFIRMATION_FAILED: "confirmation_failed",
  ADDRESS_PROBLEM: "address_problem",
  EXTERNAL_OBSTRUCTION: "temporary_external_obstruction",
});

export const DELIVERY_OCCURRENCE_RESPONSIBILITIES = Object.freeze([
  "CLIENTE", "EMPRESA", "MOTOBOY", "SISTEMA", "INDEFINIDO",
]);

const occurrenceTypes = new Set(Object.values(DELIVERY_OCCURRENCE_TYPES));
const responsibilities = new Set(DELIVERY_OCCURRENCE_RESPONSIBILITIES);

function occurrenceError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseDeliveryOccurrenceId(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw occurrenceError("Identificador de ocorrência inválido.", 400);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw occurrenceError("Identificador de ocorrência inválido.", 400);
  return id;
}

function requirePositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw occurrenceError(`${field} deve ser um inteiro positivo seguro.`, 500);
  }
}

function normalizeDescription(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) {
    throw occurrenceError("A descrição da ocorrência deve ter até 500 caracteres.", 500);
  }
  return value.trim();
}

function requirePlainObject(value, message, statusCode = 400) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw occurrenceError(message, statusCode);
  }
  return value;
}

export function createDeliveryOccurrenceInTransaction(database, {
  deliveryId, deliveryAttemptId = null, type, description = null,
  reportedByUserId, evidence = {},
}) {
  requirePositiveSafeInteger(deliveryId, "deliveryId");
  requirePositiveSafeInteger(reportedByUserId, "reportedByUserId");
  if (deliveryAttemptId !== null) requirePositiveSafeInteger(deliveryAttemptId, "deliveryAttemptId");
  if (!occurrenceTypes.has(type)) throw occurrenceError("Tipo interno de ocorrência inválido.", 500);
  requirePlainObject(evidence, "A evidência interna da ocorrência é inválida.", 500);

  const delivery = database.prepare("SELECT id FROM deliveries WHERE id = ?").get(deliveryId);
  if (!delivery) throw occurrenceError("Entrega não encontrada.", 404);
  const reporter = database.prepare("SELECT id FROM users WHERE id = ?").get(reportedByUserId);
  if (!reporter) throw occurrenceError("Usuário relator não encontrado.", 500);
  if (deliveryAttemptId !== null) {
    const attempt = database.prepare(`SELECT id FROM delivery_attempts
      WHERE id = ? AND delivery_id = ?`).get(deliveryAttemptId, deliveryId);
    if (!attempt) throw occurrenceError("A tentativa informada não pertence à entrega.", 500);
  }

  const result = database.prepare(`INSERT INTO delivery_occurrences
    (delivery_id, delivery_attempt_id, type, description, reported_by_user_id, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    deliveryId, deliveryAttemptId, type, normalizeDescription(description), reportedByUserId,
    JSON.stringify(evidence),
  );
  if (Number(result.changes) !== 1) throw occurrenceError("Não foi possível registrar a ocorrência.", 500);
  return Number(result.lastInsertRowid);
}

function safeOccurrence(row) {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    deliveryAttemptId: row.deliveryAttemptId,
    type: row.type,
    description: row.description,
    reportedAt: row.reportedAt,
    reporter: { fullName: row.reporterName, role: row.reporterRole },
    classified: row.responsibility !== null,
    responsibility: row.responsibility,
    classifiedAt: row.classifiedAt,
    classifier: row.classifierName ? { fullName: row.classifierName, role: row.classifierRole } : null,
    analysisResult: row.analysisResult,
  };
}

const occurrenceSelect = `SELECT occurrence.id,
    occurrence.delivery_id AS deliveryId,
    occurrence.delivery_attempt_id AS deliveryAttemptId,
    occurrence.type, occurrence.description,
    occurrence.reported_at AS reportedAt,
    occurrence.responsibility,
    occurrence.classified_at AS classifiedAt,
    occurrence.analysis_result AS analysisResult,
    reporter.full_name AS reporterName, reporter.role AS reporterRole,
    classifier.full_name AS classifierName, classifier.role AS classifierRole
  FROM delivery_occurrences occurrence
  JOIN deliveries delivery ON delivery.id = occurrence.delivery_id
  JOIN orders orders ON orders.id = delivery.order_id
  JOIN users reporter ON reporter.id = occurrence.reported_by_user_id
  LEFT JOIN users classifier ON classifier.id = occurrence.classified_by_user_id`;

export function listCompanyDeliveryOccurrences(companyId) {
  return db.prepare(`${occurrenceSelect}
    WHERE orders.company_id = ?
    ORDER BY occurrence.reported_at, occurrence.id`).all(companyId).map(safeOccurrence);
}

function requireClassificationBody(body) {
  requirePlainObject(body, "O corpo deve ser um objeto JSON.");
  const unexpected = Object.keys(body).filter((key) => !["responsibility", "analysisResult"].includes(key));
  if (unexpected.length) throw occurrenceError(`Campos não permitidos: ${unexpected.join(", ")}.`, 400);
  if (!responsibilities.has(body.responsibility)) {
    throw occurrenceError("Responsabilidade inválida.", 400);
  }
  if (body.analysisResult !== undefined && body.analysisResult !== null
    && (typeof body.analysisResult !== "string" || !body.analysisResult.trim()
      || body.analysisResult.trim().length > 2000)) {
    throw occurrenceError("O resultado da análise deve ter até 2000 caracteres.", 400);
  }
  return {
    responsibility: body.responsibility,
    analysisResult: body.analysisResult === undefined || body.analysisResult === null
      ? null : body.analysisResult.trim(),
  };
}

export function classifyDeliveryOccurrence(occurrenceId, classifierUserId, companyId, body) {
  const classification = requireClassificationBody(body);
  return transaction(() => {
    const occurrence = db.prepare(`${occurrenceSelect}
      WHERE occurrence.id = ? AND orders.company_id = ?`).get(occurrenceId, companyId);
    if (!occurrence) throw occurrenceError("Ocorrência não encontrada.", 404);
    if (occurrence.responsibility !== null) throw occurrenceError("A ocorrência já foi classificada.");

    const update = db.prepare(`UPDATE delivery_occurrences
      SET responsibility = ?, classified_by_user_id = ?, classified_at = CURRENT_TIMESTAMP,
          analysis_result = ?
      WHERE id = ? AND responsibility IS NULL`).run(
      classification.responsibility, classifierUserId, classification.analysisResult, occurrenceId,
    );
    if (Number(update.changes) !== 1) throw occurrenceError("A ocorrência já foi classificada.");
    const eventResult = db.prepare(`INSERT INTO delivery_events
      (delivery_id, actor_user_id, event_type, details_json)
      VALUES (?, ?, ?, ?)`).run(occurrence.deliveryId, classifierUserId,
      DELIVERY_EVENT_TYPES.OCCURRENCE_CLASSIFIED,
      JSON.stringify({ occurrenceId, responsibility: classification.responsibility }));
    if (Number(eventResult.changes) !== 1) {
      throw occurrenceError("Não foi possível registrar a classificação da ocorrência.", 500);
    }
    const classified = db.prepare(`${occurrenceSelect}
      WHERE occurrence.id = ? AND orders.company_id = ?`).get(occurrenceId, companyId);
    return safeOccurrence(classified);
  });
}
