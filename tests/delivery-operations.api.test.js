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
  const { createDeliveryAttemptInTransaction } = await import("../src/delivery-attempts.js");
  const { recordPaymentInTransaction } = await import("../src/finance.js");
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
    return transaction(() => {
      const result = createDeliveryForEligibleOrderInTransaction(orderId);
      recordPaymentInTransaction(db, {
        id: orderId, clientId, itemsTotalCents: 1000,
        freightTotalCents: null,
        paymentPaidAt: db.prepare("SELECT payment_paid_at AS value FROM orders WHERE id = ?")
          .get(orderId).value,
      }, result.delivery.id);
      return result;
    });
  }
  const post = (cookie, id, action, body = {}) => request(`/api/courier/deliveries/${id}/${action}`,
    { cookie, method: "POST", body });
  const storedAttempts = (deliveryId) => db.prepare(`SELECT id, delivery_id AS deliveryId,
    attempt_number AS attemptNumber, courier_id AS courierId, status,
    invalid_code_attempts AS invalidCodeAttempts,
    started_at AS startedAt, ended_at AS endedAt,
    end_reason AS endReason, end_nature AS endNature
    FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number`).all(deliveryId)
    .map((row) => ({ ...row }));

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

  await context.test("motoboy consulta a própria atribuição após aceitar a entrega", async () => {
    const item = createDelivery();
    const available = await (await request("/api/courier/deliveries/available",
      { cookie: cookies.courier1 })).json();
    const availableDelivery = available.deliveries.find(({ id }) => id === item.delivery.id);
    assert.ok(availableDelivery);
    assert.equal(db.prepare("SELECT courier_id AS courierId FROM deliveries WHERE id = ?")
      .get(item.delivery.id).courierId, null);
    assert.equal(Object.hasOwn(availableDelivery, "courier"), false);

    const accepted = await post(cookies.courier1, item.delivery.id, "accept");
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).delivery.status, "heading_to_pickup");

    const current = await (await request("/api/courier/deliveries/current",
      { cookie: cookies.courier1 })).json();
    assert.equal(current.delivery.id, item.delivery.id);
    assert.equal(current.delivery.status, "heading_to_pickup");
    assert.deepEqual(current.delivery.courier, {
      fullName: "motoboy1@ermes.local",
      vehicleType: "motorcycle",
      vehicleIdentifier: "Moto vermelha",
      plate: "ABC1D23",
    });
    assert.deepEqual(Object.keys(current.delivery.courier).sort(),
      ["fullName", "plate", "vehicleIdentifier", "vehicleType"]);

    db.prepare("UPDATE deliveries SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(item.delivery.id);
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

  await context.test("não cria tentativa antes da coleta nem na falha pré-coleta", async () => {
    const item = createDelivery();
    assert.deepEqual(storedAttempts(item.delivery.id), []);
    assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 200);
    assert.deepEqual(storedAttempts(item.delivery.id), []);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-pickup")).status, 200);
    assert.deepEqual(storedAttempts(item.delivery.id), []);
    const failed = await post(cookies.courier1, item.delivery.id, "fail", { reason: "Pneu furou" });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).delivery.status, "available");
    assert.deepEqual(storedAttempts(item.delivery.id), []);
  });

  await context.test("coleta cria atomicamente a tentativa 1 e código válido a conclui", async () => {
    const item = createDelivery();
    await post(cookies.courier1, item.delivery.id, "accept");
    await post(cookies.courier1, item.delivery.id, "arrive-pickup");
    const collectedResponse = await post(cookies.courier1, item.delivery.id, "collect");
    assert.equal(collectedResponse.status, 200);
    const collected = (await collectedResponse.json()).delivery;
    const attempts = storedAttempts(item.delivery.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attemptNumber, 1);
    assert.equal(attempts[0].courierId, courier1);
    assert.equal(attempts[0].status, "active");
    assert.match(attempts[0].startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(attempts[0].endedAt, null);
    assert.deepEqual(collected.attempts.map(({ attemptNumber, status, courier }) => (
      { attemptNumber, status, courier }
    )), [{ attemptNumber: 1, status: "active", courier: { fullName: "motoboy1@ermes.local" } }]);
    assert.deepEqual({ ...db.prepare(`SELECT confirmation_code_hash IS NOT NULL AS hasHash,
      confirmation_code_ciphertext IS NOT NULL AS hasCiphertext
      FROM deliveries WHERE id = ?`).get(item.delivery.id) }, { hasHash: 1, hasCiphertext: 1 });
    const attemptColumns = db.prepare("PRAGMA table_info(delivery_attempts)").all().map(({ name }) => name);
    assert.ok(!attemptColumns.some((name) => name.includes("confirmation_code")));
    assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 409);
    assert.equal(storedAttempts(item.delivery.id).length, 1);

    await post(cookies.courier1, item.delivery.id, "arrive-destination");
    const completedResponse = await post(cookies.courier1, item.delivery.id, "confirm", {
      code: item.confirmationCode,
    });
    assert.equal(completedResponse.status, 200);
    const completedAttempt = storedAttempts(item.delivery.id)[0];
    assert.equal(completedAttempt.status, "completed");
    assert.match(completedAttempt.endedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(completedAttempt.endReason, null);
    assert.equal(completedAttempt.endNature, null);
    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", {
      code: item.confirmationCode,
    })).status, 409);
    assert.equal(storedAttempts(item.delivery.id).length, 1);
  });

  await context.test("falha no evento da coleta desfaz tentativa, horário e transição", async () => {
    const item = createDelivery();
    await post(cookies.courier1, item.delivery.id, "accept");
    await post(cookies.courier1, item.delivery.id, "arrive-pickup");
    db.exec(`CREATE TRIGGER fail_order_collected BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'order_collected'
      BEGIN SELECT RAISE(ABORT, 'forced collected event failure'); END;`);
    const failed = await post(cookies.courier1, item.delivery.id, "collect");
    db.exec("DROP TRIGGER fail_order_collected");
    assert.equal(failed.status, 500);
    assert.deepEqual({ ...db.prepare(`SELECT status, collected_at AS collectedAt
      FROM deliveries WHERE id = ?`).get(item.delivery.id) }, {
      status: "awaiting_pickup", collectedAt: null,
    });
    assert.deepEqual(storedAttempts(item.delivery.id), []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'order_collected'`).get(item.delivery.id).total, 0);
    await post(cookies.courier1, item.delivery.id, "collect");
    await post(cookies.courier1, item.delivery.id, "arrive-destination");
    await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode });
  });

  await context.test("coletas concorrentes convergem para uma única tentativa ativa", async () => {
    const item = createDelivery();
    await post(cookies.courier1, item.delivery.id, "accept");
    await post(cookies.courier1, item.delivery.id, "arrive-pickup");
    const responses = await Promise.all([
      post(cookies.courier1, item.delivery.id, "collect"),
      post(cookies.courier1, item.delivery.id, "collect"),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const attempts = storedAttempts(item.delivery.id);
    assert.equal(attempts.length, 1);
    assert.deepEqual({ attemptNumber: attempts[0].attemptNumber, status: attempts[0].status }, {
      attemptNumber: 1, status: "active",
    });
    await post(cookies.courier1, item.delivery.id, "arrive-destination");
    await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode });
  });

  await context.test("Entrega legada pós-coleta sem tentativa exige reconciliação explícita", async () => {
    const item = createDelivery();
    db.prepare(`UPDATE deliveries SET courier_id = ?, status = 'awaiting_confirmation',
      accepted_at = CURRENT_TIMESTAMP, collected_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(courier1, item.delivery.id);
    const response = await post(cookies.courier1, item.delivery.id, "confirm", {
      code: item.confirmationCode,
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /reconciliação dos dados legados/i);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
      "awaiting_confirmation");
    assert.deepEqual(storedAttempts(item.delivery.id), []);
    db.prepare("UPDATE deliveries SET courier_id = NULL, status = 'cancelled' WHERE id = ?")
      .run(item.delivery.id);
  });

  await context.test("índice impede duas tentativas abertas e cada Entrega inicia sua sequência em 1", async () => {
    const first = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      await post(cookies.courier1, first.delivery.id, action);
    }
    assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, courier_id, status) VALUES (?, 2, ?, 'active')`)
      .run(first.delivery.id, courier1), /UNIQUE constraint failed/);
    await post(cookies.courier1, first.delivery.id, "arrive-destination");
    await post(cookies.courier1, first.delivery.id, "confirm", { code: first.confirmationCode });

    const second = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      await post(cookies.courier1, second.delivery.id, action);
    }
    assert.equal(storedAttempts(second.delivery.id)[0].attemptNumber, 1);
    await post(cookies.courier1, second.delivery.id, "arrive-destination");
    await post(cookies.courier1, second.delivery.id, "confirm", { code: second.confirmationCode });
  });

  await context.test("criação interna valida inteiro, papel, empresa e atribuição do motoboy", () => {
    const invalidRole = createDelivery().delivery.id;
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'awaiting_pickup' WHERE id = ?")
      .run(client1, invalidRole);
    assert.throws(() => transaction(() => createDeliveryAttemptInTransaction(db, invalidRole, client1)),
      /motoboy atribuído não é válido/i);
    assert.equal(storedAttempts(invalidRole).length, 0);
    db.prepare("UPDATE deliveries SET courier_id = NULL, status = 'cancelled' WHERE id = ?").run(invalidRole);

    const wrongCompany = createDelivery().delivery.id;
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'awaiting_pickup' WHERE id = ?")
      .run(otherCourier, wrongCompany);
    assert.throws(() => transaction(() => createDeliveryAttemptInTransaction(db, wrongCompany, otherCourier)),
      /motoboy atribuído não é válido/i);
    assert.equal(storedAttempts(wrongCompany).length, 0);
    db.prepare("UPDATE deliveries SET courier_id = NULL, status = 'cancelled' WHERE id = ?").run(wrongCompany);

    const wrongAssignment = createDelivery().delivery.id;
    db.prepare("UPDATE deliveries SET courier_id = ?, status = 'awaiting_pickup' WHERE id = ?")
      .run(courier1, wrongAssignment);
    assert.throws(() => transaction(() => createDeliveryAttemptInTransaction(db, wrongAssignment, courier2)),
      /motoboy atribuído não é válido/i);
    assert.throws(() => transaction(() => createDeliveryAttemptInTransaction(db, wrongAssignment, 1.5)),
      /identificadores inteiros positivos/i);
    assert.equal(storedAttempts(wrongAssignment).length, 0);
    db.prepare("UPDATE deliveries SET courier_id = NULL, status = 'cancelled' WHERE id = ?")
      .run(wrongAssignment);
  });

  await context.test("cada tentativa 2 começa em zero após 0, 1 ou 2 erros na tentativa anterior", async () => {
    for (const previousInvalidAttempts of [0, 1, 2]) {
      const item = createDelivery();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      const wrongCodes = ["111111", "222222", "333333", "444444"]
        .filter((code) => code !== item.confirmationCode).slice(0, 3);
      for (const code of wrongCodes.slice(0, previousInvalidAttempts)) {
        assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code })).status, 422);
      }
      assert.equal(storedAttempts(item.delivery.id)[0].invalidCodeAttempts, previousInvalidAttempts);
      assert.equal(db.prepare("SELECT invalid_code_attempts AS value FROM deliveries WHERE id = ?")
        .get(item.delivery.id).value, 0);

      assert.equal((await post(cookies.courier1, item.delivery.id, "fail", {
        reason: "Veículo avariado",
      })).status, 200);
      assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 409);
      assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 200);
      assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 409);
      const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
        { cookie: cookies.company1, method: "POST", body: {} });
      assert.equal(confirmed.status, 200);
      const firstAttempt = storedAttempts(item.delivery.id)[0];
      assert.deepEqual({
        status: firstAttempt.status,
        invalidCodeAttempts: firstAttempt.invalidCodeAttempts,
        endNature: firstAttempt.endNature,
        endReason: firstAttempt.endReason,
      }, {
        status: "closed_unsuccessfully",
        invalidCodeAttempts: previousInvalidAttempts,
        endNature: "recoverable",
        endReason: "courier_failure_after_pickup",
      });

      for (const action of ["accept", "arrive-pickup", "collect"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      let attempts = storedAttempts(item.delivery.id);
      assert.deepEqual(attempts.map(({ attemptNumber, status, invalidCodeAttempts }) => ({
        attemptNumber, status, invalidCodeAttempts,
      })), [
        { attemptNumber: 1, status: "closed_unsuccessfully", invalidCodeAttempts: previousInvalidAttempts },
        { attemptNumber: 2, status: "active", invalidCodeAttempts: 0 },
      ]);
      assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-destination")).status, 200);

      const firstInvalid = await post(cookies.courier1, item.delivery.id, "confirm", { code: wrongCodes[0] });
      assert.equal(firstInvalid.status, 422);
      assert.equal((await firstInvalid.json()).delivery.invalidCodeAttempts, 1);
      attempts = storedAttempts(item.delivery.id);
      assert.equal(attempts[1].invalidCodeAttempts, 1);
      assert.equal(attempts[1].status, "active");

      if (previousInvalidAttempts < 2) {
        const completed = await post(cookies.courier1, item.delivery.id, "confirm", {
          code: item.confirmationCode,
        });
        assert.equal(completed.status, 200);
        assert.equal((await completed.json()).delivery.status, "completed");
      } else {
        for (const code of wrongCodes.slice(1, 3)) {
          assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code })).status, 422);
        }
        const secondAttempt = storedAttempts(item.delivery.id)[1];
        assert.deepEqual({ status: secondAttempt.status, invalidCodeAttempts: secondAttempt.invalidCodeAttempts },
          { status: "returning", invalidCodeAttempts: 3 });
        assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
          "returning");
        await post(cookies.courier1, item.delivery.id, "report-return");
        await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
          cookie: cookies.company1, method: "POST", body: {},
        });
      }
    }
  });

  await context.test("executa fluxo normal, rejeita atalhos e conclui somente com código correto", async () => {
    const item = createDelivery();
    assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 200);
    assert.equal((await post(cookies.courier2, item.delivery.id, "arrive-pickup")).status, 404);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-destination")).status, 409);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-pickup")).status, 200);
    assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 200);
    assert.equal((await post(cookies.courier1, item.delivery.id, "arrive-destination")).status, 200);
    const wrongCodes = ["111111", "222222", "333333"]
      .filter((code) => code !== item.confirmationCode).slice(0, 2);
    for (const code of wrongCodes) {
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
    for (const code of wrongCodes) assert.equal(JSON.stringify(delivery.events).includes(code), false);
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
    const wrongCodes = ["111111", "222222", "333333", "444444"]
      .filter((code) => code !== item.confirmationCode).slice(0, 3);
    for (const code of wrongCodes) {
      assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code })).status, 422);
    }
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status, "returning");
    const returningAttempt = storedAttempts(item.delivery.id)[0];
    assert.equal(returningAttempt.status, "returning");
    assert.equal(returningAttempt.endedAt, null);
    assert.equal(returningAttempt.endNature, null);
    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode })).status, 409);
    assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 200);
    const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).delivery.status, "returned");
    const failedAttempt = storedAttempts(item.delivery.id)[0];
    assert.deepEqual({
      status: failedAttempt.status,
      invalidCodeAttempts: failedAttempt.invalidCodeAttempts,
      endReason: failedAttempt.endReason,
      endNature: failedAttempt.endNature,
    }, {
      status: "closed_unsuccessfully",
      invalidCodeAttempts: 3,
      endReason: "confirmation_failed",
      endNature: "terminal",
    });
    const failureEvent = db.prepare(`SELECT details_json AS detailsJson FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'confirmation_failed'`).get(item.delivery.id);
    assert.deepEqual(JSON.parse(failureEvent.detailsJson), { attempt: 3, remainingAttempts: 0 });
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
    const returningAttempt = storedAttempts(after.delivery.id)[0];
    assert.equal(returningAttempt.status, "returning");
    assert.equal(returningAttempt.endedAt, null);
    assert.equal(returningAttempt.endNature, null);
    await post(cookies.courier1, after.delivery.id, "report-return");
    const confirmed = await request(`/api/company/deliveries/${after.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    const returned = (await confirmed.json()).delivery;
    assert.equal(returned.status, "available");
    assert.equal(db.prepare("SELECT courier_id AS value FROM deliveries WHERE id = ?").get(after.delivery.id).value, null);
    assert.ok(returned.events.some(({ eventType }) => eventType === "delivery_reavailable"));
    const closedAttempt = storedAttempts(after.delivery.id)[0];
    assert.equal(closedAttempt.status, "closed_unsuccessfully");
    assert.match(closedAttempt.endedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(closedAttempt.endNature, "recoverable");
    assert.equal(closedAttempt.endReason, "courier_failure_after_pickup");
  });

  await context.test("falha no evento ao iniciar retorno restaura tentativa e Entrega", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
    }
    db.exec(`CREATE TRIGGER fail_courier_return_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'courier_failed_after_pickup'
      BEGIN SELECT RAISE(ABORT, 'forced return start event failure'); END;`);
    const failed = await post(cookies.courier1, item.delivery.id, "fail", { reason: "Pane" });
    db.exec("DROP TRIGGER fail_courier_return_event");
    assert.equal(failed.status, 500);
    assert.deepEqual({ ...db.prepare(`SELECT status, return_reason AS returnReason
      FROM deliveries WHERE id = ?`).get(item.delivery.id) }, {
      status: "in_transit", returnReason: null,
    });
    assert.deepEqual(storedAttempts(item.delivery.id).map(({ status, endedAt }) => ({ status, endedAt })), [
      { status: "active", endedAt: null },
    ]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'courier_failed_after_pickup'`).get(item.delivery.id).total, 0);

    await post(cookies.courier1, item.delivery.id, "fail", { reason: "Encerramento do teste" });
    await post(cookies.courier1, item.delivery.id, "report-return");
    await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
  });

  await context.test("falha no evento final desfaz encerramento recuperável e redisponibilização", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      await post(cookies.courier1, item.delivery.id, action);
    }
    await post(cookies.courier1, item.delivery.id, "fail", { reason: "Pane recuperável" });
    await post(cookies.courier1, item.delivery.id, "report-return");
    const before = { ...db.prepare(`SELECT status, courier_id AS courierId,
      collected_at AS collectedAt, return_reason AS returnReason,
      return_reported_at AS returnReportedAt FROM deliveries WHERE id = ?`).get(item.delivery.id) };
    db.exec(`CREATE TRIGGER fail_reavailable_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'delivery_reavailable'
      BEGIN SELECT RAISE(ABORT, 'forced recoverable close event failure'); END;`);
    const failed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    db.exec("DROP TRIGGER fail_reavailable_event");
    assert.equal(failed.status, 500);
    assert.deepEqual({ ...db.prepare(`SELECT status, courier_id AS courierId,
      collected_at AS collectedAt, return_reason AS returnReason,
      return_reported_at AS returnReportedAt FROM deliveries WHERE id = ?`).get(item.delivery.id) }, before);
    assert.deepEqual(storedAttempts(item.delivery.id).map(({ status, endedAt, endNature }) => (
      { status, endedAt, endNature }
    )), [{ status: "returning", endedAt: null, endNature: null }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'delivery_reavailable'`).get(item.delivery.id).total, 0);

    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
  });

  await context.test("ocorrências definidas no destino exigem retorno confirmado pela empresa", async () => {
    for (const type of ["recipient_absent", "recipient_refused"]) {
      const item = createDelivery();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      const occurrence = await post(cookies.courier1, item.delivery.id, "occurrences", { type });
      assert.equal(occurrence.status, 200);
      assert.equal((await occurrence.json()).delivery.status, "returning");
      const returningAttempt = storedAttempts(item.delivery.id)[0];
      assert.equal(returningAttempt.status, "returning");
      assert.equal(returningAttempt.endedAt, null);
      assert.equal(returningAttempt.endNature, null);
      await post(cookies.courier1, item.delivery.id, "report-return");
      const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
        { cookie: cookies.company1, method: "POST", body: {} });
      const delivery = (await confirmed.json()).delivery;
      assert.equal(delivery.status, "returned");
      assert.ok(delivery.events.some(({ eventType }) => eventType === type));
      assert.ok(delivery.events.some(({ eventType }) => eventType === "return_confirmed"));
      const closedAttempt = storedAttempts(item.delivery.id)[0];
      assert.equal(closedAttempt.status, "closed_unsuccessfully");
      assert.match(closedAttempt.endedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(closedAttempt.endNature, "terminal");
      assert.equal(closedAttempt.endReason, type);
    }
  });

  await context.test("problema genérico de endereço é rejeitado sem efeitos colaterais", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
      assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
    }
    const deliveryBefore = { ...db.prepare(`SELECT status, return_reason AS returnReason
      FROM deliveries WHERE id = ?`).get(item.delivery.id) };
    const attemptBefore = storedAttempts(item.delivery.id);
    const eventsBefore = db.prepare("SELECT COUNT(*) AS total FROM delivery_events WHERE delivery_id = ?")
      .get(item.delivery.id).total;
    const financialBefore = db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE delivery_id = ?")
      .get(item.delivery.id).total;

    assert.equal((await post(cookies.otherCourier, item.delivery.id, "occurrences", {
      type: "address_problem",
    })).status, 404);
    const response = await post(cookies.courier1, item.delivery.id, "occurrences", {
      type: "address_problem",
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /classificação de ocorrências da Baseline 0\.2/i);
    assert.deepEqual({ ...db.prepare(`SELECT status, return_reason AS returnReason
      FROM deliveries WHERE id = ?`).get(item.delivery.id) }, deliveryBefore);
    assert.deepEqual(storedAttempts(item.delivery.id), attemptBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM delivery_events WHERE delivery_id = ?")
      .get(item.delivery.id).total, eventsBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE delivery_id = ?")
      .get(item.delivery.id).total, financialBefore);

    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", {
      code: item.confirmationCode,
    })).status, 200);
  });

  await context.test("falha no evento final desfaz encerramento terminal do retorno", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
      await post(cookies.courier1, item.delivery.id, action);
    }
    await post(cookies.courier1, item.delivery.id, "occurrences", { type: "recipient_absent" });
    await post(cookies.courier1, item.delivery.id, "report-return");
    const before = { ...db.prepare(`SELECT status, courier_id AS courierId,
      returned_at AS returnedAt FROM deliveries WHERE id = ?`).get(item.delivery.id) };
    db.exec(`CREATE TRIGGER fail_return_confirmed_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'return_confirmed'
      BEGIN SELECT RAISE(ABORT, 'forced terminal close event failure'); END;`);
    const failed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    db.exec("DROP TRIGGER fail_return_confirmed_event");
    assert.equal(failed.status, 500);
    assert.deepEqual({ ...db.prepare(`SELECT status, courier_id AS courierId,
      returned_at AS returnedAt FROM deliveries WHERE id = ?`).get(item.delivery.id) }, before);
    assert.deepEqual(storedAttempts(item.delivery.id).map(({ status, endedAt, endNature }) => (
      { status, endedAt, endNature }
    )), [{ status: "returning", endedAt: null, endNature: null }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'return_confirmed'`).get(item.delivery.id).total, 0);

    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
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
    const afterPickup = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      await post(cookies.courier1, afterPickup.delivery.id, action);
    }
    db.prepare("UPDATE users SET order_blocked_until = '2099-01-01 00:00:00' WHERE id = ?").run(client1);
    db.prepare("UPDATE deliveries SET collected_at = datetime('now', '-4 minutes') WHERE id = ?")
      .run(afterPickup.delivery.id);
    const cancelledAfterPickup = await request(`/api/client/deliveries/${afterPickup.delivery.id}/cancel`,
      { cookie: cookies.client1, method: "POST", body: {} });
    const cancelledAfterPickupDelivery = (await cancelledAfterPickup.json()).delivery;
    assert.equal(cancelledAfterPickupDelivery.status, "returning");
    const cancellationEvent = cancelledAfterPickupDelivery.events.find(
      ({ eventType }) => eventType === "client_cancelled_after_pickup",
    );
    assert.deepEqual(cancellationEvent.details, {});
    await post(cookies.courier1, afterPickup.delivery.id, "report-return");
    await request(`/api/company/deliveries/${afterPickup.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    const orderDespiteLegacyValue = await request("/api/client/orders", { cookie: cookies.client1, method: "POST",
      body: { companyId: company1, items: [{ productId: product, quantity: 1 }] } });
    const orderDespiteLegacyBody = await orderDespiteLegacyValue.json();
    assert.equal(orderDespiteLegacyValue.status, 201, orderDespiteLegacyBody.error);
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
