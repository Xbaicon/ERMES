import { db, transaction } from "./database.js";
import { MAX_ORDER_WEIGHT_KG } from "./freight.js";
import { createDeliveryForEligibleOrderInTransaction } from "./delivery-creation.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function orderError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowOnly(value, fields) {
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key));
  if (unexpected.length) throw orderError(`Campos não permitidos: ${unexpected.join(", ")}.`);
}

function requireOwn(value, field) {
  if (!Object.hasOwn(value, field)) throw orderError(`O campo ${field} é obrigatório.`);
  return value[field];
}

function positiveSafeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw orderError(`O campo ${field} deve ser um inteiro positivo e seguro.`);
  }
  return value;
}

export function parseDraftOrder(body) {
  if (!isObject(body)) throw orderError("O corpo deve ser um objeto JSON de pedido.");
  allowOnly(body, ["companyId", "items"]);
  const companyId = positiveSafeInteger(requireOwn(body, "companyId"), "companyId");
  const items = parseItems(requireOwn(body, "items"));
  return { companyId, items };
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw orderError("O pedido deve conter ao menos um produto.");
  }
  const seen = new Set();
  return items.map((item) => {
    if (!isObject(item)) throw orderError("Cada item deve ser um objeto JSON.");
    allowOnly(item, ["productId", "quantity"]);
    const productId = positiveSafeInteger(requireOwn(item, "productId"), "productId");
    const quantity = positiveSafeInteger(requireOwn(item, "quantity"), "quantity");
    if (seen.has(productId)) throw orderError("Produto repetido no pedido. Ajuste a quantidade de um único item.");
    seen.add(productId);
    return { productId, quantity };
  });
}

export function parseDraftItemsUpdate(body) {
  if (!isObject(body)) throw orderError("O corpo deve ser um objeto JSON de pedido.");
  allowOnly(body, ["items"]);
  return { items: parseItems(requireOwn(body, "items")) };
}

export function parseOrderConfirmation(body) {
  if (!isObject(body)) throw orderError("O corpo deve ser um objeto JSON de confirma\u00e7\u00e3o.");
  allowOnly(body, ["version"]);
  return { version: positiveSafeInteger(requireOwn(body, "version"), "version") };
}

function parseSimulatedPayment(body) {
  if (!isObject(body)) throw orderError("O corpo deve ser um objeto JSON de pagamento.");
  allowOnly(body, []);
}

export function parseOrderId(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw orderError("Identificador de pedido inválido.");
  }
  const orderId = Number(value);
  if (!Number.isSafeInteger(orderId)) throw orderError("Identificador de pedido inválido.");
  return orderId;
}

function decimalWeight(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw orderError("O peso cadastrado do produto é inválido.", 409);
  }
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw orderError("O peso cadastrado do produto é inválido.", 409);
  const fraction = match[2] || "";
  const exponent = Number(match[3] || 0);
  const places = fraction.length - exponent;
  const digits = BigInt(match[1] + fraction);
  return places > 0
    ? { numerator: digits, places }
    : { numerator: digits * 10n ** BigInt(-places), places: 0 };
}

export function calculateDraftTotals(items) {
  let subtotal = 0n;
  let weightNumerator = 0n;
  let weightPlaces = 0;
  for (const item of items) {
    const quantity = positiveSafeInteger(item.quantity, "quantity");
    const price = item.unitPriceCents;
    if (typeof price !== "bigint" || price < 0n || price > MAX_SAFE) {
      throw orderError("O preço cadastrado do produto excede o limite seguro.", 409);
    }
    subtotal += price * BigInt(quantity);
    if (subtotal > MAX_SAFE) throw orderError("O subtotal excede o limite seguro. Reduza as quantidades.");

    const weight = decimalWeight(item.unitWeightKg);
    const places = Math.max(weightPlaces, weight.places);
    weightNumerator = weightNumerator * 10n ** BigInt(places - weightPlaces)
      + weight.numerator * BigInt(quantity) * 10n ** BigInt(places - weight.places);
    weightPlaces = places;
    if (weightNumerator > BigInt(MAX_ORDER_WEIGHT_KG) * 10n ** BigInt(weightPlaces)) {
      throw orderError("O pedido excede 12 kg. Reduza a quantidade ou remova itens.");
    }
  }
  if (weightNumerator <= 0n) throw orderError("O peso total deve ser maior que zero.");
  return {
    itemsTotalCents: Number(subtotal),
    weightKg: Number(`${weightNumerator}e-${weightPlaces}`),
  };
}

