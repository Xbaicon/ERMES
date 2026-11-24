import { AUTHORIZED_ADJUSTMENT_ENTRY, PRODUCT_UNAVAILABLE_EVIDENCE } from "./order-adjustment-schema.js";
import { splitNormalFreight } from "./freight.js";
import { clientAddressEvidence } from "./client-address-evidence.js";
import { systemAddressEvidence } from "./system-address-evidence.js";

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
  "confirmation_failed",
]);
const RECIPIENT_TERMINAL_REASONS = new Set(["recipient_absent", "recipient_refused", "address_problem"]);
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

function adjustmentHistory(database, orderId) {
  return database.prepare(`SELECT id, base_version, original_subtotal, proposed_subtotal,
      original_freight, proposed_freight, delivery_id
    FROM order_adjustments
    WHERE order_id = ? AND state = 'applied' ORDER BY base_version`).all(orderId);
}

function matchesAdjustmentSnapshot(database, delivery, grossProducts) {
  if (grossProducts === undefined) return false;
  const adjustmentRefunds = database.prepare(`SELECT amount_cents AS amount FROM financial_entries
    WHERE order_id = ? AND entry_type = 'refund' AND reason = 'order_adjustment'`).all(delivery.orderId);
  return grossProducts - sumFinancialAmounts(adjustmentRefunds.map(({ amount }) => amount))
    === delivery.itemsTotalCents;
}

function paidComponents(database, orderId, clientId) {
  const order = database.prepare(`SELECT o.items_total_cents AS subtotal, o.freight_total_cents AS freight, o.version,
    d.id AS deliveryId FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
    WHERE o.id = ? AND o.client_id = ?`).get(orderId, clientId);
  const adjustments = adjustmentHistory(database, orderId);
  const entries = database.prepare(`SELECT f.*,
    EXISTS (${AUTHORIZED_ADJUSTMENT_ENTRY.replaceAll("ENTRY.", "f.")}) AS authorized
    FROM financial_entries f WHERE f.order_id = ? OR f.delivery_id = ? ORDER BY f.id`)
    .all(orderId, order?.deliveryId ?? null);
  const original = new Map();
  const additional = new Map();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amount_cents) || entry.amount_cents < 0) {
      throw financialError("Valor financeiro persistido exige reconciliação.");
    }
    if (entry.order_id !== orderId || (entry.delivery_id !== null && entry.delivery_id !== order?.deliveryId)) {
      throw financialError("Lançamento financeiro com vínculo incompatível.");
    }
    if (entry.entry_type === "distribution") continue;
    if (!["payment", "refund"].includes(entry.entry_type) || !["products", "freight"].includes(entry.component)
      || entry.party_type !== "client" || entry.party_user_id !== clientId || entry.party_company_id !== null) {
      throw financialError("Lançamento financeiro com vínculo incompatível.");
    }
    if (entry.reason === "order_adjustment" || entry.idempotency_key.startsWith("order-adjustment:")) {
      if (!entry.authorized) throw financialError("Lançamento de ajuste exige reconciliação.");
      additional.set(entry.idempotency_key, entry.amount_cents);
    } else if (entry.entry_type === "payment") {
      if (original.has(entry.component) || entry.reason !== "simulated_payment") {
        throw financialError(`O Pedido ${orderId} possui pagamentos duplicados ou incompatíveis.`);
      }
      if (adjustments.length && entry.idempotency_key !== `payment:${orderId}:${entry.component}`) {
        throw financialError("O pagamento original do Pedido ajustado exige reconciliação.");
      }
      original.set(entry.component, entry.amount_cents);
    }
  }
  const payments = new Map(original);
  let subtotal = original.get("products");
  let priorVersion = null;
  for (const adjustment of adjustments) {
    if (adjustment.original_subtotal !== subtotal || adjustment.base_version >= order.version
      || adjustment.delivery_id !== order.deliveryId || adjustment.original_freight !== order.freight
      || adjustment.proposed_freight !== order.freight
      || (priorVersion !== null && adjustment.base_version !== priorVersion + 1)) {
      throw financialError("A sequência comercial dos ajustes exige reconciliação.");
    }
    const delta = adjustment.proposed_subtotal - adjustment.original_subtotal;
    if (delta !== 0) {
      const type = delta > 0 ? "payment" : "refund";
      const key = `order-adjustment:${adjustment.id}:${type}-products`;
      if (additional.get(key) !== Math.abs(delta)) throw financialError("Ajuste sem lançamento compatível.");
      additional.delete(key);
      if (delta > 0) {
        const gross = payments.get("products") + delta;
        if (!Number.isSafeInteger(gross)) throw financialError("O total pago excede o limite inteiro seguro.");
        payments.set("products", gross);
      }
    }
    subtotal = adjustment.proposed_subtotal;
    priorVersion = adjustment.base_version;
  }
  if (additional.size || (adjustments.length && (subtotal !== order.subtotal || priorVersion + 1 !== order.version))) {
    throw financialError("O ledger de ajustes diverge da composição vigente.");
  }
  return payments;
}

