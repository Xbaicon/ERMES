import { db, transaction } from "./database.js";
import { calculateDraftTotals, loadStoredItems, parseDraftItemsUpdate } from "./orders.js";
import { sealAdjustmentSnapshot, verifyAdjustmentSnapshot } from "./security.js";
import {
  adjustmentAvailableBalance, insertFinancialEntryInTransaction, recordProductUnavailableInTransaction,
} from "./finance.js";

const beforePickup = new Set(["available", "heading_to_pickup", "awaiting_pickup"]);
const openStates = new Set(["pending", "awaiting_payment"]);

function problem(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function operation(deliveryId, owner, role) {
  const row = db.prepare(`SELECT d.id, d.status, d.courier_id AS courierId, d.accepted_at AS acceptedAt,
    d.collected_at AS collectedAt, d.completed_at AS completedAt, d.cancelled_at AS cancelledAt,
    d.return_reason AS returnReason, d.return_reported_at AS returnReportedAt, d.returned_at AS returnedAt,
    o.id AS orderId, o.status AS orderStatus, o.company_id AS companyId, o.client_id AS clientId,
    o.version, o.items_total_cents AS itemsTotalCents, o.freight_total_cents AS freightTotalCents,
    o.payment_status AS paymentStatus, o.payment_paid_at AS paymentPaidAt
    FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`).get(deliveryId);
  if (!row || row[role === "company" ? "companyId" : "clientId"] !== owner) {
    throw problem("Entrega não encontrada.", 404);
  }
  return row;
}

function isBeforeFirstPickup(row) {
  const assigned = row.status !== "available";
  return !(!beforePickup.has(row.status) || row.orderStatus !== "confirmed"
    || assigned !== (row.courierId !== null) || assigned !== (row.acceptedAt !== null)
    || [row.collectedAt, row.completedAt, row.cancelledAt, row.returnReason,
      row.returnReportedAt, row.returnedAt].some((value) => value !== null)
    || db.prepare("SELECT 1 FROM delivery_attempts WHERE delivery_id = ?").get(row.id)
    || db.prepare(`SELECT 1 FROM delivery_events WHERE delivery_id = ?
      AND event_type NOT IN ('delivery_created', 'delivery_accepted', 'courier_arrived_at_pickup',
        'courier_failed_before_pickup', 'occurrence_classified', 'order_adjustment_proposed',
        'order_adjustment_accepted', 'order_adjustment_paid', 'order_adjustment_applied')`).get(row.id)
    || db.prepare(`SELECT 1 FROM delivery_occurrences WHERE delivery_id = ?
        AND (delivery_attempt_id IS NOT NULL OR type <> 'courier_failure_before_pickup')`).get(row.id));
}

function requireBeforePickup(row) {
  if (!isBeforeFirstPickup(row)) {
    throw problem("O ajuste exige operação íntegra antes da coleta com mercadoria na empresa.");
  }
}

function latest(deliveryId) {
  return db.prepare("SELECT * FROM order_adjustments WHERE delivery_id = ? ORDER BY id DESC LIMIT 1")
    .get(deliveryId);
}

export function adjustmentBlocksDelivery(deliveryId) {
  return Boolean(db.prepare(`SELECT 1 FROM order_adjustments WHERE delivery_id = ?
    AND state IN ('pending', 'awaiting_payment') AND cancelled_at IS NULL`).get(deliveryId));
}

export function requireAdjustmentUnblocked(deliveryId) {
  if (adjustmentBlocksDelivery(deliveryId)) throw problem("A entrega está bloqueada por um ajuste comercial.");
}

function composition(row) {
  const items = loadStoredItems(row.orderId).sort((a, b) => a.productId - b.productId);
  if (new Set(items.map(({ productId }) => productId)).size !== items.length) {
    throw problem("Produtos duplicados no snapshot exigem reconciliação.");
  }
  const totals = calculateDraftTotals(items, { includeExactWeight: true });
  if (totals.itemsTotalCents !== row.itemsTotalCents) throw problem("O subtotal exige reconciliação.");
  return { items, totals };
}

function serialize(items) {
  return JSON.stringify(items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
    productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
  })));
}

