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
  "address_problem",
  "confirmation_failed",
]);
const RECIPIENT_TERMINAL_REASONS = new Set(["recipient_absent", "recipient_refused"]);
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

// Evidência compartilhada pela função financeira, projeções e trigger de INSERT.
// Uma tentativa anterior, mesmo recuperável, não prova elegibilidade para 8.1.
export const CLIENT_CANCELLATION_BEFORE_PICKUP_EVIDENCE_SQL = `
  SELECT d.id, d.order_id AS orderId, o.client_id AS clientId,
    o.items_total_cents AS itemsTotalCents, o.freight_total_cents AS freightTotalCents,
    o.payment_status AS paymentStatus, o.payment_paid_at AS paymentPaidAt,
    d.cancelled_at AS cancelledAt
  FROM deliveries d JOIN orders o ON o.id = d.order_id
  JOIN users client ON client.id = o.client_id AND client.role = 'client'
  WHERE d.status = 'cancelled' AND o.status = 'confirmed'
    AND d.courier_id IS NULL AND d.collected_at IS NULL AND d.completed_at IS NULL
    AND d.return_reason IS NULL AND d.return_reported_at IS NULL AND d.returned_at IS NULL
    AND is_canonical_timestamp(d.cancelled_at) = 1 AND d.cancelled_at <= CURRENT_TIMESTAMP
    AND NOT EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.delivery_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM delivery_occurrences oc WHERE oc.delivery_id = d.id
      AND (oc.delivery_attempt_id IS NOT NULL OR oc.type <> 'courier_failure_before_pickup'))
    AND NOT EXISTS (SELECT 1 FROM delivery_events conflict WHERE conflict.delivery_id = d.id
      AND conflict.event_type NOT IN ('delivery_created', 'delivery_accepted',
        'courier_arrived_at_pickup', 'courier_failed_before_pickup',
        'occurrence_classified', 'client_cancelled_before_pickup'))
    AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'client_cancelled_before_pickup') = 1
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'client_cancelled_before_pickup' AND e.actor_user_id = o.client_id
      AND e.occurred_at = d.cancelled_at)
`;

// Ciclo físico já encerrado. O estado é parametrizado para validar antes da
// transição e novamente depois dela, inclusive no gatilho do ledger.
const LATEST_COLLECTION_EVENT_ID_SQL = `(SELECT MAX(collected.id) FROM delivery_events collected
  WHERE collected.delivery_id = d.id AND collected.event_type = 'order_collected')`;
export const EXTERNAL_OBSTRUCTION_CYCLE_SQL = `
  SELECT r.id AS revalidationId, oc.id AS occurrenceId,
    d.id AS deliveryId, d.order_id AS orderId, d.cancelled_at AS cancelledAt
  FROM deliveries d JOIN orders o ON o.id = d.order_id
  JOIN users client ON client.id = o.client_id AND client.role = 'client'
  JOIN delivery_revalidations r ON r.delivery_id = d.id
  JOIN delivery_attempts a ON a.id = r.delivery_attempt_id AND a.delivery_id = d.id
  JOIN users courier ON courier.id = a.courier_id AND courier.role = 'courier'
    AND courier.company_id = o.company_id
  JOIN users receiver ON receiver.id = r.received_by_user_id AND receiver.role = 'company'
    AND receiver.company_id = o.company_id
  JOIN delivery_occurrences oc ON oc.id = r.occurrence_id AND oc.delivery_id = d.id
    AND oc.delivery_attempt_id = a.id
  WHERE d.status = ? AND o.status = 'confirmed' AND r.verified_at IS NULL
    AND (d.status <> 'awaiting_revalidation' OR d.cancelled_at IS NULL)
    AND r.verified_by_user_id IS NULL AND r.verification_result IS NULL
    AND d.return_reason = 'temporary_external_obstruction'
    AND d.courier_id IS NULL AND d.completed_at IS NULL
    AND is_canonical_timestamp(d.collected_at) = 1
    AND is_canonical_timestamp(d.return_reported_at) = 1
    AND is_canonical_timestamp(d.returned_at) = 1
    AND d.collected_at <= d.return_reported_at AND d.return_reported_at <= d.returned_at
    AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'recoverable'
    AND a.end_reason = 'temporary_external_obstruction'
    AND is_canonical_timestamp(a.started_at) = 1 AND is_canonical_timestamp(a.ended_at) = 1
    AND a.started_at <= a.ended_at AND a.ended_at <= d.returned_at
    AND a.id = (SELECT latest.id FROM delivery_attempts latest
      WHERE latest.delivery_id = d.id ORDER BY latest.attempt_number DESC LIMIT 1)
    AND oc.type = 'temporary_external_obstruction'
    AND is_canonical_timestamp(oc.reported_at) = 1
    AND a.started_at <= oc.reported_at AND oc.reported_at <= d.returned_at
    AND is_canonical_timestamp(r.received_at) = 1
    AND d.returned_at <= r.received_at AND r.received_at <= CURRENT_TIMESTAMP
    AND NOT EXISTS (SELECT 1 FROM delivery_attempts open WHERE open.delivery_id = d.id
      AND open.status IN ('active', 'returning'))
    AND (SELECT COUNT(*) FROM delivery_revalidations pending
      WHERE pending.delivery_id = d.id AND pending.verified_at IS NULL) = 1
    AND (SELECT COUNT(*) FROM delivery_occurrences evidence
      WHERE evidence.delivery_id = d.id AND evidence.delivery_attempt_id = a.id
        AND evidence.type = 'temporary_external_obstruction') = 1
    AND (SELECT COUNT(*) FROM delivery_occurrences same_attempt
      WHERE same_attempt.delivery_id = d.id AND same_attempt.delivery_attempt_id = a.id) = 1
    AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'temporary_external_obstruction'
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}) = 1
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'temporary_external_obstruction' AND e.actor_user_id = a.courier_id
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}
      AND json_valid(e.details_json) = 1
      AND json_extract(e.details_json, '$.occurrenceId') = oc.id
      AND e.occurred_at >= d.collected_at AND e.occurred_at <= d.return_reported_at)
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'return_reported' AND e.actor_user_id = a.courier_id
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}
      AND e.occurred_at = d.return_reported_at)
    AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'return_reported'
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}) = 1
    AND EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'delivery_awaiting_revalidation' AND e.actor_user_id = r.received_by_user_id
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}
      AND json_valid(e.details_json) = 1
      AND json_extract(e.details_json, '$.revalidationId') = r.id
      AND json_extract(e.details_json, '$.occurrenceId') = oc.id
      AND e.occurred_at = r.received_at)
    AND (SELECT COUNT(*) FROM delivery_events e WHERE e.delivery_id = d.id
      AND e.event_type = 'delivery_awaiting_revalidation'
      AND e.id > ${LATEST_COLLECTION_EVENT_ID_SQL}) = 1
    AND NOT EXISTS (SELECT 1 FROM delivery_events conflict WHERE conflict.delivery_id = d.id
      AND conflict.event_type IN ('delivery_completed', 'client_cancelled_before_pickup',
        'client_cancelled_after_pickup', 'recipient_absent', 'recipient_refused',
        'confirmation_failed', 'product_unavailable'))
    AND NOT EXISTS (SELECT 1 FROM delivery_events verified WHERE verified.delivery_id = d.id
      AND verified.event_type = 'delivery_revalidated'
      AND verified.id > ${LATEST_COLLECTION_EVENT_ID_SQL})
`;

