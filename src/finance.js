import { splitNormalFreight } from "./freight.js";

export const FINANCIAL_ENTRY_TYPES = Object.freeze({
  PAYMENT: "payment",
  REFUND: "refund",
  DISTRIBUTION: "distribution",
});

export const FINANCIAL_COMPONENTS = Object.freeze({
  PRODUCTS: "products",
  FREIGHT: "freight",
});

export const FINANCIAL_PARTIES = Object.freeze({
  CLIENT: "client",
  COURIER: "courier",
  COMPANY: "company",
  ERMES: "ermes",
});

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const PENDING_DISTRIBUTION_REASONS = new Set([
  "recipient_absent",
  "recipient_refused",
  "address_problem",
  "confirmation_failed",
]);
const semanticEntryFields = Object.freeze([
  "orderId", "deliveryId", "entryType", "component", "partyType",
  "partyUserId", "partyCompanyId", "amountCents", "reason",
]);

const CANONICAL_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = CANONICAL_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function financialError(message) {
  return Object.assign(new Error(message), {
    statusCode: 500,
    code: "FINANCIAL_RECONCILIATION_REQUIRED",
  });
}

function requireCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} deve ser informado em centavos inteiros não negativos e seguros.`);
  }
  return value;
}

export function sumFinancialAmounts(values, field = "O total financeiro") {
  let total = 0n;
  for (const value of values) total += BigInt(requireCents(value, field));
  if (total > MAX_SAFE) throw new RangeError(`${field} excede o limite inteiro seguro.`);
  return Number(total);
}

export function splitHalfFreight(totalCents) {
  const total = BigInt(requireCents(totalCents, "O frete"));
  const clientRefundCents = (total + 1n) / 2n;
  return {
    clientRefundCents: Number(clientRefundCents),
    courierCents: Number(total - clientRefundCents),
  };
}

function partyColumns(partyType, partyId) {
  if ([FINANCIAL_PARTIES.CLIENT, FINANCIAL_PARTIES.COURIER].includes(partyType)) {
    if (!Number.isSafeInteger(partyId) || partyId <= 0) throw new RangeError("Usuário financeiro inválido.");
    return { partyUserId: partyId, partyCompanyId: null };
  }
  if (partyType === FINANCIAL_PARTIES.COMPANY) {
    if (!Number.isSafeInteger(partyId) || partyId <= 0) throw new RangeError("Empresa financeira inválida.");
    return { partyUserId: null, partyCompanyId: partyId };
  }
  if (partyType === FINANCIAL_PARTIES.ERMES) {
    return { partyUserId: null, partyCompanyId: null };
  }
  throw new RangeError("Parte financeira inválida.");
}

function normalizeEntry(input) {
  const { partyUserId, partyCompanyId } = partyColumns(input.partyType, input.partyId);
  return {
    orderId: input.orderId,
    deliveryId: input.deliveryId ?? null,
    entryType: input.entryType,
    component: input.component,
    partyType: input.partyType,
    partyUserId,
    partyCompanyId,
    amountCents: requireCents(input.amountCents, "O lançamento"),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt ?? null,
  };
}

function findEntryByIdempotencyKey(database, idempotencyKey) {
  return database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
    entry_type AS entryType, component, party_type AS partyType,
    party_user_id AS partyUserId, party_company_id AS partyCompanyId,
    amount_cents AS amountCents, reason
    FROM financial_entries WHERE idempotency_key = ?`).get(idempotencyKey) || null;
}

function assertSameSemanticEntry(existing, expected) {
  const different = semanticEntryFields.filter((field) => existing[field] !== expected[field]);
  if (different.length) {
    throw financialError(`A chave financeira ${expected.idempotencyKey} já existe com conteúdo divergente (${different.join(", ")}). Reconciliação necessária.`);
  }
}

