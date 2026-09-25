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

function positiveSafeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw orderError(`O campo ${field} deve ser um inteiro positivo e seguro.`);
  }
  return value;
}

export function parseDraftOrder(body) {
  if (!isObject(body)) throw orderError("O corpo deve ser um objeto JSON de pedido.");
  allowOnly(body, ["companyId", "items"]);
  const companyId = positiveSafeInteger(body.companyId, "companyId");
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw orderError("O pedido deve conter ao menos um produto.");
  }
  const seen = new Set();
  const items = body.items.map((item) => {
    if (!isObject(item)) throw orderError("Cada item deve ser um objeto JSON.");
    allowOnly(item, ["productId", "quantity"]);
    const productId = positiveSafeInteger(item.productId, "productId");
    const quantity = positiveSafeInteger(item.quantity, "quantity");
    if (seen.has(productId)) throw orderError("Produto repetido no pedido. Ajuste a quantidade de um único item.");
    seen.add(productId);
    return { productId, quantity };
  });
  return { companyId, items };
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
      if (!/^\d+$/.test(product.priceCents)) {
        throw orderError("O preço cadastrado do produto é inválido.", 409);
      }
      return { productId, name: product.name, quantity,
        unitPriceCents: BigInt(product.priceCents), unitWeightKg: product.unitWeightKg };
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
