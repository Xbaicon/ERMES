import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = {
  postalCode: "01001000", state: "SP", city: "Sao Paulo", neighborhood: "Centro",
  street: "Rua Um", number: "10", complement: "",
};

test("pagamento simulado de pedido confirmado pelo cliente", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-client-payment-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?client-payment=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, method = "GET", body } = {}) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function login(email, password = "Senha123!") {
    const response = await request("/api/auth/login", { method: "POST", body: { email, password } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  async function registerClient(email) {
    const response = await request("/api/auth/register/client", { method: "POST", body: {
      fullName: email, email, birthDate: "1990-01-01", password: "Senha123!",
    } });
    assert.equal(response.status, 201);
    const id = (await response.json()).id;
    const cookie = await login(email);
    assert.equal((await request("/api/client/default-address", {
      cookie, method: "PUT", body: address,
    })).status, 200);
    return { id, cookie };
  }
  async function createDraft(cookie, companyId, productId, quantity = 1) {
    const response = await request("/api/client/orders", {
      cookie, method: "POST", body: { companyId, items: [{ productId, quantity }] },
    });
    assert.equal(response.status, 201);
    return (await response.json()).order;
  }
  async function confirmDraft(cookie, order) {
    const response = await request(`/api/company/orders/${order.id}/confirm`, {
      cookie, method: "POST", body: { version: 1 },
    });
    assert.equal(response.status, 200);
    return (await response.json()).order;
  }
  const pay = (cookie, orderId, body = {}) => request(`/api/client/orders/${orderId}/pay`, {
    cookie, method: "POST", body,
  });
  const storedOrder = (orderId) => ({ ...db.prepare(`SELECT id, client_id AS clientId,
    company_id AS companyId, status, version,
    destination_snapshot_json AS destinationSnapshotJson,
    route_snapshot_json AS routeSnapshotJson,
    items_total_cents AS itemsTotalCents,
    freight_total_cents AS freightTotalCents,
    payment_status AS paymentStatus, payment_paid_at AS paymentPaidAt,
    confirmed_at AS confirmedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM orders WHERE id = ?`).get(orderId) });
  const storedItems = (orderId) => db.prepare(`SELECT product_id AS productId, quantity,
    unit_price_cents AS unitPriceCents, unit_weight_kg AS unitWeightKg
    FROM order_items WHERE order_id = ? ORDER BY id`).all(orderId).map((row) => ({ ...row }));

  const firstClient = await registerClient("pagamento.primeiro@ermes.local");
  const secondClient = await registerClient("pagamento.segundo@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  const company = db.prepare("SELECT id FROM companies WHERE cnpj = ?").get("00000000000191");
  const product = db.prepare("SELECT id FROM products WHERE company_id = ? ORDER BY id LIMIT 1").get(company.id);

  const courierResponse = await request("/api/company/couriers", {
    cookie: companyCookie, method: "POST", body: {
      fullName: "Motoboy pagamento", email: "motoboy.pagamento@ermes.local",
      cpf: "111.444.777-35", phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!",
    },
  });
  assert.equal(courierResponse.status, 201);
  const courierCookie = await login("motoboy.pagamento@ermes.local");
  const passwordHash = db.prepare("SELECT password_hash AS value FROM users WHERE email = ?")
    .get("empresa@ermes.local").value;
  db.prepare("INSERT INTO users (role, full_name, email, password_hash) VALUES ('platform_admin', ?, ?, ?)")
    .run("Admin pagamento", "admin.pagamento@ermes.local", passwordHash);
  const adminCookie = await login("admin.pagamento@ermes.local", "Ermes123!");

  const ownDraft = await createDraft(firstClient.cookie, company.id, product.id);
  const ownConfirmedDraft = await createDraft(firstClient.cookie, company.id, product.id, 2);
  const ownConfirmed = await confirmDraft(companyCookie, ownConfirmedDraft);
  const otherConfirmedDraft = await createDraft(secondClient.cookie, company.id, product.id);
  const otherConfirmed = await confirmDraft(companyCookie, otherConfirmedDraft);
  const concurrentDraft = await createDraft(firstClient.cookie, company.id, product.id);
  const concurrentConfirmed = await confirmDraft(companyCookie, concurrentDraft);

  await context.test("exige sessao de cliente em consulta e pagamento", async () => {
    const paths = [
      ["GET", "/api/client/orders/confirmed", undefined],
      ["GET", `/api/client/orders/confirmed/${ownConfirmed.id}`, undefined],
      ["POST", `/api/client/orders/${ownConfirmed.id}/pay`, {}],
    ];
    for (const [method, path, body] of paths) {
      assert.equal((await request(path, { method, body })).status, 401);
      for (const cookie of [companyCookie, courierCookie, adminCookie]) {
        assert.equal((await request(path, { cookie, method, body })).status, 403);
      }
    }
    assert.equal(storedOrder(ownConfirmed.id).paymentStatus, "pending");
  });

  await context.test("cliente consulta somente pedidos confirmed proprios", async () => {
    const response = await request("/api/client/orders/confirmed", { cookie: firstClient.cookie });
    assert.equal(response.status, 200);
    const { orders } = await response.json();
    assert.deepEqual(new Set(orders.map(({ id }) => id)), new Set([ownConfirmed.id, concurrentConfirmed.id]));
    assert.equal(orders.some(({ id }) => id === ownDraft.id), false);
    assert.equal(orders.some(({ id }) => id === otherConfirmed.id), false);
    for (const order of orders) {
      assert.equal(order.status, "confirmed");
      assert.equal(order.paymentStatus, "pending");
      assert.equal(order.paymentPaidAt, null);
      assert.equal(order.freightTotalCents, null);
    }

    const detail = await request(`/api/client/orders/confirmed/${ownConfirmed.id}`, { cookie: firstClient.cookie });
    assert.equal(detail.status, 200);
    const { order } = await detail.json();
    assert.equal(order.id, ownConfirmed.id);
    assert.equal(order.status, "confirmed");
    assert.equal(order.paymentStatus, "pending");
    assert.equal(order.freightTotalCents, null);
    assert.equal((await request(`/api/client/orders/confirmed/${otherConfirmed.id}`, {
      cookie: firstClient.cookie,
    })).status, 404);
    assert.equal((await request(`/api/client/orders/confirmed/${ownDraft.id}`, {
      cookie: firstClient.cookie,
    })).status, 409);
  });

  await context.test("valida identificador, existencia e corpo sem aceitar valores financeiros", async () => {
    for (const value of ["0", "-1", "1.5", "01", "+1", "1e0", "abc", "9007199254740992"]) {
      assert.equal((await pay(firstClient.cookie, value)).status, 400);
      assert.equal((await request(`/api/client/orders/confirmed/${value}`, { cookie: firstClient.cookie })).status, 400);
    }
    assert.equal((await pay(firstClient.cookie, 999999)).status, 404);
    assert.equal((await request("/api/client/orders/confirmed/999999", { cookie: firstClient.cookie })).status, 404);
    for (const body of [null, [], { itemsTotalCents: 1 }, { freightTotalCents: 0 },
      { paymentStatus: "paid" }, { paymentPaidAt: "2026-01-01 00:00:00" }]) {
      assert.equal((await pay(firstClient.cookie, ownConfirmed.id, body)).status, 400);
    }
    assert.equal(storedOrder(ownConfirmed.id).paymentStatus, "pending");
  });

  await context.test("pedido draft nao pode ser pago", async () => {
    const before = storedOrder(ownDraft.id);
    const response = await pay(firstClient.cookie, ownDraft.id);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /n.o est. confirmado comercialmente/i);
    assert.deepEqual(storedOrder(ownDraft.id), before);
  });

  await context.test("cliente nao paga pedido de outro cliente", async () => {
    const before = storedOrder(otherConfirmed.id);
    assert.equal((await pay(firstClient.cookie, otherConfirmed.id)).status, 404);
    assert.deepEqual(storedOrder(otherConfirmed.id), before);
  });

  await context.test("confirma pagamento, cria entrega e protege o código persistido", async () => {
    const before = { order: storedOrder(ownConfirmed.id), items: storedItems(ownConfirmed.id) };
    assert.equal(before.order.status, "confirmed");
    assert.equal(before.order.paymentStatus, "pending");
    assert.equal(before.order.paymentPaidAt, null);
    assert.equal(before.order.freightTotalCents, null);
    const response = await pay(firstClient.cookie, ownConfirmed.id);
    assert.equal(response.status, 200);
    const payment = await response.json();
    const paid = payment.order;
    assert.match(payment.confirmationCode, /^\d{6}$/);
    assert.equal(payment.delivery.status, "available");
    assert.equal(paid.status, "confirmed");
    assert.equal(paid.paymentStatus, "paid");
    assert.match(paid.paymentPaidAt, /^\d{4}-\d{2}-\d{2} /);
    assert.equal(paid.itemsTotalCents, before.order.itemsTotalCents);
    assert.equal(paid.freightTotalCents, null);

    const after = storedOrder(ownConfirmed.id);
    assert.equal(after.status, "confirmed");
    assert.equal(after.paymentStatus, "paid");
    assert.equal(after.paymentPaidAt, paid.paymentPaidAt);
    assert.equal(after.itemsTotalCents, before.order.itemsTotalCents);
    assert.equal(after.freightTotalCents, null);
    assert.equal(after.routeSnapshotJson, before.order.routeSnapshotJson);
    assert.equal(after.destinationSnapshotJson, before.order.destinationSnapshotJson);
    assert.equal(after.confirmedAt, before.order.confirmedAt);
    assert.deepEqual(storedItems(ownConfirmed.id), before.items);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 1);
    const storedDelivery = db.prepare("SELECT * FROM deliveries WHERE order_id = ?").get(ownConfirmed.id);
    assert.match(storedDelivery.confirmation_code_hash, /^scrypt\$/);
    assert.match(storedDelivery.confirmation_code_ciphertext, /^aes-256-gcm\$/);
    assert.equal(JSON.stringify(storedDelivery).includes(payment.confirmationCode), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM delivery_events WHERE delivery_id = ? AND event_type = 'delivery_created'").get(storedDelivery.id).value, 1);
    assert.deepEqual(db.prepare(`SELECT entry_type AS entryType, component, party_type AS partyType,
      amount_cents AS amountCents, reason, delivery_id AS deliveryId
      FROM financial_entries WHERE order_id = ? ORDER BY id`).all(ownConfirmed.id).map((row) => ({ ...row })), [{
      entryType: "payment", component: "products", partyType: "client",
      amountCents: before.order.itemsTotalCents, reason: "simulated_payment", deliveryId: storedDelivery.id,
    }]);
  });

  await context.test("repeticao idempotente preserva payment_paid_at e todos os dados", async () => {
    const before = { order: storedOrder(ownConfirmed.id), items: storedItems(ownConfirmed.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value,
      financialEntries: db.prepare("SELECT COUNT(*) AS value FROM financial_entries WHERE order_id = ?")
        .get(ownConfirmed.id).value };
    const response = await pay(firstClient.cookie, ownConfirmed.id);
    assert.equal(response.status, 200);
    const repeatedResult = await response.json();
    const repeated = repeatedResult.order;
    assert.equal(repeatedResult.confirmationCode.length, 6);
    const detail = await request(`/api/client/deliveries/${repeatedResult.delivery.id}`,
      { cookie: firstClient.cookie });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).delivery.confirmationCode, repeatedResult.confirmationCode);
    assert.equal(repeated.paymentStatus, "paid");
    assert.equal(repeated.paymentPaidAt, before.order.paymentPaidAt);
    assert.deepEqual({ order: storedOrder(ownConfirmed.id), items: storedItems(ownConfirmed.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value,
      financialEntries: db.prepare("SELECT COUNT(*) AS value FROM financial_entries WHERE order_id = ?")
        .get(ownConfirmed.id).value }, before);
  });

  await context.test("pedido paid permanece consultavel e nao editavel", async () => {
    const detail = await request(`/api/client/orders/confirmed/${ownConfirmed.id}`, { cookie: firstClient.cookie });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).order.paymentStatus, "paid");
    assert.equal((await request(`/api/client/orders/${ownConfirmed.id}`, { cookie: firstClient.cookie })).status, 409);
    const edit = await request(`/api/client/orders/${ownConfirmed.id}/items`, {
      cookie: firstClient.cookie, method: "PUT", body: { items: [{ productId: product.id, quantity: 3 }] },
    });
    assert.equal(edit.status, 409);
    assert.equal(storedOrder(ownConfirmed.id).paymentStatus, "paid");
  });

  await context.test("pagamentos simultaneos produzem uma unica transicao e o mesmo timestamp", async () => {
    db.exec(`CREATE TABLE payment_transition_audit (order_id INTEGER NOT NULL);
             CREATE TRIGGER audit_payment_transition AFTER UPDATE OF payment_status ON orders
             WHEN OLD.payment_status = 'pending' AND NEW.payment_status = 'paid'
             BEGIN INSERT INTO payment_transition_audit (order_id) VALUES (NEW.id); END;`);
    const [first, second] = await Promise.all([
      pay(firstClient.cookie, concurrentConfirmed.id),
      pay(firstClient.cookie, concurrentConfirmed.id),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstResult = await first.json();
    const secondResult = await second.json();
    const firstOrder = firstResult.order;
    const secondOrder = secondResult.order;
    assert.equal(firstResult.confirmationCode, secondResult.confirmationCode);
    assert.equal(firstResult.delivery.id, secondResult.delivery.id);
    assert.equal(firstOrder.paymentStatus, "paid");
    assert.equal(secondOrder.paymentStatus, "paid");
    assert.equal(firstOrder.paymentPaidAt, secondOrder.paymentPaidAt);
    assert.equal(storedOrder(concurrentConfirmed.id).paymentPaidAt, firstOrder.paymentPaidAt);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM payment_transition_audit WHERE order_id = ?")
      .get(concurrentConfirmed.id).value, 1);
    assert.equal(storedOrder(concurrentConfirmed.id).freightTotalCents, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries WHERE order_id = ?").get(concurrentConfirmed.id).value, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS value FROM delivery_events e JOIN deliveries d ON d.id = e.delivery_id
      WHERE d.order_id = ? AND e.event_type = 'delivery_created'`).get(concurrentConfirmed.id).value, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM financial_entries WHERE order_id = ?")
      .get(concurrentConfirmed.id).value, 1);
  });

  await context.test("rejeita dados comerciais persistidos inconsistentes sem pagamento parcial", async () => {
    const draft = await createDraft(firstClient.cookie, company.id, product.id);
    const confirmed = await confirmDraft(companyCookie, draft);
    db.prepare("UPDATE orders SET items_total_cents = items_total_cents + 1 WHERE id = ?").run(confirmed.id);
    const before = storedOrder(confirmed.id);
    const response = await pay(firstClient.cookie, confirmed.id);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /dados comerciais.*inconsistentes/i);
    assert.deepEqual(storedOrder(confirmed.id), before);
    assert.equal(before.paymentStatus, "pending");
    assert.equal(before.paymentPaidAt, null);
  });

  await context.test("falha no evento inicial desfaz pagamento e entrega na mesma transação", async () => {
    const draft = await createDraft(firstClient.cookie, company.id, product.id);
    const confirmed = await confirmDraft(companyCookie, draft);
    db.exec(`CREATE TRIGGER fail_delivery_created BEFORE INSERT ON delivery_events
             WHEN NEW.event_type = 'delivery_created'
             BEGIN SELECT RAISE(ABORT, 'forced delivery event failure'); END;`);
    const response = await pay(firstClient.cookie, confirmed.id);
    assert.equal(response.status, 500);
    assert.equal(storedOrder(confirmed.id).paymentStatus, "pending");
    assert.equal(storedOrder(confirmed.id).paymentPaidAt, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE order_id = ?")
      .get(confirmed.id).total, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE order_id = ?")
      .get(confirmed.id).total, 0);
    db.exec("DROP TRIGGER fail_delivery_created");
  });

  await context.test("falha no lançamento financeiro desfaz pagamento, entrega e evento inicial", async () => {
    const draft = await createDraft(firstClient.cookie, company.id, product.id);
    const confirmed = await confirmDraft(companyCookie, draft);
    db.exec(`CREATE TRIGGER fail_payment_entry BEFORE INSERT ON financial_entries
             WHEN NEW.order_id = ${confirmed.id}
             BEGIN SELECT RAISE(ABORT, 'forced payment entry failure'); END;`);
    const response = await pay(firstClient.cookie, confirmed.id);
    db.exec("DROP TRIGGER fail_payment_entry");
    assert.equal(response.status, 500);
    assert.equal(storedOrder(confirmed.id).paymentStatus, "pending");
    assert.equal(storedOrder(confirmed.id).paymentPaidAt, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE order_id = ?")
      .get(confirmed.id).total, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM financial_entries WHERE order_id = ?")
      .get(confirmed.id).total, 0);
  });

  await context.test("banco rejeita situacao de pagamento fora de pending ou paid", async () => {
    const draft = await createDraft(firstClient.cookie, company.id, product.id);
    const confirmed = await confirmDraft(companyCookie, draft);
    assert.throws(() => db.prepare("UPDATE orders SET payment_status = 'refunded' WHERE id = ?")
      .run(confirmed.id), /invalid payment status/);
    assert.equal(storedOrder(confirmed.id).paymentStatus, "pending");
    assert.equal(storedOrder(confirmed.id).paymentPaidAt, null);
  });
});