export function insertFinancialEntryInTransaction(database, input) {
  const entry = normalizeEntry(input);
  const existing = findEntryByIdempotencyKey(database, entry.idempotencyKey);
  if (existing) {
    assertSameSemanticEntry(existing, entry);
    return false;
  }

  const result = database.prepare(`INSERT INTO financial_entries
    (order_id, delivery_id, entry_type, component, party_type, party_user_id,
     party_company_id, amount_cents, reason, idempotency_key, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    ON CONFLICT(idempotency_key) DO NOTHING`)
    .run(entry.orderId, entry.deliveryId, entry.entryType, entry.component,
      entry.partyType, entry.partyUserId, entry.partyCompanyId, entry.amountCents,
      entry.reason, entry.idempotencyKey, entry.occurredAt);
  if (Number(result.changes) === 1) return true;

  const concurrent = findEntryByIdempotencyKey(database, entry.idempotencyKey);
  if (!concurrent) throw financialError("A gravação financeira não foi concluída nem localizada para reconciliação.");
  assertSameSemanticEntry(concurrent, entry);
  return false;
}

function entryBase(delivery, reason, occurredAt) {
  return {
    orderId: delivery.orderId,
    deliveryId: delivery.id,
    reason,
    occurredAt,
  };
}

function entriesForOrder(database, orderId) {
  return database.prepare(`SELECT entry_type AS entryType, component, party_type AS partyType,
                                  party_user_id AS partyUserId,
                                  party_company_id AS partyCompanyId,
                                  amount_cents AS amountCents, reason, occurred_at AS occurredAt
                           FROM financial_entries WHERE order_id = ? ORDER BY id`).all(orderId)
    .map((row) => ({ ...row }));
}

function paidComponents(database, orderId, clientId) {
  const payments = database.prepare(`SELECT component, amount_cents AS amountCents
    FROM financial_entries
    WHERE order_id = ? AND entry_type = 'payment' AND party_type = 'client'
      AND party_user_id = ? ORDER BY id`).all(orderId, clientId).map((row) => ({ ...row }));
  const byComponent = new Map();
  for (const payment of payments) {
    requireCents(payment.amountCents, "O pagamento persistido");
    if (byComponent.has(payment.component)) {
      throw financialError(`O Pedido ${orderId} possui pagamentos duplicados para ${payment.component}.`);
    }
    byComponent.set(payment.component, payment.amountCents);
  }
  return byComponent;
}

function assertFreightPaymentMatchesSnapshot(delivery, freightPayment) {
  if (freightPayment === undefined) return;
  if (delivery.freightTotalCents === null
    || requireCents(delivery.freightTotalCents, "O frete preservado") !== freightPayment) {
    throw financialError(`O pagamento de frete do Pedido ${delivery.orderId} diverge do snapshot preservado.`);
  }
}

export function recordPaymentInTransaction(database, order, deliveryId = null) {
  const base = {
    orderId: order.id,
    deliveryId,
    entryType: FINANCIAL_ENTRY_TYPES.PAYMENT,
    partyType: FINANCIAL_PARTIES.CLIENT,
    partyId: order.clientId,
    reason: "simulated_payment",
    occurredAt: order.paymentPaidAt,
  };
  insertFinancialEntryInTransaction(database, {
    ...base,
    component: FINANCIAL_COMPONENTS.PRODUCTS,
    amountCents: requireCents(order.itemsTotalCents, "O subtotal dos produtos"),
    idempotencyKey: `payment:${order.id}:products`,
  });
  if (order.freightTotalCents !== null) {
    insertFinancialEntryInTransaction(database, {
      ...base,
      component: FINANCIAL_COMPONENTS.FREIGHT,
      amountCents: requireCents(order.freightTotalCents, "O frete"),
      idempotencyKey: `payment:${order.id}:freight`,
    });
  }
}

