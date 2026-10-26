import { db, transaction } from "./database.js";
import { DELIVERY_EVENT_TYPES, DELIVERY_STATES } from "./deliveries.js";
import { decryptConfirmationCode, verifyConfirmationCode } from "./security.js";
import {
  clientFinancialSummary, companyFinancialSummary, courierFinancialSummary,
  recordClientCancellationAfterPickupInTransaction, recordNormalCompletionInTransaction,
  recordProductUnavailableInTransaction,
} from "./finance.js";

const TERMINAL_STATES = Object.freeze([
  DELIVERY_STATES.COMPLETED, DELIVERY_STATES.CANCELLED, DELIVERY_STATES.RETURNED,
]);
const BEFORE_PICKUP = new Set([
  DELIVERY_STATES.AVAILABLE, DELIVERY_STATES.HEADING_TO_PICKUP, DELIVERY_STATES.AWAITING_PICKUP,
]);

function deliveryError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseDeliveryId(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw deliveryError("Identificador de entrega inválido.", 400);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw deliveryError("Identificador de entrega inválido.", 400);
  return id;
}

function requireObject(body, allowed = []) {
  if (body === null || Array.isArray(body) || typeof body !== "object") {
    throw deliveryError("O corpo deve ser um objeto JSON.", 400);
  }
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw deliveryError(`Campos não permitidos: ${unexpected.join(", ")}.`, 400);
  return body;
}

export function requireEmptyDeliveryBody(body) {
  requireObject(body);
}

