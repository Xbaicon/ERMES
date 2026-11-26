import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const destination = JSON.stringify({
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Centro",
  street: "Rua Financeira", number: "10", complement: "",
});

test("financeiro, reembolsos e distribuições da Baseline 0.1", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-finance-api-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?finance=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  const { hashPassword } = await import("../src/security.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
  const {
    backfillFinancialEntries, insertFinancialEntryInTransaction, orderRefundSummary,
    recordPaymentInTransaction, recordRecipientTerminalFailureInTransaction,
  } = await import("../src/finance.js");
  const { splitNormalFreight } = await import("../src/freight.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, method = "GET", body } = {}) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const passwordHash = hashPassword("Senha123!");
  const company1 = Number(db.prepare("INSERT INTO companies (name, cnpj, email, address_json) VALUES (?, ?, ?, ?)")
    .run("Empresa Financeira", "11222333000181", "financeira@ermes.local", destination).lastInsertRowid);
  const company2 = Number(db.prepare("INSERT INTO companies (name, cnpj, email, address_json) VALUES (?, ?, ?, ?)")
    .run("Outra Empresa", "22333444000181", "outra@ermes.local", destination).lastInsertRowid);
  const createUser = (role, email, companyId = null) => Number(db.prepare(`INSERT INTO users
    (company_id, role, company_profile, full_name, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(companyId, role, role === "company" ? "RESPONSAVEL" : null, email, email, passwordHash).lastInsertRowid);
  const client1 = createUser("client", "cliente.financeiro@ermes.local");
  const client2 = createUser("client", "cliente.outro@ermes.local");
  const companyUser1 = createUser("company", "empresa.financeiro@ermes.local", company1);
  const companyUser2 = createUser("company", "empresa.outra@ermes.local", company2);
  const courier1 = createUser("courier", "motoboy.financeiro@ermes.local", company1);
  const courier1Alternate = createUser("courier", "motoboy.financeiro.2@ermes.local", company1);
  const courier2 = createUser("courier", "motoboy.outro@ermes.local", company2);
  for (const courierId of [courier1, courier1Alternate, courier2]) {
    db.prepare("INSERT INTO couriers (user_id, vehicle_type, is_online) VALUES (?, 'motorcycle', 1)")
      .run(courierId);
  }
  const product = Number(db.prepare(`INSERT INTO products
    (company_id, name, price_cents, unit_weight_kg) VALUES (?, 'Produto financeiro', 2000, 1)`)
    .run(company1).lastInsertRowid);

  async function login(email) {
    const response = await request("/api/auth/login", {
      method: "POST", body: { email, password: "Senha123!" },
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const cookies = {
    client1: await login("cliente.financeiro@ermes.local"),
    client2: await login("cliente.outro@ermes.local"),
    company1: await login("empresa.financeiro@ermes.local"),
    company2: await login("empresa.outra@ermes.local"),
    courier1: await login("motoboy.financeiro@ermes.local"),
    courier2: await login("motoboy.outro@ermes.local"),
  };

  function createDelivery({ freightCents = 1001, itemsCents = 2000 } = {}) {
    return transaction(() => {
      const orderId = Number(db.prepare(`INSERT INTO orders
        (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
         items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
        VALUES (?, ?, 'confirmed', ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(client1, company1, destination,
          JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }),
          itemsCents, freightCents).lastInsertRowid);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, ?, 1)`).run(orderId, product, itemsCents);
      const result = createDeliveryForEligibleOrderInTransaction(orderId);
      const order = db.prepare(`SELECT id, client_id AS clientId, items_total_cents AS itemsTotalCents,
        freight_total_cents AS freightTotalCents, payment_paid_at AS paymentPaidAt
        FROM orders WHERE id = ?`).get(orderId);
      recordPaymentInTransaction(db, order, result.delivery.id);
      return { ...result, orderId };
    });
  }
  function createDeliveryWithoutFreightLedger() {
    return transaction(() => {
      const orderId = Number(db.prepare(`INSERT INTO orders
        (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
         items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
        VALUES (?, ?, 'confirmed', ?, ?, 2000, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(client1, company1, destination,
          JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }))
        .lastInsertRowid);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, 2000, 1)`).run(orderId, product);
      const result = createDeliveryForEligibleOrderInTransaction(orderId);
      insertFinancialEntryInTransaction(db, {
        orderId,
        deliveryId: result.delivery.id,
        entryType: "payment",
        component: "products",
        partyType: "client",
        partyId: client1,
        amountCents: 2000,
        reason: "simulated_payment",
        idempotencyKey: `payment:${orderId}:products`,
      });
      return { ...result, orderId };
    });
  }
  const postCourier = (deliveryId, action, body = {}) => request(
    `/api/courier/deliveries/${deliveryId}/${action}`,
    { cookie: cookies.courier1, method: "POST", body },
  );
  async function advanceToDestination(item) {
    for (const action of ["accept", "arrive-pickup", "collect", "arrive-destination"]) {
      assert.equal((await postCourier(item.delivery.id, action)).status, 200);
    }
  }
  const ledger = (orderId) => db.prepare(`SELECT entry_type AS entryType, component,
    party_type AS partyType, amount_cents AS amountCents, reason
    FROM financial_entries WHERE order_id = ? ORDER BY id`).all(orderId).map((row) => ({ ...row }));
  const insertHistoricalEvent = db.prepare(`INSERT INTO delivery_events
    (delivery_id, actor_user_id, event_type, occurred_at) VALUES (?, ?, ?, ?)`);
  const insertHistoricalEventWithDetails = db.prepare(`INSERT INTO delivery_events
    (delivery_id, actor_user_id, event_type, details_json, occurred_at) VALUES (?, ?, ?, ?, ?)`);
  function createHistoricalDelivery() {
    return transaction(() => {
      const orderId = Number(db.prepare(`INSERT INTO orders
        (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
         items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
        VALUES (?, ?, 'confirmed', ?, ?, 2000, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(client1, company1, destination,
          JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }))
        .lastInsertRowid);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, 2000, 1)`).run(orderId, product);
      const deliveryId = Number(db.prepare(`INSERT INTO deliveries (order_id, status)
        VALUES (?, 'available')`).run(orderId).lastInsertRowid);
      db.prepare(`INSERT INTO delivery_events (delivery_id, event_type)
        VALUES (?, 'delivery_created')`).run(deliveryId);
      return { orderId, deliveryId };
    });
  }
  function completeHistoricalDelivery(item, completedActor = courier1,
    completedAt = "2099-01-01 11:00:00", confirmation = {}) {
    const attempts = confirmation.attempts ?? 0;
    const persistedAttempts = confirmation.persistedAttempts
      ?? (confirmation.failed ? 3 : attempts);
    db.prepare(`UPDATE deliveries SET courier_id = ?, status = 'completed',
      accepted_at = '2099-01-01 10:10:00', collected_at = '2099-01-01 10:30:00',
      completed_at = ?, invalid_code_attempts = ? WHERE id = ?`)
      .run(courier1, completedAt, persistedAttempts, item.deliveryId);
    insertHistoricalEvent.run(item.deliveryId, courier1, "delivery_accepted", "2099-01-01 10:10:00");
    insertHistoricalEvent.run(item.deliveryId, courier1, "courier_arrived_at_pickup", "2099-01-01 10:20:00");
    insertHistoricalEvent.run(item.deliveryId, courier1, "order_collected", "2099-01-01 10:30:00");
    const insertAttempts = () => {
      for (let index = 0; index < attempts; index += 1) {
        const details = confirmation.attemptDetails?.[index]
          ?? { attempt: index + 1, remainingAttempts: 2 - index };
        insertHistoricalEventWithDetails.run(item.deliveryId, courier1,
          "confirmation_code_invalid", JSON.stringify(details),
          `2099-01-01 10:${String(51 + index).padStart(2, "0")}:00`);
      }
    };
    if (confirmation.attemptsBeforeDestination) insertAttempts();
    insertHistoricalEvent.run(item.deliveryId, courier1, "courier_arrived_at_destination", "2099-01-01 10:50:00");
    if (!confirmation.attemptsBeforeDestination) insertAttempts();
    if (confirmation.failed) {
      insertHistoricalEventWithDetails.run(item.deliveryId, courier1, "confirmation_failed",
        JSON.stringify({ attempt: 3, remainingAttempts: 0 }), "2099-01-01 10:59:00");
    }
    insertHistoricalEvent.run(item.deliveryId, completedActor, "delivery_completed", completedAt);
  }
  function cancelHistoricalDelivery(item, cancellationActor = client1, courierId = courier1,
    confirmation = {}) {
    const attempts = confirmation.attempts ?? 0;
    const persistedAttempts = confirmation.persistedAttempts
      ?? (confirmation.failed ? 3 : attempts);
    db.prepare(`UPDATE deliveries SET courier_id = NULL, status = 'returned',
      accepted_at = '2099-02-01 10:10:00', collected_at = '2099-02-01 10:30:00',
      return_reason = 'client_cancelled_after_pickup',
      return_reported_at = '2099-02-01 10:50:00', returned_at = '2099-02-01 11:00:00',
      invalid_code_attempts = ? WHERE id = ?`).run(persistedAttempts, item.deliveryId);
    insertHistoricalEvent.run(item.deliveryId, courierId, "delivery_accepted", "2099-02-01 10:10:00");
    insertHistoricalEvent.run(item.deliveryId, courierId, "courier_arrived_at_pickup", "2099-02-01 10:20:00");
    insertHistoricalEvent.run(item.deliveryId, courierId, "order_collected", "2099-02-01 10:30:00");
    if (attempts || confirmation.failed) {
      insertHistoricalEvent.run(item.deliveryId, courierId,
        "courier_arrived_at_destination", "2099-02-01 10:35:00");
      for (let index = 0; index < attempts; index += 1) {
        insertHistoricalEventWithDetails.run(item.deliveryId, courierId,
          "confirmation_code_invalid",
          JSON.stringify({ attempt: index + 1, remainingAttempts: 2 - index }),
          `2099-02-01 10:${String(36 + index).padStart(2, "0")}:00`);
      }
      if (confirmation.failed) {
        insertHistoricalEventWithDetails.run(item.deliveryId, courierId, "confirmation_failed",
          JSON.stringify({ attempt: 3, remainingAttempts: 0 }), "2099-02-01 10:39:00");
      }
    }
    insertHistoricalEvent.run(item.deliveryId, cancellationActor, "client_cancelled_after_pickup",
      "2099-02-01 10:40:00");
    insertHistoricalEvent.run(item.deliveryId, courierId, "return_reported", "2099-02-01 10:50:00");
    insertHistoricalEvent.run(item.deliveryId, companyUser1, "return_confirmed", "2099-02-01 11:00:00");
  }
  function markHistoricalProductUnavailable(item, actor = companyUser1) {
    db.prepare(`UPDATE deliveries SET status = 'cancelled', courier_id = NULL,
      cancelled_at = '2099-03-01 10:10:00' WHERE id = ?`).run(item.deliveryId);
    insertHistoricalEvent.run(item.deliveryId, actor, "product_unavailable", "2099-03-01 10:10:00");
  }

  await context.test("conclusão normal persiste 70/25/5, projeções mínimas e idempotência", async () => {
    const item = createDelivery();
    await advanceToDestination(item);
    const completed = await postCourier(item.delivery.id, "confirm", { code: item.confirmationCode });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).delivery.status, "completed");
    assert.deepEqual(ledger(item.orderId), [
      { entryType: "payment", component: "products", partyType: "client", amountCents: 2000, reason: "simulated_payment" },
      { entryType: "payment", component: "freight", partyType: "client", amountCents: 1001, reason: "simulated_payment" },
      { entryType: "distribution", component: "freight", partyType: "courier", amountCents: 701, reason: "delivery_completed" },
      { entryType: "distribution", component: "freight", partyType: "company", amountCents: 250, reason: "delivery_completed" },
      { entryType: "distribution", component: "freight", partyType: "ermes", amountCents: 50, reason: "delivery_completed" },
    ]);
    const client = (await (await request(`/api/client/deliveries/${item.delivery.id}`,
      { cookie: cookies.client1 })).json()).delivery;
    assert.deepEqual(client.financial, {
      paymentStatus: "paid", refundStatus: "none", paidAt: client.financial.paidAt,
      paidItemsCents: 2000, paidFreightCents: 1001, paidTotalCents: 3001,
      refunds: [], refundedTotalCents: 0, pending: [],
    });
    assert.equal(Object.hasOwn(client.financial, "distributions"), false);
    const company = (await (await request(`/api/company/deliveries/${item.delivery.id}`,
      { cookie: cookies.company1 })).json()).delivery;
    assert.equal(company.financial.totalReceivedCents, 250);
    assert.deepEqual(company.financial.distributions.map(({ amountCents }) => amountCents), [250]);
    const courier = await (await request("/api/courier/financial-entries", { cookie: cookies.courier1 })).json();
    assert.equal(courier.entries.find(({ deliveryId }) => deliveryId === item.delivery.id).amountCents, 701);
    const otherCourier = await (await request("/api/courier/financial-entries",
      { cookie: cookies.courier2 })).json();
    assert.deepEqual(otherCourier, { entries: [], totalReceivedCents: 0 });
    assert.equal((await request("/api/courier/financial-entries", { cookie: cookies.client1 })).status, 403);
    assert.equal((await request(`/api/client/deliveries/${item.delivery.id}`,
      { cookie: cookies.client2 })).status, 404);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}`,
      { cookie: cookies.company2 })).status, 404);
    assert.equal((await postCourier(item.delivery.id, "confirm", { code: item.confirmationCode })).status, 409);
    assert.equal(ledger(item.orderId).length, 5);
  });

  await context.test("frete conhecido sem ledger impede conclusão e desfaz estado e evento", async () => {
    const item = createDeliveryWithoutFreightLedger();
    await advanceToDestination(item);
    const response = await postCourier(item.delivery.id, "confirm", { code: item.confirmationCode });
    assert.equal(response.status, 500);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
      "awaiting_confirmation");
    assert.deepEqual({ ...db.prepare(`SELECT status, ended_at AS endedAt
      FROM delivery_attempts WHERE delivery_id = ?`).get(item.delivery.id) }, {
      status: "active", endedAt: null,
    });
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'delivery_completed'`).get(item.delivery.id).total, 0);
    assert.equal(ledger(item.orderId).some(({ entryType }) => entryType === "distribution"), false);
    const detail = (await (await request(`/api/client/deliveries/${item.delivery.id}`,
      { cookie: cookies.client1 })).json()).delivery;
    assert.deepEqual(detail.financial.pending, []);
    assert.equal((await postCourier(item.delivery.id, "occurrences", { type: "recipient_absent" })).status, 200);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 500);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
      "awaiting_return_confirmation");
    assert.equal(ledger(item.orderId).some(({ entryType }) => entryType === "refund"), false);
    recordPaymentInTransaction(db, {
      id: item.orderId, clientId: client1, itemsTotalCents: 2000,
      freightTotalCents: 1000,
      paymentPaidAt: db.prepare("SELECT payment_paid_at AS value FROM orders WHERE id = ?")
        .get(item.orderId).value,
    }, item.delivery.id);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
  });

  await context.test("cancelamento pós-coleta reembolsa produtos e metade do frete somente ao cliente e motoboy", async () => {
    const item = createDelivery();
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      assert.equal((await postCourier(item.delivery.id, action)).status, 200);
    }
    const cancelled = await request(`/api/client/deliveries/${item.delivery.id}/cancel`, {
      cookie: cookies.client1, method: "POST", body: {},
    });
    assert.equal(cancelled.status, 200);
    let client = (await cancelled.json()).delivery;
    assert.equal(client.status, "returning");
    assert.equal(ledger(item.orderId).length, 2);
    assert.equal(client.financial.refundedTotalCents, 0);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    assert.equal(ledger(item.orderId).length, 2);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: 'POST', body: {},
    })).status, 200);
    client = (await (await request(`/api/client/deliveries/${item.delivery.id}`, {
      cookie: cookies.client1,
    })).json()).delivery;
    assert.equal(db.prepare("SELECT payment_status AS value FROM orders WHERE id = ?").get(item.orderId).value,
      "paid");
    assert.deepEqual(ledger(item.orderId).slice(2), [
      { entryType: "refund", component: "products", partyType: "client", amountCents: 2000, reason: "client_cancelled_after_pickup" },
      { entryType: "refund", component: "freight", partyType: "client", amountCents: 501, reason: "client_cancelled_after_pickup" },
      { entryType: "distribution", component: "freight", partyType: "courier", amountCents: 500, reason: "client_cancelled_after_pickup" },
    ]);
    assert.equal(client.financial.refundedTotalCents, 2501);
    assert.equal(client.financial.refundStatus, "partial");
    assert.deepEqual(client.financial.refunds.map(({ amountCents }) => amountCents), [2000, 501]);
    const company = (await (await request(`/api/company/deliveries/${item.delivery.id}`,
      { cookie: cookies.company1 })).json()).delivery;
    assert.equal(company.financial.totalReceivedCents, 0);
    assert.equal((await request(`/api/client/deliveries/${item.delivery.id}/cancel`, {
      cookie: cookies.client1, method: "POST", body: {},
    })).status, 409);
    assert.equal(ledger(item.orderId).length, 5);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 404);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 409);
    assert.equal(ledger(item.orderId).length, 5);
  });

  await context.test('cancelamento em retorno bloqueia SQL direto e backfill antes do recebimento', async () => {
    const item = createDelivery(); const id = item.delivery.id;
    for (const action of ['accept', 'arrive-pickup', 'collect']) assert.equal((await postCourier(id, action)).status, 200);
    assert.equal((await request(`/api/client/deliveries/${id}/cancel`, {
      cookie: cookies.client1, method: 'POST', body: {},
    })).status, 200);
    for (const stage of ['returning', 'awaiting_return_confirmation']) {
      const before = db.prepare('SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id').all(item.orderId);
      for (const [type, component, party, userId] of [
        ['refund', 'products', 'client', client1], ['refund', 'freight', 'client', client1],
        ['distribution', 'freight', 'courier', courier1],
      ]) assert.throws(() => db.prepare(`INSERT INTO financial_entries
        (order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'client_cancelled_after_pickup', ?)`)
        .run(item.orderId, id, type, component, party, userId, `premature:${stage}:${type}:${component}`), /invalid financial entry kind/);
      transaction(() => backfillFinancialEntries(db));
      assert.deepEqual(db.prepare('SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id').all(item.orderId), before);
      assert.equal(db.prepare('SELECT status FROM deliveries WHERE id = ?').get(id).status, stage);
      if (stage === 'returning') assert.equal((await postCourier(id, 'report-return')).status, 200);
    }
    assert.equal((await postCourier(id, 'report-return')).status, 409);
    assert.equal((await request(`/api/company/deliveries/${id}/confirm-return`, {
      cookie: cookies.company1, method: 'POST', body: {},
    })).status, 200);
    const before = ledger(item.orderId);
    transaction(() => backfillFinancialEntries(db));
    assert.deepEqual(ledger(item.orderId), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  await context.test("produto indisponível gera reembolso integral conhecido sem distribuição", async () => {
    const item = createDelivery({ freightCents: 1000 });
    const response = await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    assert.equal(response.status, 200);
    assert.equal(db.prepare("SELECT payment_status AS value FROM orders WHERE id = ?").get(item.orderId).value,
      "paid");
    assert.deepEqual(ledger(item.orderId).slice(2), [
      { entryType: "refund", component: "products", partyType: "client", amountCents: 2000, reason: "product_unavailable" },
      { entryType: "refund", component: "freight", partyType: "client", amountCents: 1000, reason: "product_unavailable" },
    ]);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 409);
    const orderDetail = await request(`/api/client/orders/confirmed/${item.orderId}`, {
      cookie: cookies.client1,
    });
    assert.equal(orderDetail.status, 200);
    const refundedOrder = (await orderDetail.json()).order;
    assert.equal(refundedOrder.paymentStatus, "paid");
    assert.equal(refundedOrder.refundStatus, "full");
    const repeatedPayment = await request(`/api/client/orders/${item.orderId}/pay`, {
      cookie: cookies.client1, method: "POST", body: {},
    });
    assert.equal(repeatedPayment.status, 200);
    const repeatedOrder = (await repeatedPayment.json()).order;
    assert.equal(repeatedOrder.paymentStatus, "paid");
    assert.equal(repeatedOrder.refundStatus, "full");
    assert.equal(ledger(item.orderId).length, 4);
  });

  await context.test("produto indisponível não inventa componente não pago nem converte frete NULL", async () => {
    const item = createDelivery({ freightCents: null });
    const response = await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    assert.equal(response.status, 200);
    assert.equal(db.prepare("SELECT freight_total_cents AS value FROM orders WHERE id = ?")
      .get(item.orderId).value, null);
    assert.deepEqual(ledger(item.orderId), [
      { entryType: "payment", component: "products", partyType: "client", amountCents: 2000, reason: "simulated_payment" },
      { entryType: "refund", component: "products", partyType: "client", amountCents: 2000, reason: "product_unavailable" },
    ]);
    assert.deepEqual(orderRefundSummary(db, item.orderId, client1), {
      totalPaidCents: 2000, refundedTotalCents: 2000, refundStatus: "full",
    });
  });

  await context.test("produto indisponível com pagamento zero não cria reembolso nem pendência artificial", async () => {
    const item = createDelivery({ freightCents: null, itemsCents: 0 });
    const response = await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    assert.equal(response.status, 200);
    assert.deepEqual(ledger(item.orderId), [
      { entryType: "payment", component: "products", partyType: "client", amountCents: 0,
        reason: "simulated_payment" },
    ]);
    const detail = (await (await request(`/api/client/deliveries/${item.delivery.id}`,
      { cookie: cookies.client1 })).json()).delivery;
    assert.equal(detail.financial.refundStatus, "none");
    assert.equal(detail.financial.refundedTotalCents, 0);
    assert.deepEqual(detail.financial.refunds, []);
    assert.deepEqual(detail.financial.pending, []);
    assert.equal(detail.events.at(-1).eventType, "product_unavailable");
  });

  await context.test("evidência histórica de produto indisponível exige timestamp civil estrito", async () => {
    const cases = [
      { timestamp: "2026-10-19 10:00:00", recognized: true },
      { timestamp: "2026-02-30 10:00:00", recognized: false },
      { timestamp: "2026-04-31 10:00:00", recognized: false },
      { timestamp: "2028-02-29 10:00:00", recognized: true },
    ];
    for (const { timestamp, recognized } of cases) {
      const item = createDelivery();
      db.prepare(`UPDATE deliveries SET status = 'cancelled', courier_id = NULL,
        cancelled_at = ? WHERE id = ?`).run(timestamp, item.delivery.id);
      insertHistoricalEvent.run(item.delivery.id, companyUser1, "product_unavailable", timestamp);
      const entriesBefore = ledger(item.orderId);
      const historyBefore = db.prepare(`SELECT event_type AS eventType, occurred_at AS occurredAt
        FROM delivery_events WHERE delivery_id = ? ORDER BY id`).all(item.delivery.id)
        .map((event) => ({ ...event }));

      const response = await request(`/api/client/deliveries/${item.delivery.id}`, {
        cookie: cookies.client1,
      });
      assert.equal(response.status, 200, timestamp);
      const detail = (await response.json()).delivery;
      assert.deepEqual(detail.financial.pending, recognized
        ? [] : ["client_cancellation_before_pickup_refund_rule_undefined"], timestamp);
      assert.deepEqual(ledger(item.orderId), entriesBefore, timestamp);
      assert.deepEqual(db.prepare(`SELECT event_type AS eventType, occurred_at AS occurredAt
        FROM delivery_events WHERE delivery_id = ? ORDER BY id`).all(item.delivery.id)
        .map((event) => ({ ...event })), historyBefore, timestamp);
      assert.equal(entriesBefore.some(({ reason }) => reason === "product_unavailable"), false,
        timestamp);
    }
  });

  await context.test("ausência e recusa com frete indisponível reembolsam produtos sem inventar distribuição", async () => {
    for (const type of ["recipient_absent", "recipient_refused"]) {
      const item = createDelivery({ freightCents: null });
      await advanceToDestination(item);
      assert.equal((await postCourier(item.delivery.id, "occurrences", { type })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      assert.deepEqual(new Set(ledger(item.orderId).map(({ entryType }) => entryType)),
        new Set(["payment", "refund"]));
      assert.equal(ledger(item.orderId).find(({ entryType }) => entryType === "refund").amountCents, 2000);
      const detail = (await (await request(`/api/company/deliveries/${item.delivery.id}`,
        { cookie: cookies.company1 })).json()).delivery;
      assert.deepEqual(detail.financial.pending, ["freight_amount_unavailable"]);
    }

    const failedCode = createDelivery();
    await advanceToDestination(failedCode);
    const wrongCodes = ["111111", "222222", "333333", "444444"]
      .filter((code) => code !== failedCode.confirmationCode);
    for (const code of wrongCodes.slice(0, 3)) {
      assert.equal((await postCourier(failedCode.delivery.id, "confirm", { code })).status, 422);
    }
    assert.equal((await postCourier(failedCode.delivery.id, "report-return")).status, 200);
    assert.equal((await request(`/api/company/deliveries/${failedCode.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    assert.deepEqual(new Set(ledger(failedCode.orderId).map(({ entryType }) => entryType)), new Set(["payment"]));

    const noFreight = createDelivery({ freightCents: null });
    await advanceToDestination(noFreight);
    assert.equal((await postCourier(noFreight.delivery.id, "confirm", { code: noFreight.confirmationCode })).status, 200);
    assert.equal(ledger(noFreight.orderId).some(({ entryType }) => entryType === "distribution"), false);
    const noFreightDetail = (await (await request(`/api/client/deliveries/${noFreight.delivery.id}`,
      { cookie: cookies.client1 })).json()).delivery;
    assert.deepEqual(noFreightDetail.financial.pending, ["freight_amount_unavailable"]);

    const beforePickup = createDelivery();
    assert.equal((await request(`/api/client/deliveries/${beforePickup.delivery.id}/cancel`, {
      cookie: cookies.client1, method: "POST", body: {},
    })).status, 200);
    assert.deepEqual(new Set(ledger(beforePickup.orderId).map(({ entryType }) => entryType)), new Set(["payment", "refund"]));
    assert.equal(orderRefundSummary(db, beforePickup.orderId).refundedTotalCents, 3001);
    const beforeDetail = (await (await request(`/api/client/deliveries/${beforePickup.delivery.id}`,
      { cookie: cookies.client1 })).json()).delivery;
    assert.deepEqual(beforeDetail.financial.pending, []);
    assert.equal(beforeDetail.financial.refundStatus, "full");
  });

  await context.test("falha no lançamento financeiro desfaz conclusão e evento", async () => {
    const item = createDelivery({ freightCents: 1000 });
    await advanceToDestination(item);
    db.exec(`CREATE TRIGGER fail_financial_distribution BEFORE INSERT ON financial_entries
      WHEN NEW.entry_type = 'distribution'
      BEGIN SELECT RAISE(ABORT, 'forced financial failure'); END;`);
    const response = await postCourier(item.delivery.id, "confirm", { code: item.confirmationCode });
    db.exec("DROP TRIGGER fail_financial_distribution");
    assert.equal(response.status, 500);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
      "awaiting_confirmation");
    assert.deepEqual({ ...db.prepare(`SELECT status, ended_at AS endedAt
      FROM delivery_attempts WHERE delivery_id = ?`).get(item.delivery.id) }, {
      status: "active", endedAt: null,
    });
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'delivery_completed'`).get(item.delivery.id).total, 0);
    assert.deepEqual(new Set(ledger(item.orderId).map(({ entryType }) => entryType)), new Set(["payment"]));
    assert.equal((await postCourier(item.delivery.id, "occurrences", { type: "recipient_absent" })).status, 200);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
  });

  await context.test("falha financeira desfaz cancelamento pós-coleta sem criar sanção temporal", async () => {
    const item = createDelivery({ freightCents: 1000 });
    for (const action of ["accept", "arrive-pickup", "collect"]) {
      assert.equal((await postCourier(item.delivery.id, action)).status, 200);
    }
    assert.equal((await request(`/api/client/deliveries/${item.delivery.id}/cancel`, {
      cookie: cookies.client1, method: 'POST', body: {},
    })).status, 200);
    assert.equal((await postCourier(item.delivery.id, 'report-return')).status, 200);
    const before = {
      delivery: db.prepare('SELECT * FROM deliveries WHERE id = ?').get(item.delivery.id),
      attempts: db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id = ?').all(item.delivery.id),
      events: db.prepare('SELECT * FROM delivery_events WHERE delivery_id = ?').all(item.delivery.id),
      ledger: ledger(item.orderId),
    };
    db.exec(`CREATE TRIGGER fail_financial_refund_cancel BEFORE INSERT ON financial_entries
      WHEN NEW.entry_type = 'distribution' AND NEW.reason = 'client_cancelled_after_pickup'
      BEGIN SELECT RAISE(ABORT, 'forced cancellation financial failure'); END;`);
    const response = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    db.exec("DROP TRIGGER fail_financial_refund_cancel");
    assert.equal(response.status, 500);
    assert.deepEqual({ ...db.prepare(`SELECT status, return_reason AS returnReason
      FROM deliveries WHERE id = ?`).get(item.delivery.id) }, {
      status: "awaiting_return_confirmation", returnReason: 'client_cancelled_after_pickup',
    });
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'client_cancelled_after_pickup'`)
      .get(item.delivery.id).total, 1);
    assert.deepEqual({
      delivery: db.prepare('SELECT * FROM deliveries WHERE id = ?').get(item.delivery.id),
      attempts: db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id = ?').all(item.delivery.id),
      events: db.prepare('SELECT * FROM delivery_events WHERE delivery_id = ?').all(item.delivery.id),
      ledger: ledger(item.orderId),
    }, before);
    assert.equal(db.prepare("SELECT order_blocked_until AS value FROM users WHERE id = ?")
      .get(client1).value, null);
    assert.deepEqual(new Set(ledger(item.orderId).map(({ entryType }) => entryType)), new Set(["payment"]));
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
  });

  await context.test("falha financeira desfaz indisponibilidade de produto e evento", async () => {
    const item = createDelivery({ freightCents: 1000 });
    db.exec(`CREATE TRIGGER fail_financial_refund_unavailable BEFORE INSERT ON financial_entries
      WHEN NEW.entry_type = 'refund'
      BEGIN SELECT RAISE(ABORT, 'forced product financial failure'); END;`);
    const response = await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    db.exec("DROP TRIGGER fail_financial_refund_unavailable");
    assert.equal(response.status, 500);
    assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
      "available");
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'product_unavailable'`).get(item.delivery.id).total, 0);
    assert.deepEqual(new Set(ledger(item.orderId).map(({ entryType }) => entryType)), new Set(["payment"]));
  });

  await context.test("operações terminais concorrentes não duplicam evento nem distribuição", async () => {
    const item = createDelivery({ freightCents: 1001 });
    await advanceToDestination(item);
    const responses = await Promise.all([
      postCourier(item.delivery.id, "confirm", { code: item.confirmationCode }),
      postCourier(item.delivery.id, "confirm", { code: item.confirmationCode }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
      WHERE delivery_id = ? AND event_type = 'delivery_completed'`).get(item.delivery.id).total, 1);
    assert.equal(ledger(item.orderId).filter(({ entryType }) => entryType === "distribution").length, 3);
  });

  await context.test("backfill ignora Pedido pago sem Entrega e não bloqueia o fluxo normal posterior", async () => {
    const orderId = transaction(() => {
      const id = Number(db.prepare(`INSERT INTO orders
        (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
         items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
        VALUES (?, ?, 'confirmed', ?, ?, 2000, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(client1, company1, destination,
          JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }))
        .lastInsertRowid);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, 2000, 1)`).run(id, product);
      return id;
    });
    transaction(() => backfillFinancialEntries(db));
    transaction(() => backfillFinancialEntries(db));
    assert.deepEqual(ledger(orderId), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE order_id = ?")
      .get(orderId).total, 0);

    const response = await request(`/api/client/orders/${orderId}/pay`, {
      cookie: cookies.client1, method: "POST", body: {},
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM deliveries WHERE order_id = ?")
      .get(orderId).total, 1);
    assert.deepEqual(ledger(orderId).map(({ entryType, component }) => ({ entryType, component })), [
      { entryType: "payment", component: "products" },
      { entryType: "payment", component: "freight" },
    ]);
  });

  await context.test("backfill terminal exige ator, empresa, horário e cadeia operacional coerentes", () => {
    const coherent = createHistoricalDelivery();
    completeHistoricalDelivery(coherent);
    const oneInvalidAttempt = createHistoricalDelivery();
    completeHistoricalDelivery(oneInvalidAttempt, courier1, "2099-01-01 11:00:00", { attempts: 1 });
    const twoInvalidAttempts = createHistoricalDelivery();
    completeHistoricalDelivery(twoInvalidAttempts, courier1, "2099-01-01 11:00:00", { attempts: 2 });
    const threeInvalidAttempts = createHistoricalDelivery();
    completeHistoricalDelivery(threeInvalidAttempts, courier1, "2099-01-01 11:00:00", { attempts: 3 });
    const fourInvalidAttempts = createHistoricalDelivery();
    completeHistoricalDelivery(fourInvalidAttempts, courier1, "2099-01-01 11:00:00", { attempts: 4 });
    const definitiveFailure = createHistoricalDelivery();
    completeHistoricalDelivery(definitiveFailure, courier1, "2099-01-01 11:00:00",
      { attempts: 2, failed: true, persistedAttempts: 2 });
    const persistedLimit = createHistoricalDelivery();
    completeHistoricalDelivery(persistedLimit, courier1, "2099-01-01 11:00:00",
      { persistedAttempts: 3 });
    const divergentCounter = createHistoricalDelivery();
    completeHistoricalDelivery(divergentCounter, courier1, "2099-01-01 11:00:00",
      { attempts: 1, persistedAttempts: 2 });
    const divergentAttemptCounter = createHistoricalDelivery();
    completeHistoricalDelivery(divergentAttemptCounter, courier1, "2099-01-01 11:00:00",
      { attempts: 1 });
    db.prepare(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, courier_id, status, invalid_code_attempts, started_at, ended_at)
      VALUES (?, 1, ?, 'completed', 2, '2099-01-01 10:30:00', '2099-01-01 11:00:00')`)
      .run(divergentAttemptCounter.deliveryId, courier1);
    const incoherentDetails = createHistoricalDelivery();
    completeHistoricalDelivery(incoherentDetails, courier1, "2099-01-01 11:00:00",
      { attempts: 1, attemptDetails: [{ attempt: 2, remainingAttempts: 1 }] });
    const attemptOutOfOrder = createHistoricalDelivery();
    completeHistoricalDelivery(attemptOutOfOrder, courier1, "2099-01-01 11:00:00",
      { attempts: 1, attemptsBeforeDestination: true });
    const wrongCourier = createHistoricalDelivery();
    completeHistoricalDelivery(wrongCourier, courier1Alternate);
    const wrongRole = createHistoricalDelivery();
    completeHistoricalDelivery(wrongRole, client1);
    const wrongCompany = createHistoricalDelivery();
    completeHistoricalDelivery(wrongCompany, courier2);
    const invalidTimestamp = createHistoricalDelivery();
    completeHistoricalDelivery(invalidTimestamp, courier1, "not-a-date");
    const impossibleTimestamp = createHistoricalDelivery();
    completeHistoricalDelivery(impossibleTimestamp, courier1, "2099-02-30 11:00:00");
    const emptyTimestamp = createHistoricalDelivery();
    completeHistoricalDelivery(emptyTimestamp, courier1, "");
    const wrongOrder = createHistoricalDelivery();
    completeHistoricalDelivery(wrongOrder, courier1, "2099-01-01 10:25:00");

    const coherentCancellation = createHistoricalDelivery();
    cancelHistoricalDelivery(coherentCancellation);
    const cancellationAfterConfirmationFailure = createHistoricalDelivery();
    cancelHistoricalDelivery(cancellationAfterConfirmationFailure, client1, courier1,
      { attempts: 2, failed: true, persistedAttempts: 2 });
    const invalidCancellation = createHistoricalDelivery();
    cancelHistoricalDelivery(invalidCancellation, companyUser1, courier1Alternate);
    const coherentUnavailable = createHistoricalDelivery();
    markHistoricalProductUnavailable(coherentUnavailable);
    const invalidUnavailable = createHistoricalDelivery();
    markHistoricalProductUnavailable(invalidUnavailable, companyUser2);

    transaction(() => backfillFinancialEntries(db));
    for (const item of [coherent, oneInvalidAttempt, twoInvalidAttempts,
      persistedLimit, divergentCounter]) {
      assert.equal(ledger(item.orderId).filter(({ entryType }) => entryType === "distribution").length, 3);
    }
    for (const item of [threeInvalidAttempts, fourInvalidAttempts, definitiveFailure,
      divergentAttemptCounter, incoherentDetails, attemptOutOfOrder,
      wrongCourier, wrongRole, wrongCompany, invalidTimestamp, impossibleTimestamp,
      emptyTimestamp, wrongOrder]) {
      assert.equal(ledger(item.orderId).filter(({ entryType }) => entryType === "distribution").length, 0);
      assert.equal(ledger(item.orderId).filter(({ entryType }) => entryType === "payment").length, 2);
    }
    // Esse legado usa datas futuras e não possui TentativaEntrega: não prova
    // recebimento físico válido para o fechamento financeiro da 0.2.
    assert.deepEqual(ledger(coherentCancellation.orderId).slice(2), []);
    assert.equal(ledger(cancellationAfterConfirmationFailure.orderId).length, 2);
    assert.equal(ledger(invalidCancellation.orderId).length, 2);
    assert.equal(ledger(coherentUnavailable.orderId)
      .filter(({ entryType }) => entryType === "refund").length, 2);
    assert.deepEqual(ledger(invalidUnavailable.orderId), []);

    const count = db.prepare("SELECT COUNT(*) AS total FROM financial_entries").get().total;
    transaction(() => backfillFinancialEntries(db));
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM financial_entries").get().total, count);
  });

  await context.test("idempotência semântica compara conteúdo e ignora apenas timestamp técnico", () => {
    const item = createDelivery({ freightCents: 1001 });
    const input = {
      orderId: item.orderId,
      deliveryId: item.delivery.id,
      entryType: "payment",
      component: "products",
      partyType: "client",
      partyId: client1,
      amountCents: 2000,
      reason: "simulated_payment",
      idempotencyKey: `payment:${item.orderId}:products`,
      occurredAt: "2099-01-01 00:00:00",
    };
    assert.equal(insertFinancialEntryInTransaction(db, input), false);
    for (const divergent of [
      { amountCents: 2001 },
      { partyId: client2 },
      { component: "freight", amountCents: 1001 },
    ]) {
      assert.throws(() => insertFinancialEntryInTransaction(db, { ...input, ...divergent }),
        (error) => error.code === "FINANCIAL_RECONCILIATION_REQUIRED"
          && /conteúdo divergente/.test(error.message));
    }
    assert.equal(ledger(item.orderId).length, 2);
  });

  await context.test("backfill aborta chave histórica divergente para reconciliação", () => {
    const item = transaction(() => {
      const orderId = Number(db.prepare(`INSERT INTO orders
        (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
         items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
        VALUES (?, ?, 'confirmed', ?, ?, 2000, 1000, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(client1, company1, destination,
          JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }))
        .lastInsertRowid);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, 2000, 1)`).run(orderId, product);
      return { orderId, ...createDeliveryForEligibleOrderInTransaction(orderId) };
    });
    db.prepare(`INSERT INTO financial_entries
      (order_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, 'payment', 'products', 'client', ?, 2000,
        'simulated_payment', ?)`)
      .run(item.orderId, client1, `payment:${item.orderId}:products`);
    assert.throws(() => transaction(() => backfillFinancialEntries(db)),
      (error) => error.code === "FINANCIAL_RECONCILIATION_REQUIRED"
        && /deliveryId/.test(error.message));
    assert.equal(ledger(item.orderId).length, 1);
  });

  await context.test("ledger é append-only, impede over-refund, relações e combinações inválidas", async () => {
    const item = createDelivery({ freightCents: 1000 });
    const entryId = db.prepare(`SELECT id FROM financial_entries
      WHERE order_id = ? AND component = 'products'`).get(item.orderId).id;
    assert.throws(() => db.prepare("UPDATE financial_entries SET amount_cents = 1 WHERE id = ?")
      .run(entryId), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM financial_entries WHERE id = ?").run(entryId),
      /append-only/);
    assert.throws(() => db.prepare("DELETE FROM deliveries WHERE id = ?").run(item.delivery.id),
      /FOREIGN KEY/);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 1.5, 'product_unavailable', ?)`)
      .run(item.orderId, item.delivery.id, client1, `invalid:float:${item.orderId}`),
    /safe integer|CHECK constraint/);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 1, 'product_unavailable', ?)`)
      .run(item.orderId, item.delivery.id, client2, `invalid:owner:${item.orderId}`),
    /refund does not match/);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'distribution', 'products', 'courier', ?, 1, 'delivery_completed', ?)`)
      .run(item.orderId, item.delivery.id, courier1, `invalid:component:${item.orderId}`),
    /invalid financial entry kind|distribution beneficiary|CHECK constraint/);

    const other = createDelivery({ freightCents: 1000 });
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 1, 'product_unavailable', ?)`)
      .run(item.orderId, other.delivery.id, client1, `invalid:relation:${item.orderId}`),
    /delivery does not belong/);

    const completed = createDelivery({ freightCents: 1000 });
    await advanceToDestination(completed);
    assert.equal((await postCourier(completed.delivery.id, "confirm", {
      code: completed.confirmationCode,
    })).status, 200);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_company_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'distribution', 'freight', 'company', ?, 0, 'delivery_completed', ?)`)
      .run(completed.orderId, completed.delivery.id, company2,
        `invalid:company:${completed.orderId}`), /distribution beneficiary/);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'distribution', 'freight', 'courier', ?, 0, 'delivery_completed', ?)`)
      .run(completed.orderId, completed.delivery.id, courier2,
        `invalid:courier:${completed.orderId}`), /distribution beneficiary/);

    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/product-unavailable`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    assert.throws(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
       amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 1, 'product_unavailable', ?)`)
      .run(item.orderId, item.delivery.id, client1, `invalid:over-refund:${item.orderId}`),
    /refund exceeds/);
  });

  await context.test("payment exige Pedido paid com horário válido e impede regressão para pending", () => {
    const pendingOrder = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
       items_total_cents, freight_total_cents, payment_status, confirmed_at)
      VALUES (?, ?, 'confirmed', ?, ?, 2000, 1000, 'pending', CURRENT_TIMESTAMP)`)
      .run(client1, company1, destination,
        JSON.stringify({ type: "self", name: "cliente.financeiro@ermes.local" }))
      .lastInsertRowid);
    assert.throws(() => insertFinancialEntryInTransaction(db, {
      orderId: pendingOrder,
      entryType: "payment",
      component: "products",
      partyType: "client",
      partyId: client1,
      amountCents: 2000,
      reason: "simulated_payment",
      idempotencyKey: `payment:${pendingOrder}:products`,
    }), /requires paid order/);

    for (const invalidTimestamp of [
      "2026-02-29 10:00:00", "2026-02-30 10:00:00", "2026-04-31 10:00:00",
      "2026-00-10 10:00:00", "2026-13-10 10:00:00", "2026-01-00 10:00:00",
      "2026-01-10 24:00:00", "2026-01-10 23:60:00", "2026-01-10 23:59:60",
      "", "2026-01-10T23:59:59Z", "not-a-date",
    ]) {
      db.prepare("UPDATE orders SET payment_status = 'paid', payment_paid_at = ? WHERE id = ?")
        .run(invalidTimestamp, pendingOrder);
      assert.throws(() => insertFinancialEntryInTransaction(db, {
        orderId: pendingOrder,
        entryType: "payment",
        component: "products",
        partyType: "client",
        partyId: client1,
        amountCents: 2000,
        reason: "simulated_payment",
        idempotencyKey: `payment:${pendingOrder}:products`,
      }), /requires paid order/, invalidTimestamp);
    }
    db.prepare("UPDATE orders SET payment_status = 'paid', payment_paid_at = ? WHERE id = ?")
      .run("2024-02-29 23:59:59", pendingOrder);
    assert.equal(insertFinancialEntryInTransaction(db, {
      orderId: pendingOrder,
      entryType: "payment",
      component: "products",
      partyType: "client",
      partyId: client1,
      amountCents: 2000,
      reason: "simulated_payment",
      idempotencyKey: `payment:${pendingOrder}:products`,
    }), true);

    const paid = createDelivery();
    assert.throws(() => db.prepare("UPDATE orders SET payment_status = 'pending' WHERE id = ?")
      .run(paid.orderId), /cannot return to pending/);
    assert.equal(db.prepare("SELECT payment_status AS value FROM orders WHERE id = ?")
      .get(paid.orderId).value, "paid");
  });

  await context.test("ausência e recusa: reembolso acumulado, divisão exata e idempotência", async () => {
    for (const type of ["recipient_absent", "recipient_refused"]) {
      for (const freightCents of [1, 2, 3, 101]) {
        const item = createDelivery({ freightCents, itemsCents: 2000 });
        await advanceToDestination(item);
        if (freightCents === 101) {
          insertFinancialEntryInTransaction(db, {
            orderId: item.orderId, deliveryId: item.delivery.id, entryType: "refund",
            component: "products", partyType: "client", partyId: client1,
            amountCents: 400, reason: "product_unavailable",
            idempotencyKey: `test:prior-refund:${item.delivery.id}`,
          });
        }
        assert.equal((await postCourier(item.delivery.id, "occurrences", { type })).status, 200);
        assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
        assert.equal(ledger(item.orderId).some((entry) => entry.reason === type), false);
        const closed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
          cookie: cookies.company1, method: "POST", body: {},
        });
        assert.equal(closed.status, 200);
        const entries = ledger(item.orderId);
        const refund = entries.find((entry) => entry.entryType === "refund" && entry.reason === type);
        assert.equal(refund.amountCents, freightCents === 101 ? 1600 : 2000);
        assert.equal(entries.filter((entry) => entry.entryType === "refund"
          && entry.component === "products").reduce((sum, entry) => sum + entry.amountCents, 0), 2000);
        assert.equal(entries.some((entry) => entry.entryType === "refund"
          && entry.component === "freight"), false);
        const split = splitNormalFreight(freightCents);
        const distributions = entries.filter((entry) => entry.entryType === "distribution");
        assert.deepEqual(distributions.map((entry) => entry.amountCents),
          [split.courierCents, split.companyCents, split.ermesCents]);
        assert.deepEqual(distributions.map((entry) => entry.partyType), ["courier", "company", "ermes"]);
        assert.equal(distributions.reduce((sum, entry) => sum + entry.amountCents, 0), freightCents);
        const attemptId = db.prepare("SELECT id FROM delivery_attempts WHERE delivery_id = ?")
          .get(item.delivery.id).id;
        const snapshot = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
          .all(item.orderId);
        const keyPrefix = `delivery:${item.delivery.id}:${type.replaceAll("_", "-")}`;
        assert.deepEqual(snapshot.filter((entry) => entry.reason === type)
          .map((entry) => entry.idempotency_key), [
          `${keyPrefix}:refund-products`,
          `${keyPrefix}:distribution-freight:courier`,
          `${keyPrefix}:distribution-freight:company`,
          `${keyPrefix}:distribution-freight:ermes`,
        ]);
        assert.equal(snapshot.find((entry) => entry.idempotency_key.endsWith(":courier"))
          .party_user_id, courier1);
        assert.equal(snapshot.find((entry) => entry.idempotency_key.endsWith(":company"))
          .party_company_id, company1);
        recordRecipientTerminalFailureInTransaction(db, {
          id: item.delivery.id, orderId: item.orderId, companyId: company1, clientId: client1,
          itemsTotalCents: 2000, freightTotalCents: freightCents, paymentStatus: "paid",
          paymentPaidAt: db.prepare("SELECT payment_paid_at AS value FROM orders WHERE id = ?")
            .get(item.orderId).value,
        }, attemptId, type);
        assert.deepEqual(db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
          .all(item.orderId), snapshot);
        assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
          cookie: cookies.company1, method: "POST", body: {},
        })).status, 409);
        const client = (await (await request(`/api/client/deliveries/${item.delivery.id}`,
          { cookie: cookies.client1 })).json()).delivery.financial;
        assert.equal(client.refundedTotalCents, 2000);
        assert.equal(client.refundStatus, "partial");
        assert.deepEqual(client.pending, []);
        const company = (await (await request(`/api/company/deliveries/${item.delivery.id}`,
          { cookie: cookies.company1 })).json()).delivery.financial;
        assert.ok(company.distributions.some((entry) => entry.reason === type
          && entry.amountCents === split.companyCents));
        const courier = (await (await request("/api/courier/financial-entries",
          { cookie: cookies.courier1 })).json());
        assert.ok(courier.entries.some((entry) => entry.deliveryId === item.delivery.id
          && entry.amountCents === split.courierCents));
      }
    }
  });

  await context.test("falha no refund e na distribuição reverte operação e ledger", async () => {
    for (const component of ["refund", "distribution"]) {
      const item = createDelivery({ freightCents: 101 });
      await advanceToDestination(item);
      assert.equal((await postCourier(item.delivery.id, "occurrences",
        { type: "recipient_absent" })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      const before = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
        .all(item.orderId);
      db.exec(`CREATE TRIGGER fail_recipient_finance BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = '${component}' AND NEW.reason = 'recipient_absent'
        BEGIN SELECT RAISE(ABORT, 'forced recipient finance failure'); END;`);
      const failed = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      });
      db.exec("DROP TRIGGER fail_recipient_finance");
      assert.equal(failed.status, 500);
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
        .all(item.orderId), before);
      assert.deepEqual({ ...db.prepare("SELECT status, courier_id AS courierId, returned_at AS returnedAt FROM deliveries WHERE id = ?")
        .get(item.delivery.id) }, {
        status: "awaiting_return_confirmation", courierId: courier1, returnedAt: null,
      });
      const attempt = db.prepare(`SELECT status, ended_at AS endedAt, end_reason AS endReason,
        end_nature AS endNature FROM delivery_attempts WHERE delivery_id = ?`).get(item.delivery.id);
      assert.deepEqual({ ...attempt }, {
        status: "returning", endedAt: null, endReason: null, endNature: null,
      });
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM delivery_events
        WHERE delivery_id = ? AND event_type = 'return_confirmed'`).get(item.delivery.id).total, 0);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
    }
  });

  await context.test("refund anterior integral não duplica; classificação posterior não altera financeiro", async () => {
    const item = createDelivery({ freightCents: 101 });
    await advanceToDestination(item);
    insertFinancialEntryInTransaction(db, {
      orderId: item.orderId, deliveryId: item.delivery.id, entryType: "refund",
      component: "products", partyType: "client", partyId: client1,
      amountCents: 2000, reason: "product_unavailable",
      idempotencyKey: `test:full-prior-refund:${item.delivery.id}`,
    });
    assert.equal((await postCourier(item.delivery.id, "occurrences",
      { type: "recipient_refused" })).status, 200);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    assert.equal(ledger(item.orderId).filter((entry) => entry.entryType === "refund").length, 1);
    const before = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
      .all(item.orderId);
    const occurrenceId = db.prepare("SELECT id FROM delivery_occurrences WHERE delivery_id = ?")
      .get(item.delivery.id).id;
    const classified = await request(`/api/company/delivery-occurrences/${occurrenceId}/classify`, {
      cookie: cookies.company1, method: "POST",
      body: { responsibility: "INDEFINIDO" },
    });
    assert.equal(classified.status, 200);
    assert.deepEqual(db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
      .all(item.orderId), before);
  });

  await context.test("frete NULL cobrado e chave divergente exigem reconciliação", async () => {
    for (const mode of ["freight-null-with-payment", "divergent-key"]) {
      const item = createDelivery({ freightCents: 101 });
      await advanceToDestination(item);
      assert.equal((await postCourier(item.delivery.id, "occurrences",
        { type: "recipient_absent" })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      if (mode === "freight-null-with-payment") {
        db.prepare("UPDATE orders SET freight_total_cents = NULL WHERE id = ?").run(item.orderId);
      } else {
        insertFinancialEntryInTransaction(db, {
          orderId: item.orderId, deliveryId: item.delivery.id, entryType: "refund",
          component: "products", partyType: "client", partyId: client1,
          amountCents: 100, reason: "product_unavailable",
          idempotencyKey: `delivery:${item.delivery.id}:recipient-absent:refund-products`,
        });
      }
      const before = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
        .all(item.orderId);
      const response = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      });
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error, "Erro interno.");
      assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = ?").get(item.delivery.id).status,
        "awaiting_return_confirmation");
      assert.deepEqual(db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
        .all(item.orderId), before);
      if (mode === "freight-null-with-payment") {
        db.prepare("UPDATE orders SET freight_total_cents = 101 WHERE id = ?").run(item.orderId);
      } else {
        // A chave divergente é evidência persistida: não há correção automática nem UPDATE no ledger.
        // A fixture isolada libera o motoboy para os cenários seguintes.
        db.prepare("UPDATE deliveries SET status = 'returned', courier_id = NULL WHERE id = ?")
          .run(item.delivery.id);
        continue;
      }
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
    }
  });

  function assertTerminalFinanceReconciliationCode(item, reason) {
    const attemptId = db.prepare("SELECT id FROM delivery_attempts WHERE delivery_id = ?")
      .get(item.delivery.id).id;
    assert.throws(() => transaction(() => {
      db.prepare(`UPDATE delivery_attempts SET status = 'closed_unsuccessfully',
        ended_at = CURRENT_TIMESTAMP, end_reason = ?, end_nature = 'terminal'
        WHERE id = ?`).run(reason, attemptId);
      db.prepare(`UPDATE deliveries SET status = 'returned', courier_id = NULL,
        returned_at = CURRENT_TIMESTAMP WHERE id = ?`).run(item.delivery.id);
      db.prepare(`INSERT INTO delivery_events(delivery_id, actor_user_id, event_type, details_json)
        VALUES (?, ?, 'return_confirmed', ?)`).run(item.delivery.id, companyUser1,
        JSON.stringify({ reason }));
      recordRecipientTerminalFailureInTransaction(db, {
        id: item.delivery.id, orderId: item.orderId, companyId: company1, clientId: client1,
        itemsTotalCents: 2000, freightTotalCents: 101, paymentStatus: "paid",
        paymentPaidAt: db.prepare("SELECT payment_paid_at AS value FROM orders WHERE id = ?")
          .get(item.orderId).value,
      }, attemptId, reason);
    }), (error) => error.code === "FINANCIAL_RECONCILIATION_REQUIRED");
  }

  async function assertBlockedTerminalClose(item, reason) {
    const deliveryBefore = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id);
    const attemptsBefore = db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ?")
      .all(item.delivery.id);
    const eventsBefore = db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ?")
      .all(item.delivery.id);
    const ledgerBefore = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
      .all(item.orderId);
    const response = await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    });
    assert.equal(response.status, 500);
    assertTerminalFinanceReconciliationCode(item, reason);
    assert.deepEqual(db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id), deliveryBefore);
    assert.deepEqual(db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ?")
      .all(item.delivery.id), attemptsBefore);
    assert.deepEqual(db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ?")
      .all(item.delivery.id), eventsBefore);
    assert.deepEqual(db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id")
      .all(item.orderId), ledgerBefore);
    assert.equal(deliveryBefore.status, "awaiting_return_confirmation");
    assert.equal(attemptsBefore[0].status, "returning");
    assert.equal(deliveryBefore.returned_at, null);
  }

  await context.test("motoboy da tentativa contradiz coleta, ocorrência e retorno: rollback integral", async () => {
    for (const reason of ["recipient_absent", "recipient_refused"]) {
      const item = createDelivery({ freightCents: 101 });
      await advanceToDestination(item);
      assert.equal((await postCourier(item.delivery.id, "occurrences", { type: reason })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      db.prepare("UPDATE delivery_attempts SET courier_id = ? WHERE delivery_id = ?")
        .run(courier1Alternate, item.delivery.id);
      await assertBlockedTerminalClose(item, reason);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM financial_entries
        WHERE delivery_id = ? AND entry_type = 'distribution'`).get(item.delivery.id).total, 0);
      db.prepare("UPDATE delivery_attempts SET courier_id = ? WHERE delivery_id = ?")
        .run(courier1, item.delivery.id);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      assert.equal(db.prepare(`SELECT party_user_id AS courierId FROM financial_entries
        WHERE delivery_id = ? AND entry_type = 'distribution' AND party_type = 'courier'`)
        .get(item.delivery.id).courierId, courier1);
    }
  });

  await context.test("refund anterior de frete, parcial ou integral, bloqueia ambos os motivos", async () => {
    for (const reason of ["recipient_absent", "recipient_refused"]) {
      for (const refundedFreightCents of [1, 101]) {
        const item = createDelivery({ freightCents: 101 });
        await advanceToDestination(item);
        assert.equal((await postCourier(item.delivery.id, "occurrences", { type: reason })).status, 200);
        assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
        insertFinancialEntryInTransaction(db, {
          orderId: item.orderId, deliveryId: item.delivery.id, entryType: "refund",
          component: "freight", partyType: "client", partyId: client1,
          amountCents: refundedFreightCents, reason: "product_unavailable",
          idempotencyKey: `test:prior-freight-refund:${item.delivery.id}`,
        });
        await assertBlockedTerminalClose(item, reason);
        assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM financial_entries
          WHERE delivery_id = ? AND entry_type = 'distribution'`).get(item.delivery.id).total, 0);
        // Libera o motoboy apenas na fixture isolada; não altera o ledger inconsistente.
        db.prepare("UPDATE deliveries SET status = 'returned', courier_id = NULL WHERE id = ?")
          .run(item.delivery.id);
      }
    }
  });

  await context.test("tentativa terminal após retorno recuperável usa somente o ciclo da segunda coleta", async () => {
    for (const reason of ["recipient_absent", "recipient_refused"]) {
      const item = createDelivery({ freightCents: 101 });
      await advanceToDestination(item);
      assert.equal((await postCourier(item.delivery.id, "fail",
        { reason: "Veículo avariado" })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      await advanceToDestination(item);
      assert.deepEqual(db.prepare(`SELECT attempt_number AS number FROM delivery_attempts
        WHERE delivery_id = ? ORDER BY attempt_number`).all(item.delivery.id)
        .map(({ number }) => number), [1, 2]);
      assert.equal((await postCourier(item.delivery.id, "occurrences", { type: reason })).status, 200);
      assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
      assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
        cookie: cookies.company1, method: "POST", body: {},
      })).status, 200);
      assert.deepEqual(ledger(item.orderId).filter((entry) => entry.entryType === "distribution")
        .map((entry) => entry.amountCents), [71, 25, 5]);
    }
  });
});