export function externalObstructionCycle(database, deliveryId, status = "awaiting_revalidation") {
  const cycles = database.prepare(`${EXTERNAL_OBSTRUCTION_CYCLE_SQL} AND d.id = ?`)
    .all(status, deliveryId);
  if (cycles.length !== 1) {
    throw financialError("O impedimento externo e o ciclo pendente exigem reconciliação.");
  }
  return cycles[0];
}

function externalObstructionRefundPlan(database, deliveryId) {
  try { return readExternalObstructionRefundPlan(database, deliveryId); }
  catch (error) {
    if (error.code === "ERR_OUT_OF_RANGE") throw financialError("Valor financeiro fora do inteiro seguro.");
    throw error;
  }
}

function readExternalObstructionRefundPlan(database, deliveryId) {
  const cycle = externalObstructionCycle(database, deliveryId, "cancelled");
  const delivery = database.prepare(`SELECT d.id, d.order_id AS orderId, d.cancelled_at AS cancelledAt,
    o.client_id AS clientId, o.items_total_cents AS itemsTotalCents,
    o.freight_total_cents AS freightTotalCents, o.payment_status AS paymentStatus,
    o.payment_paid_at AS paymentPaidAt
    FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`).get(deliveryId);
  const cancellation = database.prepare(`SELECT e.occurred_at AS occurredAt, e.actor_user_id AS actorId
    FROM delivery_events e WHERE e.delivery_id = ?
      AND e.event_type = 'client_cancelled_after_external_obstruction'`).all(deliveryId);
  if (!delivery || !isCanonicalTimestamp(delivery.cancelledAt)
    || delivery.cancelledAt < database.prepare("SELECT returned_at AS value FROM deliveries WHERE id = ?")
      .get(deliveryId).value
    || delivery.cancelledAt > database.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now
    || cancellation.length !== 1 || cancellation[0].actorId !== delivery.clientId
    || cancellation[0].occurredAt !== delivery.cancelledAt || cycle.orderId !== delivery.orderId) {
    throw financialError("O cancelamento após impedimento externo exige reconciliação operacional.");
  }
  const entries = database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
    entry_type AS entryType, component, party_type AS partyType,
    party_user_id AS partyUserId, party_company_id AS partyCompanyId,
    amount_cents AS amountCents, reason, idempotency_key AS idempotencyKey
    FROM financial_entries WHERE order_id = ? OR delivery_id = ? ORDER BY id`)
    .all(delivery.orderId, delivery.id);
  const payments = new Map();
  const incompatible = new Set(["recipient_absent", "recipient_refused", "confirmation_failed",
    "client_cancelled_before_pickup", "client_cancelled_after_pickup", "product_unavailable",
    "address_problem", "delivery_completed"]);
  for (const entry of entries) {
    if (entry.orderId !== delivery.orderId
      || (entry.deliveryId !== null && entry.deliveryId !== delivery.id)
      || !Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0
      || !["products", "freight"].includes(entry.component)
      || !["payment", "refund"].includes(entry.entryType)
      || entry.partyType !== "client" || entry.partyUserId !== delivery.clientId
      || entry.partyCompanyId !== null) {
      throw financialError("Ledger ou vínculo incompatível com o impedimento externo.");
    }
    if (entry.entryType === "payment") {
      if (payments.has(entry.component) || entry.reason !== "simulated_payment") {
        throw financialError("Pagamento duplicado ou incompatível com o Pedido.");
      }
      payments.set(entry.component, entry.amountCents);
    } else if (incompatible.has(entry.reason)) {
      throw financialError("Refund de outro desfecho exige reconciliação.");
    }
  }
  if (delivery.paymentStatus !== "paid") {
    throw financialError("Pedido pós-coleta pendente exige reconciliação financeira.");
  }
  const items = database.prepare(`SELECT quantity, unit_price_cents AS price
    FROM order_items WHERE order_id = ?`).all(delivery.orderId);
  let subtotal = 0n;
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0
      || !Number.isSafeInteger(item.price) || item.price < 0) {
      throw financialError("Snapshot dos produtos inválido.");
    }
    subtotal += BigInt(item.quantity) * BigInt(item.price);
  }
  if (!items.length || !Number.isSafeInteger(delivery.itemsTotalCents)
    || subtotal !== BigInt(delivery.itemsTotalCents)
    || !isCanonicalTimestamp(delivery.paymentPaidAt)
    || delivery.paymentPaidAt > delivery.cancelledAt
    || payments.get("products") !== delivery.itemsTotalCents
    || (delivery.freightTotalCents === null
      ? payments.has("freight") : payments.get("freight") !== delivery.freightTotalCents)) {
    throw financialError("Pagamentos ausentes ou divergentes dos snapshots do Pedido.");
  }
  const base = entryBase(delivery, "client_cancelled_after_external_obstruction", delivery.cancelledAt);
  return ["products", "freight"].map((component) => {
    const paid = payments.get(component) ?? 0;
    const refunds = entries.filter((entry) => entry.entryType === "refund" && entry.component === component);
    let refunded;
    try { refunded = sumFinancialAmounts(refunds.map((entry) => entry.amountCents)); }
    catch { throw financialError("O total reembolsado exige reconciliação."); }
    if (refunded > paid) throw financialError("Reembolso superior ao componente pago.");
    const idempotencyKey = `delivery:${delivery.id}:client-cancelled-after-external-obstruction:refund-${component}`;
    const ownRefund = refunds.find((entry) => entry.idempotencyKey === idempotencyKey);
    const amountCents = paid - refunded + (ownRefund?.amountCents ?? 0);
    const entry = { ...base, entryType: "refund", component, partyType: "client",
      partyId: delivery.clientId, amountCents, idempotencyKey };
    const existing = findEntryByIdempotencyKey(database, idempotencyKey);
    if (existing) {
      if (amountCents === 0) throw financialError("Chave de refund sem saldo compatível.");
      assertSameSemanticEntry(existing, normalizeEntry(entry));
    }
    return { entry, paid, refunded };
  });
}

export function recordClientCancellationAfterExternalObstructionInTransaction(database, delivery) {
  const plan = externalObstructionRefundPlan(database, delivery.id);
  for (const { entry } of plan) {
    if (entry.amountCents > 0) insertFinancialEntryInTransaction(database, entry);
  }
}

function clientCancellationBeforePickupRefundPlan(database, deliveryId) {
  try { return readClientCancellationBeforePickupRefundPlan(database, deliveryId); }
  catch (error) {
    // node:sqlite rejeita INTEGER fora do intervalo seguro antes da validação JS.
    if (error.code === "ERR_OUT_OF_RANGE") throw financialError("Valor financeiro fora do inteiro seguro.");
    throw error;
  }
}

function readClientCancellationBeforePickupRefundPlan(database, deliveryId) {
  const delivery = database.prepare(`${CLIENT_CANCELLATION_BEFORE_PICKUP_EVIDENCE_SQL}
    AND d.id = ?`).get(deliveryId);
  if (!delivery) {
    throw financialError("O cancelamento pré-coleta exige reconciliação do histórico operacional, inclusive coletas anteriores.");
  }
  // Inclui também vínculos corrompidos que apontem para esta Entrega e outro Pedido.
  const entries = database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
    entry_type AS entryType, component, party_type AS partyType,
    party_user_id AS partyUserId, party_company_id AS partyCompanyId,
    amount_cents AS amountCents, reason, idempotency_key AS idempotencyKey
    FROM financial_entries WHERE order_id = ? OR delivery_id = ? ORDER BY id`)
    .all(delivery.orderId, delivery.id);
  const payments = new Map();
  const incompatibleRefundReasons = new Set([
    "client_cancelled_after_pickup", "product_unavailable", "confirmation_failed",
    "recipient_absent", "recipient_refused", "address_problem", "delivery_completed",
  ]);
  for (const entry of entries) {
    if (entry.orderId !== delivery.orderId
      || (entry.deliveryId !== null && entry.deliveryId !== delivery.id)
      || !Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0
      || !["products", "freight"].includes(entry.component)
      || !["payment", "refund"].includes(entry.entryType)
      || entry.partyType !== "client" || entry.partyUserId !== delivery.clientId
      || entry.partyCompanyId !== null) {
      throw financialError("Lançamento inválido, distribuição ou vínculo financeiro incompatível com a pré-coleta.");
    }
    if (entry.entryType === "payment") {
      if (payments.has(entry.component) || entry.reason !== "simulated_payment") {
        throw financialError("Pagamento duplicado ou incompatível com o Pedido.");
      }
      payments.set(entry.component, entry.amountCents);
    } else if (incompatibleRefundReasons.has(entry.reason)) {
      throw financialError("Refund de outro desfecho terminal exige reconciliação.");
    }
  }
  if (delivery.paymentStatus === "pending") {
    if (entries.length || delivery.paymentPaidAt !== null) {
      throw financialError("Pedido pendente com evidência financeira inesperada.");
    }
  } else if (delivery.paymentStatus === "paid") {
    const items = database.prepare(`SELECT quantity, unit_price_cents AS price
      FROM order_items WHERE order_id = ?`).all(delivery.orderId);
    let subtotal = 0n;
    for (const item of items) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0
        || !Number.isSafeInteger(item.price) || item.price < 0) {
        throw financialError("Snapshot dos produtos inválido.");
      }
      subtotal += BigInt(item.quantity) * BigInt(item.price);
    }
    if (!isCanonicalTimestamp(delivery.paymentPaidAt) || delivery.paymentPaidAt > delivery.cancelledAt
      || !items.length || !Number.isSafeInteger(delivery.itemsTotalCents)
      || subtotal !== BigInt(delivery.itemsTotalCents)
      || payments.get("products") !== delivery.itemsTotalCents
      || (delivery.freightTotalCents === null
        ? payments.has("freight") : payments.get("freight") !== delivery.freightTotalCents)) {
      throw financialError("Pagamentos ausentes ou divergentes dos snapshots do Pedido.");
    }
  } else {
    throw financialError("Estado de pagamento incompatível.");
  }
  const base = entryBase(delivery, "client_cancelled_before_pickup", delivery.cancelledAt);
  return ["products", "freight"].map((component) => {
    const paid = payments.get(component) ?? 0;
    const refunds = entries.filter((entry) => entry.entryType === "refund" && entry.component === component);
    let refunded;
    try { refunded = sumFinancialAmounts(refunds.map((entry) => entry.amountCents)); }
    catch { throw financialError("O total reembolsado exige reconciliação."); }
    if (refunded > paid) throw financialError("Reembolso superior ao componente efetivamente pago.");
    const idempotencyKey = `delivery:${delivery.id}:client-cancelled-before-pickup:refund-${component}`;
    const ownRefund = refunds.find((entry) => entry.idempotencyKey === idempotencyKey);
    const amountCents = paid - refunded + (ownRefund?.amountCents ?? 0);
    const entry = {
      ...base, entryType: "refund", component, partyType: "client",
      partyId: delivery.clientId, amountCents, idempotencyKey,
    };
    const existing = findEntryByIdempotencyKey(database, idempotencyKey);
    if (existing) {
      if (amountCents === 0) throw financialError("Chave de refund existente sem saldo compatível.");
      assertSameSemanticEntry(existing, normalizeEntry(entry));
    }
    return { entry, paid, refunded };
  });
}