function findDelivery(id) {
  return db.prepare(`SELECT d.id, d.order_id AS orderId, d.courier_id AS courierId, d.status,
                            d.invalid_code_attempts AS invalidCodeAttempts,
                            d.accepted_at AS acceptedAt, d.collected_at AS collectedAt,
                            d.completed_at AS completedAt, d.cancelled_at AS cancelledAt,
                            d.return_reason AS returnReason, d.return_reported_at AS returnReportedAt,
                            d.returned_at AS returnedAt, d.created_at AS createdAt,
                            d.confirmation_code_hash AS confirmationCodeHash,
                            d.confirmation_code_ciphertext AS confirmationCodeCiphertext,
                            o.client_id AS clientId, o.company_id AS companyId,
                            o.items_total_cents AS itemsTotalCents,
                            o.freight_total_cents AS freightTotalCents,
                            o.payment_status AS paymentStatus,
                            o.payment_paid_at AS paymentPaidAt,
                            o.destination_snapshot_json AS destinationSnapshotJson,
                            o.recipient_snapshot_json AS recipientSnapshotJson,
                            c.name AS companyName, c.address_json AS pickupAddressJson,
                            client.full_name AS clientName, client.phone AS clientPhone,
                            courier.full_name AS courierName,
                            profile.vehicle_type AS courierVehicleType,
                            profile.vehicle_identifier AS courierVehicleIdentifier,
                            profile.plate AS courierPlate
                     FROM deliveries d
                     JOIN orders o ON o.id = d.order_id
                     JOIN companies c ON c.id = o.company_id
                     JOIN users client ON client.id = o.client_id
                     LEFT JOIN users courier ON courier.id = d.courier_id
                     LEFT JOIN couriers profile ON profile.user_id = d.courier_id
                     WHERE d.id = ?`).get(id) || null;
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function parseRecipientSnapshot(value) {
  let snapshot;
  try {
    snapshot = JSON.parse(value);
  } catch {
    throw deliveryError("O destinatário preservado do pedido é inválido.", 500);
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !["self", "other"].includes(snapshot.type)
    || typeof snapshot.name !== "string" || !snapshot.name.trim()
    || Object.keys(snapshot).some((field) => !["type", "name"].includes(field))) {
    throw deliveryError("O destinatário preservado do pedido é inválido.", 500);
  }
  return { type: snapshot.type, name: snapshot.name.trim() };
}

function publicDelivery(row, {
  includeAmounts = false, includeClient = false, includeCourier = false,
  includeDestination = false, includePickupAddress = false, includeRecipient = false,
} = {}) {
  const delivery = {
    id: row.id, orderId: row.orderId, status: row.status,
    company: { id: row.companyId, name: row.companyName },
    invalidCodeAttempts: row.invalidCodeAttempts,
    acceptedAt: row.acceptedAt, collectedAt: row.collectedAt, completedAt: row.completedAt,
    cancelledAt: row.cancelledAt, returnReason: row.returnReason,
    returnReportedAt: row.returnReportedAt, returnedAt: row.returnedAt, createdAt: row.createdAt,
  };
  if (includeAmounts) {
    delivery.itemsTotalCents = row.itemsTotalCents;
    delivery.freightTotalCents = row.freightTotalCents;
  }
  if (includeDestination) delivery.destination = parseJson(row.destinationSnapshotJson);
  if (includeRecipient) {
    delivery.recipient = parseRecipientSnapshot(row.recipientSnapshotJson);
  }
  if (includePickupAddress) delivery.pickupAddress = parseJson(row.pickupAddressJson);
  if (includeClient) delivery.client = { fullName: row.clientName, phone: row.clientPhone || null };
  if (includeCourier) delivery.courier = row.courierId ? {
    fullName: row.courierName,
    vehicleType: row.courierVehicleType,
    vehicleIdentifier: row.courierVehicleIdentifier || null,
    plate: row.courierPlate || null,
  } : null;
  return delivery;
}

function history(deliveryId) {
  return db.prepare(`SELECT e.event_type AS eventType, e.details_json AS detailsJson,
                            e.occurred_at AS occurredAt, u.full_name AS actorName, u.role AS actorRole
                     FROM delivery_events e LEFT JOIN users u ON u.id = e.actor_user_id
                     WHERE e.delivery_id = ? ORDER BY e.id`).all(deliveryId)
    .map(({ detailsJson, actorName, actorRole, ...eventData }) => {
      const { courierId, ...details } = parseJson(detailsJson);
      return { ...eventData, actor: actorName ? { fullName: actorName, role: actorRole } : null, details };
    });
}

function withHistory(row, options) {
  return { ...publicDelivery(row, options), events: history(row.id) };
}

const courierView = (row) => ({
  ...withHistory(row, {
    includeClient: true, includeCourier: true, includeDestination: true,
    includePickupAddress: true, includeRecipient: true,
  }),
  financial: courierFinancialSummary(db, row),
});
const clientView = (row) => ({
  ...withHistory(row, {
    includeAmounts: true, includeCourier: true, includeDestination: true, includeRecipient: true,
  }),
  financial: clientFinancialSummary(db, row),
});
const companyView = (row) => ({
  ...withHistory(row, {
    includeAmounts: true, includeClient: true, includeCourier: true,
    includeDestination: true, includePickupAddress: true, includeRecipient: true,
  }),
  financial: companyFinancialSummary(db, row),
});

function event(deliveryId, actorUserId, eventType, details = {}) {
  const result = db.prepare(`INSERT INTO delivery_events
                               (delivery_id, actor_user_id, event_type, details_json)
                             VALUES (?, ?, ?, ?)`)
    .run(deliveryId, actorUserId ?? null, eventType, JSON.stringify(details));
  if (Number(result.changes) !== 1) throw deliveryError("Não foi possível registrar o evento da entrega.", 500);
}

function requireDelivery(id) {
  const delivery = findDelivery(id);
  if (!delivery) throw deliveryError("Entrega não encontrada.", 404);
  return delivery;
}

function requireCourierDelivery(id, courierId, companyId) {
  const delivery = requireDelivery(id);
  if (delivery.companyId !== companyId || delivery.courierId !== courierId) {
    throw deliveryError("Entrega não encontrada.", 404);
  }
  return delivery;
}

export function listAvailableDeliveries(companyId) {
  return db.prepare(`SELECT d.id FROM deliveries d JOIN orders o ON o.id = d.order_id
                     WHERE o.company_id = ? AND d.status = 'available' AND d.courier_id IS NULL
                     ORDER BY d.created_at, d.id`).all(companyId)
    .map(({ id }) => publicDelivery(requireDelivery(id), { includePickupAddress: true }));
}

export function getCourierCurrentDelivery(courierId, companyId) {
  const row = db.prepare(`SELECT d.id FROM deliveries d JOIN orders o ON o.id = d.order_id
                          WHERE d.courier_id = ? AND o.company_id = ?
                            AND d.status NOT IN ('completed', 'cancelled', 'returned')
                          ORDER BY d.id LIMIT 1`).get(courierId, companyId);
  return row ? courierView(requireDelivery(row.id)) : null;
}

export function listClientDeliveries(clientId) {
  return db.prepare(`SELECT d.id FROM deliveries d JOIN orders o ON o.id = d.order_id
                     WHERE o.client_id = ? ORDER BY d.created_at DESC, d.id DESC`).all(clientId)
    .map(({ id }) => publicDelivery(requireDelivery(id), { includeAmounts: true, includeCourier: true }));
}

export function getClientDelivery(clientId, id) {
  const row = requireDelivery(id);
  if (row.clientId !== clientId) throw deliveryError("Entrega não encontrada.", 404);
  const delivery = clientView(row);
  if ([DELIVERY_STATES.AVAILABLE, DELIVERY_STATES.HEADING_TO_PICKUP,
    DELIVERY_STATES.AWAITING_PICKUP, DELIVERY_STATES.IN_TRANSIT,
    DELIVERY_STATES.AWAITING_CONFIRMATION].includes(row.status)) {
    if (!row.confirmationCodeCiphertext) throw deliveryError("O código da entrega não está disponível.", 500);
    delivery.confirmationCode = decryptConfirmationCode(row.confirmationCodeCiphertext);
  }
  return delivery;
}

export function listCompanyDeliveries(companyId) {
  return db.prepare(`SELECT d.id FROM deliveries d JOIN orders o ON o.id = d.order_id
                     WHERE o.company_id = ? ORDER BY d.created_at DESC, d.id DESC`).all(companyId)
    .map(({ id }) => publicDelivery(requireDelivery(id), { includeAmounts: true, includeCourier: true }));
}

export function getCompanyDelivery(companyId, id) {
  const row = requireDelivery(id);
  if (row.companyId !== companyId) throw deliveryError("Entrega não encontrada.", 404);
  return companyView(row);
}

export function acceptDelivery(id, courierId, companyId, body) {
  requireEmptyDeliveryBody(body);
  return transaction(() => {
    const courier = db.prepare(`SELECT c.is_online AS isOnline
                                FROM couriers c JOIN users u ON u.id = c.user_id
                                WHERE c.user_id = ? AND u.company_id = ? AND u.status = 'active'`)
      .get(courierId, companyId);
    if (!courier) throw deliveryError("Motoboy não encontrado.", 404);
    if (!courier.isOnline) throw deliveryError("O motoboy precisa estar online para aceitar uma entrega.");
    const active = db.prepare(`SELECT id FROM deliveries WHERE courier_id = ?
                               AND status NOT IN ('completed', 'cancelled', 'returned') LIMIT 1`).get(courierId);
    if (active) throw deliveryError("O motoboy já possui uma entrega ativa.");
    const delivery = requireDelivery(id);
    if (delivery.companyId !== companyId) throw deliveryError("Entrega não encontrada.", 404);
    const update = db.prepare(`UPDATE deliveries SET courier_id = ?, status = ?, accepted_at = CURRENT_TIMESTAMP
                               WHERE id = ? AND status = ? AND courier_id IS NULL`)
      .run(courierId, DELIVERY_STATES.HEADING_TO_PICKUP, id, DELIVERY_STATES.AVAILABLE);
    if (Number(update.changes) !== 1) throw deliveryError("Esta entrega não está mais disponível.");
    event(id, courierId, DELIVERY_EVENT_TYPES.ACCEPTED);
    return courierView(requireDelivery(id));
  });
}

function courierTransition(id, courierId, companyId, body, from, to, eventType, timestampColumn) {
  requireEmptyDeliveryBody(body);
  return transaction(() => {
    const delivery = requireCourierDelivery(id, courierId, companyId);
    if (delivery.status !== from) throw deliveryError(`A entrega não pode avançar a partir de ${delivery.status}.`);
    const timestamp = timestampColumn ? `, ${timestampColumn} = CURRENT_TIMESTAMP` : "";
    const update = db.prepare(`UPDATE deliveries SET status = ?${timestamp} WHERE id = ? AND status = ? AND courier_id = ?`)
      .run(to, id, from, courierId);
    if (Number(update.changes) !== 1) throw deliveryError("A entrega foi alterada. Recarregue o estado atual.");
    event(id, courierId, eventType);
    return courierView(requireDelivery(id));
  });
}

export const arriveAtPickup = (id, courierId, companyId, body) => courierTransition(
  id, courierId, companyId, body, DELIVERY_STATES.HEADING_TO_PICKUP,
  DELIVERY_STATES.AWAITING_PICKUP, DELIVERY_EVENT_TYPES.ARRIVED_AT_PICKUP,
);
export const collectDelivery = (id, courierId, companyId, body) => courierTransition(
  id, courierId, companyId, body, DELIVERY_STATES.AWAITING_PICKUP,
  DELIVERY_STATES.IN_TRANSIT, DELIVERY_EVENT_TYPES.COLLECTED, "collected_at",
);
export const arriveAtDestination = (id, courierId, companyId, body) => courierTransition(
  id, courierId, companyId, body, DELIVERY_STATES.IN_TRANSIT,
  DELIVERY_STATES.AWAITING_CONFIRMATION, DELIVERY_EVENT_TYPES.ARRIVED_AT_DESTINATION,
);

export function confirmDelivery(id, courierId, companyId, body) {
  requireObject(body, ["code"]);
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
    throw deliveryError("Informe o código de confirmação com seis dígitos.", 400);
  }
  return transaction(() => {
    const delivery = requireCourierDelivery(id, courierId, companyId);
    if (delivery.status !== DELIVERY_STATES.AWAITING_CONFIRMATION) {
      throw deliveryError("A entrega não está aguardando confirmação.");
    }
    if (delivery.invalidCodeAttempts >= 3) throw deliveryError("O limite de três tentativas foi atingido.");
    if (!delivery.confirmationCodeHash) throw deliveryError("A entrega não possui código de confirmação válido.");
    if (verifyConfirmationCode(body.code, delivery.confirmationCodeHash)) {
      db.prepare(`UPDATE deliveries SET status = ?, completed_at = CURRENT_TIMESTAMP
                  WHERE id = ? AND status = ?`).run(DELIVERY_STATES.COMPLETED, id, delivery.status);
      event(id, courierId, DELIVERY_EVENT_TYPES.COMPLETED);
      recordNormalCompletionInTransaction(db, delivery);
      return { valid: true, delivery: courierView(requireDelivery(id)) };
    }
    const attempt = delivery.invalidCodeAttempts + 1;
    if (attempt < 3) {
      db.prepare("UPDATE deliveries SET invalid_code_attempts = ? WHERE id = ?").run(attempt, id);
      event(id, courierId, DELIVERY_EVENT_TYPES.CONFIRMATION_CODE_INVALID,
        { attempt, remainingAttempts: 3 - attempt });
    } else {
      db.prepare(`UPDATE deliveries SET invalid_code_attempts = 3, status = ?, return_reason = ?
                  WHERE id = ?`).run(DELIVERY_STATES.RETURNING, "confirmation_failed", id);
      event(id, courierId, DELIVERY_EVENT_TYPES.CONFIRMATION_FAILED,
        { attempt: 3, remainingAttempts: 0 });
    }
    return { valid: false, delivery: courierView(requireDelivery(id)) };
  });
}