export function recordNormalCompletionInTransaction(database, delivery, occurredAt = null) {
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const paidFreight = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
  if (delivery.freightTotalCents === null) {
    assertFreightPaymentMatchesSnapshot(delivery, paidFreight);
    return;
  }
  requireCents(delivery.freightTotalCents, "O frete preservado");
  if (paidFreight === undefined) {
    throw financialError(`O Pedido ${delivery.orderId} possui frete conhecido sem evidência do pagamento.`);
  }
  assertFreightPaymentMatchesSnapshot(delivery, paidFreight);
  if (!delivery.courierId) throw financialError("A Entrega concluída não possui motoboy para distribuição financeira.");
  const split = splitNormalFreight(paidFreight);
  const base = entryBase(delivery, "delivery_completed", occurredAt);
  for (const [partyType, partyId, amountCents] of [
    [FINANCIAL_PARTIES.COURIER, delivery.courierId, split.courierCents],
    [FINANCIAL_PARTIES.COMPANY, delivery.companyId, split.companyCents],
    [FINANCIAL_PARTIES.ERMES, null, split.ermesCents],
  ]) {
    insertFinancialEntryInTransaction(database, {
      ...base,
      entryType: FINANCIAL_ENTRY_TYPES.DISTRIBUTION,
      component: FINANCIAL_COMPONENTS.FREIGHT,
      partyType,
      partyId,
      amountCents,
      idempotencyKey: `delivery:${delivery.id}:completed:${partyType}`,
    });
  }
}

function insertRefund(database, delivery, base, component, amountCents, idempotencyKey) {
  if (amountCents === 0) return;
  insertFinancialEntryInTransaction(database, {
    ...base,
    entryType: FINANCIAL_ENTRY_TYPES.REFUND,
    component,
    partyType: FINANCIAL_PARTIES.CLIENT,
    partyId: delivery.clientId,
    amountCents,
    idempotencyKey,
  });
}

export function recordClientCancellationAfterPickupInTransaction(database, delivery, occurredAt = null) {
  if (!delivery.courierId) throw financialError("O cancelamento pós-coleta não possui motoboy responsável.");
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const paidProducts = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
  if (paidProducts === undefined) {
    throw financialError(`O Pedido ${delivery.orderId} não possui evidência do pagamento dos produtos.`);
  }
  const base = entryBase(delivery, "client_cancelled_after_pickup", occurredAt);
  insertRefund(database, delivery, base, FINANCIAL_COMPONENTS.PRODUCTS, paidProducts,
    `delivery:${delivery.id}:client-cancelled:refund-products`);

  const paidFreight = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
  if (paidFreight !== undefined) {
    assertFreightPaymentMatchesSnapshot(delivery, paidFreight);
    const split = splitHalfFreight(paidFreight);
    insertRefund(database, delivery, base, FINANCIAL_COMPONENTS.FREIGHT, split.clientRefundCents,
      `delivery:${delivery.id}:client-cancelled:refund-freight`);
    insertFinancialEntryInTransaction(database, {
      ...base,
      entryType: FINANCIAL_ENTRY_TYPES.DISTRIBUTION,
      component: FINANCIAL_COMPONENTS.FREIGHT,
      partyType: FINANCIAL_PARTIES.COURIER,
      partyId: delivery.courierId,
      amountCents: split.courierCents,
      idempotencyKey: `delivery:${delivery.id}:client-cancelled:courier`,
    });
  }
}

export function recordProductUnavailableInTransaction(database, delivery, occurredAt = null) {
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  if (!payments.size) {
    throw financialError(`O Pedido ${delivery.orderId} não possui evidência de valores efetivamente pagos.`);
  }
  const base = entryBase(delivery, "product_unavailable", occurredAt);
  for (const [component, amountCents] of payments) {
    insertRefund(database, delivery, base, component, amountCents,
      `delivery:${delivery.id}:product-unavailable:refund-${component}`);
  }
}

function publicEntry({ entryType, component, amountCents, reason, occurredAt }) {
  return { entryType, component, amountCents, reason, occurredAt };
}