export function adjustmentAvailableBalance(database, delivery, { additionalPayment } = {}) {
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const entries = entriesForOrder(database, delivery.orderId);
  if (entries.some(({ entryType }) => entryType === "distribution")) {
    throw financialError("Distribuição incompatível com ajuste pré-coleta.");
  }
  if (delivery.paymentStatus === "pending") {
    if (entries.length || delivery.paymentPaidAt !== null) throw financialError("Pagamento pendente com lançamentos.");
  } else {
    if (!isCanonicalTimestamp(delivery.paymentPaidAt)
      || !matchesAdjustmentSnapshot(database, delivery, payments.get("products"))) {
      throw financialError("Pagamento dos produtos diverge da composição comercial.");
    }
    assertFreightPaymentMatchesSnapshot(delivery, payments.get("freight"));
    if (delivery.freightTotalCents !== null && !payments.has("freight")) {
      throw financialError("Não há evidência de pagamento do frete conhecido.");
    }
  }
  const grossPaid = sumFinancialAmounts([...payments.values()], "O total pago");
  if (additionalPayment !== undefined && (delivery.paymentStatus !== "paid"
    || !Number.isSafeInteger(additionalPayment) || additionalPayment <= 0
    || additionalPayment > Number.MAX_SAFE_INTEGER - grossPaid)) {
    throw Object.assign(new Error("A diferença excede o limite seguro do total bruto pago."), { statusCode: 409 });
  }
  return Object.fromEntries(["products", "freight"].map((component) => {
    const refunded = sumFinancialAmounts(entries.filter((entry) => entry.entryType === "refund"
      && entry.component === component).map(({ amountCents }) => amountCents));
    const paid = payments.get(component) ?? 0;
    if (refunded > paid) throw financialError("Reembolso superior ao componente efetivamente pago.");
    return [component, paid - refunded];
  }));
}

function assertFreightPaymentMatchesSnapshot(delivery, freightPayment) {
  if (freightPayment === undefined) return;
  if (delivery.freightTotalCents === null
    || requireCents(delivery.freightTotalCents, "O frete preservado") !== freightPayment) {
    throw financialError(`O pagamento de frete do Pedido ${delivery.orderId} diverge do snapshot preservado.`);
  }
}

function paymentEntries(order, deliveryId) {
  const base = {
    orderId: order.id,
    deliveryId,
    entryType: FINANCIAL_ENTRY_TYPES.PAYMENT,
    partyType: FINANCIAL_PARTIES.CLIENT,
    partyId: order.clientId,
    reason: "simulated_payment",
    occurredAt: order.paymentPaidAt,
  };
  const entries = [{
    ...base,
    component: FINANCIAL_COMPONENTS.PRODUCTS,
    amountCents: requireCents(order.itemsTotalCents, "O subtotal dos produtos"),
    idempotencyKey: `payment:${order.id}:products`,
  }];
  if (order.freightTotalCents !== null) {
    entries.push({
      ...base,
      component: FINANCIAL_COMPONENTS.FREIGHT,
      amountCents: requireCents(order.freightTotalCents, "O frete"),
      idempotencyKey: `payment:${order.id}:freight`,
    });
  }
  return entries;
}