export function reportCourierFailure(id, courierId, companyId, body) {
  requireObject(body, ["reason"]);
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 500) {
    throw deliveryError("Informe um motivo com até 500 caracteres.", 400);
  }
  return transaction(() => {
    const delivery = requireCourierDelivery(id, courierId, companyId);
    const details = { reason: body.reason.trim() };
    if ([DELIVERY_STATES.HEADING_TO_PICKUP, DELIVERY_STATES.AWAITING_PICKUP].includes(delivery.status)) {
      db.prepare(`UPDATE deliveries SET status = ?, courier_id = NULL, accepted_at = NULL
                  WHERE id = ?`).run(DELIVERY_STATES.AVAILABLE, id);
      event(id, courierId, DELIVERY_EVENT_TYPES.COURIER_FAILED_BEFORE_PICKUP, details);
    } else if ([DELIVERY_STATES.IN_TRANSIT, DELIVERY_STATES.AWAITING_CONFIRMATION].includes(delivery.status)) {
      db.prepare("UPDATE deliveries SET status = ?, return_reason = ? WHERE id = ?")
        .run(DELIVERY_STATES.RETURNING, "courier_failure_after_pickup", id);
      event(id, courierId, DELIVERY_EVENT_TYPES.COURIER_FAILED_AFTER_PICKUP, details);
    } else {
      throw deliveryError("Não é possível registrar falha do motoboy no estado atual.");
    }
    return courierView(requireDelivery(id));
  });
}