export function recordClientCancellationBeforePickupInTransaction(database, delivery) {
  const plan = clientCancellationBeforePickupRefundPlan(database, delivery.id);
  for (const { entry } of plan) {
    if (entry.amountCents > 0) insertFinancialEntryInTransaction(database, entry);
  }
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

function recipientTerminalFailureEvidence(database, delivery, attemptId, reason) {
  const attempt = database.prepare(`SELECT a.courier_id AS courierId,
      a.attempt_number AS attemptNumber, a.started_at AS startedAt, a.ended_at AS endedAt,
      d.collected_at AS collectedAt, d.return_reported_at AS returnReportedAt,
      d.returned_at AS returnedAt
    FROM delivery_attempts a
    JOIN deliveries d ON d.id = a.delivery_id AND d.status = 'returned'
      AND d.return_reason = ? AND d.returned_at IS NOT NULL
    JOIN orders o ON o.id = d.order_id AND o.company_id = ?
    JOIN users courier ON courier.id = a.courier_id AND courier.role = 'courier'
      AND courier.company_id = o.company_id
    JOIN couriers profile ON profile.user_id = courier.id
    WHERE a.id = ? AND a.delivery_id = ? AND a.status = 'closed_unsuccessfully'
      AND a.end_nature = 'terminal' AND a.end_reason = ?
      AND EXISTS (SELECT 1 FROM delivery_events event
        JOIN users company_actor ON company_actor.id = event.actor_user_id
        WHERE event.delivery_id = d.id AND event.event_type = 'return_confirmed'
          AND event.occurred_at = d.returned_at AND company_actor.role = 'company'
          AND company_actor.company_id = o.company_id)
      AND a.id = (SELECT latest.id FROM delivery_attempts latest
        WHERE latest.delivery_id = a.delivery_id ORDER BY latest.attempt_number DESC LIMIT 1)`)
    .get(reason, delivery.companyId, attemptId, delivery.id, reason);
  const occurrences = database.prepare(`SELECT id, type, reported_by_user_id AS reporterId,
    reported_at AS reportedAt FROM delivery_occurrences
    WHERE delivery_id = ? AND delivery_attempt_id = ?
      AND type IN ('recipient_absent', 'recipient_refused',
        'confirmation_failed', 'address_problem')`).all(delivery.id, attemptId);
  const occurrence = occurrences[0];
  if (!attempt || occurrences.length !== 1 || occurrence.type !== reason
    || occurrence.reporterId !== attempt.courierId) {
    throw financialError("A tentativa e a ocorrência terminal exigem reconciliação financeira.");
  }
  const events = deliveryEvents(database, delivery.id);
  const collections = events.filter((event) => event.eventType === "order_collected");
  const collected = collections.at(-1);
  const terminalEvents = events.filter((event) => event.eventType === reason);
  const terminal = terminalEvents[0];
  const reports = events.filter((event) => event.eventType === "return_reported"
    && collected && event.id > collected.id);
  const report = reports[0];
  const confirmations = events.filter((event) => event.eventType === "return_confirmed"
    && collected && event.id > collected.id);
  const confirmation = confirmations[0];
  const conflictingTerminal = events.some((event) => collected && event.id > collected.id
    && ["recipient_absent", "recipient_refused", "confirmation_failed",
      "client_cancelled_after_pickup", "delivery_completed"].includes(event.eventType)
    && event !== terminal);
  const details = terminal && eventDetails(terminal);
  if (collections.length !== attempt.attemptNumber || !collected || !terminal
    || terminalEvents.length !== 1 || reports.length !== 1 || confirmations.length !== 1
    || conflictingTerminal || !details
    || (Object.hasOwn(details, "occurrenceId") && details.occurrenceId !== occurrence.id)
    || !eventsFollowOrder([collected, terminal, report, confirmation])
    || !courierEvent(collected, attempt.courierId, delivery.companyId)
    || !courierEvent(terminal, attempt.courierId, delivery.companyId)
    || !courierEvent(report, attempt.courierId, delivery.companyId)
    || !companyEvent(confirmation, delivery.companyId)
    || !chronological([attempt.startedAt, collected.occurredAt, occurrence.reportedAt,
      terminal.occurredAt, report.occurredAt, confirmation.occurredAt, attempt.endedAt])
    || !sameTimestamp(attempt.startedAt, collected.occurredAt)
    || !sameTimestamp(attempt.collectedAt, collected.occurredAt)
    || !sameTimestamp(occurrence.reportedAt, terminal.occurredAt)
    || !sameTimestamp(attempt.returnReportedAt, report.occurredAt)
    || !sameTimestamp(attempt.returnedAt, confirmation.occurredAt)
    || !sameTimestamp(attempt.endedAt, confirmation.occurredAt)) {
    throw financialError("A cadeia de coleta, ocorrência e retorno exige reconciliação financeira.");
  }
  return attempt.courierId;
}

export function recordRecipientTerminalFailureInTransaction(database, delivery, attemptId, reason) {
  if (!RECIPIENT_TERMINAL_REASONS.has(reason)) throw new RangeError("Motivo terminal inválido.");
  const courierId = recipientTerminalFailureEvidence(database, delivery, attemptId, reason);
  if (delivery.paymentStatus !== "paid" || !isCanonicalTimestamp(delivery.paymentPaidAt)) {
    throw financialError("O pagamento exige reconciliação financeira.");
  }
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const paidProducts = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
  if (paidProducts === undefined || paidProducts !== delivery.itemsTotalCents) {
    throw financialError(`O pagamento de produtos do Pedido ${delivery.orderId} exige reconciliação.`);
  }
  const paidFreight = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
  if ((delivery.freightTotalCents === null) !== (paidFreight === undefined)
    || (paidFreight !== undefined && paidFreight !== delivery.freightTotalCents)) {
    throw financialError(`O pagamento de frete do Pedido ${delivery.orderId} exige reconciliação.`);
  }
  const freightRefunds = database.prepare(`SELECT amount_cents AS amountCents
    FROM financial_entries WHERE order_id = ? AND entry_type = 'refund'
      AND component = 'freight'`).all(delivery.orderId);
  if (freightRefunds.length && paidFreight === undefined) {
    throw financialError(`O Pedido ${delivery.orderId} possui reembolso de frete sem pagamento coerente.`);
  }
  let refundedFreightCents;
  try {
    refundedFreightCents = sumFinancialAmounts(freightRefunds.map(({ amountCents }) => amountCents));
  } catch {
    throw financialError(`O reembolso de frete do Pedido ${delivery.orderId} exige reconciliação.`);
  }
  if (refundedFreightCents !== 0) {
    throw financialError(`O Pedido ${delivery.orderId} possui reembolso de frete incompatível.`);
  }

  const keyPrefix = `delivery:${delivery.id}:${reason.replaceAll("_", "-")}`;
  const refundKey = `${keyPrefix}:refund-products`;
  const priorRefunds = database.prepare(`SELECT amount_cents AS amountCents,
    idempotency_key AS idempotencyKey FROM financial_entries
    WHERE order_id = ? AND entry_type = 'refund' AND component = 'products'`).all(delivery.orderId);
  const refundedByOthers = sumFinancialAmounts(priorRefunds
    .filter((entry) => entry.idempotencyKey !== refundKey).map((entry) => entry.amountCents));
  if (refundedByOthers > paidProducts) {
    throw financialError(`O Pedido ${delivery.orderId} possui reembolso excessivo de produtos.`);
  }
  const base = entryBase(delivery, reason);
  const remaining = paidProducts - refundedByOthers;
  if (remaining > 0) {
    insertRefund(database, delivery, base, FINANCIAL_COMPONENTS.PRODUCTS, remaining, refundKey);
  } else if (findEntryByIdempotencyKey(database, refundKey)) {
    throw financialError(`A chave financeira ${refundKey} existe sem saldo correspondente.`);
  }
  if (paidFreight === undefined) return;
  const split = splitNormalFreight(paidFreight);
  for (const [partyType, partyId, amountCents] of [
    [FINANCIAL_PARTIES.COURIER, courierId, split.courierCents],
    [FINANCIAL_PARTIES.COMPANY, delivery.companyId, split.companyCents],
    [FINANCIAL_PARTIES.ERMES, null, split.ermesCents],
  ]) {
    insertFinancialEntryInTransaction(database, {
      ...base, entryType: FINANCIAL_ENTRY_TYPES.DISTRIBUTION,
      component: FINANCIAL_COMPONENTS.FREIGHT, partyType, partyId, amountCents,
      idempotencyKey: `${keyPrefix}:distribution-freight:${partyType}`,
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

const CONFIRMATION_FAILURE_RESPONSIBILITIES = new Set(["CLIENTE", "MOTOBOY", "SISTEMA", "INDEFINIDO"]);
const FINAL_DISTRIBUTION_REASONS = new Set([
  "confirmation_failed", "delivery_completed", "recipient_absent", "recipient_refused",
  "client_cancelled_after_pickup",
]);

function confirmationFailureClassification(database, occurrenceId, responsibility) {
  if (!CONFIRMATION_FAILURE_RESPONSIBILITIES.has(responsibility)) {
    throw financialError("Responsabilidade incompatível com o financeiro de três códigos inválidos.");
  }
  const delivery = database.prepare(`SELECT d.id, d.order_id AS orderId,
    o.client_id AS clientId, o.company_id AS companyId,
    o.items_total_cents AS itemsTotalCents, o.freight_total_cents AS freightTotalCents,
    o.payment_status AS paymentStatus, o.payment_paid_at AS paymentPaidAt,
    oc.classified_at AS classifiedAt
    FROM delivery_occurrences oc JOIN deliveries d ON d.id = oc.delivery_id
    JOIN orders o ON o.id = d.order_id
    JOIN users classifier ON classifier.id = oc.classified_by_user_id
      AND classifier.role = 'company' AND classifier.company_id = o.company_id
    JOIN delivery_attempts a ON a.id = oc.delivery_attempt_id AND a.delivery_id = d.id
      AND a.status = 'closed_unsuccessfully' AND a.end_nature = 'terminal'
      AND a.end_reason = 'confirmation_failed'
    WHERE oc.id = ? AND oc.type = 'confirmation_failed' AND oc.responsibility = ?
      AND (SELECT COUNT(*) FROM delivery_occurrences evidence
        WHERE evidence.delivery_id = d.id AND evidence.type = 'confirmation_failed') = 1
      AND NOT EXISTS (SELECT 1 FROM delivery_occurrences conflict
        WHERE conflict.delivery_attempt_id = a.id
          AND conflict.type IN ('recipient_absent', 'recipient_refused', 'address_problem'))
      AND a.attempt_number = (SELECT MAX(latest.attempt_number)
        FROM delivery_attempts latest WHERE latest.delivery_id = d.id)
      AND is_canonical_timestamp(oc.classified_at) = 1
      AND oc.classified_at >= oc.reported_at AND oc.classified_at >= d.returned_at
      AND oc.classified_at <= CURRENT_TIMESTAMP
      AND d.status = 'returned' AND d.return_reason = 'confirmation_failed'`)
    .get(occurrenceId, responsibility);
  if (!delivery || delivery.paymentStatus !== "paid"
    || !isCanonicalTimestamp(delivery.paymentPaidAt)) {
    throw financialError("A classificação e o pagamento exigem reconciliação financeira.");
  }
  return delivery;
}

// O chamador valida a evidência operacional em official-statuses antes de
// persistir a classificação. Esta camada valida somente classificação e ledger,
// sem importar official-statuses de volta nem abrir outra transação.
function confirmationFailureRefundPlan(database, delivery, responsibility) {
  const entries = database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
    entry_type AS entryType, component, party_type AS partyType,
    party_user_id AS partyUserId, party_company_id AS partyCompanyId,
    amount_cents AS amountCents, reason, idempotency_key AS idempotencyKey
    FROM financial_entries WHERE order_id = ? ORDER BY id`).all(delivery.orderId);
  const payments = new Map();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents < 0
      || !["products", "freight"].includes(entry.component)
      || (entry.deliveryId !== null && entry.deliveryId !== delivery.id)) {
      throw financialError("Lançamento financeiro inválido ou vinculado a outra Entrega.");
    }
    if (entry.entryType === "distribution") {
      // Uma remuneração histórica de outra natureza não é, por si só, corrupção.
      // Desfechos finais concorrentes e lançamentos atribuídos a este fluxo são.
      if (FINAL_DISTRIBUTION_REASONS.has(entry.reason)
        || entry.idempotencyKey.startsWith(`delivery:${delivery.id}:confirmation-failed:`)) {
        throw financialError("Distribuição incompatível com o desfecho confirmation_failed.");
      }
      continue;
    }
    if (!["payment", "refund"].includes(entry.entryType)
      || entry.partyType !== "client" || entry.partyUserId !== delivery.clientId
      || entry.partyCompanyId !== null) {
      throw financialError("O componente financeiro não pertence ao cliente do Pedido.");
    }
    if (entry.entryType === "payment") {
      if (payments.has(entry.component) || entry.reason !== "simulated_payment") {
        throw financialError("Pagamento duplicado ou incompatível.");
      }
      payments.set(entry.component, entry.amountCents);
    }
  }
  if (payments.get("products") !== delivery.itemsTotalCents
    || (delivery.freightTotalCents === null
      ? payments.has("freight") : payments.get("freight") !== delivery.freightTotalCents)) {
    throw financialError("Pagamentos ausentes ou divergentes dos snapshots do Pedido.");
  }
  const base = entryBase(delivery, "confirmation_failed", delivery.classifiedAt);
  return ["products", "freight"].map((component) => {
    const paid = payments.get(component) ?? 0;
    const refunds = entries.filter((entry) => entry.entryType === "refund" && entry.component === component);
    let refunded;
    try { refunded = sumFinancialAmounts(refunds.map((entry) => entry.amountCents)); }
    catch { throw financialError("O total reembolsado exige reconciliação."); }
    if (refunded > paid || (component === "freight" && responsibility === "CLIENTE" && refunded > 0)) {
      throw financialError("Reembolso excessivo ou incompatível com a responsabilidade classificada.");
    }
    const idempotencyKey = `delivery:${delivery.id}:confirmation-failed:refund-${component}`;
    const existing = findEntryByIdempotencyKey(database, idempotencyKey);
    const ownRefund = refunds.find((entry) => entry.idempotencyKey === idempotencyKey);
    const shouldRefund = component === "products" || responsibility !== "CLIENTE";
    const amountCents = shouldRefund ? paid - refunded + (ownRefund?.amountCents ?? 0) : 0;
    const entry = {
      ...base, entryType: "refund", component, partyType: "client",
      partyId: delivery.clientId, amountCents, idempotencyKey,
    };
    if (existing) {
      if (amountCents === 0) throw financialError("Chave de reembolso existente sem saldo compatível.");
      assertSameSemanticEntry(existing, normalizeEntry(entry));
    }
    return { entry, refunded, paid, shouldRefund };
  });
}

export function recordConfirmationFailureFinancialConsequencesInTransaction(database, occurrenceId, responsibility) {
  const delivery = confirmationFailureClassification(database, occurrenceId, responsibility);
  const plan = confirmationFailureRefundPlan(database, delivery, responsibility);
  for (const { entry } of plan) {
    if (entry.amountCents > 0) insertFinancialEntryInTransaction(database, entry);
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
  if (delivery.returnReason === "temporary_external_obstruction"
    && ["awaiting_revalidation", "cancelled"].includes(delivery.status)) {
    // Refere-se somente ao custo interno futuro da tentativa malsucedida.
    pending.push("freight_distribution_rule_undefined");
    if (delivery.status === "cancelled") {
      const plan = externalObstructionRefundPlan(database, delivery.id);
      if (plan.some(({ paid, refunded }) => paid !== refunded)) {
        throw financialError("Cancelamento externo sem refunds integrais exige reconciliação.");
      }
    }
  }
  if (delivery.returnReason === "confirmation_failed") {
    const occurrences = database.prepare(`SELECT id, responsibility FROM delivery_occurrences
      WHERE delivery_id = ? AND type = 'confirmation_failed'`).all(delivery.id);
    const occurrence = occurrences.length === 1 ? occurrences[0] : null;
    if (occurrences.length > 1) throw financialError("Ocorrências contraditórias exigem reconciliação financeira.");
    if (!occurrence || occurrence.responsibility === null) {
      pending.push("confirmation_failure_classification_required");
    } else {
      const persisted = confirmationFailureClassification(database, occurrence.id, occurrence.responsibility);
      const plan = confirmationFailureRefundPlan(database, persisted, occurrence.responsibility);
      if (plan.some(({ shouldRefund, refunded, paid }) => shouldRefund && refunded !== paid)) {
        throw financialError("Histórico classificado sem reembolsos completos; reconciliação explícita necessária.");
      }
    }
    if (delivery.freightTotalCents === null && !paidFreight) pending.push("freight_amount_unavailable");
  }
  if (RECIPIENT_TERMINAL_REASONS.has(delivery.returnReason) && delivery.status === "returned") {
    const payments = paidComponents(database, delivery.orderId, delivery.clientId);
    const paidProductsCents = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
    const paidFreightCents = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
    const refundedProductsCents = sumFinancialAmounts(entries.filter((entry) =>
      entry.entryType === FINANCIAL_ENTRY_TYPES.REFUND
        && entry.component === FINANCIAL_COMPONENTS.PRODUCTS).map((entry) => entry.amountCents));
    if (paidProductsCents === undefined || paidProductsCents !== delivery.itemsTotalCents
      || refundedProductsCents !== paidProductsCents) {
      throw financialError(`Os produtos do Pedido ${delivery.orderId} exigem reconciliação.`);
    }
    if ((delivery.freightTotalCents === null) !== (paidFreightCents === undefined)
      || (paidFreightCents !== undefined && paidFreightCents !== delivery.freightTotalCents)) {
      throw financialError(`O frete do Pedido ${delivery.orderId} exige reconciliação.`);
    }
    if (paidFreightCents === undefined) {
      pending.push("freight_amount_unavailable");
    } else {
      const distribution = database.prepare(`SELECT party_type AS partyType,
        party_user_id AS partyUserId, party_company_id AS partyCompanyId,
        amount_cents AS amountCents FROM financial_entries
        WHERE delivery_id = ? AND entry_type = 'distribution' AND reason = ? ORDER BY id`)
        .all(delivery.id, delivery.returnReason);
      const attempt = database.prepare(`SELECT courier_id AS courierId FROM delivery_attempts
        WHERE delivery_id = ? AND status = 'closed_unsuccessfully' AND end_nature = 'terminal'
          AND end_reason = ? ORDER BY attempt_number DESC LIMIT 1`)
        .get(delivery.id, delivery.returnReason);
      const split = splitNormalFreight(paidFreightCents);
      if (!attempt || distribution.length !== 3
        || distribution[0].partyType !== "courier"
        || distribution[0].partyUserId !== attempt.courierId
        || distribution[0].amountCents !== split.courierCents
        || distribution[1].partyType !== "company"
        || distribution[1].partyCompanyId !== delivery.companyId
        || distribution[1].amountCents !== split.companyCents
        || distribution[2].partyType !== "ermes"
        || distribution[2].amountCents !== split.ermesCents) {
        throw financialError(`A distribuição do Pedido ${delivery.orderId} exige reconciliação.`);
      }
    }
  }
  const productUnavailable = entries.some((entry) => entry.reason === "product_unavailable")
    || hasAuthorizedProductUnavailableEvent(database, delivery);
  const clientCancellation = database.prepare(`SELECT 1 FROM delivery_events
    WHERE delivery_id = ? AND event_type = 'client_cancelled_before_pickup'`).get(delivery.id);
  if (delivery.status === "cancelled" && clientCancellation) {
    const plan = clientCancellationBeforePickupRefundPlan(database, delivery.id);
    if (plan.some(({ paid, refunded }) => paid !== refunded)) {
      throw financialError("Cancelamento pré-coleta histórico sem refunds completos; reconciliação explícita necessária.");
    }
    if (delivery.paymentStatus === "paid" && delivery.freightTotalCents === null) {
      pending.push("freight_amount_unavailable");
    }
  } else if (delivery.status === "cancelled" && delivery.returnReason === null && !productUnavailable) {
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

function latestAttemptInvalidCodeCount(database, deliveryId) {
  const attempt = database.prepare(`SELECT invalid_code_attempts AS invalidCodeAttempts
    FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number DESC LIMIT 1`)
    .get(deliveryId);
  return attempt?.invalidCodeAttempts ?? null;
}

function confirmationHistoryIsCompatible(events, chain, persistedAttempts,
  destination, terminal, courierId, companyId) {
  if ((persistedAttempts !== null && (!Number.isSafeInteger(persistedAttempts)
    || persistedAttempts < 0 || persistedAttempts >= 3))
    || events.some((event) => event.eventType === "confirmation_failed")) return false;
  const allInvalidAttempts = events.filter(
    (event) => event.eventType === "confirmation_code_invalid",
  );
  const chainInvalidAttempts = chain.filter(
    (event) => event.eventType === "confirmation_code_invalid",
  );
  if (allInvalidAttempts.length !== chainInvalidAttempts.length
    || chainInvalidAttempts.length >= 3
    || (persistedAttempts !== null && chainInvalidAttempts.length !== persistedAttempts)) return false;
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
  if (!confirmationHistoryIsCompatible(events, chain,
    latestAttemptInvalidCodeCount(database, outcome.id),
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
  const invalidCodeAttempts = latestAttemptInvalidCodeCount(database, outcome.id);
  if (invalidCodeAttempts !== null && invalidCodeAttempts > 0 && destinationEvents.length !== 1) return null;
  const destination = destinationEvents[0];
  if (destination && !confirmationHistoryIsCompatible(events, chain,
    invalidCodeAttempts, destination, cancellation, courierId, order.companyId)) return null;
  if (!destination && ((invalidCodeAttempts !== null && (!Number.isSafeInteger(invalidCodeAttempts)
    || invalidCodeAttempts !== 0))
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
    d.collected_at AS collectedAt, d.completed_at AS completedAt
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
    d.returned_at AS returnedAt
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