function audit(deliveryId, actorId, eventType, timestamp, details) {
  db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type, occurred_at, details_json)
    VALUES (?, ?, ?, ?, ?)`).run(deliveryId, actorId, eventType, timestamp, JSON.stringify(details));
}

function now() {
  return db.prepare("SELECT CURRENT_TIMESTAMP AS value").get().value;
}

function publicAdjustment(adjustment) {
  if (!adjustment) return null;
  return {
    id: adjustment.id,
    baseVersion: adjustment.base_version,
    state: adjustment.cancelled_at ? "cancelled" : adjustment.state,
    original: {
      items: JSON.parse(adjustment.original_items), subtotalCents: adjustment.original_subtotal,
      weightKg: adjustment.original_weight, freightTotalCents: adjustment.original_freight,
    },
    proposed: {
      items: JSON.parse(adjustment.proposed_items), subtotalCents: adjustment.proposed_subtotal,
      weightKg: adjustment.proposed_weight, freightTotalCents: adjustment.proposed_freight,
    },
    differenceCents: adjustment.proposed_subtotal - adjustment.original_subtotal,
    requiresPayment: adjustment.state === "awaiting_payment" && adjustment.cancelled_at === null,
    decision: adjustment.state === "pending" ? null : adjustment.state === "rejected" ? "rejected" : "accepted",
    createdAt: adjustment.created_at,
    decidedAt: adjustment.decided_at,
    appliedAt: adjustment.applied_at,
    paidAt: adjustment.paid_at,
    cancelledAt: adjustment.cancelled_at,
  };
}

export function adjustmentDetails(deliveryId) {
  return publicAdjustment(latest(deliveryId));
}

export function productUnavailability(deliveryId) {
  return db.prepare(`SELECT reason, responsibility, origin, occurred_at AS occurredAt
    FROM product_unavailability_closures WHERE delivery_id = ?`).get(deliveryId) ?? null;
}

export function adjustmentAvailability(row) {
  const canCloseUnavailable = isBeforeFirstPickup(row) && !adjustmentBlocksDelivery(row.id);
  return { canCloseUnavailable, canPropose: canCloseUnavailable && row.paymentStatus === "paid" };
}

export function getAdjustment(deliveryId, owner, role) {
  const row = operation(deliveryId, owner, role);
  const availability = role === "company" ? adjustmentAvailability(row)
    : { canPropose: false, canCloseUnavailable: false };
  return { adjustment: adjustmentDetails(deliveryId), unavailability: productUnavailability(deliveryId),
    orderVersion: row.version, currentItems: JSON.parse(serialize(loadStoredItems(row.orderId))), ...availability };
}

export function cancelOpenAdjustmentInTransaction(row, clientId) {
  if (!adjustmentBlocksDelivery(row.id)) return;
  requireBeforePickup(row);
  const adjustment = latest(row.id);
  const timestamp = now();
  db.prepare("UPDATE order_adjustments SET cancelled_at = ? WHERE id = ?").run(timestamp, adjustment.id);
  audit(row.id, clientId, "order_adjustment_cancelled", timestamp, { adjustmentId: adjustment.id });
}

function requestComposition(items) {
  return items.map(({ productId, quantity }) => ({ productId, quantity }));
}

function validatedProposedComposition(row, original, proposedItemsJson, persisted = null) {
  let items;
  try { items = JSON.parse(proposedItemsJson); } catch { throw problem("A composição proposta exige reconciliação."); }
  if (!Array.isArray(items) || items.length === 0) {
    throw problem("A composição proposta exige reconciliação.");
  }
  const originalByProduct = new Map(original.items.map((item) => [item.productId, item]));
  const product = db.prepare(`SELECT id, company_id AS companyId, name,
    CAST(price_cents AS TEXT) AS unitPriceCents, unit_weight_kg AS unitWeightKg,
    is_available AS isAvailable FROM products WHERE id = ?`);
  const seen = new Set();
  for (const item of items) {
    if (!item || Array.isArray(item) || typeof item !== "object"
      || Object.keys(item).length !== 5
      || !["productId", "name", "quantity", "unitPriceCents", "unitWeightKg"]
        .every((field) => Object.hasOwn(item, field))
      || !Number.isSafeInteger(item.productId) || item.productId <= 0
      || !Number.isSafeInteger(item.quantity) || item.quantity <= 0
      || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0
      || typeof item.unitWeightKg !== "number" || !Number.isFinite(item.unitWeightKg)
      || item.unitWeightKg <= 0 || typeof item.name !== "string" || !item.name.trim()
      || seen.has(item.productId)) throw problem("A composição proposta exige reconciliação.");
    seen.add(item.productId);
    if (!persisted) {
      const existing = originalByProduct.get(item.productId);
      const catalog = product.get(item.productId);
      const source = existing ?? catalog;
      if (!catalog || catalog.companyId !== row.companyId
        || (!existing && catalog.isAvailable !== 1)
        || BigInt(item.unitPriceCents) !== BigInt(source.unitPriceCents)
        || item.unitWeightKg !== source.unitWeightKg || item.name !== source.name) {
        throw problem("Os snapshots da proposta exigem reconciliação.");
      }
    }
  }
  const requested = requestComposition(items).sort((a, b) => a.productId - b.productId);
  if (JSON.stringify(requestComposition(original.items)) === JSON.stringify(requested)) {
    throw problem("A proposta deve alterar a composição.");
  }
  let totals;
  try {
    totals = calculateDraftTotals(items.map((item) => ({
      ...item, unitPriceCents: BigInt(item.unitPriceCents),
    })), { includeExactWeight: true });
  } catch (error) {
    if (!persisted) throw error;
    throw problem("A composição proposta excede seus limites ou exige reconciliação.");
  }
  if (row.freightTotalCents !== null && original.totals.exactWeight !== totals.exactWeight) {
    throw problem("Frete conhecido exige reconciliação: faltam distância e tempo autoritativos.");
  }
  if (persisted && (persisted.proposed_subtotal !== totals.itemsTotalCents
    || persisted.proposed_weight !== totals.weightKg
    || persisted.original_weight !== original.totals.weightKg
    || persisted.proposed_freight !== row.freightTotalCents)) {
    throw problem("Os totais da composição proposta exigem reconciliação.");
  }
  return { items, totals };
}

export function proposeAdjustment(deliveryId, companyId, actorId, body) {
  const { version, items } = body ?? {};
  if (!body || Object.keys(body).some((key) => !["version", "items"].includes(key))
    || !Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) {
    throw problem("Informe a versão comercial analisada e a composição proposta.", 400);
  }
  const requested = parseDraftItemsUpdate({ items }).items.sort((a, b) => a.productId - b.productId);
  return transaction(() => {
    const row = operation(deliveryId, companyId, "company");
    const previous = latest(deliveryId);
    if (previous?.base_version === version
      && JSON.stringify(requestComposition(JSON.parse(previous.proposed_items))) === JSON.stringify(requested)) {
      return publicAdjustment(previous);
    }
    requireBeforePickup(row);
    requireAdjustmentUnblocked(deliveryId);
    if (row.version !== version) throw problem("A versão comercial foi alterada.");
    if (row.paymentStatus !== "paid") throw problem("O ajuste exige pagamento original confirmado.");
    adjustmentAvailableBalance(db, row);
    const original = composition(row);
    const existing = new Map(original.items.map((item) => [item.productId, item]));
    const product = db.prepare(`SELECT id AS productId, name, CAST(price_cents AS TEXT) AS unitPriceCents,
      unit_weight_kg AS unitWeightKg FROM products WHERE id = ? AND company_id = ? AND is_available = 1`);
    const proposed = requested.map(({ productId, quantity }) => {
      const preserved = existing.get(productId);
      if (preserved) return { ...preserved, quantity };
      const introduced = product.get(productId, companyId);
      if (!introduced) throw problem("Produto indisponível para esta empresa.", 400);
      return { ...introduced, quantity, unitPriceCents: BigInt(introduced.unitPriceCents) };
    });
    if (JSON.stringify(requestComposition(original.items)) === JSON.stringify(requested)) {
      throw problem("A proposta deve alterar a composição.", 400);
    }
    const proposedItemsJson = serialize(proposed);
    const { totals } = validatedProposedComposition(row, original, proposedItemsJson);
    const timestamp = now();
    const { lastInsertRowid } = db.prepare(`INSERT INTO order_adjustments
      (order_id, delivery_id, company_id, proposed_by, base_version, original_items, proposed_items,
       original_subtotal, proposed_subtotal, original_weight, proposed_weight, original_freight,
       proposed_freight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.orderId, deliveryId, companyId, actorId, version, serialize(original.items), proposedItemsJson,
        row.itemsTotalCents, totals.itemsTotalCents, original.totals.weightKg, totals.weightKg,
        row.freightTotalCents, row.freightTotalCents, timestamp);
    const adjustment = db.prepare("SELECT * FROM order_adjustments WHERE id = ?")
      .get(Number(lastInsertRowid));
    db.prepare(`INSERT INTO order_adjustment_validations
      (adjustment_id, order_id, company_id, proposed_items, proposed_subtotal, proposed_weight, seal)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(Number(lastInsertRowid), row.orderId, companyId, proposedItemsJson,
        totals.itemsTotalCents, totals.weightKg, sealAdjustmentSnapshot(adjustment));
    audit(deliveryId, actorId, "order_adjustment_proposed", timestamp, { adjustmentId: Number(lastInsertRowid) });
    return adjustmentDetails(deliveryId);
  });
}

function verifyVersion(row, adjustment) {
  const stored = composition(row);
  const commercialSnapshot = (items) => items.map(({ name, ...snapshot }) => snapshot);
  if (row.version !== adjustment.base_version || row.freightTotalCents !== adjustment.original_freight
    || row.itemsTotalCents !== adjustment.original_subtotal
    || JSON.stringify(commercialSnapshot(JSON.parse(serialize(stored.items))))
      !== JSON.stringify(commercialSnapshot(JSON.parse(adjustment.original_items)))) {
    throw problem("A versão ou composição comercial exige reconciliação.");
  }
  return stored;
}

function close(row, actorId, timestamp, adjustmentId = null) {
  const origin = adjustmentId === null ? "company_no_adjustment" : "client_rejected";
  db.prepare(`UPDATE deliveries SET status = 'cancelled', courier_id = NULL, cancelled_at = ?
    WHERE id = ?`).run(timestamp, row.id);
  db.prepare(`INSERT INTO product_unavailability_closures
    (delivery_id, actor_id, adjustment_id, origin, occurred_at) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, actorId, adjustmentId, origin, timestamp);
  audit(row.id, actorId, "product_unavailable", timestamp, {
    reason: "PRODUTO_INDISPONIVEL", responsibility: "EMPRESA", origin, adjustmentId,
  });
  recordProductUnavailableInTransaction(db, row, timestamp);
}