export function orderRefundSummary(database, orderId, clientId = null) {
  const entries = entriesForOrder(database, orderId)
    .filter((entry) => clientId === null || (entry.partyType === FINANCIAL_PARTIES.CLIENT
      && entry.partyUserId === clientId));
  const totalPaidCents = sumFinancialAmounts(entries
    .filter((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.PAYMENT)
    .map((entry) => entry.amountCents), "O total pago");
  const refundedTotalCents = sumFinancialAmounts(entries
    .filter((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.REFUND)
    .map((entry) => entry.amountCents), "O total reembolsado");
  if (refundedTotalCents > totalPaidCents) {
    throw financialError(`O Pedido ${orderId} possui reembolso superior ao total efetivamente pago.`);
  }
  const refundStatus = refundedTotalCents === 0 ? "none"
    : refundedTotalCents === totalPaidCents && totalPaidCents > 0 ? "full" : "partial";
  return { totalPaidCents, refundedTotalCents, refundStatus };
}

function hasAuthorizedProductUnavailableEvent(database, delivery) {
  const candidates = database.prepare(`SELECT event.occurred_at AS occurredAt,
      persisted.cancelled_at AS cancelledAt
    FROM delivery_events event
    JOIN users actor ON actor.id = event.actor_user_id
    JOIN deliveries persisted ON persisted.id = event.delivery_id
    JOIN orders o ON o.id = persisted.order_id
    WHERE event.delivery_id = ? AND event.event_type = 'product_unavailable'
      AND persisted.status = 'cancelled' AND actor.role = 'company'
      AND actor.company_id = o.company_id AND o.company_id = ?
      AND persisted.return_reason IS NULL AND persisted.collected_at IS NULL
    `).all(delivery.id, delivery.companyId);
  return candidates.some(({ occurredAt, cancelledAt }) => sameTimestamp(occurredAt, cancelledAt));
}

function pendingFinancialEffects(database, delivery, entries) {
  const pending = [];
  const paidFreight = entries.some((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.PAYMENT
    && entry.component === FINANCIAL_COMPONENTS.FREIGHT);
  if (delivery.status === "completed" && !paidFreight) {
    pending.push(delivery.freightTotalCents === null
      ? "freight_amount_unavailable" : "freight_payment_reconciliation_required");
  }
  if (delivery.returnReason === "client_cancelled_after_pickup" && !paidFreight) {
    pending.push(delivery.freightTotalCents === null
      ? "freight_amount_unavailable" : "freight_payment_reconciliation_required");
  }
  if (PENDING_DISTRIBUTION_REASONS.has(delivery.returnReason)) {
    pending.push("freight_distribution_rule_undefined");
  }
  const productUnavailable = entries.some((entry) => entry.reason === "product_unavailable")
    || hasAuthorizedProductUnavailableEvent(database, delivery);
  if (delivery.status === "cancelled" && delivery.returnReason === null && !productUnavailable) {
    pending.push("client_cancellation_before_pickup_refund_rule_undefined");
  }
  return pending;
}

export function clientFinancialSummary(database, delivery) {
  const entries = entriesForOrder(database, delivery.orderId);
  const payments = entries.filter((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.PAYMENT
    && entry.partyType === FINANCIAL_PARTIES.CLIENT && entry.partyUserId === delivery.clientId);
  const refunds = entries.filter((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.REFUND
    && entry.partyType === FINANCIAL_PARTIES.CLIENT && entry.partyUserId === delivery.clientId);
  const paidProducts = payments.find((entry) => entry.component === FINANCIAL_COMPONENTS.PRODUCTS);
  const paidFreight = payments.find((entry) => entry.component === FINANCIAL_COMPONENTS.FREIGHT);
  const refund = orderRefundSummary(database, delivery.orderId, delivery.clientId);
  return {
    paymentStatus: delivery.paymentStatus,
    refundStatus: refund.refundStatus,
    paidAt: delivery.paymentPaidAt,
    paidItemsCents: paidProducts?.amountCents ?? null,
    paidFreightCents: paidFreight?.amountCents ?? null,
    paidTotalCents: payments.length ? refund.totalPaidCents : null,
    refunds: refunds.map(publicEntry),
    refundedTotalCents: refund.refundedTotalCents,
    pending: pendingFinancialEffects(database, delivery, entries),
  };
}

function distributionSummary(database, delivery, partyType, partyId) {
  const entries = entriesForOrder(database, delivery.orderId);
  const distributions = entries
    .filter((entry) => entry.entryType === FINANCIAL_ENTRY_TYPES.DISTRIBUTION
      && entry.partyType === partyType
      && (partyType === FINANCIAL_PARTIES.COMPANY
        ? entry.partyCompanyId === partyId : entry.partyUserId === partyId));
  return {
    distributions: distributions.map(publicEntry),
    totalReceivedCents: sumFinancialAmounts(distributions.map((entry) => entry.amountCents),
      "O total distribuído"),
    pending: pendingFinancialEffects(database, delivery, entries),
  };
}

export const companyFinancialSummary = (database, delivery) => distributionSummary(
  database, delivery, FINANCIAL_PARTIES.COMPANY, delivery.companyId,
);

export const courierFinancialSummary = (database, delivery) => distributionSummary(
  database, delivery, FINANCIAL_PARTIES.COURIER, delivery.courierId,
);

export function listCourierFinancialEntries(database, courierId, companyId) {
  const entries = database.prepare(`SELECT f.delivery_id AS deliveryId, f.order_id AS orderId,
                                           f.component, f.amount_cents AS amountCents,
                                           f.reason, f.occurred_at AS occurredAt
                                    FROM financial_entries f
                                    JOIN orders o ON o.id = f.order_id
                                    WHERE f.entry_type = 'distribution'
                                      AND f.party_type = 'courier'
                                      AND f.party_user_id = ? AND o.company_id = ?
                                    ORDER BY f.occurred_at DESC, f.id DESC`)
    .all(courierId, companyId).map((row) => ({ ...row }));
  return {
    entries,
    totalReceivedCents: sumFinancialAmounts(entries.map((entry) => entry.amountCents),
      "O total recebido pelo motoboy"),
  };
}

function validTimestamp(value) {
  return isCanonicalTimestamp(value);
}

function sameTimestamp(left, right) {
  return validTimestamp(left) && validTimestamp(right) && left === right;
}

function chronological(values) {
  if (values.some((value) => !validTimestamp(value))) return false;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] > values[index]) return false;
  }
  return true;
}

function deliveryEvents(database, deliveryId) {
  return database.prepare(`SELECT event.id, event.event_type AS eventType,
    event.actor_user_id AS actorUserId, event.occurred_at AS occurredAt,
    event.details_json AS detailsJson,
    actor.role AS actorRole, actor.company_id AS actorCompanyId
    FROM delivery_events event
    LEFT JOIN users actor ON actor.id = event.actor_user_id
    WHERE event.delivery_id = ? ORDER BY event.id`).all(deliveryId).map((row) => ({ ...row }));
}

function singleEvent(events, eventType) {
  const matches = events.filter((event) => event.eventType === eventType);
  return matches.length === 1 ? matches[0] : null;
}

function eventsFollowOrder(events) {
  return events.every((event, index) => index === 0 || events[index - 1].id < event.id);
}

function courierEvent(event, courierId, companyId) {
  return event?.actorUserId === courierId && event.actorRole === "courier"
    && event.actorCompanyId === companyId;
}

function companyEvent(event, companyId) {
  return Boolean(event) && event.actorUserId !== null && event.actorRole === "company"
    && event.actorCompanyId === companyId;
}

function clientEvent(event, clientId) {
  return event?.actorUserId === clientId && event.actorRole === "client";
}

function eventDetails(event) {
  try {
    const details = JSON.parse(event.detailsJson);
    return details !== null && typeof details === "object" && !Array.isArray(details)
      ? details : null;
  } catch {
    return null;
  }
}

function confirmationHistoryIsCompatible(events, chain, persistedAttempts,
  destination, terminal, courierId, companyId) {
  if (!Number.isSafeInteger(persistedAttempts) || persistedAttempts < 0 || persistedAttempts >= 3
    || events.some((event) => event.eventType === "confirmation_failed")) return false;
  const allInvalidAttempts = events.filter(
    (event) => event.eventType === "confirmation_code_invalid",
  );
  const chainInvalidAttempts = chain.filter(
    (event) => event.eventType === "confirmation_code_invalid",
  );
  if (allInvalidAttempts.length !== chainInvalidAttempts.length
    || chainInvalidAttempts.length !== persistedAttempts) return false;
  return chainInvalidAttempts.every((event, index) => {
    if (event.id <= destination.id || event.id >= terminal.id
      || !courierEvent(event, courierId, companyId)) return false;
    const details = eventDetails(event);
    if (!details) return false;
    const hasAttempt = Object.hasOwn(details, "attempt");
    const hasRemaining = Object.hasOwn(details, "remainingAttempts");
    if (hasAttempt !== hasRemaining) return false;
    if (!hasAttempt) return true;
    return Number.isSafeInteger(details.attempt) && Number.isSafeInteger(details.remainingAttempts)
      && details.attempt === index + 1 && details.remainingAttempts === 2 - index;
  });
}

function createdDeliveryEvidence(database, order, events) {
  const created = singleEvent(events, "delivery_created");
  if (!created || created.actorUserId !== null
    || !chronological([
      order.confirmedAt, order.paymentPaidAt, order.deliveryCreatedAt, created.occurredAt,
    ])) return null;
  return created;
}

function paidOrderEvidence(database, orderId) {
  const order = database.prepare(`SELECT o.id, o.client_id AS clientId, o.company_id AS companyId,
    o.status, o.payment_status AS paymentStatus, o.payment_paid_at AS paymentPaidAt,
    o.confirmed_at AS confirmedAt,
    o.items_total_cents AS itemsTotalCents, o.freight_total_cents AS freightTotalCents,
    d.id AS deliveryId, d.created_at AS deliveryCreatedAt
    FROM orders o
    JOIN users client ON client.id = o.client_id AND client.role = 'client'
    JOIN companies company ON company.id = o.company_id
    JOIN deliveries d ON d.order_id = o.id
    WHERE o.id = ?`).get(orderId);
  if (!order || order.status !== "confirmed" || order.paymentStatus !== "paid"
    || !Number.isSafeInteger(order.itemsTotalCents) || order.itemsTotalCents < 0
    || (order.freightTotalCents !== null
      && (!Number.isSafeInteger(order.freightTotalCents) || order.freightTotalCents < 0))) {
    return null;
  }

  const items = database.prepare(`SELECT quantity, unit_price_cents AS unitPriceCents
    FROM order_items WHERE order_id = ?`).all(order.id);
  if (!items.length) return null;
  let calculated = 0n;
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0
      || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) return null;
    calculated += BigInt(item.quantity) * BigInt(item.unitPriceCents);
    if (calculated > MAX_SAFE) return null;
  }
  if (Number(calculated) !== order.itemsTotalCents) return null;
  const events = deliveryEvents(database, order.deliveryId);
  const created = createdDeliveryEvidence(database, order, events);
  return created ? { ...order, createdEventAt: created.occurredAt } : null;
}