const occurrenceEvents = Object.freeze({
  recipient_absent: DELIVERY_EVENT_TYPES.RECIPIENT_ABSENT,
  recipient_refused: DELIVERY_EVENT_TYPES.RECIPIENT_REFUSED,
  address_problem: DELIVERY_EVENT_TYPES.ADDRESS_PROBLEM,
});

export function reportDeliveryOccurrence(id, courierId, companyId, body) {
  requireObject(body, ["type"]);
  if (!Object.hasOwn(occurrenceEvents, body.type)) throw deliveryError("Tipo de ocorrência inválido.", 400);
  return transaction(() => {
    const delivery = requireCourierDelivery(id, courierId, companyId);
    if (delivery.status !== DELIVERY_STATES.AWAITING_CONFIRMATION) {
      throw deliveryError("A ocorrência só pode ser registrada no destino.");
    }
    db.prepare("UPDATE deliveries SET status = ?, return_reason = ? WHERE id = ?")
      .run(DELIVERY_STATES.RETURNING, body.type, id);
    event(id, courierId, occurrenceEvents[body.type]);
    return courierView(requireDelivery(id));
  });
}

export function reportReturn(id, courierId, companyId, body) {
  return courierTransition(id, courierId, companyId, body, DELIVERY_STATES.RETURNING,
    DELIVERY_STATES.AWAITING_RETURN_CONFIRMATION, DELIVERY_EVENT_TYPES.RETURN_REPORTED,
    "return_reported_at");
}

