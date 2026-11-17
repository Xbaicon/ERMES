import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const destination = JSON.stringify({
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Centro",
  street: "Rua Financeira", number: "10", complement: "",
});

test("cancelamento pré-coleta financeiro — Baseline 0.2", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-prepickup-finance-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?finance=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  const { hashPassword } = await import("../src/security.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
  const {
    backfillFinancialEntries, insertFinancialEntryInTransaction, orderRefundSummary,
    recordPaymentInTransaction, recordClientCancellationBeforePickupInTransaction,
  } = await import("../src/finance.js");
  const { cancelClientDelivery } = await import("../src/delivery-operations.js");
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
    (company_id, role, full_name, email, password_hash) VALUES (?, ?, ?, ?, ?)`)
    .run(companyId, role, email, email, passwordHash).lastInsertRowid);
  const client1 = createUser("client", "cliente.financeiro@ermes.local");
  const client2 = createUser("client", "cliente.outro@ermes.local");
  const companyUser1 = createUser("company", "empresa.financeiro@ermes.local", company1);
  const companyUser2 = createUser("company", "empresa.outra@ermes.local", company2);
  const courier1 = createUser("courier", "motoboy.financeiro@ermes.local", company1);
  const courier2 = createUser("courier", "motoboy.outro@ermes.local", company2);
  for (const courierId of [courier1, courier2]) {
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

  function createDelivery({ freightCents = 101, itemsCents = 2000, pending = false } = {}) {
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
      if (pending) {
        db.prepare("UPDATE orders SET payment_status = 'pending', payment_paid_at = NULL WHERE id = ?").run(orderId);
      } else recordPaymentInTransaction(db, order, result.delivery.id);
      return { ...result, orderId };
    });
  }
  const postCourier = (deliveryId, action, body = {}) => request(
    `/api/courier/deliveries/${deliveryId}/${action}`,
    { cookie: cookies.courier1, method: "POST", body },
  );
  const cancel = (item, cookie = cookies.client1, body = {}) => request(
    `/api/client/deliveries/${item.delivery.id}/cancel`, { method: "POST", cookie, body },
  );
  const detailResponse = (item) => request(`/api/client/deliveries/${item.delivery.id}`, { cookie: cookies.client1 });
  async function detail(item) {
    const response = await detailResponse(item);
    assert.equal(response.status, 200);
    return (await response.json()).delivery;
  }
  const rawLedger = (item) => {
    const statement = db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id");
    statement.setReadBigInts(true);
    return statement.all(item.orderId).map((row) => Object.fromEntries(Object.entries(row)
      .map(([name, value]) => [name, typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value) : value])));
  };
  const snapshot = (item) => ({
    delivery: db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id),
    order: db.prepare("SELECT * FROM orders WHERE id = ?").get(item.orderId),
    events: db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id").all(item.delivery.id),
    attempts: db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY id").all(item.delivery.id),
    ledger: rawLedger(item),
  });
  const key = (item, component) => `delivery:${item.delivery.id}:client-cancelled-before-pickup:refund-${component}`;
  const refunds = (item) => rawLedger(item).filter((e) => e.entry_type === "refund");
  function noDistributionOrAttempt(item) {
    assert.equal(rawLedger(item).filter((e) => e.entry_type === "distribution").length, 0);
    assert.equal(snapshot(item).attempts.length, 0);
  }
  // Fixtures legados incompatíveis não passam pelas proteções atuais; restaure
  // todas as proteções antes de testar a operação real.
  function corruptLedger(work) {
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'financial_entries'").all();
    try {
      for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
      db.exec("PRAGMA ignore_check_constraints = ON");
      work();
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
      for (const { sql } of triggers) db.exec(sql);
    }
  }
  function rawRefund(item, component, amount, { reason = "client_cancelled_before_pickup",
    client = client1, deliveryId = item.delivery.id, orderId = item.orderId,
    idempotencyKey = `raw:${item.orderId}:${component}` } = {}) {
    db.prepare(`INSERT INTO financial_entries (order_id, delivery_id, entry_type, component,
      party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', ?, 'client', ?, ?, ?, ?)`)
      .run(orderId, deliveryId, component, client, amount, reason, idempotencyKey);
  }
  function priorRefund(item, component, amount, options = {}) {
    corruptLedger(() => rawRefund(item, component, amount, {
      reason: "historical_adjustment", ...options,
    }));
  }
  function cancelledEvidence(item, actor = client1) {
    db.prepare("UPDATE deliveries SET status = 'cancelled', courier_id = NULL, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(item.delivery.id);
    db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type)
      VALUES (?, ?, 'client_cancelled_before_pickup')`).run(item.delivery.id, actor);
  }
  async function rejectsUnchanged(item) {
    const before = snapshot(item);
    assert.throws(() => cancelClientDelivery(item.delivery.id, client1, {}), {
      code: "FINANCIAL_RECONCILIATION_REQUIRED",
    });
    assert.deepEqual(snapshot(item), before);
    assert.equal((await cancel(item)).status, 500);
    assert.deepEqual(snapshot(item), before);
  }
  async function advance(item, actions) {
    for (const action of actions) assert.equal((await postCourier(item.delivery.id, action)).status, 200);
  }

  for (const [state, actions] of [
    ["available", []], ["heading_to_pickup", ["accept"]],
    ["awaiting_pickup", ["accept", "arrive-pickup"]],
  ]) {
    await context.test(`${state}: refund integral, projeções e liberação do motoboy`, async () => {
      const item = createDelivery();
      await advance(item, actions);
      const before = snapshot(item);
      assert.equal(before.delivery.status, state);
      const response = await cancel(item);
      assert.equal(response.status, 200);
      const result = (await response.json()).delivery;
      assert.equal(result.status, "cancelled");
      assert.equal(result.officialStatus, "CANCELADA");
      assert.equal(result.orderOfficialStatus, "CANCELADO");
      assert.equal(result.financial.paymentStatus, "paid");
      assert.equal(result.financial.refundStatus, "full");
      assert.equal(result.financial.refundedTotalCents, 2101);
      assert.deepEqual(result.financial.pending, []);
      assert.equal(snapshot(item).order.status, "confirmed");
      assert.equal(snapshot(item).delivery.courier_id, null);
      assert.deepEqual(snapshot(item).events.slice(0, -1), before.events);
      assert.deepEqual(refunds(item).map((e) => [e.component, e.amount_cents]), [["products", 2000], ["freight", 101]]);
      assert.ok(refunds(item).every((e) => e.reason === "client_cancelled_before_pickup"));
      noDistributionOrAttempt(item);
      const after = snapshot(item);
      assert.equal((await cancel(item)).status, 409);
      transaction(() => recordClientCancellationBeforePickupInTransaction(db, item.delivery));
      assert.deepEqual(snapshot(item), after);
      const next = createDelivery();
      await advance(next, ["accept"]);
      assert.equal((await cancel(next)).status, 200);
      assert.equal(db.prepare("SELECT order_blocked_until FROM users WHERE id = ?").get(client1).order_blocked_until, null);
    });
  }
  await context.test("pending sem pagamento: cancela sem refund fictício", async () => {
    const item = createDelivery({ pending: true });
    const response = await cancel(item);
    assert.equal(response.status, 200);
    const financial = (await response.json()).delivery.financial;
    assert.equal(financial.paymentStatus, "pending");
    assert.equal(financial.refundStatus, "none");
    assert.equal(financial.paidTotalCents, null);
    assert.equal(financial.refundedTotalCents, 0);
    assert.deepEqual(financial.pending, []);
    assert.deepEqual(rawLedger(item), []);
    noDistributionOrAttempt(item);
  });
  for (const [itemsCents, freightCents, expected] of [[2000, null, 2000], [2000, 0, 2000], [0, 101, 101], [0, 0, 0], [0, null, 0]]) {
    await context.test(`produtos ${itemsCents}, frete ${freightCents}: zero e NULL distintos`, async () => {
      const item = createDelivery({ itemsCents, freightCents });
      assert.equal((await cancel(item)).status, 200);
      const { financial } = await detail(item);
      assert.equal(financial.refundedTotalCents, expected);
      assert.equal(financial.refundStatus, expected ? "full" : "none");
      assert.equal(financial.paidFreightCents, freightCents);
      assert.deepEqual(financial.pending, freightCents === null ? ["freight_amount_unavailable"] : []);
      assert.ok(refunds(item).every((e) => e.amount_cents > 0));
      noDistributionOrAttempt(item);
    });
  }
  for (const [products, freight] of [[500, 1], [2000, 1], [500, 101], [2000, 101]]) {
    await context.test(`refunds acumulados products=${products}, freight=${freight}`, async () => {
      const item = createDelivery();
      priorRefund(item, "products", products);
      priorRefund(item, "freight", freight);
      const before = rawLedger(item);
      assert.equal((await cancel(item)).status, 200);
      assert.deepEqual(rawLedger(item).slice(0, before.length), before);
      const created = refunds(item).filter((e) => e.reason === "client_cancelled_before_pickup");
      assert.deepEqual(created.map((e) => [e.component, e.amount_cents]),
        [["products", 2000 - products], ["freight", 101 - freight]].filter(([, n]) => n > 0));
      assert.equal((await detail(item)).financial.refundStatus, "full");
      const after = rawLedger(item);
      transaction(() => recordClientCancellationBeforePickupInTransaction(db, item.delivery));
      assert.deepEqual(rawLedger(item), after);
    });
  }
  for (const [name, mutate] of [
    ["over-refund products", (item) => priorRefund(item, "products", 2001)],
    ["over-refund freight", (item) => priorRefund(item, "freight", 102)],
    ["refund terminal incompatível", (item) => priorRefund(item, "products", 500, { reason: "product_unavailable" })],
    ["colisão de chave", (item) => priorRefund(item, "products", 500, { idempotencyKey: key(item, "products") })],
    ["refund de outro cliente", (item) => priorRefund(item, "products", 500, { client: client2 })],
    ["refund de outra Entrega", (item) => priorRefund(item, "products", 500, { deliveryId: createDelivery().delivery.id })],
    ["refund de outro Pedido apontando à Entrega", (item) => priorRefund(item, "products", 500, { orderId: createDelivery().orderId })],
    ["produtos sem payment", (item) => corruptLedger(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ? AND component = 'products'").run(item.orderId))],
    ["frete conhecido sem payment", (item) => corruptLedger(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ? AND component = 'freight'").run(item.orderId))],
    ["frete NULL com payment", (item) => db.prepare("UPDATE orders SET freight_total_cents = NULL WHERE id = ?").run(item.orderId)],
    ["snapshot products divergente", (item) => db.prepare("UPDATE orders SET items_total_cents = 1999 WHERE id = ?").run(item.orderId)],
    ["snapshot itens divergente", (item) => db.prepare("UPDATE order_items SET unit_price_cents = 1999 WHERE order_id = ?").run(item.orderId)],
    ["snapshot freight divergente", (item) => db.prepare("UPDATE orders SET freight_total_cents = 102 WHERE id = ?").run(item.orderId)],
    ["pagamento duplicado", (item) => corruptLedger(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
      SELECT order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key || ':duplicate'
      FROM financial_entries WHERE order_id = ? AND component = 'products'`).run(item.orderId))],
    ["pagamento de outro cliente", (item) => corruptLedger(() => db.prepare("UPDATE financial_entries SET party_user_id = ? WHERE order_id = ?").run(client2, item.orderId))],
    ["valor fracionário", (item) => corruptLedger(() => db.prepare("UPDATE financial_entries SET amount_cents = 1.5 WHERE order_id = ? AND component = 'products'").run(item.orderId))],
    ["inteiro inseguro", (item) => corruptLedger(() => db.prepare("UPDATE financial_entries SET amount_cents = 9007199254740992 WHERE order_id = ? AND component = 'products'").run(item.orderId))],
    ["distribuição incompatível", (item) => corruptLedger(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'distribution', 'freight', 'courier', ?, 1, 'delivery_completed', ?)`)
      .run(item.orderId, item.delivery.id, courier1, `distribution:${item.orderId}`))],
  ]) {
    await context.test(`reconciliação sem mutação: ${name}`, async () => {
      const item = createDelivery();
      mutate(item);
      await rejectsUnchanged(item);
    });
  }
  await context.test("chave de outro Pedido e chave sem saldo exigem reconciliação", async () => {
    const item = createDelivery();
    const other = createDelivery();
    priorRefund(other, "products", 500, { idempotencyKey: key(item, "products") });
    await rejectsUnchanged(item);
    const zero = createDelivery({ itemsCents: 0 });
    priorRefund(zero, "products", 0, { idempotencyKey: key(zero, "products"), reason: "client_cancelled_before_pickup" });
    await rejectsUnchanged(zero);
  });
  await context.test("falha no evento de cancelamento reverte atribuição e ledger", async () => {
    const item = createDelivery();
    await advance(item, ["accept"]);
    const before = snapshot(item);
    db.exec(`CREATE TRIGGER fail_cancellation_event BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'client_cancelled_before_pickup'
      BEGIN SELECT RAISE(ABORT, 'forced cancellation event failure'); END;`);
    try {
      assert.equal((await cancel(item)).status, 500);
      assert.deepEqual(snapshot(item), before);
    } finally { db.exec("DROP TRIGGER fail_cancellation_event"); }
    assert.equal((await cancel(item)).status, 200);
  });
  await context.test("estado terminal inválido e retorno pendente rejeitam cancelamento sem financeiro", async () => {
    for (const state of ["completed", "returning", "awaiting_return_confirmation", "awaiting_revalidation", "returned"]) {
      const item = createDelivery();
      db.prepare("UPDATE deliveries SET status = ? WHERE id = ?").run(state, item.delivery.id);
      const before = snapshot(item);
      assert.equal((await cancel(item)).status, 409);
      assert.deepEqual(snapshot(item), before);
    }
  });
  await context.test("pending com payment persistido exige reconciliação", async () => {
    const item = createDelivery();
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_payment_ledger_regression_update'").get().sql;
    try {
      db.exec("DROP TRIGGER order_payment_ledger_regression_update");
      db.prepare("UPDATE orders SET payment_status = 'pending', payment_paid_at = NULL WHERE id = ?").run(item.orderId);
    } finally { db.exec(trigger); }
    await rejectsUnchanged(item);
  });
  for (const component of ["products", "freight"]) {
    await context.test(`rollback integral na inserção de ${component} e repetição após retirar falha`, async () => {
      const item = createDelivery();
      await advance(item, ["accept", "arrive-pickup"]);
      const before = snapshot(item);
      const financialBefore = (await detail(item)).financial;
      let attemptedProducts = 0;
      db.function("observe_product_refund", () => { attemptedProducts++; return 1; });
      db.exec(`CREATE TRIGGER observe_refund BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = 'refund' AND NEW.component = 'products'
        BEGIN SELECT observe_product_refund(); END;
        CREATE TRIGGER fail_refund BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = 'refund' AND NEW.component = '${component}'
        BEGIN SELECT RAISE(ABORT, 'forced refund failure'); END;`);
      try {
        assert.equal((await cancel(item)).status, 500);
        if (component === "freight") assert.equal(attemptedProducts, 1);
        assert.deepEqual(snapshot(item), before);
        assert.deepEqual((await detail(item)).financial, financialBefore);
      } finally { db.exec("DROP TRIGGER fail_refund; DROP TRIGGER observe_refund;"); }
      assert.equal((await cancel(item)).status, 200);
      assert.equal((await detail(item)).financial.refundedTotalCents, 2101);
      noDistributionOrAttempt(item);
    });
  }
  await context.test("autorização e corpo inválido não mudam financeiro", async () => {
    const item = createDelivery();
    const before = snapshot(item);
    for (const [cookie, body, status] of [
      [null, {}, 401], [cookies.company1, {}, 403], [cookies.courier1, {}, 403],
      [cookies.client2, {}, 404], [cookies.client1, { amountCents: 1 }, 400],
    ]) {
      assert.equal((await cancel(item, cookie, body)).status, status);
      assert.deepEqual(snapshot(item), before);
    }
    assert.equal((await cancel(item)).status, 200);
  });
  await context.test("duas requisições concorrentes: um cancelamento e um par de refunds", async () => {
    const item = createDelivery();
    const responses = await Promise.all([cancel(item), cancel(item)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(refunds(item).length, 2);
    assert.equal(snapshot(item).events.filter((e) => e.event_type === "client_cancelled_before_pickup").length, 1);
    noDistributionOrAttempt(item);
  });
  await context.test("falha mecânica pré-coleta preserva eventos e permite refund integral", async () => {
    const item = createDelivery();
    await advance(item, ["accept", "arrive-pickup"]);
    assert.equal((await postCourier(item.delivery.id, "fail", { reason: "Falha mecânica antes da coleta" })).status, 200);
    const before = snapshot(item);
    assert.equal((await cancel(item)).status, 200);
    assert.deepEqual(snapshot(item).events.slice(0, -1), before.events);
    noDistributionOrAttempt(item);
    assert.equal((await detail(item)).financial.refundedTotalCents, 2101);
  });
  await context.test("tentativa recuperável anterior: available com collected_at limpo exige reconciliação", async () => {
    const item = createDelivery();
    await advance(item, ["accept", "arrive-pickup", "collect"]);
    assert.equal((await postCourier(item.delivery.id, "fail", { reason: "Falha mecânica após coleta" })).status, 200);
    await advance(item, ["report-return"]);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    const before = snapshot(item);
    assert.equal(before.delivery.status, "available");
    assert.equal(before.delivery.collected_at, null);
    assert.equal(before.attempts[0].end_nature, "recoverable");
    await rejectsUnchanged(item);
  });
  for (const eventType of ["order_collected", "delivery_completed", "product_unavailable", "client_cancelled_after_pickup", "confirmation_failed"]) {
    await context.test(`evento conflitante ${eventType} sem tentativa bloqueia pré-coleta`, async () => {
      const item = createDelivery();
      db.prepare("INSERT INTO delivery_events (delivery_id, actor_user_id, event_type) VALUES (?, ?, ?)")
        .run(item.delivery.id, courier1, eventType);
      await rejectsUnchanged(item);
    });
  }
  await context.test("tentativa ativa e custódia pendente bloqueiam estado available inconsistente", async () => {
    const item = createDelivery();
    await advance(item, ["accept", "arrive-pickup", "collect"]);
    db.prepare("UPDATE deliveries SET status = 'available', courier_id = NULL, collected_at = NULL WHERE id = ?").run(item.delivery.id);
    await rejectsUnchanged(item);
  });
  await context.test("SQL direto exige evidência pré-coleta, proprietário, relação e limites", () => {
    const item = createDelivery();
    assert.throws(() => rawRefund(item, "products", 1), /invalid financial entry kind/);
    cancelledEvidence(item, client2);
    assert.throws(() => rawRefund(item, "products", 1), /invalid financial entry kind/);
    db.prepare("UPDATE delivery_events SET actor_user_id = ? WHERE delivery_id = ? AND event_type = 'client_cancelled_before_pickup'")
      .run(client1, item.delivery.id);
    assert.throws(() => rawRefund(item, "products", 1, { client: client2 }), /refund does not match/);
    assert.throws(() => rawRefund(item, "products", 2001), /refund exceeds/);
    assert.throws(() => rawRefund(item, "freight", 102), /refund exceeds/);
    assert.throws(() => rawRefund(item, "products", 1, { deliveryId: createDelivery().delivery.id }), /invalid financial|does not belong/);
    rawRefund(item, "products", 2000);
    rawRefund(item, "freight", 101);
    assert.equal(orderRefundSummary(db, item.orderId).refundedTotalCents, 2101);
    assert.throws(() => db.prepare("UPDATE financial_entries SET amount_cents = 1 WHERE order_id = ?").run(item.orderId), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ?").run(item.orderId), /append-only/);
    assert.throws(() => insertFinancialEntryInTransaction(db, {
      orderId: item.orderId, deliveryId: item.delivery.id, entryType: "distribution", component: "freight",
      partyType: "courier", partyId: courier1, amountCents: 1,
      reason: "client_cancelled_before_pickup", idempotencyKey: `forbidden:${item.orderId}`,
    }));
  });
  await context.test("SQL direto rejeita conflito, tentativa anterior e horário inválido", () => {
    for (const mutate of [
      (item) => db.prepare("INSERT INTO delivery_events (delivery_id, event_type) VALUES (?, 'order_collected')").run(item.delivery.id),
      (item) => db.prepare(`INSERT INTO delivery_attempts (delivery_id, attempt_number, courier_id, status,
        ended_at, end_reason, end_nature) VALUES (?, 1, ?, 'closed_unsuccessfully', CURRENT_TIMESTAMP, 'courier_failure_after_pickup', 'recoverable')`).run(item.delivery.id, courier1),
      (item) => db.prepare("UPDATE deliveries SET cancelled_at = '2026-02-30 10:00:00' WHERE id = ?").run(item.delivery.id),
      (item) => db.prepare("UPDATE deliveries SET collected_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.delivery.id),
    ]) {
      const item = createDelivery();
      cancelledEvidence(item);
      mutate(item);
      assert.throws(() => rawRefund(item, "products", 1), /invalid financial entry kind/);
    }
  });
  await context.test("projeções não escondem conflito sob produto indisponível ou refund faltante", async () => {
    const item = createDelivery();
    cancelledEvidence(item);
    assert.equal((await detailResponse(item)).status, 500);
    db.prepare("INSERT INTO delivery_events (delivery_id, actor_user_id, event_type) VALUES (?, ?, 'product_unavailable')")
      .run(item.delivery.id, companyUser1);
    assert.equal((await detailResponse(item)).status, 500);
  });
  await context.test("startup repetido preserva cancelamento legado sem fabricar refunds", async () => {
    // Usa banco separado: os demais cenários deliberadamente corrompem o ledger.
    const legacyPath = join(directory, "legacy.sqlite");
    const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { db } = await import('./src/database.js');
      db.prepare("INSERT INTO companies (id,name,cnpj,email) VALUES (1,'Empresa','123','e@e')").run();
      db.prepare("INSERT INTO users (id,role,full_name,email,password_hash) VALUES (1,'client','Cliente','c@c','hash')").run();
      db.prepare("INSERT INTO products (id,company_id,name,price_cents,unit_weight_kg) VALUES (1,1,'Produto',2000,1)").run();
      db.prepare("INSERT INTO orders (id,client_id,company_id,status,items_total_cents,freight_total_cents,payment_status,payment_paid_at,confirmed_at) VALUES (1,1,1,'confirmed',2000,101,'paid',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO order_items (order_id,product_id,quantity,unit_price_cents,unit_weight_kg) VALUES (1,1,1,2000,1)").run();
      db.prepare("INSERT INTO deliveries (id,order_id,status,confirmation_code_hash,cancelled_at) VALUES (1,1,'cancelled','hash',CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO delivery_events (delivery_id,event_type) VALUES (1,'delivery_created')").run();
      db.prepare("INSERT INTO delivery_events (delivery_id,actor_user_id,event_type) VALUES (1,1,'client_cancelled_before_pickup')").run();
      const { recordPaymentInTransaction } = await import('./src/finance.js');
      recordPaymentInTransaction(db, {id:1,clientId:1,itemsTotalCents:2000,freightTotalCents:101}, 1);
      db.close();
    `], { cwd: process.cwd(), env: { ...process.env, ERMES_DB_PATH: legacyPath }, encoding: "utf8" });
    assert.equal(seed.status, 0, seed.stderr);
    for (let i = 0; i < 2; i++) {
      const startup = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const { db } = await import('./src/database.js');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM financial_entries WHERE entry_type = 'refund'").get().n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM financial_entries").get().n, 2);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_attempts").get().n, 0);
        assert.equal(db.prepare("SELECT status FROM deliveries WHERE id = 1").get().status, 'cancelled');
        const { clientFinancialSummary } = await import('./src/finance.js');
        assert.throws(() => clientFinancialSummary(db, {id:1,orderId:1,clientId:1,companyId:1,status:'cancelled',returnReason:null}), {code:'FINANCIAL_RECONCILIATION_REQUIRED'});
        db.close();
      `], { cwd: process.cwd(), env: { ...process.env, ERMES_DB_PATH: legacyPath }, encoding: "utf8" });
      assert.equal(startup.status, 0, startup.stderr);
    }
  });
});
