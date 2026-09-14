import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, seedDevelopmentData, transaction } from "./database.js";
import { calculateFreight, splitNormalFreight } from "./freight.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./security.js";
import { assertPassword, isEmail, isValidCnpj, isValidCpf, normalizeEmail, onlyDigits, requireFields } from "./validation.js";

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
  if (request.method === "GET" && pathname === "/api/companies") {
    const rows = db.prepare("SELECT id, name FROM companies WHERE status = 'active' ORDER BY name").all();
    return json(response, 200, { companies: rows });
  }
  const publicProducts = pathname.match(/^\/api\/companies\/(\d+)\/products$/);
  if (request.method === "GET" && publicProducts) {
    const rows = db.prepare(`SELECT id, name, description, price_cents AS priceCents,
                                    unit_weight_kg AS unitWeightKg, is_available AS isAvailable
                             FROM products WHERE company_id = ? AND is_available = 1 ORDER BY name`)
      .all(Number(publicProducts[1])).map(mapProduct);
    return json(response, 200, { products: rows });
  }
  if (request.method === "GET" && pathname === "/api/company/products") {
    const user = requireUser(request, ["company"]);
    const rows = db.prepare(`SELECT id, name, description, price_cents AS priceCents,
                                    unit_weight_kg AS unitWeightKg, is_available AS isAvailable
                             FROM products WHERE company_id = ? ORDER BY id DESC`)
      .all(user.companyId).map(mapProduct);
    return json(response, 200, { products: rows });
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
    db.prepare("UPDATE couriers SET is_online = ? WHERE user_id = ?").run(body.isOnline ? 1 : 0, user.id);
    return json(response, 200, { isOnline: Boolean(body.isOnline) });
  }
  if (request.method === "GET" && pathname === "/api/courier/availability") {
    const user = requireUser(request, ["courier"]);
    const row = db.prepare("SELECT is_online AS isOnline FROM couriers WHERE user_id = ?").get(user.id);
    return json(response, 200, { isOnline: Boolean(row?.isOnline) });
  }
  if (request.method === "POST" && pathname === "/api/freight/quote") {
    const user = requireUser(request, ["company"]);
    const body = await readJson(request);
    requireFields(body, ["weightKg", "distanceKm", "estimatedMinutes"]);
    const configRow = db.prepare(`SELECT under_1kg_cents AS under1KgCents, from_1_to_3kg_cents AS from1To3KgCents,
                                         from_3_to_8kg_cents AS from3To8KgCents, from_8_to_12kg_cents AS from8To12KgCents,
                                         per_km_cents AS perKmCents, per_minute_cents AS perMinuteCents,
                                         max_weight_kg AS maxWeightKg
                                  FROM freight_configs WHERE company_id = ?`).get(user.companyId);
    const quote = calculateFreight({ ...body, config: configRow });
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
      const handled = await api(request, response, url);
      if (handled === false) json(response, 404, { error: "Rota de API não encontrada." });
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const sqliteConflict = String(error.code || "").startsWith("SQLITE_CONSTRAINT");
    const status = sqliteConflict ? 409 : Number(error.statusCode || 500);
    if (status >= 500) console.error(error);
    json(response, status, { error: sqliteConflict ? "Já existe um cadastro com esses dados." : error.message || "Erro interno." });
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
