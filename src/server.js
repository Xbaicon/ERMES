import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAddress } from "./address.js";
import { db, seedDevelopmentData, transaction } from "./database.js";
import { calculateFreight, splitNormalFreight } from "./freight.js";
import { listCourierFinancialEntries } from "./finance.js";
import { confirmCompanyDraftOrder, confirmSimulatedPayment, createDraftOrder, getClientConfirmedOrder, getCompanyDraftOrder, getDraftOrder, listClientConfirmedOrders, listCompanyDraftOrders, listDraftOrders, parseOrderId, updateDraftOrderItems } from "./orders.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./security.js";
import { assertPassword, isEmail, isValidCnpj, isValidCpf, normalizeEmail, onlyDigits, requireFields } from "./validation.js";
import {
  acceptDelivery, arriveAtDestination, arriveAtPickup, cancelClientDelivery,
  cancelForUnavailableProduct, collectDelivery, confirmDelivery, confirmReturn,
  getClientDelivery, getCompanyDelivery, getCourierCurrentDelivery, listAvailableDeliveries,
  listClientDeliveries, listCompanyDeliveries, parseDeliveryId, reportCourierFailure,
  reportDeliveryOccurrence, reportReturn,
} from "./delivery-operations.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDirectory = join(root, "public");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!isProduction) seedDevelopmentData();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(response, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...extraHeaders });
  response.end(payload);
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return [decodeURIComponent(item.slice(0, index).trim()), decodeURIComponent(item.slice(index + 1).trim())];
  }));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      const error = new Error("Corpo da requisição muito grande.");
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("JSON inválido.");
    error.statusCode = 400;
    throw error;
  }
}

