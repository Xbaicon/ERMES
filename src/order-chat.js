import { db, transaction } from "./database.js";

const CHAT_MESSAGE_MAX_LENGTH = 2000;
const WRITABLE_ORDER_STATES = new Set(["draft", "confirmed"]);
const TERMINAL_DELIVERY_STATES = new Set(["completed", "cancelled", "returned"]);

function chatError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireChatActor(actor) {
  if (!actor || !["client", "company"].includes(actor.role)) {
    throw chatError("Você não possui permissão para esta ação.", 403);
  }
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0
    || (actor.role === "company"
      && (!Number.isSafeInteger(actor.companyId) || actor.companyId <= 0))) {
    throw chatError("A sessão não possui um participante de chat válido.", 403);
  }
  return actor;
}

function ownedOrder(actor, orderId) {
  const ownership = actor.role === "client" ? "o.client_id = ?" : "o.company_id = ?";
  const ownerId = actor.role === "client" ? actor.id : actor.companyId;
  const order = db.prepare(`SELECT o.id, o.status, o.created_at AS createdAt,
                                   o.updated_at AS updatedAt,
                                   d.status AS deliveryStatus
                            FROM orders o
                            LEFT JOIN deliveries d ON d.order_id = o.id
                            WHERE o.id = ? AND ${ownership}`).get(orderId, ownerId);
  if (!order) throw chatError("Pedido não encontrado.", 404);
  return order;
}

function isReadOnly(order) {
  return !WRITABLE_ORDER_STATES.has(order.status)
    || TERMINAL_DELIVERY_STATES.has(order.deliveryStatus);
}

function publicOrder(order) {
  return {
    orderId: order.id,
    orderStatus: order.status,
    deliveryStatus: order.deliveryStatus ?? null,
    readOnly: isReadOnly(order),
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    senderRole: row.senderRole,
    message: row.message,
    sentAt: row.sentAt,
  };
}

function messagesForOrder(orderId) {
  return db.prepare(`SELECT id, sender_role AS senderRole, content AS message,
                            created_at AS sentAt
                     FROM order_chat_messages
                     WHERE order_id = ? ORDER BY id`).all(orderId).map(publicMessage);
}

function parseMessage(body) {
  if (body === null || Array.isArray(body) || typeof body !== "object") {
    throw chatError("O corpo da requisição deve ser um objeto JSON.");
  }
  const unexpected = Object.keys(body).filter((field) => field !== "message");
  if (unexpected.length) throw chatError(`Campos não permitidos: ${unexpected.join(", ")}.`);
  if (!Object.hasOwn(body, "message")) throw chatError("Informe a mensagem.");
  if (typeof body.message !== "string") throw chatError("A mensagem deve ser textual.");
  const message = body.message.trim();
  if (!message) throw chatError("A mensagem não pode ficar vazia.");
  if (message.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw chatError(`A mensagem deve possuir no máximo ${CHAT_MESSAGE_MAX_LENGTH} caracteres.`);
  }
  return message;
}

export function listOrderChats(actorInput) {
  const actor = requireChatActor(actorInput);
  const ownership = actor.role === "client" ? "o.client_id = ?" : "o.company_id = ?";
  const ownerId = actor.role === "client" ? actor.id : actor.companyId;
  return db.prepare(`SELECT o.id, o.status, o.created_at AS createdAt,
                            o.updated_at AS updatedAt, d.status AS deliveryStatus,
                            EXISTS(SELECT 1 FROM order_chat_messages message
                              WHERE message.order_id = o.id) AS hasMessages,
                            COALESCE((SELECT MAX(message.id) FROM order_chat_messages message
                              WHERE message.order_id = o.id), 0) AS lastMessageId
                     FROM orders o
                     LEFT JOIN deliveries d ON d.order_id = o.id
                     WHERE ${ownership}
                     ORDER BY lastMessageId DESC, o.updated_at DESC, o.id DESC`)
    .all(ownerId).map((order) => ({
      ...publicOrder(order),
      hasMessages: Boolean(order.hasMessages),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    }));
}

export function getOrderChat(actorInput, orderId) {
  const actor = requireChatActor(actorInput);
  const order = ownedOrder(actor, orderId);
  return { ...publicOrder(order), messages: messagesForOrder(order.id) };
}

export function sendOrderChatMessage(actorInput, orderId, body) {
  const actor = requireChatActor(actorInput);
  const message = parseMessage(body);
  return transaction(() => {
    const order = ownedOrder(actor, orderId);
    if (isReadOnly(order)) {
      throw chatError("O chat deste pedido está disponível somente para consulta.", 409);
    }
    const result = db.prepare(`INSERT INTO order_chat_messages
      (order_id, sender_user_id, sender_role, content) VALUES (?, ?, ?, ?)`)
      .run(order.id, actor.id, actor.role, message);
    const persisted = db.prepare(`SELECT id, sender_role AS senderRole, content AS message,
                                         created_at AS sentAt
                                  FROM order_chat_messages WHERE id = ?`)
      .get(Number(result.lastInsertRowid));
    if (!persisted) throw chatError("Não foi possível persistir a mensagem.", 500);
    return publicMessage(persisted);
  });
}

export { CHAT_MESSAGE_MAX_LENGTH };
