import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = { postalCode: "01001000", state: "SP", city: "São Paulo",
  neighborhood: "Centro", street: "Rua Um", number: "10", complement: "" };

test("perfis empresariais, isolamento e auditoria transacional", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-company-users-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?company-users=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, method = "GET", body } = {}) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function login(email, password = "Senha123!") {
    const response = await request("/api/auth/login", { method: "POST", body: { email, password } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], user: (await response.json()).user };
  }
  const audit = () => db.prepare(`SELECT company_id AS companyId, actor_user_id AS actorId,
    action, entity_type AS entityType, entity_id AS entityId FROM company_audit_events ORDER BY id`).all();
  const ownerA = await login("empresa@ermes.local", "Ermes123!");
  const companyA = ownerA.user.companyId;
  assert.equal(ownerA.user.companyProfile, "RESPONSAVEL");
  assert.equal((await (await request("/api/auth/me", { cookie: ownerA.cookie })).json()).user.companyProfile,
    "RESPONSAVEL");

  await context.test("cadastro inicial e usuários internos sempre pertencem à sessão", async () => {
    const registered = await request("/api/auth/register/company", { method: "POST", body: {
      companyName: "Empresa B", cnpj: "00000000000272", companyEmail: "b@local.test",
      responsibleName: "Responsável B", cpf: "123.456.789-09", accessEmail: "owner.b@local.test",
      password: "Senha123!", address,
    } });
    assert.equal(registered.status, 201);
    const b = await registered.json();
    assert.equal(db.prepare("SELECT company_profile FROM users WHERE id = ?").get(b.userId).company_profile,
      "RESPONSAVEL");
    assert.deepEqual(audit().filter((event) => event.entityId === b.userId).map((event) => ({ ...event })), [{ companyId: b.companyId,
      actorId: b.userId, action: "company_user_created", entityType: "user", entityId: b.userId }]);
  });
  const ownerB = await login("owner.b@local.test");
  const createUser = (cookie, email, companyProfile, extra = {}) => request("/api/company/users", {
    cookie, method: "POST", body: { fullName: email, email, password: "Senha123!", companyProfile, ...extra },
  });
  const attendantResponse = await createUser(ownerA.cookie, "attendant.a@local.test", "ATENDENTE");
  assert.equal(attendantResponse.status, 201);
  const attendantId = (await attendantResponse.json()).id;
  const attendant = await login("attendant.a@local.test");
  assert.equal(attendant.user.id, attendantId);
  assert.equal(attendant.user.role, "company");
  assert.equal(attendant.user.companyProfile, "ATENDENTE");

  await context.test("criação valida perfil, e-mail e vínculo; listagem omite segredos", async () => {
    assert.equal((await createUser(ownerA.cookie, "owner.a.2@local.test", "RESPONSAVEL")).status, 201);
    assert.equal((await createUser(attendant.cookie, "denied@local.test", "ATENDENTE")).status, 403);
    assert.equal((await createUser(ownerA.cookie, "attendant.a@local.test", "ATENDENTE")).status, 409);
    assert.equal((await createUser(ownerA.cookie, "invalid@local.test", "INVALIDO")).status, 400);
    assert.equal((await createUser(ownerA.cookie, "foreign@local.test", "ATENDENTE",
      { companyId: ownerB.user.companyId })).status, 400);
    const response = await request("/api/company/users", { cookie: ownerA.cookie });
    assert.equal(response.status, 200);
    const { users } = await response.json();
    assert.ok(users.some((user) => user.id === attendantId && user.companyProfile === "ATENDENTE"));
    assert.ok(users.every((user) => !Object.hasOwn(user, "password_hash") && !Object.hasOwn(user, "token")));
    assert.ok(users.every((user) => db.prepare("SELECT company_id AS id FROM users WHERE id = ?")
      .get(user.id).id === companyA));
    assert.equal((await request("/api/company/users", { cookie: attendant.cookie })).status, 403);
    assert.deepEqual((await (await request("/api/company/users", { cookie: ownerB.cookie })).json()).users
      .map(({ id }) => id), [ownerB.user.id]);
    assert.equal((await (await request("/api/auth/me", { cookie: attendant.cookie })).json()).user.companyProfile,
      "ATENDENTE");
  });

  await context.test("sessão existente consulta o perfil atual do banco", async () => {
    db.prepare("UPDATE users SET company_profile = 'RESPONSAVEL' WHERE id = ?").run(attendantId);
    try {
      assert.equal((await request("/api/company/freight-config", { cookie: attendant.cookie })).status, 200);
      assert.equal((await (await request("/api/auth/me", { cookie: attendant.cookie })).json()).user.companyProfile,
        "RESPONSAVEL");
    } finally {
      db.prepare("UPDATE users SET company_profile = 'ATENDENTE' WHERE id = ?").run(attendantId);
    }
    assert.equal((await request("/api/company/freight-config", { cookie: attendant.cookie })).status, 403);
  });

  await context.test("ATENDENTE recebe 403 nas ações administrativas e RESPONSAVEL tem acesso", async () => {
    const newProduct = { name: "Novo", priceCents: 100, unitWeightKg: 1 };
    const courier = { fullName: "Motoboy A", email: "courier.a@local.test", cpf: "111.444.777-35",
      phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!" };
    const config = { perKm: "1.00" };
    const productId = db.prepare("SELECT id FROM products WHERE company_id = ? LIMIT 1").get(companyA).id;
    const checks = [
      ["/api/company/products", "POST", newProduct],
      [`/api/company/products/${productId}`, "PATCH", { isAvailable: false }],
      ["/api/company/freight-config", "GET"],
      ["/api/company/freight-config", "PATCH", config],
      ["/api/company/couriers", "GET"],
      ["/api/company/couriers", "POST", courier],
      ["/api/company/users", "GET"],
      ["/api/company/users", "POST", { fullName: "Outro", email: "other@local.test",
        password: "Senha123!", companyProfile: "ATENDENTE" }],
    ];
    const before = audit();
    for (const [path, method, body] of checks) {
      assert.equal((await request(path, { cookie: attendant.cookie, method, body })).status, 403, path);
    }
    assert.deepEqual(audit(), before);
    for (const [path, method, body] of checks) {
      assert.ok([200, 201].includes((await request(path, { cookie: ownerA.cookie, method, body })).status), path);
    }
    assert.equal((await request("/api/company/products", { cookie: attendant.cookie })).status, 200);
    assert.equal((await request("/api/freight/quote", { cookie: attendant.cookie, method: "POST",
      body: { weightKg: 1, distanceKm: 1, estimatedMinutes: 1 } })).status, 200);
    assert.equal(db.prepare("SELECT is_available AS value FROM products WHERE id = ?").get(productId).value, 0);
    assert.ok(audit().filter((event) => event.action === "product_created").some((event) =>
      event.actorId === ownerA.user.id));
    for (const action of ["product_created", "product_availability_changed", "freight_config_changed",
      "courier_created", "company_user_created"]) {
      assert.ok(audit().some((event) => event.action === action && event.companyId === companyA
        && event.actorId === ownerA.user.id), action);
    }
  });

  await context.test("responsável não administra dados de outra empresa", async () => {
    const created = await request("/api/company/products", { cookie: ownerB.cookie, method: "POST",
      body: { name: "Produto B", priceCents: 200, unitWeightKg: 1 } });
    assert.equal(created.status, 201);
    const productB = (await created.json()).id;
    assert.ok(audit().some((event) => event.action === "product_created"
      && event.entityId === productB && event.actorId === ownerB.user.id
      && event.companyId === ownerB.user.companyId));
    const before = audit();
    assert.equal((await request(`/api/company/products/${productB}`, { cookie: ownerA.cookie,
      method: "PATCH", body: { isAvailable: false } })).status, 404);
    assert.deepEqual(audit(), before);
    assert.equal(db.prepare("SELECT is_available AS value FROM products WHERE id = ?").get(productB).value, 1);
    assert.ok((await (await request("/api/company/products", { cookie: ownerA.cookie })).json()).products
      .every((product) => product.id !== productB));
    assert.ok((await (await request("/api/company/products", { cookie: ownerB.cookie })).json()).products
      .some((product) => product.id === productB));
    const configA = (await (await request("/api/company/freight-config", { cookie: ownerA.cookie })).json())
      .freightConfig;
    const configB = (await (await request("/api/company/freight-config", { cookie: ownerB.cookie })).json())
      .freightConfig;
    assert.equal(configA.perKm, "1.00");
    assert.equal(configB.perKm, "0.50");
  });

  await context.test("ATENDENTE opera Pedido e chat com seu próprio ID", async () => {
    const created = await request("/api/auth/register/client", { method: "POST", body: {
      fullName: "Cliente", email: "client.a@local.test", birthDate: "1990-01-01", password: "Senha123!",
    } });
    assert.equal(created.status, 201);
    const client = await login("client.a@local.test");
    assert.equal(client.user.companyProfile, null);
    assert.equal((await request("/api/client/default-address", { cookie: client.cookie, method: "PUT",
      body: address })).status, 200);
    const productId = db.prepare("SELECT id FROM products WHERE company_id = ? AND is_available = 1 LIMIT 1")
      .get(companyA).id;
    const draft = await request("/api/client/orders", { cookie: client.cookie, method: "POST",
      body: { companyId: companyA, items: [{ productId, quantity: 1 }] } });
    assert.equal(draft.status, 201);
    const order = (await draft.json()).order;
    assert.equal((await request(`/api/client/orders/${order.id}/submit`, { cookie: client.cookie,
      method: 'POST', body: { version: 1 } })).status, 200);
    assert.equal((await request("/api/company/orders/drafts", { cookie: attendant.cookie })).status, 200);
    assert.equal((await request(`/api/company/orders/${order.id}`, { cookie: attendant.cookie })).status, 200);
    assert.equal((await request("/api/company/order-chats", { cookie: attendant.cookie })).status, 200);
    assert.equal((await request(`/api/company/orders/${order.id}/chat`, { cookie: attendant.cookie })).status, 200);
    assert.equal((await request(`/api/company/orders/${order.id}/chat`, { cookie: attendant.cookie,
      method: "POST", body: { message: "Mensagem do atendente" } })).status, 201);
    assert.equal(db.prepare("SELECT sender_user_id AS id FROM order_chat_messages WHERE order_id = ?")
      .get(order.id).id, attendantId);
    assert.equal((await request(`/api/company/orders/${order.id}/confirm`, { cookie: ownerB.cookie,
      method: "POST", body: { version: 1 } })).status, 404);
    assert.equal((await request(`/api/company/orders/${order.id}/confirm`, { cookie: attendant.cookie,
      method: "POST", body: { version: 1 } })).status, 200);
    assert.equal((await request(`/api/company/orders/${order.id}/confirm`, { cookie: attendant.cookie,
      method: "POST", body: { version: 1 } })).status, 200);
    const confirmations = audit().filter((event) => event.action === "order_confirmed" && event.entityId === order.id);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].actorId, attendantId);
    assert.equal((await request(`/api/client/orders/${order.id}/pay`, { cookie: client.cookie,
      method: "POST", body: {} })).status, 200);
    assert.equal((await request("/api/company/deliveries", { cookie: attendant.cookie })).status, 200);
    const delivery = db.prepare("SELECT id FROM deliveries WHERE order_id = ?").get(order.id);
    assert.equal((await request(`/api/company/deliveries/${delivery.id}`, { cookie: attendant.cookie })).status, 200);
    assert.equal((await request(`/api/company/deliveries/${delivery.id}/product-unavailable`, {
      cookie: attendant.cookie, method: "POST", body: {} })).status, 200);
    assert.ok(db.prepare(`SELECT 1 FROM delivery_events WHERE delivery_id = ?
      AND event_type = 'product_unavailable' AND actor_user_id = ?`).get(delivery.id, attendantId));
  });

  await context.test("ATENDENTE classifica ocorrência e preserva identidade no evento", async () => {
    const client = await login("client.a@local.test");
    const courier = await login("courier.a@local.test");
    const productId = db.prepare("SELECT id FROM products WHERE company_id = ? AND is_available = 1 LIMIT 1")
      .get(companyA).id;
    const draft = await request("/api/client/orders", { cookie: client.cookie, method: "POST",
      body: { companyId: companyA, items: [{ productId, quantity: 1 }] } });
    assert.equal(draft.status, 201);
    const orderId = (await draft.json()).order.id;
    assert.equal((await request(`/api/client/orders/${orderId}/submit`, { cookie: client.cookie,
      method: 'POST', body: { version: 1 } })).status, 200);
    assert.equal((await request(`/api/company/orders/${orderId}/confirm`, { cookie: attendant.cookie,
      method: "POST", body: { version: 1 } })).status, 200);
    assert.equal((await request(`/api/client/orders/${orderId}/pay`, { cookie: client.cookie,
      method: "POST", body: {} })).status, 200);
    const deliveryId = db.prepare("SELECT id FROM deliveries WHERE order_id = ?").get(orderId).id;
    assert.equal((await request("/api/courier/availability", { cookie: courier.cookie,
      method: "PATCH", body: { isOnline: true } })).status, 200);
    assert.equal((await request(`/api/courier/deliveries/${deliveryId}/accept`, { cookie: courier.cookie,
      method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/courier/deliveries/${deliveryId}/fail`, { cookie: courier.cookie,
      method: "POST", body: { reason: "Pane mecânica" } })).status, 200);
    const occurrenceId = db.prepare("SELECT id FROM delivery_occurrences WHERE delivery_id = ?")
      .get(deliveryId).id;
    assert.equal((await request("/api/company/delivery-occurrences", { cookie: attendant.cookie })).status, 200);
    assert.equal((await request(`/api/company/delivery-occurrences/${occurrenceId}/classify`, {
      cookie: ownerB.cookie, method: "POST", body: { responsibility: "MOTOBOY" } })).status, 404);
    assert.equal((await request(`/api/company/delivery-occurrences/${occurrenceId}/classify`, {
      cookie: attendant.cookie, method: "POST", body: { responsibility: "MOTOBOY" } })).status, 200);
    assert.equal(db.prepare("SELECT classified_by_user_id AS id FROM delivery_occurrences WHERE id = ?")
      .get(occurrenceId).id, attendantId);
    assert.ok(db.prepare(`SELECT 1 FROM delivery_events WHERE delivery_id = ?
      AND event_type = 'occurrence_classified' AND actor_user_id = ?`).get(deliveryId, attendantId));
  });

  await context.test("todas as rotas operacionais empresariais aceitam ATENDENTE", async () => {
    const checks = [
      ["GET", "/api/company/orders/drafts"], ["GET", "/api/company/order-chats"],
      ["GET", "/api/company/orders/999999"], ["POST", "/api/company/orders/999999/confirm", { version: 1 }],
      ["GET", "/api/company/orders/999999/chat"], ["POST", "/api/company/orders/999999/chat", { message: "Teste" }],
      ["GET", "/api/company/deliveries"], ["GET", "/api/company/delivery-occurrences"],
      ["GET", "/api/company/deliveries/999999"], ["GET", "/api/company/deliveries/999999/adjustment"],
      ["POST", "/api/company/deliveries/999999/adjustment", {}],
      ["POST", "/api/company/deliveries/999999/product-unavailable", {}],
      ["POST", "/api/company/deliveries/999999/revalidate", {}],
      ["POST", "/api/company/deliveries/999999/system-address-resolution", {}],
      ["POST", "/api/company/deliveries/999999/confirm-return", {}],
      ["POST", "/api/company/delivery-occurrences/999999/classify", { responsibility: "MOTOBOY" }],
    ];
    for (const [method, path, body] of checks) {
      const response = await request(path, { cookie: attendant.cookie, method, body });
      assert.notEqual(response.status, 403, path);
      assert.notEqual(response.status, 401, path);
      assert.notEqual(response.status, 500, path);
    }
  });

  await context.test("falha de auditoria reverte alteração principal e permite repetição", async () => {
    const beforeProducts = db.prepare("SELECT COUNT(*) AS total FROM products").get().total;
    const beforeAudit = audit();
    db.exec(`CREATE TEMP TRIGGER reject_company_audit BEFORE INSERT ON main.company_audit_events
      WHEN NEW.action = 'product_created' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
    try {
      assert.equal((await request("/api/company/products", { cookie: ownerA.cookie, method: "POST",
        body: { name: "Rollback", priceCents: 100, unitWeightKg: 1 } })).status, 500);
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM products").get().total, beforeProducts);
      assert.deepEqual(audit(), beforeAudit);
    } finally { db.exec("DROP TRIGGER reject_company_audit"); }
    assert.equal((await request("/api/company/products", { cookie: ownerA.cookie, method: "POST",
      body: { name: "Rollback", priceCents: 100, unitWeightKg: 1 } })).status, 201);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM products").get().total, beforeProducts + 1);
    assert.throws(() => db.prepare("DELETE FROM company_audit_events WHERE id = 1").run());
    assert.throws(() => db.prepare("UPDATE company_audit_events SET action = 'order_confirmed' WHERE id = 1").run());
    assert.throws(() => db.prepare(`INSERT INTO company_audit_events
      (company_id, actor_user_id, action, entity_type, entity_id)
      VALUES (?, ?, 'product_created', 'product', ?)`).run(companyA, ownerB.user.id, 1));
    const ownProduct = db.prepare("SELECT id FROM products WHERE company_id = ? LIMIT 1").get(companyA).id;
    const foreignProduct = db.prepare("SELECT id FROM products WHERE company_id = ? LIMIT 1")
      .get(ownerB.user.companyId).id;
    const insertAudit = db.prepare(`INSERT INTO company_audit_events
      (company_id, actor_user_id, action, entity_type, entity_id)
      VALUES (?, ?, 'product_created', 'product', ?)`);
    assert.throws(() => insertAudit.run(companyA, attendantId, ownProduct));
    assert.throws(() => insertAudit.run(companyA, ownerA.user.id, foreignProduct));
    assert.throws(() => db.prepare("UPDATE users SET company_id = ? WHERE id = ?")
      .run(ownerB.user.companyId, ownerA.user.id));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});