export function confirmReturn(id, companyUserId, companyId, body) {
  requireEmptyDeliveryBody(body);
  return transaction(() => {
    const delivery = requireDelivery(id);
    if (delivery.companyId !== companyId) throw deliveryError("Entrega não encontrada.", 404);
    if (delivery.status !== DELIVERY_STATES.AWAITING_RETURN_CONFIRMATION) {
      throw deliveryError("A entrega não está aguardando confirmação de retorno.");
    }
    if (delivery.returnReason === "courier_failure_after_pickup") {
      db.prepare(`UPDATE deliveries SET status = ?, courier_id = NULL, accepted_at = NULL,
                    collected_at = NULL, return_reason = NULL, return_reported_at = NULL
                  WHERE id = ?`).run(DELIVERY_STATES.AVAILABLE, id);
      event(id, companyUserId, DELIVERY_EVENT_TYPES.REAVAILABLE, { previousReason: delivery.returnReason });
    } else {
      db.prepare(`UPDATE deliveries SET status = ?, courier_id = NULL, returned_at = CURRENT_TIMESTAMP
                  WHERE id = ?`).run(DELIVERY_STATES.RETURNED, id);
      event(id, companyUserId, DELIVERY_EVENT_TYPES.RETURN_CONFIRMED, { reason: delivery.returnReason });
    }
    return companyView(requireDelivery(id));
  });
}

export function cancelClientDelivery(id, clientId, body) {
  requireEmptyDeliveryBody(body);
  return transaction(() => {
    const delivery = requireDelivery(id);
    if (delivery.clientId !== clientId) throw deliveryError("Entrega não encontrada.", 404);
    if (BEFORE_PICKUP.has(delivery.status)) {
      db.prepare(`UPDATE deliveries SET status = ?, courier_id = NULL, cancelled_at = CURRENT_TIMESTAMP
                  WHERE id = ?`).run(DELIVERY_STATES.CANCELLED, id);
      event(id, clientId, DELIVERY_EVENT_TYPES.CLIENT_CANCELLED_BEFORE_PICKUP);
    } else if ([DELIVERY_STATES.IN_TRANSIT, DELIVERY_STATES.AWAITING_CONFIRMATION].includes(delivery.status)) {
      const late = Boolean(db.prepare("SELECT collected_at < datetime('now', '-3 minutes') AS value FROM deliveries WHERE id = ?")
        .get(id).value);
      db.prepare("UPDATE deliveries SET status = ?, return_reason = ? WHERE id = ?")
        .run(DELIVERY_STATES.RETURNING, "client_cancelled_after_pickup", id);
      if (late) db.prepare("UPDATE users SET order_blocked_until = datetime('now', '+2 hours') WHERE id = ?").run(clientId);
      event(id, clientId, DELIVERY_EVENT_TYPES.CLIENT_CANCELLED_AFTER_PICKUP,
        { lateCancellation: late });
      recordClientCancellationAfterPickupInTransaction(db, delivery);
    } else {
      throw deliveryError("A entrega não pode ser cancelada pelo cliente no estado atual.");
    }
    return clientView(requireDelivery(id));
  });
}

export function cancelForUnavailableProduct(id, companyUserId, companyId, body) {
  requireEmptyDeliveryBody(body);
  return transaction(() => {
    const delivery = requireDelivery(id);
    if (delivery.companyId !== companyId) throw deliveryError("Entrega não encontrada.", 404);
    if (!BEFORE_PICKUP.has(delivery.status)) throw deliveryError("O produto não pode ser marcado indisponível após a coleta.");
    db.prepare(`UPDATE deliveries SET status = ?, courier_id = NULL, cancelled_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(DELIVERY_STATES.CANCELLED, id);
    event(id, companyUserId, DELIVERY_EVENT_TYPES.PRODUCT_UNAVAILABLE);
    recordProductUnavailableInTransaction(db, delivery);
    return companyView(requireDelivery(id));
  });
}

export { TERMINAL_STATES };