function sessionUser(request) {
  const token = parseCookies(request).ermes_session;
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.company_id AS companyId, u.role, u.full_name AS fullName,
                            u.email, u.status
                     FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`)
    .get(hashToken(token)) || null;
}

function requireUser(request, roles = []) {
  const user = sessionUser(request);
  if (!user) {
    const error = new Error("Autenticação necessária.");
    error.statusCode = 401;
    throw error;
  }
  if (roles.length && !roles.includes(user.role)) {
    const error = new Error("Você não possui permissão para esta ação.");
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function mapProduct(row) {
  return { ...row, isAvailable: Boolean(row.isAvailable) };
}

const defaultAddressSelect = `SELECT postal_code AS postalCode, state, city, neighborhood,
                                      street, number, complement
                               FROM client_default_addresses WHERE client_id = ?`;

const freightConfigFields = Object.freeze({
  under1Kg: "under_1kg_cents",
  from1To3Kg: "from_1_to_3kg_cents",
  from3To8Kg: "from_3_to_8kg_cents",
  from8To12Kg: "from_8_to_12kg_cents",
  perKm: "per_km_cents",
  perMinute: "per_minute_cents",
});

const freightConfigSelect = `SELECT under_1kg_cents AS under1KgCents,
                                    from_1_to_3kg_cents AS from1To3KgCents,
                                    from_3_to_8kg_cents AS from3To8KgCents,
                                    from_8_to_12kg_cents AS from8To12KgCents,
                                    per_km_cents AS perKmCents,
                                    per_minute_cents AS perMinuteCents
                             FROM freight_configs WHERE company_id = ?`;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseCompanyId(value) {
  if (!/^[1-9]\d*$/.test(value)) throw badRequest("Identificador de empresa inválido.");
  const companyId = Number(value);
  if (!Number.isSafeInteger(companyId)) throw badRequest("Identificador de empresa inválido.");
  return companyId;
}

function centsToReais(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function mapFreightConfig(row) {
  return {
    under1Kg: centsToReais(row.under1KgCents),
    from1To3Kg: centsToReais(row.from1To3KgCents),
    from3To8Kg: centsToReais(row.from3To8KgCents),
    from8To12Kg: centsToReais(row.from8To12KgCents),
    perKm: centsToReais(row.perKmCents),
    perMinute: centsToReais(row.perMinuteCents),
  };
}

function reaisToCents(value, field) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw badRequest(`O campo ${field} deve ser um valor monetário em reais.`);
  }
  const decimal = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) {
    throw badRequest(`O campo ${field} deve ser um valor não negativo com no máximo duas casas decimais.`);
  }
  const [integer, fraction = ""] = decimal.split(".");
  const cents = BigInt(integer) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw badRequest(`O campo ${field} excede o valor máximo permitido.`);
  }
  return Number(cents);
}

function parseFreightConfigPatch(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw badRequest("O corpo da requisição deve ser um objeto com parâmetros tarifários.");
  }
  const keys = Object.keys(body);
  const unexpected = keys.filter((key) => !Object.hasOwn(freightConfigFields, key));
  if (unexpected.length) throw badRequest(`Campos não permitidos: ${unexpected.join(", ")}.`);
  if (!keys.length) throw badRequest("Informe ao menos um parâmetro tarifário válido.");
  return keys.map((key) => ({ column: freightConfigFields[key], value: reaisToCents(body[key], key) }));
}

const duplicateEmailMessage = "Este e-mail já está cadastrado. Use outro e-mail ou faça login.";

async function api(request, response, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    return json(response, 200, { status: "ok", baseline: "0.1" });
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    return json(response, 200, { user: sessionUser(request) });
  }
  if (request.method === "POST" && pathname === "/api/auth/register/client") {
    const body = await readJson(request);
    requireFields(body, ["fullName", "email", "birthDate", "password"]);
    assertPassword(body.password);
    if (!isEmail(body.email)) throw Object.assign(new Error("Informe um e-mail válido."), { statusCode: 400 });
    const result = db.prepare(`INSERT INTO users (role, full_name, email, birth_date, password_hash)
                               VALUES ('client', ?, ?, ?, ?)`)
      .run(String(body.fullName).trim(), normalizeEmail(body.email), body.birthDate, hashPassword(body.password));
    return json(response, 201, { id: Number(result.lastInsertRowid), message: "Conta de cliente criada." });
  }
  if (request.method === "POST" && pathname === "/api/auth/register/company") {
    const body = await readJson(request);
    requireFields(body, ["companyName", "cnpj", "companyEmail", "responsibleName", "cpf", "accessEmail", "password"]);
    requireFields(body.address || {}, ["postalCode", "state", "city", "neighborhood", "street", "number"]);
    assertPassword(body.password);
    if (!isValidCnpj(body.cnpj)) throw Object.assign(new Error("CNPJ inválido."), { statusCode: 400 });
    if (!isValidCpf(body.cpf)) throw Object.assign(new Error("CPF inválido."), { statusCode: 400 });
    if (!isEmail(body.companyEmail) || !isEmail(body.accessEmail)) throw Object.assign(new Error("Informe e-mails válidos."), { statusCode: 400 });
    const ids = transaction(() => {
      const companyResult = db.prepare(`INSERT INTO companies (name, cnpj, email, phone, address_json)
                                        VALUES (?, ?, ?, ?, ?)`)
        .run(String(body.companyName).trim(), onlyDigits(body.cnpj), normalizeEmail(body.companyEmail), onlyDigits(body.phone), JSON.stringify(body.address || {}));
      const companyId = Number(companyResult.lastInsertRowid);
      db.prepare("INSERT INTO freight_configs (company_id) VALUES (?)").run(companyId);
      const userResult = db.prepare(`INSERT INTO users (company_id, role, full_name, email, cpf, phone, password_hash)
                                     VALUES (?, 'company', ?, ?, ?, ?, ?)`)
        .run(companyId, String(body.responsibleName).trim(), normalizeEmail(body.accessEmail), onlyDigits(body.cpf), onlyDigits(body.phone), hashPassword(body.password));
      return { companyId, userId: Number(userResult.lastInsertRowid) };
    });
    return json(response, 201, { ...ids, message: "Empresa e usuário responsável cadastrados." });
  }
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(request);
    requireFields(body, ["email", "password"]);
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(normalizeEmail(body.email));
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw Object.assign(new Error("E-mail ou senha incorretos."), { statusCode: 401 });
    }
    const token = newSessionToken();
    const days = body.rememberMe ? 30 : 1;
    db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
      .run(hashToken(token), user.id, `+${days} days`);
    const cookie = `ermes_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${isProduction ? "; Secure" : ""}`;
    return json(response, 200, { user: { id: user.id, companyId: user.company_id, role: user.role, fullName: user.full_name, email: user.email } }, { "Set-Cookie": cookie });
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(request).ermes_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return json(response, 200, { message: "Sessão encerrada." }, { "Set-Cookie": "ermes_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }
  if (request.method === "GET" && pathname === "/api/client/companies") {
    requireUser(request, ["client"]);
    const rows = db.prepare("SELECT id, name FROM companies WHERE status = 'active' ORDER BY name").all();
    return json(response, 200, { companies: rows });
  }
  const clientCompanyProducts = pathname.match(/^\/api\/client\/companies\/([^/]+)\/products$/);
  if (request.method === "GET" && clientCompanyProducts) {
    requireUser(request, ["client"]);
    const companyId = parseCompanyId(clientCompanyProducts[1]);
    const company = db.prepare("SELECT id, name FROM companies WHERE id = ? AND status = 'active'").get(companyId);
    if (!company) throw Object.assign(new Error("Empresa não encontrada."), { statusCode: 404 });
    const rows = db.prepare(`SELECT id, name, description, price_cents AS priceCents,
                                    unit_weight_kg AS unitWeightKg
                             FROM products
                             WHERE company_id = ? AND is_available = 1
                             ORDER BY name, id`)
      .all(companyId);
    return json(response, 200, { company, products: rows });
  }
  if (request.method === "GET" && pathname === "/api/client/default-address") {
    const user = requireUser(request, ["client"]);
    const defaultAddress = db.prepare(defaultAddressSelect).get(user.id) || null;
    return json(response, 200, { defaultAddress });
  }
  if (request.method === "PUT" && pathname === "/api/client/default-address") {
    const user = requireUser(request, ["client"]);
    const address = normalizeAddress(await readJson(request));
    db.prepare(`INSERT INTO client_default_addresses
                  (client_id, postal_code, state, city, neighborhood, street, number, complement)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                  postal_code = excluded.postal_code,
                  state = excluded.state,
                  city = excluded.city,
                  neighborhood = excluded.neighborhood,
                  street = excluded.street,
                  number = excluded.number,
                  complement = excluded.complement,
                  updated_at = CURRENT_TIMESTAMP`)
      .run(user.id, address.postalCode, address.state, address.city, address.neighborhood,
        address.street, address.number, address.complement);
    const defaultAddress = db.prepare(defaultAddressSelect).get(user.id);
    return json(response, 200, { defaultAddress });
  }
  if (request.method === "POST" && pathname === "/api/client/orders") {
    const user = requireUser(request, ["client"]);
    const order = createDraftOrder(user.id, await readJson(request));
    return json(response, 201, { order });
  }
  if (request.method === "GET" && pathname === "/api/client/orders/drafts") {
    const user = requireUser(request, ["client"]);
    return json(response, 200, { drafts: listDraftOrders(user.id) });
  }
  if (request.method === "GET" && pathname === "/api/client/orders/confirmed") {
    const user = requireUser(request, ["client"]);
    return json(response, 200, { orders: listClientConfirmedOrders(user.id) });
  }
  const clientConfirmedOrderMatch = pathname.match(/^\/api\/client\/orders\/confirmed\/([^/]+)$/);
  if (request.method === "GET" && clientConfirmedOrderMatch) {
    const user = requireUser(request, ["client"]);
    const order = getClientConfirmedOrder(user.id, parseOrderId(clientConfirmedOrderMatch[1]));
    return json(response, 200, { order });
  }
  const clientOrderMatch = pathname.match(/^\/api\/client\/orders\/([^/]+)$/);
  if (request.method === "GET" && clientOrderMatch) {
    const user = requireUser(request, ["client"]);
    const order = getDraftOrder(user.id, parseOrderId(clientOrderMatch[1]));
    return json(response, 200, { order });
  }
  const clientOrderItemsMatch = pathname.match(/^\/api\/client\/orders\/([^/]+)\/items$/);
  if (request.method === "PUT" && clientOrderItemsMatch) {
    const user = requireUser(request, ["client"]);
    const orderId = parseOrderId(clientOrderItemsMatch[1]);
    const order = updateDraftOrderItems(user.id, orderId, await readJson(request));
    return json(response, 200, { order });
  }
  const clientOrderPaymentMatch = pathname.match(/^\/api\/client\/orders\/([^/]+)\/pay$/);
  if (request.method === "POST" && clientOrderPaymentMatch) {
    const user = requireUser(request, ["client"]);
    const orderId = parseOrderId(clientOrderPaymentMatch[1]);
    const result = confirmSimulatedPayment(user.id, orderId, await readJson(request));
    return json(response, 200, result);
  }
  if (request.method === "GET" && pathname === "/api/client/deliveries") {
    const user = requireUser(request, ["client"]);
    return json(response, 200, { deliveries: listClientDeliveries(user.id) });
  }
  const clientDeliveryMatch = pathname.match(/^\/api\/client\/deliveries\/([^/]+)$/);
  if (request.method === "GET" && clientDeliveryMatch) {
    const user = requireUser(request, ["client"]);
    return json(response, 200, { delivery: getClientDelivery(user.id, parseDeliveryId(clientDeliveryMatch[1])) });
  }
  const clientDeliveryCancelMatch = pathname.match(/^\/api\/client\/deliveries\/([^/]+)\/cancel$/);
  if (request.method === "POST" && clientDeliveryCancelMatch) {
    const user = requireUser(request, ["client"]);
    const delivery = cancelClientDelivery(parseDeliveryId(clientDeliveryCancelMatch[1]), user.id, await readJson(request));
    return json(response, 200, { delivery });
  }
  if (request.method === "GET" && pathname === "/api/company/orders/drafts") {
    const user = requireUser(request, ["company"]);
    return json(response, 200, { drafts: listCompanyDraftOrders(user.companyId) });
  }
  const companyOrderConfirmationMatch = pathname.match(/^\/api\/company\/orders\/([^/]+)\/confirm$/);
  if (request.method === "POST" && companyOrderConfirmationMatch) {
    const user = requireUser(request, ["company"]);
    const orderId = parseOrderId(companyOrderConfirmationMatch[1]);
    const order = confirmCompanyDraftOrder(user.companyId, orderId, await readJson(request));
    return json(response, 200, { order });
  }
  const companyOrderMatch = pathname.match(/^\/api\/company\/orders\/([^/]+)$/);
  if (request.method === "GET" && companyOrderMatch) {
    const user = requireUser(request, ["company"]);
    const order = getCompanyDraftOrder(user.companyId, parseOrderId(companyOrderMatch[1]));
    return json(response, 200, { order });
  }
  if (request.method === "GET" && pathname === "/api/company/deliveries") {
    const user = requireUser(request, ["company"]);
    return json(response, 200, { deliveries: listCompanyDeliveries(user.companyId) });
  }
  const companyDeliveryMatch = pathname.match(/^\/api\/company\/deliveries\/([^/]+)$/);
  if (request.method === "GET" && companyDeliveryMatch) {
    const user = requireUser(request, ["company"]);
    return json(response, 200, { delivery: getCompanyDelivery(user.companyId, parseDeliveryId(companyDeliveryMatch[1])) });
  }
  const companyUnavailableMatch = pathname.match(/^\/api\/company\/deliveries\/([^/]+)\/product-unavailable$/);
  if (request.method === "POST" && companyUnavailableMatch) {
    const user = requireUser(request, ["company"]);
    const delivery = cancelForUnavailableProduct(parseDeliveryId(companyUnavailableMatch[1]),
      user.id, user.companyId, await readJson(request));
    return json(response, 200, { delivery });
  }
  const companyReturnMatch = pathname.match(/^\/api\/company\/deliveries\/([^/]+)\/confirm-return$/);
  if (request.method === "POST" && companyReturnMatch) {
    const user = requireUser(request, ["company"]);
    const delivery = confirmReturn(parseDeliveryId(companyReturnMatch[1]),
      user.id, user.companyId, await readJson(request));
    return json(response, 200, { delivery });
  }
  if (request.method === "GET" && pathname === "/api/company/products") {
    const user = requireUser(request, ["company"]);
    const rows = db.prepare(`SELECT id, name, description, price_cents AS priceCents,
                                    unit_weight_kg AS unitWeightKg, is_available AS isAvailable
                             FROM products WHERE company_id = ? ORDER BY id DESC`)
      .all(user.companyId).map(mapProduct);
    return json(response, 200, { products: rows });
  }
  if (request.method === "GET" && pathname === "/api/company/freight-config") {
    const user = requireUser(request, ["company"]);
    const config = db.prepare(freightConfigSelect).get(user.companyId);
    if (!config) throw Object.assign(new Error("Configuração tarifária não encontrada."), { statusCode: 404 });
    return json(response, 200, { freightConfig: mapFreightConfig(config) });
  }
  if (request.method === "PATCH" && pathname === "/api/company/freight-config") {
    const user = requireUser(request, ["company"]);
    const updates = parseFreightConfigPatch(await readJson(request));
    const setClause = updates.map(({ column }) => `${column} = ?`).join(", ");
    const result = db.prepare(`UPDATE freight_configs SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE company_id = ?`)
      .run(...updates.map(({ value }) => value), user.companyId);
    if (!result.changes) throw Object.assign(new Error("Configuração tarifária não encontrada."), { statusCode: 404 });
    const config = db.prepare(freightConfigSelect).get(user.companyId);
    return json(response, 200, { freightConfig: mapFreightConfig(config) });
  }
  if (request.method === "POST" && pathname === "/api/company/products") {
    const user = requireUser(request, ["company"]);
    const body = await readJson(request);
    requireFields(body, ["name", "priceCents", "unitWeightKg"]);
    if (Number(body.unitWeightKg) <= 0 || Number(body.priceCents) < 0) throw Object.assign(new Error("Preço e peso devem ser válidos."), { statusCode: 400 });
    const result = db.prepare(`INSERT INTO products (company_id, name, description, price_cents, unit_weight_kg)
                               VALUES (?, ?, ?, ?, ?)`)
      .run(user.companyId, String(body.name).trim(), String(body.description || "").trim(), Math.round(Number(body.priceCents)), Number(body.unitWeightKg));
    return json(response, 201, { id: Number(result.lastInsertRowid), message: "Produto cadastrado." });
  }
  const productPatch = pathname.match(/^\/api\/company\/products\/(\d+)$/);
  if (request.method === "PATCH" && productPatch) {
    const user = requireUser(request, ["company"]);
    const body = await readJson(request);
    const result = db.prepare("UPDATE products SET is_available = ? WHERE id = ? AND company_id = ?")
      .run(body.isAvailable ? 1 : 0, Number(productPatch[1]), user.companyId);
    if (!result.changes) throw Object.assign(new Error("Produto não encontrado."), { statusCode: 404 });
    return json(response, 200, { message: "Disponibilidade atualizada." });
  }
  if (request.method === "GET" && pathname === "/api/company/couriers") {
    const user = requireUser(request, ["company"]);
    const rows = db.prepare(`SELECT u.id, u.full_name AS fullName, u.email, u.cpf, u.phone, u.status,
                                    c.vehicle_type AS vehicleType, c.vehicle_identifier AS vehicleIdentifier,
                                    c.plate, c.cnh, c.is_online AS isOnline
                             FROM users u JOIN couriers c ON c.user_id = u.id
                             WHERE u.company_id = ? ORDER BY u.full_name`).all(user.companyId)
      .map((row) => ({ ...row, isOnline: Boolean(row.isOnline) }));
    return json(response, 200, { couriers: rows });
  }
  if (request.method === "POST" && pathname === "/api/company/couriers") {
    const user = requireUser(request, ["company"]);
    const body = await readJson(request);
    requireFields(body, ["fullName", "email", "cpf", "phone", "vehicleType", "password"]);
    assertPassword(body.password);
    if (!isValidCpf(body.cpf)) throw Object.assign(new Error("CPF inválido."), { statusCode: 400 });
    if (!isEmail(body.email)) throw Object.assign(new Error("E-mail inválido."), { statusCode: 400 });
    const userId = transaction(() => {
      const result = db.prepare(`INSERT INTO users (company_id, role, full_name, email, cpf, phone, password_hash)
                                 VALUES (?, 'courier', ?, ?, ?, ?, ?)`)
        .run(user.companyId, String(body.fullName).trim(), normalizeEmail(body.email), onlyDigits(body.cpf), onlyDigits(body.phone), hashPassword(body.password));
      const id = Number(result.lastInsertRowid);
      db.prepare(`INSERT INTO couriers (user_id, vehicle_type, vehicle_identifier, plate, cnh)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(id, body.vehicleType, String(body.vehicleIdentifier || "").trim(), String(body.plate || "").trim().toUpperCase(), onlyDigits(body.cnh));
      return id;
    });
    return json(response, 201, { id: userId, message: "Motoboy vinculado à empresa." });
  }
  if (request.method === "PATCH" && pathname === "/api/courier/availability") {
    const user = requireUser(request, ["courier"]);
    const body = await readJson(request);
    if (!body || Array.isArray(body) || typeof body !== "object"
      || Object.keys(body).length !== 1 || typeof body.isOnline !== "boolean") {
      throw badRequest("Informe somente isOnline como valor booleano.");
    }
    db.prepare("UPDATE couriers SET is_online = ? WHERE user_id = ?").run(body.isOnline ? 1 : 0, user.id);
    return json(response, 200, { isOnline: body.isOnline });
  }
  if (request.method === "GET" && pathname === "/api/courier/availability") {
    const user = requireUser(request, ["courier"]);
    const row = db.prepare("SELECT is_online AS isOnline FROM couriers WHERE user_id = ?").get(user.id);
    return json(response, 200, { isOnline: Boolean(row?.isOnline) });
  }
  if (request.method === "GET" && pathname === "/api/courier/deliveries/available") {
    const user = requireUser(request, ["courier"]);
    return json(response, 200, { deliveries: listAvailableDeliveries(user.companyId) });
  }
  if (request.method === "GET" && pathname === "/api/courier/deliveries/current") {
    const user = requireUser(request, ["courier"]);
    return json(response, 200, { delivery: getCourierCurrentDelivery(user.id, user.companyId) });
  }
  if (request.method === "GET" && pathname === "/api/courier/financial-entries") {
    const user = requireUser(request, ["courier"]);
    return json(response, 200, listCourierFinancialEntries(db, user.id, user.companyId));
  }
  const courierActionMatch = pathname.match(/^\/api\/courier\/deliveries\/([^/]+)\/(accept|arrive-pickup|collect|arrive-destination|confirm|fail|occurrences|report-return)$/);
  if (request.method === "POST" && courierActionMatch) {
    const user = requireUser(request, ["courier"]);
    const id = parseDeliveryId(courierActionMatch[1]);
    const body = await readJson(request);
    const actions = {
      accept: acceptDelivery,
      "arrive-pickup": arriveAtPickup,
      collect: collectDelivery,
      "arrive-destination": arriveAtDestination,
      fail: reportCourierFailure,
      occurrences: reportDeliveryOccurrence,
      "report-return": reportReturn,
    };
    if (courierActionMatch[2] === "confirm") {
      const result = confirmDelivery(id, user.id, user.companyId, body);
      return json(response, result.valid ? 200 : 422,
        result.valid ? result : { error: "Código inválido.", ...result });
    }
    const delivery = actions[courierActionMatch[2]](id, user.id, user.companyId, body);
    return json(response, 200, { delivery });
  }
  if (request.method === "POST" && pathname === "/api/freight/quote") {
    const user = requireUser(request, ["company"]);
    const body = await readJson(request);
    requireFields(body, ["weightKg", "distanceKm", "estimatedMinutes"]);
    const configRow = db.prepare(freightConfigSelect).get(user.companyId);
    let quote;
    try {
      quote = calculateFreight({ ...body, config: configRow });
    } catch (error) {
      if (error instanceof RangeError) error.statusCode = 400;
      throw error;
    }
    return json(response, 200, { quote, split: splitNormalFreight(quote.totalCents), note: "Distância e tempo devem vir do futuro provedor de rotas, nunca do cliente." });
  }
  return false;
}