function normalCompletionEvidence(database, outcome, order) {
  if (!outcome.courierId || !validTimestamp(outcome.acceptedAt)
    || !validTimestamp(outcome.collectedAt)
    || !validTimestamp(outcome.completedAt)) return null;
  const events = deliveryEvents(database, outcome.id);
  const completed = singleEvent(events, "delivery_completed");
  if (!courierEvent(completed, outcome.courierId, order.companyId)) return null;
  const acceptedEvents = events.filter((event) => event.eventType === "delivery_accepted"
    && event.id < completed.id);
  const accepted = acceptedEvents.at(-1);
  if (!courierEvent(accepted, outcome.courierId, order.companyId)) return null;
  const chain = events.filter((event) => event.id >= accepted.id && event.id <= completed.id);
  const requiredTypes = [
    "delivery_accepted", "courier_arrived_at_pickup", "order_collected",
    "courier_arrived_at_destination", "delivery_completed",
  ];
  const required = requiredTypes.map((eventType) => singleEvent(chain, eventType));
  if (required.some((event) => !courierEvent(event, outcome.courierId, order.companyId))
    || !eventsFollowOrder(required)) return null;
  const allowedTypes = new Set([...requiredTypes, "confirmation_code_invalid"]);
  if (chain.some((event) => !allowedTypes.has(event.eventType))) return null;
  const destination = required[3];
  if (!confirmationHistoryIsCompatible(events, chain, outcome.invalidCodeAttempts,
    destination, completed, outcome.courierId, order.companyId)) return null;
  if (!chronological([order.createdEventAt, ...chain.map((event) => event.occurredAt)])
    || !sameTimestamp(outcome.acceptedAt, accepted.occurredAt)
    || !sameTimestamp(outcome.collectedAt, required[2].occurredAt)
    || !sameTimestamp(outcome.completedAt, completed.occurredAt)) return null;
  return completed;
}

