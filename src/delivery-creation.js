import { db, transaction } from "./database.js";
import { INITIAL_DELIVERY_EVENT_TYPE, INITIAL_DELIVERY_STATE } from "./deliveries.js";
import {
  decryptConfirmationCode, encryptConfirmationCode, hashConfirmationCode, newConfirmationCode,
} from "./security.js";

const requiredDestinationFields = Object.freeze([
  "postalCode",
  "state",
  "city",
  "neighborhood",
  "street",
  "number",
]);

function deliveryCreationError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function requireOrderId(orderId) {
  if (typeof orderId !== "number" || !Number.isSafeInteger(orderId) || orderId <= 0) {
    throw deliveryCreationError("Identificador de pedido inválido.", 400);
  }
  return orderId;
}

function requireValidDestinationSnapshot(value) {
  let snapshot;
  try {
    snapshot = JSON.parse(value);
  } catch {
    throw deliveryCreationError("O pedido não possui um destino preservado válido.");
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
    || requiredDestinationFields.some((field) => typeof snapshot[field] !== "string"
      || !snapshot[field].trim())
    || !/^\d{8}$/.test(snapshot.postalCode)
    || !/^[A-Z]{2}$/.test(snapshot.state)) {
    throw deliveryCreationError("O pedido não possui um destino preservado válido.");
  }
  return snapshot;
}

function findDeliveryByOrderId(orderId) {
  const delivery = db.prepare(`SELECT id, order_id AS orderId, courier_id AS courierId, status,
                                      confirmation_code_hash AS confirmationCodeHash,
                                      confirmation_code_ciphertext AS confirmationCodeCiphertext,
                                      created_at AS createdAt
                               FROM deliveries WHERE order_id = ?`).get(orderId);
  return delivery ? { ...delivery } : null;
}

function publicDelivery({ confirmationCodeHash, confirmationCodeCiphertext, ...delivery }) {
  return delivery;
}

const codeUsableStates = new Set([
  "available", "heading_to_pickup", "awaiting_pickup", "in_transit", "awaiting_confirmation",
]);

export function createDeliveryForEligibleOrder(orderId) {
  const validOrderId = requireOrderId(orderId);
  return transaction(() => createDeliveryForEligibleOrderInTransaction(validOrderId).delivery);
}

export function createDeliveryForEligibleOrderInTransaction(orderId) {
    const validOrderId = requireOrderId(orderId);
    const existing = findDeliveryByOrderId(validOrderId);
    if (existing) {
      if (!codeUsableStates.has(existing.status)) {
        return { delivery: publicDelivery(existing), confirmationCode: null, created: false };
      }
      if (existing.confirmationCodeCiphertext) {
        return {
          delivery: publicDelivery(existing),
          confirmationCode: decryptConfirmationCode(existing.confirmationCodeCiphertext),
          created: false,
        };
      }
      const replacementCode = newConfirmationCode();
      db.prepare(`UPDATE deliveries
                  SET confirmation_code_hash = ?, confirmation_code_ciphertext = ?
                  WHERE id = ? AND confirmation_code_ciphertext IS NULL`)
        .run(hashConfirmationCode(replacementCode), encryptConfirmationCode(replacementCode), existing.id);
      return { delivery: publicDelivery(findDeliveryByOrderId(validOrderId)),
        confirmationCode: replacementCode, created: false };
    }

    const order = db.prepare(`SELECT id, status, payment_status AS paymentStatus,
                                    destination_snapshot_json AS destinationSnapshotJson
                             FROM orders WHERE id = ?`).get(validOrderId);
    if (!order) throw deliveryCreationError("Pedido não encontrado.", 404);
    if (order.status !== "confirmed") {
      throw deliveryCreationError("O pedido não está confirmado comercialmente.");
    }
    if (order.paymentStatus !== "paid") {
      throw deliveryCreationError("O pagamento do pedido ainda não está confirmado.");
    }
    requireValidDestinationSnapshot(order.destinationSnapshotJson);

    const confirmationCode = newConfirmationCode();
    const result = db.prepare(`INSERT INTO deliveries
                                 (order_id, courier_id, status, confirmation_code_hash,
                                  confirmation_code_ciphertext)
                               VALUES (?, NULL, ?, ?, ?)`)
      .run(validOrderId, INITIAL_DELIVERY_STATE, hashConfirmationCode(confirmationCode),
        encryptConfirmationCode(confirmationCode));
    const deliveryId = Number(result.lastInsertRowid);
    const event = db.prepare(`INSERT INTO delivery_events (delivery_id, event_type)
                              VALUES (?, ?)`).run(deliveryId, INITIAL_DELIVERY_EVENT_TYPE);
    if (Number(event.changes) !== 1) {
      throw deliveryCreationError("Não foi possível registrar o evento inicial da entrega.", 500);
    }
    return { delivery: publicDelivery(findDeliveryByOrderId(validOrderId)), confirmationCode, created: true };
}
