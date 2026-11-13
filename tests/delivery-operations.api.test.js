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
  const { createDeliveryOccurrenceInTransaction } = await import("../src/delivery-occurrences.js");
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
  function createDelivery(companyId = company1, clientId = client1, withStoredItem = false) {
    const recipient = JSON.stringify({ type: "self",
      name: db.prepare("SELECT full_name AS fullName FROM users WHERE id = ?").get(clientId).fullName });
    const orderId = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json, items_total_cents,
       payment_status, payment_paid_at, confirmed_at)
      VALUES (?, ?, 'confirmed', ?, ?, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(clientId, companyId, destination, recipient).lastInsertRowid);
    if (withStoredItem) {
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, 1000, 1)`).run(orderId, product);
    }
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
  async function failConfirmation(item) {
    const wrong = item.confirmationCode === "111111" ? "222222" : "111111";
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code: wrong })).status, 422);
    }
  }
  const storedAttempts = (deliveryId) => db.prepare(`SELECT id, delivery_id AS deliveryId,
    attempt_number AS attemptNumber, courier_id AS courierId, status,
    invalid_code_attempts AS invalidCodeAttempts,
    started_at AS startedAt, ended_at AS endedAt,
    end_reason AS endReason, end_nature AS endNature
    FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number`).all(deliveryId)
    .map((row) => ({ ...row }));
  const storedOccurrences = (deliveryId) => db.prepare(`SELECT id, delivery_id AS deliveryId,
    delivery_attempt_id AS deliveryAttemptId, type, description,
    reported_by_user_id AS reportedByUserId, reported_at AS reportedAt,
    evidence_json AS evidenceJson, responsibility,
    classified_by_user_id AS classifiedByUserId, classified_at AS classifiedAt,
    analysis_result AS analysisResult
    FROM delivery_occurrences WHERE delivery_id = ? ORDER BY id`).all(deliveryId)
    .map(({ evidenceJson, ...row }) => ({ ...row, evidence: JSON.parse(evidenceJson) }));

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
    const [occurrence] = storedOccurrences(item.delivery.id);
    assert.deepEqual({
      type: occurrence.type,
      deliveryAttemptId: occurrence.deliveryAttemptId,
      description: occurrence.description,
      reportedByUserId: occurrence.reportedByUserId,
      responsibility: occurrence.responsibility,
      evidence: occurrence.evidence,
    }, {
      type: "courier_failure_before_pickup",
      deliveryAttemptId: null,
      description: "Pneu furou",
      reportedByUserId: courier1,
      responsibility: null,
      evidence: { deliveryState: "awaiting_pickup" },
    });
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
      assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 409);
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
    for (const [index, code] of wrongCodes.entries()) {
      assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code })).status, 422);
      const attempt = storedAttempts(item.delivery.id)[0];
      assert.equal(attempt.invalidCodeAttempts, index + 1);
      assert.equal(attempt.status, index === 2 ? "returning" : "active");
      assert.equal(attempt.endedAt, null);
    }
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status, "returning");
    const returningAttempt = storedAttempts(item.delivery.id)[0];
    assert.equal(returningAttempt.status, "returning");
    assert.equal(returningAttempt.endedAt, null);
    assert.equal(returningAttempt.endNature, null);
    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", { code: item.confirmationCode })).status, 409);
    const occurrencesAfterRetry = storedOccurrences(item.delivery.id);
    assert.equal(occurrencesAfterRetry.length, 1);
    assert.equal(occurrencesAfterRetry[0].responsibility, null);
    assert.equal(storedAttempts(item.delivery.id)[0].invalidCodeAttempts, 3);
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
    const failureDetails = JSON.parse(failureEvent.detailsJson);
    assert.deepEqual({ ...failureDetails, occurrenceId: undefined }, {
      attempt: 3, remainingAttempts: 0, occurrenceId: undefined,
    });
    assert.ok(Number.isSafeInteger(failureDetails.occurrenceId));
    const [occurrence] = storedOccurrences(item.delivery.id);
    assert.equal(occurrence.id, failureDetails.occurrenceId);
    assert.equal(occurrence.type, "confirmation_failed");
    assert.equal(occurrence.deliveryAttemptId, returningAttempt.id);
    assert.equal(occurrence.responsibility, null);
    assert.deepEqual(occurrence.evidence, { invalidCodeAttempts: 3 });
  });

  await context.test("falhas antes e depois da coleta seguem redisponibilização definida", async () => {
    const before = createDelivery();
    await post(cookies.courier1, before.delivery.id, "accept");
    const failedBefore = await post(cookies.courier1, before.delivery.id, "fail", { reason: "Pneu furou" });
    assert.equal(failedBefore.status, 200);
    assert.equal((await failedBefore.json()).delivery.status, "available");
    assert.equal(storedOccurrences(before.delivery.id)[0].deliveryAttemptId, null);
    const after = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) await post(cookies.courier1, after.delivery.id, action);
    assert.equal((await post(cookies.courier1, after.delivery.id, "fail", { reason: "Veículo avariado" })).status, 200);
    const returningAttempt = storedAttempts(after.delivery.id)[0];
    const afterOccurrence = storedOccurrences(after.delivery.id)[0];
    assert.equal(afterOccurrence.type, "courier_failure_after_pickup");
    assert.equal(afterOccurrence.deliveryAttemptId, returningAttempt.id);
    assert.equal(returningAttempt.status, "returning");
    assert.equal(returningAttempt.endedAt, null);
    assert.equal(returningAttempt.endNature, null);
    assert.equal((await post(cookies.courier1, after.delivery.id, "fail", {
      reason: "Repetição indevida",
    })).status, 409);
    assert.equal(storedOccurrences(after.delivery.id).length, 1);
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
    assert.equal(storedOccurrences(item.delivery.id).length, 0);

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
    for (const type of ["recipient_absent", "recipient_refused", "confirmation_failed"]) {
      const item = createDelivery(company1, client1, true);
      const financialBefore = db.prepare("SELECT * FROM financial_entries ORDER BY id").all();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      if (type === "confirmation_failed") await failConfirmation(item);
      else assert.equal((await post(cookies.courier1, item.delivery.id, "occurrences", { type })).status, 200);
      const returningDelivery = (await (await request(`/api/company/deliveries/${item.delivery.id}`, {
        cookie: cookies.company1,
      })).json()).delivery;
      assert.equal(returningDelivery.status, "returning");
      assert.equal(returningDelivery.officialStatus, "RETORNO_AO_ESTABELECIMENTO");
      assert.equal(returningDelivery.orderOfficialStatus, "CONFIRMADO");
      assert.equal((await post(cookies.courier1, item.delivery.id,
        type === "confirmation_failed" ? "confirm" : "occurrences",
        type === "confirmation_failed" ? { code: item.confirmationCode } : { type })).status, 409);
      assert.equal(storedOccurrences(item.delivery.id).length, 1);
      const returningAttempt = storedAttempts(item.delivery.id)[0];
      assert.equal(returningAttempt.status, "returning");
      assert.equal(returningAttempt.endedAt, null);
      assert.equal(returningAttempt.endNature, null);
      const reported = await post(cookies.courier1, item.delivery.id, "report-return");
      assert.equal(reported.status, 200);
      const reportedDelivery = (await reported.json()).delivery;
      assert.equal(reportedDelivery.status, "awaiting_return_confirmation");
      assert.equal(reportedDelivery.officialStatus, "RETORNO_AO_ESTABELECIMENTO");
      assert.equal(reportedDelivery.orderOfficialStatus, "CONFIRMADO");
      assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 409);
      const confirmed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`,
        { cookie: cookies.company1, method: "POST", body: {} });
      assert.equal(confirmed.status, 200);
      const delivery = (await confirmed.json()).delivery;
      assert.equal(delivery.status, "returned");
      assert.equal(delivery.officialStatus, "NAO_REALIZADA");
      assert.equal(delivery.orderOfficialStatus, "ENCERRADO");
      assert.equal(delivery.courier, null);
      assert.match(delivery.returnedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.ok(delivery.events.some(({ eventType }) => eventType === type));
      assert.ok(delivery.events.some(({ eventType }) => eventType === "return_confirmed"));
      const closedAttempt = storedAttempts(item.delivery.id)[0];
      assert.equal(closedAttempt.status, "closed_unsuccessfully");
      assert.match(closedAttempt.endedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(closedAttempt.endNature, "terminal");
      assert.equal(closedAttempt.endReason, type);
      const [storedOccurrence] = storedOccurrences(item.delivery.id);
      assert.equal(storedOccurrence.type, type);
      assert.equal(storedOccurrence.deliveryAttemptId, closedAttempt.id);
      assert.equal(storedOccurrence.responsibility, null);

      const clientDetail = await (await request(`/api/client/deliveries/${item.delivery.id}`, {
        cookie: cookies.client1,
      })).json();
      const companyDetail = await (await request(`/api/company/deliveries/${item.delivery.id}`, {
        cookie: cookies.company1,
      })).json();
      for (const projected of [clientDetail.delivery, companyDetail.delivery]) {
        assert.equal(projected.officialStatus, "NAO_REALIZADA");
        assert.equal(projected.orderOfficialStatus, "ENCERRADO");
      }
      assert.equal(Object.hasOwn(clientDetail.delivery, "confirmationCode"), false);
      const clientList = await (await request("/api/client/deliveries", {
        cookie: cookies.client1,
      })).json();
      const companyList = await (await request("/api/company/deliveries", {
        cookie: cookies.company1,
      })).json();
      assert.equal(clientList.deliveries.find(({ id }) => id === item.delivery.id).officialStatus,
        "NAO_REALIZADA");
      assert.equal(companyList.deliveries.find(({ id }) => id === item.delivery.id).officialStatus,
        "NAO_REALIZADA");
      const orderDetail = await request(`/api/client/orders/confirmed/${item.delivery.orderId}`, {
        cookie: cookies.client1,
      });
      assert.equal(orderDetail.status, 200);
      assert.equal((await orderDetail.json()).order.officialStatus, "ENCERRADO");

      const repeatedPayment = await request(`/api/client/orders/${item.delivery.orderId}/pay`, {
        cookie: cookies.client1, method: "POST", body: {},
      });
      assert.equal(repeatedPayment.status, 200);
      const repeatedPaymentBody = await repeatedPayment.json();
      assert.equal(repeatedPaymentBody.created, false);
      assert.equal(repeatedPaymentBody.delivery.id, item.delivery.id);
      assert.equal(repeatedPaymentBody.delivery.officialStatus, "NAO_REALIZADA");
      assert.equal(repeatedPaymentBody.confirmationCode, null);

      assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 409);
      assert.equal((await post(cookies.courier1, item.delivery.id, "collect")).status, 404);
      assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", {
        code: item.confirmationCode,
      })).status, 404);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/revalidate`, {
        cookie: cookies.company1, method: "POST", body: {
          revalidationId: Number.MAX_SAFE_INTEGER,
          release: true,
          verificationResult: "Não deve reabrir uma entrega terminal.",
        },
      })).status, 404);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 409);

      assert.equal(storedAttempts(item.delivery.id).length, 1);
      assert.equal(storedOccurrences(item.delivery.id).length, 1);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_revalidations
        WHERE delivery_id = ?`).get(item.delivery.id).total, 0);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
        WHERE delivery_id = ? AND event_type = 'return_confirmed'`)
        .get(item.delivery.id).total, 1);
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries ORDER BY id").all(), financialBefore);
      const currentCourier = await (await request("/api/courier/deliveries/current", {
        cookie: cookies.courier1,
      })).json();
      assert.equal(currentCourier.delivery, null);
    }
  });

  await context.test("falha de código terminal mantém classificação separada e ledger intacto", async () => {
    for (const responsibility of ["CLIENTE", "MOTOBOY", "SISTEMA", "INDEFINIDO"]) {
      const item = createDelivery(company1, client1, true);
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      const ledger = db.prepare("SELECT * FROM financial_entries ORDER BY id").all();
      const code = { ...db.prepare(`SELECT confirmation_code_hash, confirmation_code_ciphertext
        FROM deliveries WHERE id = ?`).get(item.delivery.id) };
      await failConfirmation(item);
      const [occurrence] = storedOccurrences(item.delivery.id);
      assert.equal(occurrence.responsibility, null);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 409);
      await post(cookies.courier1, item.delivery.id, "report-return");
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      assert.equal(storedOccurrences(item.delivery.id)[0].responsibility, null);
      const attempt = storedAttempts(item.delivery.id);
      const delivery = { ...db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id) };
      const classify = (value) => request(`/api/company/delivery-occurrences/${occurrence.id}/classify`, {
        cookie: cookies.company1, method: "POST", body: { responsibility: value },
      });
      assert.equal((await classify(responsibility)).status, 200);
      assert.equal(storedOccurrences(item.delivery.id)[0].responsibility, responsibility);
      assert.equal((await classify("INDEFINIDO")).status, 409);
      assert.deepEqual(storedAttempts(item.delivery.id), attempt);
      assert.deepEqual({ ...db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id) }, delivery);
      assert.deepEqual({ ...db.prepare(`SELECT confirmation_code_hash, confirmation_code_ciphertext
        FROM deliveries WHERE id = ?`).get(item.delivery.id) }, code);
      const detail = (await (await request(`/api/company/deliveries/${item.delivery.id}`, {
        cookie: cookies.company1,
      })).json()).delivery;
      assert.equal(detail.officialStatus, "NAO_REALIZADA");
      assert.equal(detail.orderOfficialStatus, "ENCERRADO");
      assert.notEqual(detail.orderOfficialStatus, "RECUSADO");
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries ORDER BY id").all(), ledger);
    }
  });

  await context.test("projeções legadas de falha de código exigem evidência coerente", async () => {
    const mutations = [
      "UPDATE delivery_attempts SET invalid_code_attempts = 2 WHERE delivery_id = ?",
      "UPDATE delivery_occurrences SET delivery_attempt_id = NULL WHERE delivery_id = ?",
      "DELETE FROM delivery_occurrences WHERE delivery_id = ?",
      "DELETE FROM delivery_attempts WHERE delivery_id = ?",
      "UPDATE deliveries SET return_reported_at = NULL WHERE id = ?",
      "UPDATE delivery_events SET details_json = '{}' WHERE delivery_id = ? AND event_type = 'confirmation_failed'",
      "DELETE FROM delivery_events WHERE delivery_id = ? AND event_type = 'confirmation_code_invalid'",
      "INSERT INTO delivery_events (delivery_id, event_type) VALUES (?, 'recipient_absent')",
    ];
    for (const mutation of mutations) {
      const item = createDelivery(company1, client1, true);
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      await failConfirmation(item);
      await post(cookies.courier1, item.delivery.id, "report-return");
      const ledger = db.prepare("SELECT * FROM financial_entries ORDER BY id").all();
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      db.exec("SAVEPOINT ambiguous_legacy_confirmation");
      try {
        // Simula banco legado inconsistente apenas dentro do savepoint; restaura
        // dados e triggers no finally, sem alterar as proteções do fluxo normal.
        db.exec(`DROP TRIGGER delivery_occurrences_report_immutable;
          DROP TRIGGER delivery_occurrences_delete_forbidden;`);
        if (mutation.startsWith("DELETE FROM delivery_attempts")) {
          db.prepare("DELETE FROM delivery_occurrences WHERE delivery_id = ?").run(item.delivery.id);
        }
        db.prepare(mutation).run(item.delivery.id);
        const detail = (await (await request(`/api/client/deliveries/${item.delivery.id}`, {
          cookie: cookies.client1,
        })).json()).delivery;
        assert.equal(detail.officialStatus, null, mutation);
        assert.equal(detail.orderOfficialStatus, null, mutation);
        const order = (await (await request(`/api/client/orders/confirmed/${item.delivery.orderId}`, {
          cookie: cookies.client1,
        })).json()).order;
        assert.equal(order.officialStatus, null, mutation);
        assert.equal(createDeliveryForEligibleOrderInTransaction(item.delivery.orderId)
          .delivery.officialStatus, null, mutation);
      } finally {
        db.exec("ROLLBACK TO ambiguous_legacy_confirmation; RELEASE ambiguous_legacy_confirmation");
      }
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries ORDER BY id").all(), ledger);
    }
  });

  await context.test("evidências inválidas rejeitam confirm-return sem qualquer mutação", async (cases) => {
    const { hasConfirmationFailureEvidence } = await import("../src/official-statuses.js");
    const snapshots = () => Object.fromEntries([
      "orders", "deliveries", "delivery_attempts", "delivery_occurrences", "delivery_events",
      "delivery_revalidations", "financial_entries",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    // Corrupções legadas são montadas fora da requisição. As proteções do banco
    // são restauradas antes de executar a operação real sob teste.
    const editLegacyFixture = (work) => transaction(() => {
      const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
        AND name IN ('delivery_occurrences_report_immutable',
          'delivery_occurrences_delete_forbidden', 'delivery_occurrences_attempt_update')`).all();
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
      work();
      for (const trigger of triggers) db.exec(trigger.sql);
    });
    const mutations = [
      ["contador menor que três", (id) => db.prepare("UPDATE delivery_attempts SET invalid_code_attempts=2 WHERE delivery_id=?").run(id)],
      ["ocorrência ausente", (id) => db.prepare("DELETE FROM delivery_occurrences WHERE delivery_id=?").run(id)],
      ["tentativa ausente", (id) => {
        db.prepare("UPDATE delivery_occurrences SET delivery_attempt_id=NULL WHERE delivery_id=?").run(id);
        db.prepare("DELETE FROM delivery_attempts WHERE delivery_id=?").run(id);
      }],
      ["ocorrência ligada a outra tentativa", (id) => {
        const result = db.prepare(`INSERT INTO delivery_attempts
          (delivery_id,attempt_number,courier_id,status,ended_at,end_reason,end_nature)
          VALUES (?,2,?,'closed_unsuccessfully',CURRENT_TIMESTAMP,'courier_failure_after_pickup','recoverable')`).run(id,courier1);
        db.prepare("UPDATE delivery_occurrences SET delivery_attempt_id=? WHERE delivery_id=?").run(result.lastInsertRowid,id);
      }],
      ["ocorrência ligada a outra Entrega", (id, otherId) => db.prepare("UPDATE delivery_occurrences SET delivery_id=? WHERE delivery_id=?").run(otherId,id)],
      ["tentativa incompatível", (id) => db.prepare("UPDATE delivery_attempts SET status='active' WHERE delivery_id=?").run(id)],
      ["retorno reportado no futuro", (id) => db.prepare("UPDATE delivery_events SET occurred_at=datetime('now','+1 day') WHERE delivery_id=? AND event_type='return_reported'").run(id)],
      ["retorno anterior à falha", (id) => db.prepare("UPDATE delivery_events SET occurred_at='2000-01-01 00:00:00' WHERE delivery_id=? AND event_type='return_reported'").run(id)],
      ["chegada posterior às validações", (id) => db.prepare("UPDATE delivery_events SET occurred_at=datetime('now','+1 day') WHERE delivery_id=? AND event_type='courier_arrived_at_destination'").run(id)],
      ["primeiro erro posterior ao segundo", (id) => db.prepare("UPDATE delivery_events SET occurred_at=datetime('now','+1 day') WHERE delivery_id=? AND event_type='confirmation_code_invalid' AND id=(SELECT MIN(id) FROM delivery_events WHERE delivery_id=? AND event_type='confirmation_code_invalid')").run(id,id)],
      ["falha anterior aos erros", (id) => db.prepare("UPDATE delivery_events SET occurred_at='2000-01-01 00:00:00' WHERE delivery_id=? AND event_type='confirmation_failed'").run(id)],
      ["timestamp impossível", (id) => db.prepare("UPDATE delivery_events SET occurred_at='2026-02-30 10:00:00' WHERE delivery_id=? AND event_type='return_reported'").run(id)],
      ["histórico contraditório", (id) => db.prepare("INSERT INTO delivery_events(delivery_id,event_type) VALUES (?,'recipient_absent')").run(id)],
      ["evento de falha incompatível", (id) => db.prepare("UPDATE delivery_events SET details_json='{}' WHERE delivery_id=? AND event_type='confirmation_failed'").run(id)],
      ["retorno por outro motoboy", (id) => db.prepare("UPDATE delivery_events SET actor_user_id=? WHERE delivery_id=? AND event_type='return_reported'").run(courier2,id)],
      ["Pedido inelegível", (id) => db.prepare("UPDATE orders SET status='draft' WHERE id=(SELECT order_id FROM deliveries WHERE id=?)").run(id)],
    ];
    for (const [name, mutate] of mutations) await cases.test(name, async () => {
      const item = createDelivery(company1, client1, true);
      const other = createDelivery();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
      }
      await failConfirmation(item);
      assert.equal((await post(cookies.courier1, item.delivery.id, "report-return")).status, 200);
      const original = snapshots();
      try {
        editLegacyFixture(() => mutate(item.delivery.id, other.delivery.id));
        const before = snapshots();
        assert.equal(hasConfirmationFailureEvidence(db,item.delivery.id), false);
        const response = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
          cookie: cookies.company1, method: "POST", body: {},
        });
        assert.equal(response.status, 409);
        assert.deepEqual(snapshots(), before);
        const stored = db.prepare("SELECT status,returned_at FROM deliveries WHERE id=?").get(item.delivery.id);
        assert.equal(stored.status,"awaiting_return_confirmation");
        assert.equal(stored.returned_at,null);
        if (name === "retorno reportado no futuro") {
          const [attempt] = storedAttempts(item.delivery.id);
          assert.equal(attempt.status,"returning");
          assert.equal(attempt.endedAt,null);
          assert.equal(attempt.endNature,null);
          assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
            WHERE delivery_id=? AND event_type='return_confirmed'`).get(item.delivery.id).total,0);
        }
        const detail = (await (await request(`/api/company/deliveries/${item.delivery.id}`, {
          cookie: cookies.company1,
        })).json()).delivery;
        assert.equal(detail.officialStatus,"RETORNO_AO_ESTABELECIMENTO");
        if (name !== "Pedido inelegível") assert.equal(detail.orderOfficialStatus,"CONFIRMADO");
      } finally {
        editLegacyFixture(() => {
          const ids = [item.delivery.id,other.delivery.id];
          for (const table of ["delivery_occurrences","delivery_events","delivery_attempts"]) {
            db.prepare(`DELETE FROM ${table} WHERE delivery_id IN (?,?)`).run(...ids);
          }
          for (const table of ["delivery_attempts","delivery_occurrences","delivery_events"]) {
            for (const row of original[table].filter(row=>ids.includes(row.delivery_id))) {
              const columns=Object.keys(row);
              db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
            }
          }
          db.prepare("UPDATE orders SET status='confirmed' WHERE id=?").run(item.delivery.orderId);
        });
      }
      assert.equal(hasConfirmationFailureEvidence(db,item.delivery.id), true);
      const closed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      });
      assert.equal(closed.status,200);
      const delivery=(await closed.json()).delivery;
      assert.equal(delivery.officialStatus,"NAO_REALIZADA");
      assert.equal(delivery.orderOfficialStatus,"ENCERRADO");
      assert.equal(hasConfirmationFailureEvidence(db,item.delivery.id,true), true);
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries ORDER BY id").all(),original.financial_entries);
    });
  });

  await context.test("histórico terminal ambíguo não produz projeção nem reescreve dados", async () => {
    const item = createDelivery(company1, client1, true);
    db.prepare(`UPDATE deliveries SET status = 'returned', returned_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(item.delivery.id);
    const insertEvidence = db.prepare(`INSERT INTO delivery_events
      (delivery_id, actor_user_id, event_type) VALUES (?, ?, ?)`);
    insertEvidence.run(item.delivery.id, courier1, "recipient_absent");
    insertEvidence.run(item.delivery.id, courier1, "recipient_refused");
    const eventsBefore = db.prepare(`SELECT id, event_type AS eventType FROM delivery_events
      WHERE delivery_id = ? ORDER BY id`).all(item.delivery.id).map((row) => ({ ...row }));

    const detail = await request(`/api/client/deliveries/${item.delivery.id}`, {
      cookie: cookies.client1,
    });
    assert.equal(detail.status, 200);
    const delivery = (await detail.json()).delivery;
    assert.equal(delivery.status, "returned");
    assert.equal(delivery.officialStatus, null);
    assert.equal(delivery.orderOfficialStatus, null);
    const orderDetail = await request(`/api/client/orders/confirmed/${item.delivery.orderId}`, {
      cookie: cookies.client1,
    });
    assert.equal(orderDetail.status, 200);
    assert.equal((await orderDetail.json()).order.officialStatus, null);
    const repeatedCreation = transaction(() =>
      createDeliveryForEligibleOrderInTransaction(item.delivery.orderId));
    assert.equal(repeatedCreation.delivery.officialStatus, null);
    assert.equal(repeatedCreation.confirmationCode, null);
    assert.deepEqual(db.prepare(`SELECT id, event_type AS eventType FROM delivery_events
      WHERE delivery_id = ? ORDER BY id`).all(item.delivery.id).map((row) => ({ ...row })), eventsBefore);
  });

  await context.test("empresa consulta e classifica ocorrências uma única vez com projeção segura", async () => {
    const responsibilities = ["CLIENTE", "EMPRESA", "MOTOBOY", "SISTEMA", "INDEFINIDO"];
    const created = [];
    for (const responsibility of responsibilities) {
      const item = createDelivery();
      assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 200);
      assert.equal((await post(cookies.courier1, item.delivery.id, "fail", {
        reason: `Falha para ${responsibility}`,
      })).status, 200);
      const occurrence = storedOccurrences(item.delivery.id)[0];
      assert.equal(occurrence.responsibility, null);
      assert.equal(occurrence.classifiedByUserId, null);
      assert.equal(occurrence.classifiedAt, null);
      created.push({ item, occurrence, responsibility });
    }
    const foreignItem = createDelivery(company2, client2);
    assert.equal((await post(cookies.otherCourier, foreignItem.delivery.id, "accept")).status, 200);
    assert.equal((await post(cookies.otherCourier, foreignItem.delivery.id, "fail", {
      reason: "Falha de outra empresa",
    })).status, 200);
    const foreignOccurrence = storedOccurrences(foreignItem.delivery.id)[0];

    assert.equal((await request("/api/company/delivery-occurrences")).status, 401);
    assert.equal((await request("/api/company/delivery-occurrences", { cookie: cookies.client1 })).status, 403);
    assert.equal((await request("/api/company/delivery-occurrences", { cookie: cookies.courier1 })).status, 403);
    const foreignList = await (await request("/api/company/delivery-occurrences", {
      cookie: cookies.company2,
    })).json();
    assert.ok(foreignList.occurrences.some(({ id }) => id === foreignOccurrence.id));
    assert.ok(!foreignList.occurrences.some(({ id }) => created.some(({ occurrence }) => occurrence.id === id)));

    const listResponse = await request("/api/company/delivery-occurrences", { cookie: cookies.company1 });
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()).occurrences;
    assert.ok(!listed.some(({ id }) => id === foreignOccurrence.id));
    const listedIds = listed.map(({ id }) => id);
    assert.deepEqual(listedIds, [...listedIds].sort((left, right) => left - right));
    const listedOccurrence = listed.find(({ id }) => id === created[0].occurrence.id);
    assert.deepEqual(listedOccurrence.reporter, {
      fullName: "motoboy1@ermes.local", role: "courier",
    });
    assert.equal(listedOccurrence.classified, false);
    assert.equal(listedOccurrence.responsibility, null);
    assert.doesNotMatch(JSON.stringify(listedOccurrence),
      /reportedByUserId|classifiedByUserId|evidenceJson|deliveryState|companyId|courierId/i);

    assert.equal((await request(
      `/api/company/delivery-occurrences/${created[0].occurrence.id}/classify`,
      { cookie: cookies.company2, method: "POST", body: { responsibility: "CLIENTE" } },
    )).status, 404);
    assert.equal((await request(
      `/api/company/delivery-occurrences/${created[0].occurrence.id}/classify`,
      { cookie: cookies.client1, method: "POST", body: { responsibility: "CLIENTE" } },
    )).status, 403);
    assert.equal((await request(
      `/api/company/delivery-occurrences/${created[0].occurrence.id}/classify`,
      { cookie: cookies.courier1, method: "POST", body: { responsibility: "CLIENTE" } },
    )).status, 403);
    assert.equal((await request(
      `/api/company/delivery-occurrences/${created[0].occurrence.id}/classify`,
      { cookie: cookies.company1, method: "POST", body: { responsibility: "cliente" } },
    )).status, 400);
    assert.equal((await request(
      `/api/company/delivery-occurrences/${created[0].occurrence.id}/classify`,
      { cookie: cookies.company1, method: "POST",
        body: { responsibility: "CLIENTE", evidence: { forged: true } } },
    )).status, 400);

    for (const [index, { item, occurrence, responsibility }] of created.entries()) {
      const deliveryBefore = { ...db.prepare("SELECT status, courier_id AS courierId FROM deliveries WHERE id = ?")
        .get(item.delivery.id) };
      const financialBefore = db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE delivery_id = ?")
        .get(item.delivery.id).total;
      const response = await request(
        `/api/company/delivery-occurrences/${occurrence.id}/classify`,
        { cookie: cookies.company1, method: "POST", body: {
          responsibility,
          ...(index === 0 ? { analysisResult: "Análise documentada" } : {}),
        } },
      );
      assert.equal(response.status, 200);
      const classified = (await response.json()).occurrence;
      assert.equal(classified.classified, true);
      assert.equal(classified.responsibility, responsibility);
      assert.match(classified.classifiedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.deepEqual(classified.classifier, {
        fullName: "empresa1@ermes.local", role: "company",
      });
      assert.equal(classified.analysisResult, index === 0 ? "Análise documentada" : null);
      assert.doesNotMatch(JSON.stringify(classified), /evidenceJson|reportedByUserId|classifiedByUserId/i);
      assert.deepEqual({ ...db.prepare("SELECT status, courier_id AS courierId FROM deliveries WHERE id = ?")
        .get(item.delivery.id) }, deliveryBefore);
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE delivery_id = ?")
        .get(item.delivery.id).total, financialBefore);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
        WHERE delivery_id = ? AND event_type = 'occurrence_classified'`).get(item.delivery.id).total, 1);
      const classificationEvent = db.prepare(`SELECT details_json AS detailsJson FROM delivery_events
        WHERE delivery_id = ? AND event_type = 'occurrence_classified'`).get(item.delivery.id);
      assert.deepEqual(JSON.parse(classificationEvent.detailsJson), {
        occurrenceId: occurrence.id, responsibility,
      });
      assert.equal((await request(
        `/api/company/delivery-occurrences/${occurrence.id}/classify`,
        { cookie: cookies.company1, method: "POST", body: { responsibility } },
      )).status, 409);
      assert.throws(() => db.prepare(`UPDATE delivery_occurrences SET responsibility = 'SISTEMA',
        classified_by_user_id = ?, classified_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(companyUser1, occurrence.id), /classification is final/);
    }

    const undefinedOccurrence = storedOccurrences(created.at(-1).item.delivery.id)[0];
    assert.equal(undefinedOccurrence.responsibility, "INDEFINIDO");
    assert.notEqual(undefinedOccurrence.responsibility, null);
  });

  await context.test("ocorrência e classificação fazem rollback junto com seus eventos", async () => {
    const destinationFailure = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
      assert.equal((await post(cookies.courier1, destinationFailure.delivery.id, action)).status, 200);
    }
    db.exec(`CREATE TRIGGER fail_recipient_occurrence_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'recipient_absent'
      BEGIN SELECT RAISE(ABORT, 'forced occurrence event failure'); END;`);
    const failedOccurrence = await post(cookies.courier1, destinationFailure.delivery.id,
      "occurrences", { type: "recipient_absent" });
    db.exec("DROP TRIGGER fail_recipient_occurrence_event");
    assert.equal(failedOccurrence.status, 500);
    assert.equal(storedOccurrences(destinationFailure.delivery.id).length, 0);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?")
      .get(destinationFailure.delivery.id).status, "awaiting_confirmation");
    assert.equal(storedAttempts(destinationFailure.delivery.id)[0].status, "active");
    assert.equal((await post(cookies.courier1, destinationFailure.delivery.id, "confirm", {
      code: destinationFailure.confirmationCode,
    })).status, 200);

    const classificationFailure = createDelivery();
    await post(cookies.courier1, classificationFailure.delivery.id, "accept");
    await post(cookies.courier1, classificationFailure.delivery.id, "fail", { reason: "Pane" });
    const occurrence = storedOccurrences(classificationFailure.delivery.id)[0];
    db.exec(`CREATE TRIGGER fail_occurrence_classified_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'occurrence_classified'
      BEGIN SELECT RAISE(ABORT, 'forced classification event failure'); END;`);
    const failedClassification = await request(
      `/api/company/delivery-occurrences/${occurrence.id}/classify`,
      { cookie: cookies.company1, method: "POST", body: {
        responsibility: "SISTEMA",
        analysisResult: "Falha confirmada durante análise.",
      } },
    );
    db.exec("DROP TRIGGER fail_occurrence_classified_event");
    assert.equal(failedClassification.status, 500);
    const afterFailure = storedOccurrences(classificationFailure.delivery.id)[0];
    assert.equal(afterFailure.responsibility, null);
    assert.equal(afterFailure.classifiedByUserId, null);
    assert.equal(afterFailure.classifiedAt, null);
    assert.equal(afterFailure.analysisResult, null);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'occurrence_classified'`)
      .get(classificationFailure.delivery.id).total, 0);
    assert.equal((await request(
      `/api/company/delivery-occurrences/${occurrence.id}/classify`,
      { cookie: cookies.company1, method: "POST", body: {
        responsibility: "SISTEMA",
        analysisResult: "Falha confirmada durante análise.",
      } },
    )).status, 200);
    const classified = storedOccurrences(classificationFailure.delivery.id)[0];
    assert.equal(classified.responsibility, "SISTEMA");
    assert.equal(classified.analysisResult, "Falha confirmada durante análise.");
  });

  await context.test("ocorrência classificada não pode ser excluída direta ou indiretamente", async () => {
    const item = createDelivery();
    assert.equal((await post(cookies.courier1, item.delivery.id, "accept")).status, 200);
    assert.equal((await post(cookies.courier1, item.delivery.id, "fail", {
      reason: "Falha preservada para auditoria",
    })).status, 200);
    const occurrence = storedOccurrences(item.delivery.id)[0];
    assert.equal((await request(
      `/api/company/delivery-occurrences/${occurrence.id}/classify`,
      { cookie: cookies.company1, method: "POST", body: {
        responsibility: "MOTOBOY",
        analysisResult: "Responsabilidade confirmada pelas evidências.",
      } },
    )).status, 200);
    const before = storedOccurrences(item.delivery.id)[0];

    assert.throws(() => db.prepare("DELETE FROM delivery_occurrences WHERE id = ?")
      .run(occurrence.id), /delivery occurrence cannot be deleted/);
    assert.deepEqual(storedOccurrences(item.delivery.id)[0], before);

    assert.throws(() => db.prepare("DELETE FROM deliveries WHERE id = ?")
      .run(item.delivery.id), /delivery occurrence cannot be deleted/);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE id = ?")
      .get(item.delivery.id).total, 1);
    assert.deepEqual(storedOccurrences(item.delivery.id)[0], before);
  });

  await context.test("schema rejeita enums, classificação parcial e tentativa de outra Entrega", async () => {
    const first = createDelivery();
    const second = createDelivery();
    for (const [cookie, item] of [[cookies.courier1, first], [cookies.courier2, second]]) {
      for (const action of ["accept", "arrive-pickup", "collect"]) {
        assert.equal((await post(cookie, item.delivery.id, action)).status, 200);
      }
    }
    const firstAttempt = storedAttempts(first.delivery.id)[0];
    const secondAttempt = storedAttempts(second.delivery.id)[0];
    assert.throws(() => transaction(() => createDeliveryOccurrenceInTransaction(db, {
      deliveryId: first.delivery.id,
      deliveryAttemptId: secondAttempt.id,
      type: "recipient_absent",
      reportedByUserId: courier1,
    })), /não pertence à entrega/i);
    assert.throws(() => db.prepare(`INSERT INTO delivery_occurrences
      (delivery_id, delivery_attempt_id, type, reported_by_user_id)
      VALUES (?, ?, 'recipient_absent', ?)`).run(first.delivery.id, secondAttempt.id, courier1),
    /attempt does not belong to delivery/);
    assert.throws(() => db.prepare(`INSERT INTO delivery_occurrences
      (delivery_id, delivery_attempt_id, type, reported_by_user_id)
      VALUES (?, ?, 'unknown_type', ?)`).run(first.delivery.id, firstAttempt.id, courier1), /CHECK constraint/);
    assert.throws(() => db.prepare(`INSERT INTO delivery_occurrences
      (delivery_id, delivery_attempt_id, type, reported_by_user_id, analysis_result)
      VALUES (?, ?, 'recipient_absent', ?, 'sem classificação')`)
      .run(first.delivery.id, firstAttempt.id, courier1), /CHECK constraint/);
    assert.throws(() => db.prepare(`INSERT INTO delivery_occurrences
      (delivery_id, delivery_attempt_id, type, reported_by_user_id,
       responsibility, classified_by_user_id, classified_at)
      VALUES (?, ?, 'recipient_absent', ?, 'OUTRO', ?, CURRENT_TIMESTAMP)`)
      .run(first.delivery.id, firstAttempt.id, courier1, companyUser1), /CHECK constraint/);
    assert.equal(storedOccurrences(first.delivery.id).length, 0);
    assert.equal(storedOccurrences(second.delivery.id).length, 0);
    for (const [cookie, item] of [[cookies.courier1, first], [cookies.courier2, second]]) {
      await post(cookie, item.delivery.id, "arrive-destination");
      await post(cookie, item.delivery.id, "confirm", { code: item.confirmationCode });
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
    const occurrencesBefore = storedOccurrences(item.delivery.id).length;

    assert.equal((await post(cookies.otherCourier, item.delivery.id, "occurrences", {
      type: "address_problem",
    })).status, 404);
    assert.equal((await post(cookies.courier1, item.delivery.id, "occurrences", {
      type: "recipient_absent", evidence: { arbitrary: true },
    })).status, 400);
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
    assert.equal(storedOccurrences(item.delivery.id).length, occurrencesBefore);

    assert.equal((await post(cookies.courier1, item.delivery.id, "confirm", {
      code: item.confirmationCode,
    })).status, 200);
  });

  await context.test("falha no evento final desfaz encerramento terminal do retorno", async () => {
    for (const type of ["recipient_absent", "recipient_refused", "confirmation_failed"]) {
      const item = createDelivery();
      for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
        await post(cookies.courier1, item.delivery.id, action);
      }
      if (type === "confirmation_failed") await failConfirmation(item);
      else await post(cookies.courier1, item.delivery.id, "occurrences", { type });
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

      const successful = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      });
      assert.equal(successful.status, 200);
      const projected = (await successful.json()).delivery;
      assert.equal(projected.officialStatus, "NAO_REALIZADA");
      assert.equal(projected.orderOfficialStatus, "ENCERRADO");
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
    const confirmedReturn = await request(`/api/company/deliveries/${afterPickup.delivery.id}/confirm-return`,
      { cookie: cookies.company1, method: "POST", body: {} });
    assert.equal(confirmedReturn.status, 200);
    const returnedDelivery = (await confirmedReturn.json()).delivery;
    assert.equal(returnedDelivery.status, "returned");
    assert.equal(returnedDelivery.officialStatus, "CANCELADA");
    assert.equal(returnedDelivery.orderOfficialStatus, "CANCELADO");
    const detail = await request(`/api/client/deliveries/${afterPickup.delivery.id}`,
      { cookie: cookies.client1 });
    assert.equal(detail.status, 200);
    const detailDelivery = (await detail.json()).delivery;
    assert.equal(detailDelivery.status, "returned");
    assert.equal(detailDelivery.officialStatus, "CANCELADA");
    assert.equal(detailDelivery.orderOfficialStatus, "CANCELADO");
    const repeated = transaction(() => createDeliveryForEligibleOrderInTransaction(afterPickup.delivery.orderId));
    assert.equal(repeated.created, false);
    assert.equal(repeated.delivery.id, afterPickup.delivery.id);
    assert.equal(repeated.delivery.status, "returned");
    assert.equal(repeated.delivery.officialStatus, "CANCELADA");
    assert.equal(repeated.confirmationCode, null);
    assert.equal((await request(`/api/client/orders/${afterPickup.delivery.orderId}/pay`,
      { cookie: cookies.client1, method: "POST", body: {} })).status, 409);
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
