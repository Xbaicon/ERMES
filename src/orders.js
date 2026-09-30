import { db, transaction } from "./database.js";
import { MAX_ORDER_WEIGHT_KG } from "./freight.js";

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
                                   o.created_at AS createdAt, o.updated_at AS updatedAt,
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
  const order = db.prepare(`SELECT o.id, o.status,
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
    items: items.map(({ productId, name, quantity, unitPriceCents, unitWeightKg }) => ({
      productId, name, quantity, unitPriceCents: Number(unitPriceCents), unitWeightKg,
    })),
    ...totals,
    destinationSnapshot: destinationSnapshot(order.destinationSnapshotJson),
  };
}

export function listCompanyDraftOrders(companyId) {
  return db.prepare(`SELECT o.id, o.status
                     FROM orders o
                     WHERE o.company_id = ? AND o.status = 'draft'
                     ORDER BY o.updated_at DESC, o.id DESC`).all(companyId).map((order) => {
    const items = loadStoredItems(order.id);
    const totals = calculateDraftTotals(items);
    return {
      id: order.id,
      status: order.status,
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
                               SET items_total_cents = ?, updated_at = CURRENT_TIMESTAMP
                               WHERE id = ? AND client_id = ? AND status = 'draft'`)
      .run(totals.itemsTotalCents, order.id, clientId);
    if (Number(update.changes) !== 1) {
      throw orderError("Este pedido não está mais em estado draft.", 409);
    }

    return mapDraftOrder({ ...order, updatedAt: new Date().toISOString() }, resultingItems);
  });
}

export function createDraftOrder(clientId, body) {
  const input = parseDraftOrder(body);
  return transaction(() => {
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