function cancellationEvidence(database, outcome, order) {
  if (outcome.returnReason !== "client_cancelled_after_pickup"
    || outcome.cancelledAt !== null || !validTimestamp(outcome.acceptedAt)
    || !validTimestamp(outcome.collectedAt)) return null;
  const events = deliveryEvents(database, outcome.id);
  const cancellation = singleEvent(events, "client_cancelled_after_pickup");
  if (!clientEvent(cancellation, order.clientId)) return null;
  const acceptedEvents = events.filter((event) => event.eventType === "delivery_accepted"
    && event.id < cancellation.id);
  const accepted = acceptedEvents.at(-1);
  if (!accepted || accepted.actorRole !== "courier" || accepted.actorCompanyId !== order.companyId) return null;
  const courierId = accepted.actorUserId;
  const chain = events.filter((event) => event.id >= accepted.id && event.id <= cancellation.id);
  const pickup = singleEvent(chain, "courier_arrived_at_pickup");
  const collected = singleEvent(chain, "order_collected");
  if (!courierEvent(pickup, courierId, order.companyId)
    || !courierEvent(collected, courierId, order.companyId)
    || !eventsFollowOrder([accepted, pickup, collected, cancellation])) return null;
  const destinationEvents = chain.filter((event) => event.eventType === "courier_arrived_at_destination");
  if (destinationEvents.length > 1
    || destinationEvents.some((event) => !courierEvent(event, courierId, order.companyId))) return null;
  if (outcome.invalidCodeAttempts > 0 && destinationEvents.length !== 1) return null;
  const destination = destinationEvents[0];
  if (destination && !confirmationHistoryIsCompatible(events, chain,
    outcome.invalidCodeAttempts, destination, cancellation, courierId, order.companyId)) return null;
  if (!destination && (!Number.isSafeInteger(outcome.invalidCodeAttempts)
    || outcome.invalidCodeAttempts !== 0
    || events.some((event) => ["confirmation_code_invalid", "confirmation_failed"]
      .includes(event.eventType)))) return null;
  const allowedTypes = new Set([
    "delivery_accepted", "courier_arrived_at_pickup", "order_collected",
    "courier_arrived_at_destination", "confirmation_code_invalid",
    "client_cancelled_after_pickup",
  ]);
  if (chain.some((event) => !allowedTypes.has(event.eventType))
    || !chronological([order.createdEventAt, ...chain.map((event) => event.occurredAt)])
    || !sameTimestamp(outcome.acceptedAt, accepted.occurredAt)
    || !sameTimestamp(outcome.collectedAt, collected.occurredAt)) return null;

  const reports = events.filter((event) => event.eventType === "return_reported"
    && event.id > cancellation.id);
  const confirmations = events.filter((event) => event.eventType === "return_confirmed"
    && event.id > cancellation.id);
  if (outcome.status === "returning") {
    if (outcome.courierId !== courierId || reports.length || confirmations.length
      || outcome.returnReportedAt !== null || outcome.returnedAt !== null) return null;
  } else {
    if (reports.length !== 1 || !courierEvent(reports[0], courierId, order.companyId)
      || !sameTimestamp(outcome.returnReportedAt, reports[0].occurredAt)
      || !chronological([cancellation.occurredAt, reports[0].occurredAt])) return null;
    if (outcome.status === "awaiting_return_confirmation") {
      if (outcome.courierId !== courierId || confirmations.length || outcome.returnedAt !== null) return null;
    } else if (outcome.status === "returned") {
      if (outcome.courierId !== null || confirmations.length !== 1
        || !companyEvent(confirmations[0], order.companyId)
        || !sameTimestamp(outcome.returnedAt, confirmations[0].occurredAt)
        || !chronological([reports[0].occurredAt, confirmations[0].occurredAt])) return null;
    } else return null;
  }
  return { courierId, occurredAt: cancellation.occurredAt };
}

