import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const destination = JSON.stringify({
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Centro",
  street: "Rua Um", number: "10", complement: "",
});

test("acompanhamento operacional completo de entregas", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-delivery-operations-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?deliveries=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  const { hashPassword } = await import("../src/security.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
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
  const passwordHash = hashPassword("Senha123!");
  const company1 = Number(db.prepare("INSERT INTO companies (name, cnpj, email, address_json) VALUES (?, ?, ?, ?)")
    .run("Empresa 1", "11222333000181", "e1@ermes.local", destination).lastInsertRowid);
  const company2 = Number(db.prepare("INSERT INTO companies (name, cnpj, email, address_json) VALUES (?, ?, ?, ?)")
    .run("Empresa 2", "22333444000181", "e2@ermes.local", destination).lastInsertRowid);
  const user = (role, email, companyId = null) => Number(db.prepare(`INSERT INTO users
    (company_id, role, full_name, email, password_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(companyId, role, email, email, passwordHash).lastInsertRowid);
  const client1 = user("client", "cliente1@ermes.local");
  const client2 = user("client", "cliente2@ermes.local");
  const companyUser1 = user("company", "empresa1@ermes.local", company1);
  const companyUser2 = user("company", "empresa2@ermes.local", company2);
  const courier1 = user("courier", "motoboy1@ermes.local", company1);
  const courier2 = user("courier", "motoboy2@ermes.local", company1);
  const offlineCourier = user("courier", "offline@ermes.local", company1);
  const otherCourier = user("courier", "outro@ermes.local", company2);
  const indexCourier = user("courier", "indice@ermes.local", company1);
  for (const id of [courier1, courier2, otherCourier, indexCourier]) {
    db.prepare(`INSERT INTO couriers
      (user_id, vehicle_type, vehicle_identifier, plate, is_online)
      VALUES (?, 'motorcycle', 'Moto vermelha', 'ABC1D23', 1)`).run(id);
  }
  db.prepare("INSERT INTO couriers (user_id, vehicle_type, is_online) VALUES (?, 'motorcycle', 0)").run(offlineCourier);
  db.prepare(`INSERT INTO client_default_addresses
    (client_id, postal_code, state, city, neighborhood, street, number)
    VALUES (?, '01001000', 'SP', 'São Paulo', 'Centro', 'Rua Um', '10')`).run(client1);
  const product = Number(db.prepare(`INSERT INTO products
    (company_id, name, price_cents, unit_weight_kg) VALUES (?, 'Produto', 1000, 1)`)
    .run(company1).lastInsertRowid);

  async function login(email) {
    const response = await request("/api/auth/login", { method: "POST", body: { email, password: "Senha123!" } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const cookies = {
    client1: await login("cliente1@ermes.local"), client2: await login("cliente2@ermes.local"),
    company1: await login("empresa1@ermes.local"), company2: await login("empresa2@ermes.local"),
    courier1: await login("motoboy1@ermes.local"), courier2: await login("motoboy2@ermes.local"),
    offline: await login("offline@ermes.local"), otherCourier: await login("outro@ermes.local"),
  };
  function createDelivery(companyId = company1, clientId = client1) {
    const recipient = JSON.stringify({ type: "self",
      name: db.prepare("SELECT full_name AS fullName FROM users WHERE id = ?").get(clientId).fullName });
    const orderId = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json, items_total_cents,
       payment_status, payment_paid_at, confirmed_at)
      VALUES (?, ?, 'confirmed', ?, ?, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(clientId, companyId, destination, recipient).lastInsertRowid);
    return transaction(() => createDeliveryForEligibleOrderInTransaction(orderId));
  }
  const post = (cookie, id, action, body = {}) => request(`/api/courier/deliveries/${id}/${action}`,
    { cookie, method: "POST", body });

  await context.test("isola consultas por papel, cliente e empresa", async () => {
    const own = createDelivery();
    const foreign = createDelivery(company2, client2);
    assert.equal((await request("/api/courier/deliveries/available")).status, 401);
    assert.equal((await request("/api/courier/deliveries/available", { cookie: cookies.client1 })).status, 403);
    const available = await (await request("/api/courier/deliveries/available", { cookie: cookies.courier1 })).json();
    const ownAvailable = available.deliveries.find(({ id }) => id === own.delivery.id);
    assert.ok(ownAvailable);
    assert.equal(Object.hasOwn(ownAvailable, "destination"), false);
    assert.equal(Object.hasOwn(ownAvailable, "client"), false);
    assert.equal(Object.hasOwn(ownAvailable, "itemsTotalCents"), false);
    assert.ok(!available.deliveries.some(({ id }) => id === foreign.delivery.id));
    assert.equal((await request(`/api/client/deliveries/${foreign.delivery.id}`, { cookie: cookies.client1 })).status, 404);
    assert.equal((await request(`/api/company/deliveries/${foreign.delivery.id}`, { cookie: cookies.company1 })).status, 404);
    assert.equal((await request(`/api/client/deliveries/${foreign.delivery.id}/cancel`,
      { cookie: cookies.client1, method: "POST", body: {} })).status, 404);
    assert.equal((await request(`/api/company/deliveries/${foreign.delivery.id}/product-unavailable`,
      { cookie: cookies.company1, method: "POST", body: {} })).status, 404);
    assert.equal((await request(`/api/client/deliveries/${own.delivery.id}/cancel`,
      { cookie: cookies.company1, method: "POST", body: {} })).status, 403);
    const clientDetail = await (await request(`/api/client/deliveries/${own.delivery.id}`,
      { cookie: cookies.client1 })).json();
    assert.equal(clientDetail.delivery.confirmationCode, own.confirmationCode);
    assert.doesNotMatch(JSON.stringify(clientDetail), /confirmationCodeHash|ciphertext|scrypt\$|aes-256-gcm/i);
    const companyDetail = await (await request(`/api/company/deliveries/${own.delivery.id}`,
      { cookie: cookies.company1 })).json();
    assert.equal(Object.hasOwn(companyDetail.delivery, "confirmationCode"), false);
    assert.doesNotMatch(JSON.stringify(companyDetail), /actorUserId|courierId|confirmationCodeHash/i);
    for (const body of [{}, { isOnline: 1 }, { isOnline: "false" }, { isOnline: true, courierId: courier1 }]) {
      assert.equal((await request("/api/courier/availability",
        { cookie: cookies.courier1, method: "PATCH", body })).status, 400);
    }
  });

  await context.test("falha ao registrar evento desfaz atomicamente o aceite", async () => {
    const item = createDelivery();
    db.exec(`CREATE TRIGGER fail_delivery_accepted BEFORE INSERT ON delivery_events
             WHEN NEW.event_type = 'delivery_accepted'
             BEGIN SELECT RAISE(ABORT, 'forced accepted event failure'); END;`);
    const response = await post(cookies.courier1, item.delivery.id, "accept");
    db.exec("DROP TRIGGER fail_delivery_accepted");
    assert.equal(response.status, 500);
    assert.deepEqual({ ...db.prepare("SELECT status, courier_id AS courierId, accepted_at AS acceptedAt FROM deliveries WHERE id = ?")
      .get(item.delivery.id) }, { status: "available", courierId: null, acceptedAt: null });
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM delivery_events WHERE delivery_id = ?")
      .get(item.delivery.id).total, 1);
  });

  await context.test("aceite exige disponibilidade e resolve disputa concorrente uma única vez", async () => {
    const item = createDelivery();
    assert.equal((await post(cookies.offline, item.delivery.id, "accept")).status, 409);
    assert.equal((await post(cookies.otherCourier, item.delivery.id, "accept")).status, 404);
    const responses = await Promise.all([
      post(cookies.courier1, item.delivery.id, "accept"),
      post(cookies.courier2, item.delivery.id, "accept"),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const stored = db.prepare("SELECT courier_id AS courierId, status FROM deliveries WHERE id = ?").get(item.delivery.id);
    assert.ok([courier1, courier2].includes(stored.courierId));
    assert.equal(stored.status, "heading_to_pickup");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM delivery_events WHERE delivery_id = ? AND event_type = 'delivery_accepted'")
      .get(item.delivery.id).total, 1);
    const second = createDelivery();
    const winnerCookie = stored.courierId === courier1 ? cookies.courier1 : cookies.courier2;
    assert.equal((await post(winnerCookie, second.delivery.id, "accept")).status, 409);
    db.prepare("UPDATE deliveries SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.delivery.id);
  });

  await context.test("executa fluxo normal, rejeita atalhos e conclui somente com código correto", async () => {
    const item = createDelivery();
    assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 200);
    assert.equal((await post(cookies.courier2, item.delivery.id, "arrive-pickup")).status, 404);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-destination")).status, 409);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-pickup")).status, 200);
    assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 200);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-destination")).status, 200);
    for (const code of ["111111", "222222"]) {
      const response = await post(cookies.courier1, item.delivery.id, "confirm", { code });
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /código inválido/i);
    }
    const complete = await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode });
    assert.equal(complete.status, 200);
    const delivery = (await complete.json()).delivery;
    assert.equal(delivery.status, "completed");
    assert.ok(delivery.completedAt);
    assert.equal(delivery.invalidCodeAttempts, 2);
    assert.deepEqual(delivery.events.map(({ eventType }) => eventType), [
      "delivery_created", "delivery_accepted", "courier_arrived_at_pickup", "order_collected",
      "courier_arrived_at_destination", "confirmation_code_invalid", "confirmation_code_invalid",
      "delivery_completed",
    ]);
    assert.doesNotMatch(JSON.stringify(delivery.events), /111111|222222/);
    const accepted = delivery.events.find(({ eventType }) => eventType === "delivery_accepted");
    assert.deepEqual(accepted.actor, { fullName: "motoboy1@ermes.local", role: "courier" });
    assert.equal(Object.hasOwn(accepted, "actorUserId"), false);
    assert.equal(Object.hasOwn(accepted.details, "courierId"), false);
    const clientDetail = await (await request(`/api/client/deliveries/${item.delivery.id}`,
      { cookie: cookies.client1 })).json();
    assert.equal(Object.hasOwn(clientDetail.delivery, "confirmationCode"), false);
    assert.deepEqual(clientDetail.delivery.courier, {
      fullName: "motoboy1@ermes.local", vehicleType: "motorcycle",
      vehicleIdentifier: "Moto vermelha", plate: "ABC1D23",
    });
  });

  await context.test("terceiro código inválido exige retorno e dupla verificação", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
      assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
    }
    for (const code of ["111111", "222222", "333333"]) {
      assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code })).status, 422);
    }
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status, "returning");
    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode })).status, 409);
    assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 200);
    const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).delivery.status, "returned");
  });

  await context.test("falhas antes e depois da coleta seguem redisponibilização definida", async () => {
    const before = createDelivery();
    await post(cookies.courier1, before.delivery.id, "accept");
    const failedBefore = await post(cookies.courier1, before.delivery.id, "fail", { reason: "Pneu furou" });
    assert.equal(failedBefore.status, 200);
    assert.equal((await failedBefore.json()).delivery.status, "available");
    const after = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) await post(cookies.courier1, after.delivery.id, action);
    assert.equal((await post(cookies.courier1, after.delivery.id, "fail", { reason: "Veículo avariado" })).status, 200);
    await post(cookies.courier1, after.delivery.id, "report-return");
    const confirmed = await request(`/api/company/deliveries/${after.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    const returned = (await confirmed.json()).delivery;
    assert.equal(returned.status, "available");
    assert.equal(db.prepare("SELECT courier_id AS value FROM deliveries WHERE id = ?").get(after.delivery.id).value, null);
    assert.ok(returned.events.some(({ eventType }) => eventType === "delivery_reavailable"));
  });

  await context.test("ocorrências definidas no destino exigem retorno confirmado pela empresa", async () => {
    for (const type of ["recipient_absent", "recipient_refused", "address_problem"]) {
      const item = createDelivery();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      const occurrence = await post(cookies.courier1, item.delivery.id, "occurrences", { type });
      assert.equal(occurrence.status, 200);
      assert.equal((await occurrence.json()).delivery.status, "returning");
      await post(cookies.courier1, item.delivery.id, "report-return");
      const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
        { cookie: cookies.company1, method: "POST", body: {} });
      const delivery = (await confirmed.json()).delivery;
      assert.equal(delivery.status, "returned");
      assert.ok(delivery.events.some(({ eventType }) => eventType === type));
      assert.ok(delivery.events.some(({ eventType }) => eventType === "return_confirmed"));
    }
  });

  await context.test("cancelamentos e produto indisponível preservam regras antes e depois da coleta", async () => {
    const before = createDelivery();
    const cancelled = await request(`/api/client/deliveries/${before.delivery.id}/cancel`,
      { cookie: cookies.client1, method: "POST", body: {} });
    assert.equal((await cancelled.json()).delivery.status, "cancelled");
    const unavailable = createDelivery();
    const unavailableResponse = await request(`/api/company/deliveries/${unavailable.delivery.id}/product-unavailable`,
      { cookie: cookies.company1, method: "POST", body: {} });
    const unavailableDelivery = (await unavailableResponse.json()).delivery;
    assert.equal(unavailableDelivery.status, "cancelled");
    assert.ok(unavailableDelivery.events.some(({ eventType }) => eventType === "product_unavailable"));
    const withinTolerance = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      await post(cookies.courier1, withinTolerance.delivery.id, action);
    }
    db.prepare("UPDATE deliveries SET collected_at = datetime('now', '-2 minutes') WHERE id = ?")
      .run(withinTolerance.delivery.id);
    const timely = await request(`/api/client/deliveries/${withinTolerance.delivery.id}/cancel`,
      { cookie: cookies.client1, method: "POST", body: {} });
    assert.equal((await timely.json()).delivery.status, "returning");
    assert.equal(db.prepare("SELECT order_blocked_until AS value FROM users WHERE id = ?").get(client1).value, null);
    await post(cookies.courier1, withinTolerance.delivery.id, "report-return");
    await request(`/api/company/deliveries/${withinTolerance.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    const after = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) await post(cookies.courier1, after.delivery.id, action);
    db.prepare("UPDATE deliveries SET collected_at = datetime('now', '-4 minutes') WHERE id = ?").run(after.delivery.id);
    const late = await request(`/api/client/deliveries/${after.delivery.id}/cancel`,
      { cookie: cookies.client1, method: "POST", body: {} });
    assert.equal((await late.json()).delivery.status, "returning");
    assert.ok(db.prepare("SELECT order_blocked_until > CURRENT_TIMESTAMP AS blocked FROM users WHERE id = ?")
      .get(client1).blocked);
    const blockedOrder = await request("/api/client/orders", { cookie: cookies.client1, method: "POST",
      body: { companyId: company1, items: [{ productId: product, quantity: 1 }] } });
    assert.equal(blockedOrder.status, 409);
    db.prepare("UPDATE users SET order_blocked_until = datetime('now', '-1 second') WHERE id = ?").run(client1);
    const releasedOrder = await request("/api/client/orders", { cookie: cookies.client1, method: "POST",
      body: { companyId: company1, items: [{ productId: product, quantity: 1 }] } });
    assert.equal(releasedOrder.status, 201);
  });

  await context.test("índice trata retornos como ativos e somente estados terminais liberam o motoboy", () => {
    const active = createDelivery().delivery.id;
    const second = createDelivery().delivery.id;
    const third = createDelivery().delivery.id;
    const fourth = createDelivery().delivery.id;
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'returning' WHERE id = ?")
      .run(indexCourier, active);
    assert.throws(() => db.prepare("UPDATE deliveries SET courier_id = ?, status = 'heading_to_pickup' WHERE id = ?")
      .run(indexCourier, second), /UNIQUE constraint failed/);
    db.prepare("UPDATE deliveries SET status = 'awaiting_return_confirmation' WHERE id = ?").run(active);
    assert.throws(() => db.prepare("UPDATE deliveries SET courier_id = ?, status = 'heading_to_pickup' WHERE id = ?")
      .run(indexCourier, second), /UNIQUE constraint failed/);
    db.prepare("UPDATE deliveries SET status = 'returned' WHERE id = ?").run(active);
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'heading_to_pickup' WHERE id = ?")
      .run(indexCourier, second);
    db.prepare("UPDATE deliveries SET status = 'completed' WHERE id = ?").run(second);
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'heading_to_pickup' WHERE id = ?")
      .run(indexCourier, third);
    db.prepare("UPDATE deliveries SET status = 'cancelled' WHERE id = ?").run(third);
    assert.equal(db.prepare("UPDATE deliveries SET courier_id = ?, status = 'heading_to_pickup' WHERE id = ?")
      .run(indexCourier, fourth).changes, 1);
  });
});