function priceSnapshot(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw orderError("O preço cadastrado do produto é inválido.", 409);
  }
  return BigInt(value);
}

function findOwnedOrder(clientId, orderId) {
  const order = db.prepare(`SELECT o.id, o.client_id AS clientId, o.company_id AS companyId,
                                   o.status, o.destination_snapshot_json AS destinationSnapshotJson,
                                   o.version, o.created_at AS createdAt, o.updated_at AS updatedAt,
                                   c.name AS companyName
                            FROM orders o
                            JOIN companies c ON c.id = o.company_id
                            WHERE o.id = ? AND o.client_id = ?`).get(orderId, clientId);
  if (!order) throw orderError("Pedido não encontrado.", 404);
  if (order.status !== "draft") throw orderError("Este pedido não está mais em estado draft.", 409);
  return order;
}

function loadStoredItems(orderId) {
  return db.prepare(`SELECT oi.product_id AS productId, p.name, oi.quantity,
                            CAST(oi.unit_price_cents AS TEXT) AS unitPriceCents,
                            oi.unit_weight_kg AS unitWeightKg
                     FROM order_items oi
                     JOIN products p ON p.id = oi.product_id
                     WHERE oi.order_id = ?
                     ORDER BY oi.id`).all(orderId).map((item) => ({
    ...item,
    unitPriceCents: priceSnapshot(item.unitPriceCents),
  }));
}

function destinationSnapshot(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw orderError("O endereço preservado do pedido é inválido.", 500);
  }
}

function mapDraftOrder(order, items) {
  const totals = calculateDraftTotals(items);
  return {
    id: order.id,
    status: order.status,
    company: { id: order.companyId, name: order.companyName },
    items: items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
      productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
    })),
    ...totals,
    destinationSnapshot: destinationSnapshot(order.destinationSnapshotJson),
  };
}

export function listDraftOrders(clientId) {
  return db.prepare(`SELECT o.id, o.company_id AS companyId, o.status,
                            o.destination_snapshot_json AS destinationSnapshotJson,
                            o.created_at AS createdAt, o.updated_at AS updatedAt,
                            c.name AS companyName
                     FROM orders o
                     JOIN companies c ON c.id = o.company_id
                     WHERE o.client_id = ? AND o.status = 'draft'
                     ORDER BY o.updated_at DESC, o.id DESC`).all(clientId).map((order) => {
    const items = loadStoredItems(order.id);
    const totals = calculateDraftTotals(items);
    return {
      id: order.id,
      status: order.status,
      company: { id: order.companyId, name: order.companyName },
      itemCount: items.length,
      ...totals,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  });
}

export function getDraftOrder(clientId, orderId) {
  const order = findOwnedOrder(clientId, orderId);
  return mapDraftOrder(order, loadStoredItems(order.id));
}

function findCompanyDraftOrder(companyId, orderId) {
  const order = db.prepare(`SELECT o.id, o.status, o.version,
                                   o.destination_snapshot_json AS destinationSnapshotJson
                            FROM orders o
                            WHERE o.id = ? AND o.company_id = ?`).get(orderId, companyId);
  if (!order) throw orderError("Pedido não encontrado.", 404);
  if (order.status !== "draft") throw orderError("Este pedido não está mais em estado draft.", 409);
  return order;
}

function mapCompanyDraftOrder(order, items) {
  const totals = calculateDraftTotals(items);
  return {
    id: order.id,
    status: order.status,
    version: order.version,
    items: items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
      productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
    })),
    ...totals,
    destinationSnapshot: destinationSnapshot(order.destinationSnapshotJson),
  };
}