function productUnavailableEvidence(database, outcome, order) {
  if (outcome.courierId !== null || outcome.returnReason !== null || outcome.collectedAt !== null
    || !validTimestamp(outcome.cancelledAt)) return null;
  const events = deliveryEvents(database, outcome.id);
  const unavailable = singleEvent(events, "product_unavailable");
  if (!companyEvent(unavailable, order.companyId)
    || events.at(-1)?.id !== unavailable.id
    || events.some((event) => event.eventType === "order_collected")
    || !chronological([order.createdEventAt, unavailable.occurredAt])
    || !sameTimestamp(outcome.cancelledAt, unavailable.occurredAt)) return null;
  return unavailable;
}

export function backfillFinancialEntries(database) {
  const eligibleOrders = new Map();
  const candidates = database.prepare(`SELECT id FROM orders
    WHERE payment_status = 'paid' AND payment_paid_at IS NOT NULL`).all();
  for (const { id } of candidates) {
    const order = paidOrderEvidence(database, id);
    if (!order) continue;
    recordPaymentInTransaction(database, order, order.deliveryId);
    eligibleOrders.set(id, order);
  }

  const completed = database.prepare(`SELECT d.id, d.order_id AS orderId,
    d.courier_id AS courierId, d.accepted_at AS acceptedAt,
    d.collected_at AS collectedAt, d.completed_at AS completedAt,
    d.invalid_code_attempts AS invalidCodeAttempts
    FROM deliveries d WHERE d.status = 'completed'`).all();
  for (const outcome of completed) {
    const order = eligibleOrders.get(outcome.orderId);
    if (!order) continue;
    const evidence = normalCompletionEvidence(database, outcome, order);
    if (!evidence) continue;
    recordNormalCompletionInTransaction(database, {
      ...outcome, ...order, id: outcome.id, orderId: outcome.orderId, courierId: outcome.courierId,
    }, evidence.occurredAt);
  }

  const cancellations = database.prepare(`SELECT d.id, d.order_id AS orderId,
    d.courier_id AS courierId, d.status, d.accepted_at AS acceptedAt,
    d.collected_at AS collectedAt, d.cancelled_at AS cancelledAt,
    d.return_reason AS returnReason, d.return_reported_at AS returnReportedAt,
    d.returned_at AS returnedAt, d.invalid_code_attempts AS invalidCodeAttempts
    FROM deliveries d
    WHERE d.status IN ('returning', 'awaiting_return_confirmation', 'returned')
      AND d.return_reason = 'client_cancelled_after_pickup'`).all();
  for (const outcome of cancellations) {
    const order = eligibleOrders.get(outcome.orderId);
    if (!order) continue;
    const evidence = cancellationEvidence(database, outcome, order);
    if (!evidence) continue;
    recordClientCancellationAfterPickupInTransaction(database, {
      ...outcome, ...order, id: outcome.id, orderId: outcome.orderId,
      courierId: evidence.courierId,
    }, evidence.occurredAt);
  }

  const unavailable = database.prepare(`SELECT d.id, d.order_id AS orderId,
    d.courier_id AS courierId, d.collected_at AS collectedAt,
    d.cancelled_at AS cancelledAt, d.return_reason AS returnReason
    FROM deliveries d WHERE d.status = 'cancelled'`).all();
  for (const outcome of unavailable) {
    const order = eligibleOrders.get(outcome.orderId);
    if (!order) continue;
    const evidence = productUnavailableEvidence(database, outcome, order);
    if (!evidence) continue;
    recordProductUnavailableInTransaction(database, {
      ...outcome, ...order, id: outcome.id, orderId: outcome.orderId,
    }, evidence.occurredAt);
  }
}