export function recordPaymentInTransaction(database, order, deliveryId = null) {
  const original = adjustmentHistory(database, order.id)[0];
  if (original) {
    paidComponents(database, order.id, order.clientId);
    return;
  }
  for (const entry of paymentEntries(order, deliveryId)) {
    insertFinancialEntryInTransaction(database, entry);
  }
}

export function recordNormalCompletionInTransaction(database, delivery, occurredAt = null) {
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const paidProducts = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
  if (adjustmentHistory(database, delivery.orderId).length
    && !matchesAdjustmentSnapshot(database, delivery, paidProducts)) {
    throw financialError("O pagamento de produtos ajustados exige reconciliação.");
  }
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
        'occurrence_classified', 'client_cancelled_before_pickup', 'order_adjustment_proposed',
        'order_adjustment_accepted', 'order_adjustment_paid', 'order_adjustment_applied',
        'order_adjustment_cancelled'))
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
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
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
    if (entry.entryType === "refund" && incompatible.has(entry.reason)) {
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
    || !matchesAdjustmentSnapshot(database, delivery, payments.get("products"))
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
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
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
    if (entry.entryType === "refund" && incompatibleRefundReasons.has(entry.reason)) {
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
      || !matchesAdjustmentSnapshot(database, delivery, payments.get("products"))
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
  const key = `delivery:${delivery.id}:client-cancelled:refund-products`;
  const prior = database.prepare(`SELECT amount_cents AS amount FROM financial_entries
    WHERE order_id = ? AND component = 'products' AND entry_type = 'refund' AND idempotency_key <> ?`)
    .all(delivery.orderId, key);
  const remaining = paidProducts - sumFinancialAmounts(prior.map(({ amount }) => amount));
  if (remaining < 0) throw financialError("Reembolso superior ao componente efetivamente pago.");
  insertRefund(database, delivery, base, FINANCIAL_COMPONENTS.PRODUCTS, remaining, key);

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
  if (reason === "address_problem" && !clientAddressEvidence(database, delivery.id, "closed")) {
    throw financialError("O endereço atribuído ao cliente exige reconciliação operacional.");
  }
  const courierId = recipientTerminalFailureEvidence(database, delivery, attemptId, reason);
  if (delivery.paymentStatus !== "paid" || !isCanonicalTimestamp(delivery.paymentPaidAt)) {
    throw financialError("O pagamento exige reconciliação financeira.");
  }
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  const paidProducts = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
  if (!matchesAdjustmentSnapshot(database, delivery, paidProducts)) {
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

export function recordClientAddressFailureInTransaction(database, delivery) {
  const evidence = clientAddressEvidence(database, delivery.id, "closed");
  if (!evidence) throw financialError("O endereço atribuído ao cliente exige reconciliação.");
  recordRecipientTerminalFailureInTransaction(database, delivery, evidence.attemptId, "address_problem");
}

function productUnavailableRefundKey(deliveryId, component) {
  return `delivery:${deliveryId}:product-unavailable:refund-${component}`;
}

export function recordProductUnavailableInTransaction(database, delivery, occurredAt = null) {
  if (database.prepare(`SELECT ${PRODUCT_UNAVAILABLE_EVIDENCE} AS present`).get(delivery.id).present) {
    const remaining = adjustmentAvailableBalance(database, delivery);
    const base = entryBase(delivery, "product_unavailable", occurredAt);
    for (const [component, amount] of Object.entries(remaining)) {
      insertRefund(database, delivery, base, component, amount,
        productUnavailableRefundKey(delivery.id, component));
    }
    return;
  }
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  if (!payments.size) {
    throw financialError(`O Pedido ${delivery.orderId} não possui evidência de valores efetivamente pagos.`);
  }
  const base = entryBase(delivery, "product_unavailable", occurredAt);
  for (const [component, amountCents] of payments) {
    insertRefund(database, delivery, base, component, amountCents,
      productUnavailableRefundKey(delivery.id, component));
  }
}

export function recordPersistentSystemAddressFailureInTransaction(database, delivery, resolutionId) {
  const evidence = systemAddressEvidence(database, delivery.id, "persistent");
  if (!evidence || evidence.resolution.id !== resolutionId) {
    throw financialError("O erro persistente de endereço exige evidência operacional íntegra.");
  }
  if (delivery.paymentStatus !== "paid" || !isCanonicalTimestamp(delivery.paymentPaidAt)) {
    throw financialError("O pagamento exige reconciliação financeira.");
  }
  const entries = database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
      entry_type AS entryType, component, party_type AS partyType,
      party_user_id AS partyUserId, party_company_id AS partyCompanyId,
      amount_cents AS amountCents, reason, idempotency_key AS idempotencyKey
    FROM financial_entries WHERE order_id = ? ORDER BY id`).all(delivery.orderId);
  if (entries.some((entry) => entry.entryType === "distribution"
    && entry.deliveryId === delivery.id)) {
    throw financialError("A Entrega possui distribuição incompatível com o erro persistente do ERMES.");
  }
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
  if (!matchesAdjustmentSnapshot(database, delivery, payments.get("products"))
    || (delivery.freightTotalCents === null
      ? payments.has("freight") : payments.get("freight") !== delivery.freightTotalCents)) {
    throw financialError("Os pagamentos divergem dos snapshots do Pedido.");
  }
  const base = entryBase(delivery, "system_address_persistent", evidence.resolution.resolved_at);
  for (const component of ["products", "freight"]) {
    const paid = payments.get(component) ?? 0;
    const key = `delivery:${delivery.id}:system-address-persistent:refund-${component}`;
    const refunds = entries.filter((entry) => entry.entryType === "refund"
      && entry.component === component);
    const own = refunds.find((entry) => entry.idempotencyKey === key);
    const refundedByOthers = sumFinancialAmounts(refunds
      .filter((entry) => entry.idempotencyKey !== key).map((entry) => entry.amountCents));
    if (refundedByOthers > paid) {
      throw financialError(`O Pedido ${delivery.orderId} possui reembolso excessivo de ${component}.`);
    }
    const amountCents = paid - refundedByOthers;
    const expected = {
      ...base, entryType: FINANCIAL_ENTRY_TYPES.REFUND, component,
      partyType: FINANCIAL_PARTIES.CLIENT, partyId: delivery.clientId,
      amountCents, idempotencyKey: key,
    };
    if (own) {
      if (amountCents === 0) throw financialError("Chave de reembolso existente sem saldo compatível.");
      assertSameSemanticEntry(findEntryByIdempotencyKey(database, key), normalizeEntry(expected));
    } else if (amountCents > 0) {
      insertFinancialEntryInTransaction(database, expected);
    }
  }
}

const CONFIRMATION_FAILURE_RESPONSIBILITIES = new Set(["CLIENTE", "MOTOBOY", "SISTEMA", "INDEFINIDO"]);
const FINAL_DISTRIBUTION_REASONS = new Set([
  "confirmation_failed", "delivery_completed", "recipient_absent", "recipient_refused",
  "client_cancelled_after_pickup", "system_address_persistent",
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
          AND (conflict.type IN ('recipient_absent', 'recipient_refused')
            OR (conflict.type = 'address_problem' AND NOT (
              conflict.responsibility = 'SISTEMA'
              AND EXISTS (SELECT 1 FROM users address_classifier
                WHERE address_classifier.id = conflict.classified_by_user_id
                  AND address_classifier.role = 'company'
                  AND address_classifier.company_id = o.company_id)))))
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
  const payments = paidComponents(database, delivery.orderId, delivery.clientId);
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

  }
  if (!matchesAdjustmentSnapshot(database, delivery, payments.get("products"))
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
  if (clientId !== null) paidComponents(database, orderId, clientId);
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
  return Boolean(database.prepare(`SELECT ${PRODUCT_UNAVAILABLE_EVIDENCE} AS present`).get(delivery.id).present)
    || candidates.some(({ occurredAt, cancelledAt }) => sameTimestamp(occurredAt, cancelledAt));
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
  const persistentSystemAddress = delivery.returnReason === "address_problem"
    && delivery.status === "returned" && systemAddressEvidence(database, delivery.id, "persistent");
  if (persistentSystemAddress) {
    const payments = paidComponents(database, delivery.orderId, delivery.clientId);
    const paidProductsCents = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
    const paidFreightCents = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
    if (!matchesAdjustmentSnapshot(database, delivery, paidProductsCents)
      || (delivery.freightTotalCents === null
        ? paidFreightCents !== undefined : paidFreightCents !== delivery.freightTotalCents)) {
      throw financialError("Os pagamentos do erro persistente do ERMES exigem reconciliação.");
    }
    for (const [component, paid] of [
      [FINANCIAL_COMPONENTS.PRODUCTS, paidProductsCents],
      [FINANCIAL_COMPONENTS.FREIGHT, paidFreightCents],
    ]) {
      const refunded = sumFinancialAmounts(entries.filter((entry) =>
        entry.entryType === FINANCIAL_ENTRY_TYPES.REFUND && entry.component === component)
        .map((entry) => entry.amountCents));
      if (refunded !== (paid ?? 0)) {
        throw financialError(`O reembolso de ${component} do erro persistente exige reconciliação.`);
      }
    }
    if (entries.some((entry) => entry.deliveryId === delivery.id
      && entry.entryType === FINANCIAL_ENTRY_TYPES.DISTRIBUTION)) {
      throw financialError("O erro persistente do ERMES não admite distribuição.");
    }
    if (paidFreightCents === undefined) pending.push("freight_amount_unavailable");
  } else if (RECIPIENT_TERMINAL_REASONS.has(delivery.returnReason)
    && delivery.status === "returned") {
    if (delivery.returnReason === "address_problem"
      && !clientAddressEvidence(database, delivery.id, "closed")) {
      throw financialError("O histórico de endereço atribuído ao cliente exige reconciliação.");
    }
    const payments = paidComponents(database, delivery.orderId, delivery.clientId);
    const paidProductsCents = payments.get(FINANCIAL_COMPONENTS.PRODUCTS);
    const paidFreightCents = payments.get(FINANCIAL_COMPONENTS.FREIGHT);
    const refundedProductsCents = sumFinancialAmounts(entries.filter((entry) =>
      entry.entryType === FINANCIAL_ENTRY_TYPES.REFUND
        && entry.component === FINANCIAL_COMPONENTS.PRODUCTS).map((entry) => entry.amountCents));
    if (paidProductsCents === undefined || !matchesAdjustmentSnapshot(database, delivery, paidProductsCents)
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
  if (database.prepare(`SELECT ${PRODUCT_UNAVAILABLE_EVIDENCE} AS present`).get(delivery.id).present) {
    const remaining = adjustmentAvailableBalance(database, delivery);
    if (remaining.products !== 0 || remaining.freight !== 0) {
      throw financialError("O reembolso por indisponibilidade exige reconciliação.");
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
  const paidProducts = sumFinancialAmounts(payments.filter(({ component }) => component === "products")
    .map(({ amountCents }) => amountCents));
  const paidFreight = payments.find((entry) => entry.component === FINANCIAL_COMPONENTS.FREIGHT);
  const refund = orderRefundSummary(database, delivery.orderId, delivery.clientId);
  return {
    paymentStatus: delivery.paymentStatus,
    refundStatus: refund.refundStatus,
    paidAt: delivery.paymentPaidAt,
    paidItemsCents: payments.some(({ component }) => component === "products") ? paidProducts : null,
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
    || outcome.completedAt !== null || outcome.returnReportedAt !== null || outcome.returnedAt !== null
    || !validTimestamp(outcome.cancelledAt)
    || database.prepare("SELECT 1 FROM delivery_attempts WHERE delivery_id = ?").get(outcome.id)) return null;
  const events = deliveryEvents(database, outcome.id);
  const unavailable = singleEvent(events, "product_unavailable");
  if (!companyEvent(unavailable, order.companyId)
    || events.at(-1)?.id !== unavailable.id
    || events.some(({ eventType }) => !["delivery_created", "delivery_accepted", "courier_arrived_at_pickup",
      "courier_failed_before_pickup", "occurrence_classified", "product_unavailable"].includes(eventType))
    || !chronological([order.createdEventAt, unavailable.occurredAt])
    || !sameTimestamp(outcome.cancelledAt, unavailable.occurredAt)) return null;
  return unavailable;
}

function legacyProductUnavailableLedgerMatches(database, order, outcome) {
  if ((order.freightTotalCents ?? 0) > Number.MAX_SAFE_INTEGER - order.itemsTotalCents) return false;
  const payments = paymentEntries(order, outcome.id);
  const refunds = payments.filter(({ amountCents }) => amountCents > 0).map((payment) => ({
    ...payment, entryType: FINANCIAL_ENTRY_TYPES.REFUND, reason: "product_unavailable",
    idempotencyKey: productUnavailableRefundKey(outcome.id, payment.component),
  }));
  const expected = new Map([...payments, ...refunds].map((entry) => [entry.idempotencyKey, normalizeEntry(entry)]));
  const keys = Array.from(expected.keys());
  const persisted = database.prepare(`SELECT order_id AS orderId, delivery_id AS deliveryId,
    entry_type AS entryType, component, party_type AS partyType, party_user_id AS partyUserId,
    party_company_id AS partyCompanyId,
    CASE WHEN typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
      THEN amount_cents END AS amountCents,
    reason, idempotency_key AS idempotencyKey
    FROM financial_entries WHERE order_id = ? OR delivery_id = ?
      OR idempotency_key IN (${keys.map(() => "?").join(", ")})`).all(order.id, outcome.id, ...keys);
  const recordedPayments = new Set(persisted.filter(({ entryType }) => entryType === FINANCIAL_ENTRY_TYPES.PAYMENT)
    .map(({ component }) => component));
  return persisted.every((entry) => {
    const planned = expected.get(entry.idempotencyKey);
    return planned && semanticEntryFields.every((field) => entry[field] === planned[field])
      && (entry.entryType !== FINANCIAL_ENTRY_TYPES.REFUND || recordedPayments.has(entry.component));
  });
}

export function backfillFinancialEntries(database) {
  const eligibleOrders = new Map();
  const candidates = database.prepare(`SELECT id FROM orders
    WHERE payment_status = 'paid' AND payment_paid_at IS NOT NULL`).all();
  const legacyUnavailable = database.prepare(`SELECT d.id, d.courier_id AS courierId,
    d.collected_at AS collectedAt, d.completed_at AS completedAt, d.cancelled_at AS cancelledAt,
    d.return_reason AS returnReason, d.return_reported_at AS returnReportedAt, d.returned_at AS returnedAt
    FROM deliveries d WHERE d.id = ? AND d.status = 'cancelled' AND (
      EXISTS (SELECT 1 FROM delivery_events e WHERE e.delivery_id = d.id AND e.event_type = 'product_unavailable')
      OR EXISTS (SELECT 1 FROM financial_entries f WHERE (f.order_id = d.order_id OR f.delivery_id = d.id)
        AND f.reason = 'product_unavailable'))`);
  for (const { id } of candidates) {
    if (adjustmentHistory(database, id).length) continue;
    const order = paidOrderEvidence(database, id);
    if (!order) continue;
    // Esses encerramentos já têm uma decisão financeira própria, fora do backfill legado.
    if (database.prepare(`SELECT ${PRODUCT_UNAVAILABLE_EVIDENCE} OR EXISTS (
      SELECT 1 FROM deliveries d JOIN delivery_events e ON e.delivery_id = d.id
      WHERE d.id = ? AND (d.status = 'cancelled' AND e.event_type IN (
        'client_cancelled_before_pickup', 'client_cancelled_after_external_obstruction')
        OR d.status = 'returned' AND d.return_reason = e.event_type
          AND e.event_type IN ('recipient_absent', 'recipient_refused', 'address_problem', 'confirmation_failed'))
      ) AS terminal`).get(order.deliveryId, order.deliveryId).terminal) continue;
    const unavailable = legacyUnavailable.get(order.deliveryId);
    if (unavailable) {
      const evidence = productUnavailableEvidence(database, unavailable, order);
      if (!evidence || !legacyProductUnavailableLedgerMatches(database, order, unavailable)) continue;
      recordPaymentInTransaction(database, order, unavailable.id);
      recordProductUnavailableInTransaction(database, {
        id: unavailable.id, orderId: order.id, clientId: order.clientId,
      }, evidence.occurredAt);
      continue;
    }
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
}