export function listCompanyDraftOrders(companyId) {
  return db.prepare(`SELECT o.id, o.status, o.version
                     FROM orders o
                     WHERE o.company_id = ? AND o.status = 'draft'
                     ORDER BY o.updated_at DESC, o.id DESC`).all(companyId).map((order) => {
    const items = loadStoredItems(order.id);
    const totals = calculateDraftTotals(items);
    return {
      id: order.id,
      status: order.status,
      version: order.version,
      itemCount: items.length,
      ...totals,
    };
  });
}

export function getCompanyDraftOrder(companyId, orderId) {
  const order = findCompanyDraftOrder(companyId, orderId);
  return mapCompanyDraftOrder(order, loadStoredItems(order.id));
}

export function updateDraftOrderItems(clientId, orderId, body) {
  const input = parseDraftItemsUpdate(body);
  return transaction(() => {
    const order = findOwnedOrder(clientId, orderId);
    const storedItems = new Map(loadStoredItems(order.id).map((item) => [item.productId, item]));
    const resultingItems = input.items.map(({ productId, quantity }) => {
      const stored = storedItems.get(productId);
      if (stored) return { ...stored, quantity };

      const product = db.prepare(`SELECT id AS productId, company_id AS companyId, name,
                                         CAST(price_cents AS TEXT) AS unitPriceCents,
                                         unit_weight_kg AS unitWeightKg,
                                         is_available AS isAvailable
                                  FROM products WHERE id = ?`).get(productId);
      if (!product) throw orderError(`Produto ${productId} não encontrado.`, 404);
      if (product.companyId !== order.companyId) {
        throw orderError("O pedido não pode receber produtos de outra empresa.", 409);
      }
      if (!product.isAvailable) {
        throw orderError(`O produto ${productId} não está disponível. Remova-o da edição.`, 409);
      }
      return { ...product, quantity, unitPriceCents: priceSnapshot(product.unitPriceCents) };
    });
    const totals = calculateDraftTotals(resultingItems);
    const hasCommercialChange = resultingItems.length !== storedItems.size
      || resultingItems.some(({ productId, quantity }) => storedItems.get(productId)?.quantity !== quantity);
    if (!hasCommercialChange) return mapDraftOrder(order, resultingItems);

    const deletion = db.prepare("DELETE FROM order_items WHERE order_id = ?").run(order.id);
    if (Number(deletion.changes) !== storedItems.size) {
      throw orderError("Não foi possível substituir integralmente os itens do pedido.", 500);
    }
    const insertItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
      VALUES (?, ?, ?, ?, ?)`);
    for (const item of resultingItems) {
      const insertion = insertItem.run(order.id, item.productId, item.quantity,
        Number(item.unitPriceCents), item.unitWeightKg);
      if (Number(insertion.changes) !== 1) {
        throw orderError("Não foi possível gravar todos os itens do pedido.", 500);
      }
    }
    const update = db.prepare(`UPDATE orders
                               SET items_total_cents = ?, version = version + 1,
                                   updated_at = CURRENT_TIMESTAMP
                               WHERE id = ? AND client_id = ? AND status = 'draft'`)
      .run(totals.itemsTotalCents, order.id, clientId);
    if (Number(update.changes) !== 1) {
      throw orderError("Este pedido não está mais em estado draft.", 409);
    }

    return mapDraftOrder({ ...order, version: order.version + 1,
      updatedAt: new Date().toISOString() }, resultingItems);
  });
}

function findCompanyOrderForConfirmation(companyId, orderId) {
  const order = db.prepare(`SELECT o.id, o.status, o.version,
                                   CAST(o.items_total_cents AS TEXT) AS itemsTotalCents,
                                   o.destination_snapshot_json AS destinationSnapshotJson,
                                   o.confirmed_at AS confirmedAt
                            FROM orders o
                            WHERE o.id = ? AND o.company_id = ?`).get(orderId, companyId);
  if (!order) throw orderError("Pedido n\u00e3o encontrado.", 404);
  return order;
}

function confirmationSnapshot(order) {
  const items = loadStoredItems(order.id);
  if (!items.length) throw orderError("O pedido n\u00e3o possui itens para confirma\u00e7\u00e3o.", 409);
  let totals;
  try {
    totals = calculateDraftTotals(items);
  } catch (error) {
    if (Number(error.statusCode || 500) < 500) error.statusCode = 409;
    throw error;
  }
  if (!/^\d+$/.test(order.itemsTotalCents)
    || BigInt(order.itemsTotalCents) !== BigInt(totals.itemsTotalCents)) {
    throw orderError("Os dados comerciais do pedido est\u00e3o inconsistentes.", 409);
  }
  const snapshot = destinationSnapshot(order.destinationSnapshotJson);
  const requiredAddressFields = ["postalCode", "state", "city", "neighborhood", "street", "number"];
  if (!isObject(snapshot)
    || requiredAddressFields.some((field) => typeof snapshot[field] !== "string" || !snapshot[field].trim())) {
    throw orderError("O pedido n\u00e3o possui um destino preservado v\u00e1lido.", 409);
  }
  return { items, totals, snapshot };
}

function mapConfirmedCompanyOrder(order, confirmation) {
  return {
    id: order.id,
    status: order.status,
    version: order.version,
    confirmedAt: order.confirmedAt,
    items: confirmation.items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
      productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
    })),
    ...confirmation.totals,
    destinationSnapshot: confirmation.snapshot,
  };
}

function findOwnedOrderForPayment(clientId, orderId) {
  const order = db.prepare(`SELECT o.id, o.client_id AS clientId, o.company_id AS companyId,
                                   o.status, CAST(o.items_total_cents AS TEXT) AS itemsTotalCents,
                                   CAST(o.freight_total_cents AS TEXT) AS freightTotalCents,
                                   o.destination_snapshot_json AS destinationSnapshotJson,
                                   o.payment_status AS paymentStatus,
                                   o.payment_paid_at AS paymentPaidAt,
                                   o.confirmed_at AS confirmedAt,
                                   o.created_at AS createdAt, o.updated_at AS updatedAt,
                                   c.name AS companyName
                            FROM orders o
                            JOIN companies c ON c.id = o.company_id
                            WHERE o.id = ? AND o.client_id = ?`).get(orderId, clientId);
  if (!order) throw orderError("Pedido n\u00e3o encontrado.", 404);
  return order;
}

function validatePaymentState(order) {
  if (typeof order.confirmedAt !== "string" || !order.confirmedAt.trim()) {
    throw orderError("Os dados de confirma\u00e7\u00e3o comercial do pedido est\u00e3o inconsistentes.", 409);
  }
  if (!["pending", "paid"].includes(order.paymentStatus)) {
    throw orderError("A situa\u00e7\u00e3o de pagamento do pedido \u00e9 incompat\u00edvel.", 409);
  }
  if (order.paymentStatus === "pending" && order.paymentPaidAt !== null) {
    throw orderError("Os dados de pagamento do pedido est\u00e3o inconsistentes.", 409);
  }
  if (order.paymentStatus === "paid" && order.paymentPaidAt === null) {
    throw orderError("Os dados de pagamento do pedido est\u00e3o inconsistentes.", 409);
  }
}

function paymentSnapshot(order) {
  let confirmation;
  try {
    confirmation = confirmationSnapshot(order);
  } catch (error) {
    error.statusCode = 409;
    throw error;
  }
  if (order.freightTotalCents !== null
    && (!/^\d+$/.test(order.freightTotalCents) || BigInt(order.freightTotalCents) > MAX_SAFE)) {
    throw orderError("O valor de frete preservado no pedido \u00e9 inv\u00e1lido.", 409);
  }
  validatePaymentState(order);
  return {
    ...confirmation,
    freightTotalCents: order.freightTotalCents === null ? null : Number(order.freightTotalCents),
  };
}

function mapClientConfirmedOrder(order, snapshot, summary = false) {
  const common = {
    id: order.id,
    status: order.status,
    company: { id: order.companyId, name: order.companyName },
    paymentStatus: order.paymentStatus,
    paymentPaidAt: order.paymentPaidAt,
    confirmedAt: order.confirmedAt,
    itemsTotalCents: snapshot.totals.itemsTotalCents,
    freightTotalCents: snapshot.freightTotalCents,
  };
  if (summary) {
    return {
      ...common,
      itemCount: snapshot.items.length,
      weightKg: snapshot.totals.weightKg,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
  return {
    ...common,
    items: snapshot.items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
      productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
    })),
    weightKg: snapshot.totals.weightKg,
    destinationSnapshot: snapshot.snapshot,
  };
}

export function listClientConfirmedOrders(clientId) {
  return db.prepare(`SELECT o.id, o.client_id AS clientId, o.company_id AS companyId,
                            o.status, CAST(o.items_total_cents AS TEXT) AS itemsTotalCents,
                            CAST(o.freight_total_cents AS TEXT) AS freightTotalCents,
                            o.destination_snapshot_json AS destinationSnapshotJson,
                            o.payment_status AS paymentStatus,
                            o.payment_paid_at AS paymentPaidAt,
                            o.confirmed_at AS confirmedAt,
                            o.created_at AS createdAt, o.updated_at AS updatedAt,
                            c.name AS companyName
                     FROM orders o
                     JOIN companies c ON c.id = o.company_id
                     WHERE o.client_id = ? AND o.status = 'confirmed'
                     ORDER BY o.confirmed_at DESC, o.id DESC`).all(clientId)
    .map((order) => mapClientConfirmedOrder(order, paymentSnapshot(order), true));
}

export function getClientConfirmedOrder(clientId, orderId) {
  const order = findOwnedOrderForPayment(clientId, orderId);
  if (order.status !== "confirmed") {
    throw orderError("Este pedido n\u00e3o est\u00e1 confirmado comercialmente.", 409);
  }
  return mapClientConfirmedOrder(order, paymentSnapshot(order));
}

export function confirmSimulatedPayment(clientId, orderId, body) {
  parseSimulatedPayment(body);
  return transaction(() => {
    const order = findOwnedOrderForPayment(clientId, orderId);
    if (order.status !== "confirmed") {
      throw orderError("Este pedido n\u00e3o est\u00e1 confirmado comercialmente.", 409);
    }
    const snapshot = paymentSnapshot(order);
    if (order.paymentStatus === "paid") {
      const ensured = createDeliveryForEligibleOrderInTransaction(order.id);
      return { order: mapClientConfirmedOrder(order, snapshot), ...ensured };
    }

    const update = db.prepare(`UPDATE orders
                               SET payment_status = 'paid', payment_paid_at = CURRENT_TIMESTAMP,
                                   updated_at = CURRENT_TIMESTAMP
                               WHERE id = ? AND client_id = ? AND status = 'confirmed'
                                 AND payment_status = 'pending' AND payment_paid_at IS NULL`)
      .run(order.id, clientId);
    if (Number(update.changes) !== 1) {
      throw orderError("O pagamento do pedido foi alterado. Recarregue a situa\u00e7\u00e3o atual.", 409);
    }
    const paid = findOwnedOrderForPayment(clientId, order.id);
    const ensured = createDeliveryForEligibleOrderInTransaction(paid.id);
    return { order: mapClientConfirmedOrder(paid, paymentSnapshot(paid)), ...ensured };
  });
}

export function confirmCompanyDraftOrder(companyId, orderId, body) {
  const input = parseOrderConfirmation(body);
  return transaction(() => {
    const order = findCompanyOrderForConfirmation(companyId, orderId);
    if (order.status === "confirmed") {
      if (order.version !== input.version) {
        throw orderError("A vers\u00e3o analisada n\u00e3o corresponde \u00e0 vers\u00e3o confirmada do pedido.", 409);
      }
      return mapConfirmedCompanyOrder(order, confirmationSnapshot(order));
    }
    if (order.status !== "draft") {
      throw orderError("Este pedido n\u00e3o pode ser confirmado no estado atual.", 409);
    }
    if (order.version !== input.version) {
      throw orderError("O pedido foi alterado pelo cliente. Recarregue a vers\u00e3o atual antes de confirmar.", 409);
    }
    const confirmation = confirmationSnapshot(order);
    const update = db.prepare(`UPDATE orders
                               SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
                                   updated_at = CURRENT_TIMESTAMP
                               WHERE id = ? AND company_id = ? AND status = 'draft' AND version = ?`)
      .run(order.id, companyId, input.version);
    if (Number(update.changes) !== 1) {
      throw orderError("O pedido foi alterado. Recarregue a vers\u00e3o atual antes de confirmar.", 409);
    }
    const confirmed = findCompanyOrderForConfirmation(companyId, order.id);
    return mapConfirmedCompanyOrder(confirmed, confirmation);
  });
}

export function createDraftOrder(clientId, body) {
  const input = parseDraftOrder(body);
  return transaction(() => {
    const client = db.prepare(`SELECT order_blocked_until AS orderBlockedUntil,
                                      order_blocked_until > CURRENT_TIMESTAMP AS isBlocked
                               FROM users WHERE id = ? AND role = 'client'`).get(clientId);
    if (client?.isBlocked) {
      throw orderError(`Novos pedidos estão bloqueados até ${client.orderBlockedUntil}.`, 409);
    }
    const company = db.prepare("SELECT id, name FROM companies WHERE id = ? AND status = 'active'")
      .get(input.companyId);
    if (!company) throw orderError("Empresa não encontrada ou indisponível.", 404);

    const address = db.prepare(`SELECT postal_code AS postalCode, state, city, neighborhood,
                                       street, number, complement
                                FROM client_default_addresses WHERE client_id = ?`)
      .get(clientId);
    if (!address) throw orderError("Cadastre seu endereço padrão antes de criar o pedido.", 409);

    const products = input.items.map(({ productId, quantity }) => {
      const product = db.prepare(`SELECT id, company_id AS companyId, name,
                                        CAST(price_cents AS TEXT) AS priceCents,
                                        unit_weight_kg AS unitWeightKg,
                                        is_available AS isAvailable
                                 FROM products WHERE id = ?`).get(productId);
      if (!product) throw orderError(`Produto ${productId} não encontrado.`, 404);
      if (product.companyId !== company.id) {
        throw orderError("O carrinho contém produto de outra empresa. Esvazie-o antes de trocar de empresa.", 409);
      }
      if (!product.isAvailable) throw orderError(`O produto ${productId} não está disponível. Remova-o do carrinho.`, 409);
      return { productId, name: product.name, quantity,
        unitPriceCents: priceSnapshot(product.priceCents), unitWeightKg: product.unitWeightKg };
    });
    const totals = calculateDraftTotals(products);

    const orderId = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, items_total_cents)
      VALUES (?, ?, 'draft', ?, ?)`).run(clientId, company.id, JSON.stringify(address), totals.itemsTotalCents).lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
      VALUES (?, ?, ?, ?, ?)`);
    for (const product of products) {
      insertItem.run(orderId, product.productId, product.quantity,
        Number(product.unitPriceCents), product.unitWeightKg);
    }
    return {
      id: orderId,
      status: "draft",
      company: { id: company.id, name: company.name },
      items: products.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
        productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
      })),
      ...totals,
      destinationSnapshot: { ...address },
    };
  });
}