export function closeUnavailableDelivery(deliveryId, companyId, actorId, version) {
  return transaction(() => {
    const row = operation(deliveryId, companyId, "company");
    const existing = productUnavailability(deliveryId);
    if (existing?.origin === "company_no_adjustment") throw problem("Indisponibilidade já registrada.");
    requireBeforePickup(row);
    requireAdjustmentUnblocked(deliveryId);
    if ((version !== undefined && version !== row.version)
      || (latest(deliveryId)?.state === "applied" && version === undefined)) {
      throw problem("A versão comercial foi alterada. Recarregue a entrega.");
    }
    close(row, actorId, now());
  });
}

function validateAdditionalPayment(row, adjustment) {
  const difference = adjustment.proposed_subtotal - adjustment.original_subtotal;
  try {
    return adjustmentAvailableBalance(db, row, { additionalPayment: difference });
  } catch (error) {
    if (error.code === "FINANCIAL_RECONCILIATION_REQUIRED" || error instanceof RangeError) {
      throw problem("O pagamento adicional exige reconciliação financeira.");
    }
    throw error;
  }
}

function apply(row, adjustment, proposedItems, actorId, timestamp, paying) {
  const difference = adjustment.proposed_subtotal - adjustment.original_subtotal;
  const balance = paying ? validateAdditionalPayment(row, adjustment) : adjustmentAvailableBalance(db, row);
  if (difference < 0 && balance.products < -difference) {
    throw problem("O saldo pago é insuficiente para o reembolso do ajuste.");
  }
  db.prepare("DELETE FROM order_items WHERE order_id = ?").run(row.orderId);
  const insert = db.prepare(`INSERT INTO order_items
    (order_id, product_id, quantity, unit_price_cents, unit_weight_kg) VALUES (?, ?, ?, ?, ?)`);
  for (const item of proposedItems) {
    insert.run(row.orderId, item.productId, item.quantity, item.unitPriceCents, item.unitWeightKg);
  }
  const updated = db.prepare(`UPDATE orders SET items_total_cents = ?, freight_total_cents = ?,
    version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
    .run(adjustment.proposed_subtotal, adjustment.proposed_freight, timestamp, row.orderId, adjustment.base_version);
  if (updated.changes !== 1) throw problem("A versão comercial foi alterada.");
  db.prepare(`UPDATE order_adjustments SET state = 'applied', decided_by = ?,
    decided_at = COALESCE(decided_at, ?), applied_at = ?, paid_at = ? WHERE id = ?`)
    .run(actorId, timestamp, timestamp, paying ? timestamp : null, adjustment.id);
  if (paying) audit(row.id, actorId, "order_adjustment_paid", timestamp, { adjustmentId: adjustment.id });
  audit(row.id, actorId, "order_adjustment_applied", timestamp, { adjustmentId: adjustment.id });
  if (difference !== 0) {
    const entryType = difference > 0 ? "payment" : "refund";
    insertFinancialEntryInTransaction(db, {
      orderId: row.orderId, deliveryId: row.id, entryType, component: "products",
      partyType: "client", partyId: actorId, amountCents: Math.abs(difference),
      reason: "order_adjustment", occurredAt: timestamp,
      idempotencyKey: `order-adjustment:${adjustment.id}:${entryType}-products`,
    });
  }
  adjustmentAvailableBalance(db, { ...row, itemsTotalCents: adjustment.proposed_subtotal });
}

export function decideAdjustment(deliveryId, adjustmentId, clientId, action) {
  return transaction(() => {
    const row = operation(deliveryId, clientId, "client");
    const adjustment = db.prepare("SELECT * FROM order_adjustments WHERE delivery_id = ? AND id = ?")
      .get(deliveryId, adjustmentId);
    if (!adjustment) throw problem("Proposta não encontrada.", 404);
    if (adjustment.cancelled_at !== null || (row.status === "cancelled" && db.prepare(`SELECT 1
      FROM delivery_events WHERE delivery_id = ? AND event_type = 'client_cancelled_before_pickup'`).get(deliveryId))) {
      throw problem("O Pedido foi cancelado voluntariamente.");
    }
    if ((action === "accept" && ["awaiting_payment", "applied"].includes(adjustment.state))
      || (action === "reject" && adjustment.state === "rejected")
      || (action === "pay" && adjustment.state === "applied" && adjustment.paid_at !== null)) {
      return publicAdjustment(adjustment);
    }
    if (!openStates.has(adjustment.state)
      || (action === "pay" ? adjustment.state !== "awaiting_payment" : adjustment.state !== "pending")) {
      throw problem("A proposta já foi decidida ou a ação não é compatível.");
    }
    requireBeforePickup(row);
    const original = verifyVersion(row, adjustment);
    const validation = action === "reject" ? null : db.prepare(`SELECT seal FROM order_adjustment_validations
      WHERE adjustment_id = ? AND order_id = ? AND company_id = ?
        AND proposed_items = ? AND proposed_subtotal = ? AND proposed_weight = ?`)
      .get(adjustmentId, row.orderId, row.companyId, adjustment.proposed_items,
        adjustment.proposed_subtotal, adjustment.proposed_weight);
    if (action !== "reject" && (!validation || !verifyAdjustmentSnapshot(adjustment, validation.seal))) {
      throw problem("A proposta não possui validação íntegra de seus snapshots.");
    }
    const proposed = action === "reject" ? null
      : validatedProposedComposition(row, original, adjustment.proposed_items, adjustment);
    const timestamp = now();
    const details = { adjustmentId };
    if (action === "reject") {
      db.prepare(`UPDATE order_adjustments SET state = 'rejected', decided_by = ?, decided_at = ?
        WHERE id = ?`).run(clientId, timestamp, adjustmentId);
      audit(deliveryId, clientId, "order_adjustment_rejected", timestamp, details);
      close(row, clientId, timestamp, adjustmentId);
    } else if (action === "accept") {
      const requiresPayment = adjustment.proposed_subtotal > adjustment.original_subtotal;
      if (requiresPayment) validateAdditionalPayment(row, adjustment);
      audit(deliveryId, clientId, "order_adjustment_accepted", timestamp, details);
      if (requiresPayment) {
        db.prepare(`UPDATE order_adjustments SET state = 'awaiting_payment', decided_by = ?, decided_at = ?
          WHERE id = ?`).run(clientId, timestamp, adjustmentId);
      } else {
        apply(row, adjustment, proposed.items, clientId, timestamp, false);
      }
    } else {
      apply(row, adjustment, proposed.items, clientId, timestamp, true);
    }
    return adjustmentDetails(deliveryId);
  });
}