async function serveStatic(response, pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === "/" ? "/index.html" : decoded;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(publicDirectory, `.${safePath}`);
  if (!filePath.startsWith(publicDirectory)) return json(response, 403, { error: "Acesso negado." });
  try {
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? join(filePath, "index.html") : filePath;
    const content = await readFile(finalPath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(finalPath)] || "application/octet-stream", "Content-Length": content.length });
    response.end(content);
  } catch {
    json(response, 404, { error: "Página não encontrada." });
  }
}

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      response.setHeader("Cache-Control", "no-store");
      const handled = await api(request, response, url);
      if (handled === false) json(response, 404, { error: "Rota de API não encontrada." });
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const sqliteCode = String(error.code || "");
    const sqliteError = sqliteCode === "ERR_SQLITE_ERROR" || sqliteCode.startsWith("SQLITE_");
    const sqliteConflict = sqliteError && /constraint failed/i.test(String(error.message || ""));
    const duplicateEmail = sqliteConflict && error.message === "UNIQUE constraint failed: users.email";
    const status = sqliteConflict ? 409 : Number(error.statusCode || 500);
    if (status >= 500) console.error(error);
    const message = status >= 500 ? "Erro interno."
      : duplicateEmail ? duplicateEmailMessage
        : sqliteConflict ? "Já existe um cadastro com esses dados."
          : error.message || "Erro interno.";
    json(response, status, { error: message });
  }
});

export function startServer(listenPort = port) {
  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(listenPort, () => {
      server.off("error", rejectStart);
      const address = server.address();
      console.log(`ERMES disponível em http://localhost:${address.port}`);
      resolveStart(server);
    });
  });
}

export { server };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
