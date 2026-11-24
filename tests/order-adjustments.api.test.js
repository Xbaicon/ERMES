import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("ajustes comerciais antes da coleta", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-adjustments-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { startServer, server } = await import("../src/server.js");
  const { db, transaction } = await import("../src/database.js");
  const { hashToken } = await import("../src/security.js");
  const { recordPaymentInTransaction } = await import("../src/finance.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = JSON.stringify({
    postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Centro",
    street: "Rua Um", number: "10",
  });
  const recipient = JSON.stringify({ type: "other", name: "Destinatário" });
  const insertId = (sql, ...params) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const companyId = (name) => insertId("INSERT INTO companies (name, email, cnpj) VALUES (?, ?, ?)",
    name, name + "@local.test", name);
  const company = companyId("empresa");
  const otherCompany = companyId("outra");
  function user(role, name, owner = null) {
    const id = insertId(`INSERT INTO users (role, full_name, email, company_id, password_hash)
      VALUES (?, ?, ?, ?, 'unused')`, role, name, name + "@local.test", owner);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .run(hashToken(name), id);
    return { id, cookie: `ermes_session=${name}` };
  }
  const client = user("client", "cliente");
  const other = user("client", "outro-cliente");
  const owner = user("company", "dono", company);
  const outsider = user("company", "outra-empresa", otherCompany);
  const courier = user("courier", "motoboy", company);
  db.prepare("INSERT INTO couriers (user_id, vehicle_type, is_online) VALUES (?, 'motorcycle', 1)")
    .run(courier.id);
  function product(name, cents, weight = 1, available = 1, ownerId = company) {
    return insertId(`INSERT INTO products (company_id, name, price_cents, unit_weight_kg, is_available)
      VALUES (?, ?, ?, ?, ?)`, ownerId, name, cents, weight, available);
  }
  const original = product("Original", 100);
  const equal = product("Mesmo valor", 100);
  const more = product("Mais caro", 101);
  const less = product("Mais barato", 99);
  const heavy = product("Pesado", 100, 8);
  const light = product("Leve", 100, 0.5);
  const foreign = product("De outra empresa", 100, 1, 1, otherCompany);
  const disabled = product("Indisponível", 100, 1, 0);
  const huge = product("Preço grande", Number.MAX_SAFE_INTEGER, 0.5);
  function fixture({ freight = null, base = original, cents = 100, weight = 1, pending = false, paidFreight = freight } = {}) {
    return transaction(() => {
      const orderId = insertId(`INSERT INTO orders (client_id, company_id, status, payment_status, payment_paid_at,
        confirmed_at, destination_snapshot_json, recipient_snapshot_json, items_total_cents, freight_total_cents, version)
        VALUES (?, ?, 'confirmed', 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, 4)`,
      client.id, company, address, recipient, cents, freight);
      db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
        VALUES (?, ?, 1, ?, ?)`).run(orderId, base, cents, weight);
      const { delivery, confirmationCode } = createDeliveryForEligibleOrderInTransaction(orderId);
      if (pending) {
        db.prepare("UPDATE orders SET payment_status = 'pending', payment_paid_at = NULL WHERE id = ?").run(orderId);
      } else {
        const { timestamp } = db.prepare("SELECT payment_paid_at AS timestamp FROM orders WHERE id = ?").get(orderId);
        recordPaymentInTransaction(db, {
          id: orderId, clientId: client.id, itemsTotalCents: cents, freightTotalCents: paidFreight, paymentPaidAt: timestamp,
        }, delivery.id);
      }
      return { orderId, deliveryId: delivery.id, confirmationCode };
    });
  }
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, actor, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: actor.cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  function companyPath(delivery, action = "adjustment") {
    return `/company/deliveries/${delivery.deliveryId}/${action}`;
  }
  function clientPath(delivery) {
    return `/client/deliveries/${delivery.deliveryId}`;
  }
  function proposal(delivery, productId, { version = 4, actor = owner, quantity = 1 } = {}) {
    return request(companyPath(delivery), actor, { version, items: [{ productId, quantity }] });
  }
  function decision(delivery, id, action, actor = client) {
    return request(clientPath(delivery) + `/adjustment/${id}/${action}`, actor, {});
  }
  function cancel(delivery, actor = client) {
    return request(clientPath(delivery) + "/cancel", actor, {});
  }
  function closeUnavailable(delivery) {
    return request(companyPath(delivery, "product-unavailable"), owner, {});
  }
  function replayPayment(delivery) {
    return request(`/client/orders/${delivery.orderId}/pay`, client, {});
  }
  function inspectAdjustment(delivery) {
    return request(clientPath(delivery) + "/adjustment", client);
  }
  function history(delivery) {
    return db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id").all(delivery.deliveryId);
  }
  function terminalWithoutFreight() {
    const delivery = fixture({ cents: 2000, freight: 100, paidFreight: null });
    const { created_at: timestamp } = stored(delivery).operation;
    db.prepare("UPDATE deliveries SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(timestamp, delivery.deliveryId);
    db.prepare(`INSERT INTO product_unavailability_closures (delivery_id, actor_id, origin, occurred_at)
      VALUES (?, ?, 'company_no_adjustment', ?)`).run(delivery.deliveryId, owner.id, timestamp);
    db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type, occurred_at)
      VALUES (?, ?, 'product_unavailable', ?)`).run(delivery.deliveryId, owner.id, timestamp);
    rawEntry(delivery, "refund", 2000);
    return delivery;
  }
  function restart() {
    execFileSync(process.execPath, ["--input-type=module", "-e",
      "import { db } from './src/database.js'; db.close();"]);
  }
  function ride(delivery, action, body = {}) {
    return request(`/courier/deliveries/${delivery.deliveryId}/${action}`, courier, body);
  }
  async function assign(delivery) {
    assert.equal((await ride(delivery, "accept")).status, 200);
    assert.equal((await ride(delivery, "arrive-pickup")).status, 200);
  }
  async function propose(delivery, productId, options) {
    const response = await proposal(delivery, productId, options);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.adjustment;
  }
  function stored(delivery) {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(delivery.orderId);
    const operation = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(delivery.deliveryId);
    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(delivery.orderId);
    return { order, operation, items };
  }
  function ledger(delivery) {
    return db.prepare(`SELECT entry_type AS type, component, amount_cents AS amount, reason, idempotency_key AS key
      FROM financial_entries WHERE order_id = ? ORDER BY id`).all(delivery.orderId).map((row) => ({ ...row }));
  }
  function events(delivery, type) {
    return db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ? AND event_type = ?")
      .all(delivery.deliveryId, type);
  }
  function attempts(delivery) {
    return db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ?").all(delivery.deliveryId);
  }
  function corruptLedger(work) {
    const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'financial_entries'").all();
    try {
      for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
      work();
    } finally {
      for (const { sql } of triggers) db.exec(sql);
    }
  }
  function rawEntry(delivery, type, amount, { component = "products", reason = "product_unavailable",
    key = `legacy:${delivery.orderId}:${type}:${component}` } = {}) {
    db.prepare(`INSERT INTO financial_entries (order_id, delivery_id, entry_type, component,
      party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, ?, ?, 'client', ?, ?, ?, ?)`)
      .run(delivery.orderId, delivery.deliveryId, type, component, client.id, amount, reason, key);
  }
  async function assertClosed(delivery, origin) {
    const response = await request(clientPath(delivery), client);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const view = response.body.delivery;
    assert.equal(view.officialStatus, "CANCELADA");
    assert.equal(view.orderOfficialStatus, "ENCERRADO");
    assert.equal(view.unavailability.origin, origin);
    assert.equal(view.unavailability.reason, "PRODUTO_INDISPONIVEL");
    assert.equal(view.unavailability.responsibility, "EMPRESA");
    assert.equal(stored(delivery).operation.courier_id, null);
    assert.equal(attempts(delivery).length, 0);
    assert.equal(events(delivery, "order_collected").length, 0);
    assert.equal(events(delivery, "product_unavailable").length, 1);
    assert.equal(ledger(delivery).filter(({ type }) => type === "distribution").length, 0);
  }

  await context.test("proposta, propriedade, payload, produtos e limites", async () => {
    const delivery = fixture();
    assert.equal((await proposal(delivery, equal, { actor: outsider })).status, 404);
    assert.equal((await request(companyPath(delivery), outsider)).status, 404);
    assert.equal((await request(clientPath(delivery) + "/adjustment", other)).status, 404);
    assert.equal((await request(companyPath(delivery), owner, { version: 4, items: [] })).status, 400);
    for (const [id, quantity] of [[foreign, 1], [disabled, 1], [heavy, 2], [equal, -1],
      [equal, 0], [equal, 1.25], [equal, Number.MAX_SAFE_INTEGER + 1], [huge, 2]]) {
      assert.equal((await proposal(delivery, id, { quantity })).status, 400);
    }
    assert.equal((await request(companyPath(delivery), owner, {
      version: 4, items: [{ productId: equal, quantity: 1, unitPriceCents: 1 }],
    })).status, 400);
    assert.equal((await proposal(delivery, equal, { version: 3 })).status, 409);
    const responses = await Promise.all([proposal(delivery, equal), proposal(delivery, more)]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const adjustment = responses.find(({ status }) => status === 200).body.adjustment;
    const repeated = await propose(delivery, adjustment.proposed.items[0].productId);
    assert.equal(repeated.id, adjustment.id);
    assert.equal(events(delivery, "order_adjustment_proposed").length, 1);
    assert.equal((await decision(delivery, adjustment.id, "accept", other)).status, 404);
    assert.equal((await decision(delivery, adjustment.id, "reject", other)).status, 404);
    assert.equal((await request(clientPath(delivery) + "/adjustment", client)).body.adjustment.state, "pending");
  });

  await context.test("aceite e pagamento recusam composição proposta persistida incoerente", async () => {
    const item = (productId, quantity = 1, unitPriceCents = 100, unitWeightKg = 1) => ({
      productId, name: db.prepare("SELECT name FROM products WHERE id = ?").get(productId)?.name
        ?? "Produto inexistente", quantity, unitPriceCents, unitWeightKg,
    });
    const persist = (delivery, proposedItems, proposedSubtotal = 100, proposedWeight = 1) =>
      insertId(`INSERT INTO order_adjustments
        (order_id, delivery_id, company_id, proposed_by, base_version, original_items,
         proposed_items, original_subtotal, proposed_subtotal, original_weight, proposed_weight,
         original_freight, proposed_freight)
        VALUES (?, ?, ?, ?, 4, ?, ?, 100, ?, 1, ?, NULL, NULL)`,
      delivery.orderId, delivery.deliveryId, company, owner.id,
      JSON.stringify([item(original)]), JSON.stringify(proposedItems), proposedSubtotal, proposedWeight);
    const snapshot = (delivery, adjustmentId) => ({
      state: stored(delivery), ledger: ledger(delivery), history: history(delivery),
      adjustment: db.prepare("SELECT * FROM order_adjustments WHERE id = ?").get(adjustmentId),
    });
    const invalid = [
      ["vazia", [], 0, 1],
      ["outra empresa", [item(foreign)], 100, 1],
      ["produto inexistente", [item(999999)], 100, 1],
      ["quantidade inválida", [item(equal, 0)], 0, 1],
      ["subtotal divergente", [item(equal)], 101, 1],
      ["peso divergente", [item(equal)], 100, 2],
      ["peso acima de 12 kg", [item(heavy, 2, 100, 8)], 200, 12],
      ["preço histórico adulterado", [item(original, 2, 101)], 202, 2],
      ["peso histórico adulterado", [item(original, 2, 100, 2)], 200, 4],
      ["produto duplicado", [item(equal), item(equal)], 200, 2],
      ["campo adicional", [{ ...item(equal), extra: true }], 100, 1],
    ];
    for (const [label, items, subtotal, weight] of invalid) {
      const delivery = fixture();
      const id = persist(delivery, items, subtotal, weight);
      assert.equal(db.prepare("SELECT 1 FROM order_adjustment_validations WHERE adjustment_id = ?")
        .get(id), undefined, label);
      const before = snapshot(delivery, id);
      assert.equal((await decision(delivery, id, "accept")).status, 409, label);
      assert.deepEqual(snapshot(delivery, id), before, label);
      assert.equal(before.adjustment.state, "pending", label);
      assert.equal(events(delivery, "order_adjustment_accepted").length, 0, label);
      assert.equal(events(delivery, "order_adjustment_applied").length, 0, label);
    }

    const payment = fixture();
    const paymentId = persist(payment, [item(more, 1, 102)], 102, 1);
    db.prepare(`UPDATE order_adjustments SET state = 'awaiting_payment',
      decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`).run(client.id, paymentId);
    const beforePayment = snapshot(payment, paymentId);
    assert.equal((await decision(payment, paymentId, "pay")).status, 409);
    assert.deepEqual(snapshot(payment, paymentId), beforePayment);
    assert.equal(events(payment, "order_adjustment_paid").length, 0);

    const forged = fixture();
    const forgedId = persist(forged, [item(more, 1, 102)], 102, 1);
    const copiedSeal = db.prepare("SELECT seal FROM order_adjustment_validations LIMIT 1").get().seal;
    db.prepare("UPDATE products SET price_cents = 102 WHERE id = ?").run(more);
    try {
      db.prepare(`INSERT INTO order_adjustment_validations
        (adjustment_id, order_id, company_id, proposed_items, proposed_subtotal, proposed_weight, seal)
        SELECT id, order_id, company_id, proposed_items, proposed_subtotal, proposed_weight, ?
          FROM order_adjustments WHERE id = ?`).run(copiedSeal, forgedId);
      const beforeForged = snapshot(forged, forgedId);
      assert.equal((await decision(forged, forgedId, "accept")).status, 409);
      assert.deepEqual(snapshot(forged, forgedId), beforeForged);
      assert.equal(events(forged, "order_adjustment_applied").length, 0);
    } finally {
      db.prepare("UPDATE products SET price_cents = 101 WHERE id = ?").run(more);
    }

    const normal = fixture();
    const proposal = await propose(normal, equal);
    assert.equal((await decision(normal, proposal.id, "accept")).status, 200);
    assert.equal(db.prepare("SELECT state FROM order_adjustments WHERE id = ?")
      .get(proposal.id).state, "applied");
  });

  await context.test("snapshot validado sobrevive a mudanças posteriores do catálogo", async () => {
    const priceCase = fixture();
    const expensive = await propose(priceCase, more);
    const evidence = db.prepare("SELECT * FROM order_adjustment_validations WHERE adjustment_id = ?")
      .get(expensive.id);
    assert.equal(evidence.proposed_items,
      db.prepare("SELECT proposed_items FROM order_adjustments WHERE id = ?").get(expensive.id).proposed_items);
    assert.equal((await decision(priceCase, expensive.id, "accept")).status, 200);
    db.prepare("UPDATE products SET price_cents = 102 WHERE id = ?").run(more);
    try {
      assert.equal((await decision(priceCase, expensive.id, "pay")).status, 200);
      assert.equal((await decision(priceCase, expensive.id, "pay")).status, 200);
      assert.equal(db.prepare("SELECT state FROM order_adjustments WHERE id = ?").get(expensive.id).state,
        "applied");
      assert.equal(stored(priceCase).items[0].unit_price_cents, 101);
      assert.equal(stored(priceCase).order.items_total_cents, 101);
      assert.equal(stored(priceCase).order.version, 5);
      assert.equal(db.prepare("SELECT price_cents FROM products WHERE id = ?").get(more).price_cents, 102);
      assert.deepEqual(ledger(priceCase).filter(({ reason }) => reason === "order_adjustment")
        .map(({ type, amount }) => [type, amount]), [["payment", 1]]);
      assert.equal(events(priceCase, "order_adjustment_paid").length, 1);
    } finally {
      db.prepare("UPDATE products SET price_cents = 101 WHERE id = ?").run(more);
    }

    const weightCase = fixture();
    const equalWeight = await propose(weightCase, equal);
    db.prepare("UPDATE products SET unit_weight_kg = 2 WHERE id = ?").run(equal);
    try {
      assert.equal((await decision(weightCase, equalWeight.id, "accept")).status, 200);
      assert.equal(stored(weightCase).items[0].unit_weight_kg, 1);
      assert.equal(db.prepare("SELECT unit_weight_kg FROM products WHERE id = ?").get(equal).unit_weight_kg, 2);
      assert.equal(events(weightCase, "order_adjustment_applied").length, 1);
    } finally {
      db.prepare("UPDATE products SET unit_weight_kg = 1 WHERE id = ?").run(equal);
    }

    const availabilityCase = fixture();
    const available = await propose(availabilityCase, equal);
    db.prepare("UPDATE products SET is_available = 0 WHERE id = ?").run(equal);
    try {
      assert.equal((await decision(availabilityCase, available.id, "accept")).status, 200);
      assert.equal(stored(availabilityCase).items[0].product_id, equal);
      assert.equal(db.prepare("SELECT is_available FROM products WHERE id = ?").get(equal).is_available, 0);
    } finally {
      db.prepare("UPDATE products SET is_available = 1 WHERE id = ?").run(equal);
    }

    assert.throws(() => db.prepare(`UPDATE order_adjustment_validations SET seal = ?
      WHERE adjustment_id = ?`).run("0".repeat(64), expensive.id), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM order_adjustment_validations WHERE adjustment_id = ?")
      .run(expensive.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE order_adjustments SET proposed_subtotal = 102 WHERE id = ?")
      .run(expensive.id), /invalid adjustment transition/);
    assert.throws(() => db.prepare(`UPDATE order_adjustments
      SET proposed_items = json_set(proposed_items, '$[0].unitPriceCents', 102)
      WHERE id = ?`).run(expensive.id), /invalid adjustment transition/);
    assert.throws(() => db.prepare("UPDATE order_adjustments SET proposed_weight = 2 WHERE id = ?")
      .run(expensive.id), /invalid adjustment transition/);

    const failedCreation = fixture();
    const before = { state: stored(failedCreation), ledger: ledger(failedCreation),
      history: history(failedCreation) };
    db.exec(`CREATE TRIGGER deny_adjustment_validation BEFORE INSERT ON order_adjustment_validations
      BEGIN SELECT RAISE(ABORT, 'forced validation failure'); END`);
    try {
      assert.equal((await proposal(failedCreation, equal)).status, 500);
      assert.deepEqual({ state: stored(failedCreation), ledger: ledger(failedCreation),
        history: history(failedCreation) }, before);
      assert.equal(db.prepare("SELECT 1 FROM order_adjustments WHERE delivery_id = ?")
        .get(failedCreation.deliveryId), undefined);
    } finally {
      db.exec("DROP TRIGGER deny_adjustment_validation");
    }
  });

  await context.test("coleta e tentativa anteriores são incompatíveis", async () => {
    const delivery = fixture();
    await assign(delivery);
    assert.equal((await ride(delivery, "collect")).status, 200);
    assert.equal((await proposal(delivery, equal)).status, 409);
    const contradictory = fixture();
    db.prepare(`INSERT INTO delivery_attempts (delivery_id, courier_id, attempt_number, status)
      VALUES (?, ?, 1, 'active')`).run(contradictory.deliveryId, courier.id);
    assert.equal((await proposal(contradictory, equal)).status, 409);
    const evidenceOnly = fixture();
    db.prepare("INSERT INTO delivery_events (delivery_id, event_type) VALUES (?, 'order_collected')")
      .run(evidenceOnly.deliveryId);
    assert.equal((await proposal(evidenceOnly, equal)).status, 409);
    assert.equal((await request(companyPath(evidenceOnly, "product-unavailable"), owner, {})).status, 409);
    await ride(delivery, "arrive-destination");
    assert.equal((await ride(delivery, "confirm", { code: delivery.confirmationCode })).status, 200);
  });

  await context.test("chat, aceite explícito, coleta concorrente e continuidade com delta zero", async () => {
    const delivery = fixture();
    await assign(delivery);
    const before = stored(delivery);
    const { id } = await propose(delivery, equal);
    const chat = await request(`/client/orders/${delivery.orderId}/chat`, client, { message: "Aceito pelo chat" });
    assert.equal(chat.status, 201, JSON.stringify(chat.body));
    assert.equal((await request(clientPath(delivery) + "/adjustment", client)).body.adjustment.state, "pending");
    const current = (await request("/courier/deliveries/current", courier)).body.delivery;
    assert.equal(current.collectionBlocked, true);
    assert.equal(current.adjustment, undefined);
    assert.equal(current.events.some(({ eventType }) => eventType.startsWith("order_adjustment")), false);
    assert.equal((await ride(delivery, "collect")).status, 409);
    assert.throws(() => db.prepare(`INSERT INTO delivery_attempts (delivery_id, courier_id, attempt_number, status)
      VALUES (?, ?, 1, 'active')`).run(delivery.deliveryId, courier.id), /adjustment blocks/);
    const [accepted, collected, closed] = await Promise.all([
      decision(delivery, id, "accept"), ride(delivery, "collect"),
      request(companyPath(delivery, "product-unavailable"), owner, {}),
    ]);
    assert.equal(accepted.status, 200);
    assert.equal(collected.status, 409);
    assert.equal(closed.status, 409);
    assert.equal((await request(companyPath(delivery, "product-unavailable"), owner, { version: 4 })).status, 409);
    assert.equal(accepted.body.adjustment.state, "applied");
    assert.equal(events(delivery, "order_adjustment_accepted")[0].actor_user_id, client.id);
    assert.equal(events(delivery, "order_adjustment_applied").length, 1);
    assert.equal((await decision(delivery, id, "accept")).status, 200);
    assert.equal((await decision(delivery, id, "reject")).status, 409);
    const after = stored(delivery);
    assert.equal(after.order.version, 5);
    assert.equal(after.order.destination_snapshot_json, before.order.destination_snapshot_json);
    assert.equal(after.order.recipient_snapshot_json, before.order.recipient_snapshot_json);
    assert.deepEqual(after.operation, before.operation);
    assert.equal(after.items[0].product_id, equal);
    assert.equal(ledger(delivery).length, 1);
    assert.equal(attempts(delivery).length, 0);
    assert.equal((await ride(delivery, "collect", { pickupVersion: 5 })).status, 200);
    assert.equal((await ride(delivery, "arrive-destination")).status, 200);
    assert.equal((await ride(delivery, "confirm", { code: delivery.confirmationCode })).status, 200);
  });

  await context.test("diferença de +1 exige ação própria e é contabilizada uma única vez", async () => {
    const delivery = fixture({ freight: 20 });
    await assign(delivery);
    const { id } = await propose(delivery, more);
    const accepted = await decision(delivery, id, "accept");
    assert.equal(accepted.body.adjustment.state, "awaiting_payment");
    assert.equal(accepted.body.adjustment.requiresPayment, true);
    assert.equal(stored(delivery).order.items_total_cents, 100);
    assert.equal(ledger(delivery).length, 2);
    assert.equal((await ride(delivery, "collect")).status, 409);
    const responses = await Promise.all([decision(delivery, id, "pay"),
      decision(delivery, id, "pay"), decision(delivery, id, "reject")]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 409]);
    assert.equal(stored(delivery).order.version, 5);
    assert.equal(stored(delivery).order.items_total_cents, 101);
    assert.equal(events(delivery, "order_adjustment_paid").length, 1);
    assert.deepEqual(ledger(delivery)[2], {
      type: "payment", component: "products", amount: 1, reason: "order_adjustment",
      key: `order-adjustment:${id}:payment-products`,
    });
    assert.equal((await request(`/client/orders/${delivery.orderId}/pay`, client, {})).status, 200);
    const summary = (await request(clientPath(delivery), client)).body.delivery.financial;
    assert.equal(summary.paidTotalCents, 121);
    assert.equal(summary.paidItemsCents, 101);
    assert.equal((await ride(delivery, "collect", { pickupVersion: 5 })).status, 200);
    assert.equal((await ride(delivery, "arrive-destination")).status, 200);
    assert.equal((await ride(delivery, "confirm", { code: delivery.confirmationCode })).status, 200);
  });

  await context.test("diferença de -1 mantém snapshot histórico e reduz reembolso terminal", async () => {
    const delivery = fixture({ freight: 20 });
    const first = await propose(delivery, less);
    assert.equal((await decision(delivery, first.id, "accept")).status, 200);
    assert.equal((await decision(delivery, first.id, "accept")).status, 200);
    assert.deepEqual(ledger(delivery)[2], {
      type: "refund", component: "products", amount: 1, reason: "order_adjustment",
      key: `order-adjustment:${first.id}:refund-products`,
    });
    const next = await propose(delivery, more, { version: 5 });
    assert.equal((await decision(delivery, next.id, "accept")).status, 200);
    assert.equal((await decision(delivery, next.id, "pay")).status, 200);
    assert.equal(ledger(delivery).at(-1).amount, 2);
    const beforeClosure = await propose(delivery, less, { version: 6 });
    assert.equal((await decision(delivery, beforeClosure.id, "reject")).status, 200);
    assert.equal((await decision(delivery, beforeClosure.id, "reject")).status, 200);
    assert.equal(events(delivery, "order_adjustment_rejected").length, 1);
    await assertClosed(delivery, "client_rejected");
    assert.deepEqual(ledger(delivery).slice(-2).map(({ amount }) => amount), [101, 20]);
  });

  await context.test("itens preservados usam preço e peso históricos ao aumentar a quantidade", async () => {
    const delivery = fixture();
    db.prepare("UPDATE products SET price_cents = 300, unit_weight_kg = 5, is_available = 0 WHERE id = ?")
      .run(original);
    const change = await propose(delivery, original, { quantity: 2 });
    assert.equal(change.proposed.items[0].unitPriceCents, 100);
    assert.equal(change.proposed.weightKg, 2);
    assert.equal(change.proposed.freightTotalCents, null);
    assert.equal((await decision(delivery, change.id, "accept")).status, 200);
    assert.equal((await decision(delivery, change.id, "pay")).status, 200);
    db.prepare("UPDATE products SET price_cents = 100, unit_weight_kg = 1, is_available = 1 WHERE id = ?")
      .run(original);
  });

  await context.test("aceitar e rejeitar concorrem por uma decisão; rejeição libera motoboy", async () => {
    const delivery = fixture({ freight: 20 });
    const { id } = await propose(delivery, more);
    const responses = await Promise.all([decision(delivery, id, "reject"), decision(delivery, id, "accept")]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    if (responses[0].status === 200) await assertClosed(delivery, "client_rejected");
    else assert.equal(responses[1].body.adjustment.state, "awaiting_payment");

    const assigned = fixture({ freight: 20 });
    await assign(assigned);
    const pending = await propose(assigned, less);
    assert.equal((await decision(assigned, pending.id, "reject")).status, 200);
    await assertClosed(assigned, "client_rejected");
    assert.equal((await request("/courier/deliveries/current", courier)).body.delivery, null);
    assert.deepEqual(ledger(assigned).filter(({ type }) => type === "refund").map(({ amount }) => amount), [100, 20]);
  });

  await context.test("encerramento empresarial desconta refunds prévios e preserva histórico", async () => {
    for (const prior of [0, 25, 100]) {
      const delivery = fixture({ freight: 20 });
      if (prior) rawEntry(delivery, "refund", prior);
      assert.equal((await request(companyPath(delivery, "product-unavailable"), owner, {})).status, 200);
      assert.equal((await request(companyPath(delivery, "product-unavailable"), owner, {})).status, 409);
      await assertClosed(delivery, "company_no_adjustment");
      assert.equal((await request(clientPath(delivery) + "/adjustment", client)).body.adjustment, null);
      const refunds = ledger(delivery).filter(({ type }) => type === "refund");
      assert.equal(refunds.filter(({ component }) => component === "products")
        .reduce((sum, { amount }) => sum + amount, 0), 100);
      assert.equal(refunds.filter(({ component }) => component === "freight")[0].amount, 20);
    }
    const pending = fixture({ pending: true });
    assert.equal((await request(companyPath(pending, "product-unavailable"), owner, {})).status, 200);
    assert.equal((await request(`/client/orders/${pending.orderId}/pay`, client, {})).status, 409);
    assert.equal(ledger(pending).length, 0);
    await assertClosed(pending, "company_no_adjustment");
  });

  await context.test("inconsistências, frete conhecido e overflow exigem reconciliação", async () => {
    const known = fixture({ freight: 20 });
    assert.match((await proposal(known, light)).body.error, /Frete conhecido/);
    assert.equal((await proposal(known, light)).status, 409);
    const stale = fixture();
    const { id } = await propose(stale, equal);
    db.prepare("UPDATE orders SET version = 5 WHERE id = ?").run(stale.orderId);
    assert.equal((await decision(stale, id, "accept")).status, 409);
    db.prepare("UPDATE orders SET version = 4 WHERE id = ?").run(stale.orderId);
    db.prepare("UPDATE order_items SET unit_weight_kg = 2 WHERE order_id = ?").run(stale.orderId);
    assert.equal((await decision(stale, id, "accept")).status, 409);

    const inconsistent = fixture();
    assert.throws(() => rawEntry(inconsistent, "payment", 100, { reason: "simulated_payment" }), /already recorded/);
    assert.throws(() => rawEntry(inconsistent, "payment", 1, {
      reason: "order_adjustment", key: "order-adjustment:9999:payment-products",
    }), /invalid financial entry kind/);
    corruptLedger(() => rawEntry(inconsistent, "payment", 100, { reason: "simulated_payment" }));
    assert.equal((await proposal(inconsistent, equal)).status, 500);

    const overRefunded = fixture();
    corruptLedger(() => rawEntry(overRefunded, "refund", 101));
    assert.equal((await request(companyPath(overRefunded, "product-unavailable"), owner, {})).status, 500);
    assert.equal(stored(overRefunded).operation.status, "available");
    assert.equal(events(overRefunded, "product_unavailable").length, 0);
  });

  await context.test("frete pago incoerente impede fechamento sem alterar a operação ou proposta", async () => {
    function setFreightPayment(delivery, amount) {
      corruptLedger(() => {
        db.prepare("DELETE FROM financial_entries WHERE order_id = ? AND component = 'freight'")
          .run(delivery.orderId);
        if (amount !== null) rawEntry(delivery, "payment", amount, {
          component: "freight", reason: "simulated_payment", key: `payment:${delivery.orderId}:freight`,
        });
      });
    }
    async function expectUnchanged(delivery, close) {
      const before = { state: stored(delivery), ledger: ledger(delivery), history: history(delivery),
        adjustment: (await inspectAdjustment(delivery)).body.adjustment };
      assert.equal((await close()).status, 500);
      assert.deepEqual(stored(delivery), before.state);
      assert.deepEqual(ledger(delivery), before.ledger);
      assert.deepEqual(history(delivery), before.history);
      assert.deepEqual((await inspectAdjustment(delivery)).body.adjustment, before.adjustment);
      assert.equal(db.prepare("SELECT * FROM product_unavailability_closures WHERE delivery_id = ?")
        .get(delivery.deliveryId), undefined);
    }
    for (const [freight, paidFreight] of [[100, null], [100, 99], [null, 100]]) {
      const delivery = fixture({ cents: 2000, freight });
      setFreightPayment(delivery, paidFreight);
      try { await expectUnchanged(delivery, () => closeUnavailable(delivery)); }
      finally { setFreightPayment(delivery, freight); }
    }
    const delivery = fixture({ cents: 2000, freight: 100 });
    const adjustment = await propose(delivery, equal);
    setFreightPayment(delivery, null);
    try { await expectUnchanged(delivery, () => decision(delivery, adjustment.id, "reject")); }
    finally { setFreightPayment(delivery, 100); }
    assert.equal((await decision(delivery, adjustment.id, "reject")).status, 200);
    await assertClosed(delivery, "client_rejected");
  });

  await context.test("repetição do pagamento de Pedido encerrado não cria frete", async () => {
    const delivery = terminalWithoutFreight();
    const before = ledger(delivery);
    assert.equal((await replayPayment(delivery)).status, 200);
    assert.deepEqual(ledger(delivery), before);
    assert.equal((await request(clientPath(delivery), client)).status, 500);
    assert.equal(stored(delivery).operation.status, "cancelled");
  });

  await context.test("Pedido não pago e já cancelado permanece sem lançamentos", async () => {
    const delivery = fixture({ cents: 2000, freight: 100, pending: true });
    assert.equal((await cancel(delivery)).status, 200);
    assert.equal((await replayPayment(delivery)).status, 409);
    assert.deepEqual(ledger(delivery), []);
    assert.equal(stored(delivery).order.payment_status, "pending");
  });

  function legacyUnavailable({ eventOffset = 0, productsRefund = 2000 } = {}) {
    const delivery = fixture({ cents: 2000, freight: 100, paidFreight: null });
    const { occurred_at: timestamp } = events(delivery, "delivery_created")[0];
    db.prepare("UPDATE deliveries SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(timestamp, delivery.deliveryId);
    if (eventOffset !== null) {
      db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type, occurred_at)
        VALUES (?, ?, 'product_unavailable', datetime(?, ?))`)
        .run(delivery.deliveryId, owner.id, timestamp, `+${eventOffset} seconds`);
    }
    rawEntry(delivery, "refund", productsRefund, {
      key: `delivery:${delivery.deliveryId}:product-unavailable:refund-products`,
    });
    return delivery;
  }

  function terminalSnapshot(delivery) {
    return {
      ...stored(delivery), events: history(delivery),
      entries: db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id").all(delivery.orderId),
    };
  }

  async function assertLegacyFreightRebuilt(delivery, before) {
    const { entries, ...state } = terminalSnapshot(delivery);
    assert.deepEqual(state, {
      order: before.order, operation: before.operation, items: before.items, events: before.events,
    });
    assert.deepEqual(entries.slice(0, before.entries.length), before.entries);
    assert.deepEqual(entries.slice(before.entries.length).map(({ entry_type, component, amount_cents,
      reason, idempotency_key }) => [entry_type, component, amount_cents, reason, idempotency_key]), [
      ["payment", "freight", 100, "simulated_payment", `payment:${delivery.orderId}:freight`],
      ["refund", "freight", 100, "product_unavailable",
        `delivery:${delivery.deliveryId}:product-unavailable:refund-freight`],
    ]);
    const response = await request(clientPath(delivery), client);
    assert.equal(response.status, 200);
    const { financial } = response.body.delivery;
    assert.equal(financial.paidTotalCents, 2100);
    assert.equal(financial.refundedTotalCents, 2100);
    assert.equal(financial.refundStatus, "full");
  }

  await context.test("bootstrap preserva encerramentos novos e legados com evidência contraditória", async () => {
    const inconsistent = legacyUnavailable({ eventOffset: 1 });
    const contradictoryLedger = legacyUnavailable({ productsRefund: 1999 });
    const missingEvent = legacyUnavailable({ eventOffset: null });
    const terminal = terminalWithoutFreight();
    const deliveries = [inconsistent, contradictoryLedger, missingEvent, terminal];
    const before = deliveries.map(terminalSnapshot);
    assert.equal((await replayPayment(inconsistent)).status, 200);
    assert.deepEqual(terminalSnapshot(inconsistent), before[0]);
    for (let run = 0; run < 2; run++) {
      restart();
      assert.deepEqual(deliveries.map(terminalSnapshot), before);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await context.test("bootstrap reconstrói frete de encerramento legado coerente uma única vez", async () => {
    const legacy = legacyUnavailable();
    const before = terminalSnapshot(legacy);
    restart();
    await assertLegacyFreightRebuilt(legacy, before);
    const settled = terminalSnapshot(legacy);
    restart();
    assert.deepEqual(terminalSnapshot(legacy), settled);
  });

  await context.test("falha no refund legado reverte o pagamento reconstruído e permite novo bootstrap", async () => {
    const legacy = legacyUnavailable();
    const before = terminalSnapshot(legacy);
    db.exec(`CREATE TRIGGER deny_legacy_freight_refund BEFORE INSERT ON financial_entries
      WHEN NEW.delivery_id = ${legacy.deliveryId} AND NEW.entry_type = 'refund' AND NEW.component = 'freight'
        AND EXISTS (SELECT 1 FROM financial_entries WHERE order_id = NEW.order_id
          AND entry_type = 'payment' AND component = 'freight' AND amount_cents = 100)
      BEGIN SELECT RAISE(ABORT, 'forced legacy freight refund failure'); END`);
    try {
      assert.throws(restart, (error) => error.status === 1
        && /forced legacy freight refund failure/.test(String(error.stderr)));
      assert.deepEqual(terminalSnapshot(legacy), before);
    } finally {
      db.exec("DROP TRIGGER deny_legacy_freight_refund");
    }
    restart();
    await assertLegacyFreightRebuilt(legacy, before);
    const settled = terminalSnapshot(legacy);
    restart();
    assert.deepEqual(terminalSnapshot(legacy), settled);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  await context.test("overflow bruto é recusado antes do aceite e preserva possibilidade de encerrar", async () => {
    const delivery = fixture({ base: huge, cents: Number.MAX_SAFE_INTEGER, weight: 0.5 });
    await assign(delivery);
    const almostHuge = product("Centavo a menos", Number.MAX_SAFE_INTEGER - 1, 0.5);
    const cheaper = await propose(delivery, almostHuge);
    assert.equal(cheaper.differenceCents, -1);
    assert.equal((await decision(delivery, cheaper.id, "accept")).status, 200);
    const expensive = await propose(delivery, huge, { version: 5 });
    const before = { state: stored(delivery), ledger: ledger(delivery), history: history(delivery) };
    const acceptance = await decision(delivery, expensive.id, "accept");
    assert.equal(acceptance.status, 409);
    assert.match(acceptance.body.error, /limite seguro do total bruto/);
    assert.equal((await decision(delivery, expensive.id, "pay")).status, 409);
    assert.deepEqual((await inspectAdjustment(delivery)).body.adjustment, expensive);
    assert.deepEqual(ledger(delivery), before.ledger);
    assert.deepEqual(history(delivery), before.history);
    assert.deepEqual(stored(delivery), before.state);
    assert.equal(before.state.order.items_total_cents, Number.MAX_SAFE_INTEGER - 1);
    assert.equal((await decision(delivery, expensive.id, "reject")).status, 200);
    await assertClosed(delivery, "client_rejected");
    assert.equal((await request("/courier/deliveries/current", courier)).body.delivery, null);
  });

  await context.test("o total bruto no limite exato inclui frete e pode ser liquidado", async () => {
    const maxWithFreight = product("Limite com frete", Number.MAX_SAFE_INTEGER - 10);
    const delivery = fixture({ freight: 10 });
    const adjustment = await propose(delivery, maxWithFreight);
    assert.equal((await decision(delivery, adjustment.id, "accept")).status, 200);
    assert.equal((await decision(delivery, adjustment.id, "pay")).status, 200);
    const { financial } = (await request(clientPath(delivery), client)).body.delivery;
    assert.equal(financial.paidTotalCents, Number.MAX_SAFE_INTEGER);
    assert.equal(financial.paidItemsCents, Number.MAX_SAFE_INTEGER - 10);
  });

  await context.test("pagamento adicional revalida incoerência financeira que surgiu após o aceite", async () => {
    const delivery = fixture();
    const { id } = await propose(delivery, more);
    assert.equal((await decision(delivery, id, "accept")).status, 200);
    corruptLedger(() => rawEntry(delivery, "payment", 100, { reason: "simulated_payment" }));
    const before = { state: stored(delivery), ledger: ledger(delivery), history: history(delivery) };
    const response = await decision(delivery, id, "pay");
    assert.equal(response.status, 409);
    assert.match(response.body.error, /reconciliação financeira/);
    assert.equal((await inspectAdjustment(delivery)).body.adjustment.state, "awaiting_payment");
    assert.deepEqual(stored(delivery), before.state);
    assert.deepEqual(ledger(delivery), before.ledger);
    assert.deepEqual(history(delivery), before.history);
  });

  async function assertVoluntaryCancellation(delivery, adjustment, accepted) {
    const view = (await request(clientPath(delivery), client)).body.delivery;
    assert.equal(view.officialStatus, "CANCELADA");
    assert.equal(view.orderOfficialStatus, "CANCELADO");
    assert.equal(view.unavailability, null);
    assert.equal(view.collectionBlocked, false);
    assert.equal(view.adjustment.id, adjustment.id);
    assert.equal(view.adjustment.state, "cancelled");
    assert.equal(view.adjustment.decision, accepted ? "accepted" : null);
    assert.equal(view.adjustment.requiresPayment, false);
    assert.ok(view.adjustment.cancelledAt);
    assert.equal(view.adjustment.decidedAt !== null, accepted);
    assert.equal(events(delivery, "order_adjustment_cancelled")[0].actor_user_id, client.id);
    assert.equal(events(delivery, "client_cancelled_before_pickup").length, 1);
    assert.equal(events(delivery, "product_unavailable").length, 0);
    assert.equal(stored(delivery).operation.courier_id, null);
    assert.equal(attempts(delivery).length, 0);
    assert.equal(ledger(delivery).filter(({ type }) => type === "distribution").length, 0);
    assert.equal(view.financial.refundStatus, "full");
    for (const action of ["accept", "pay", "reject"]) {
      assert.equal((await decision(delivery, adjustment.id, action)).status, 409);
    }
  }

  await context.test("cancelamento voluntário encerra proposta aberta e preserva decisão anterior", async () => {
    for (const accepted of [false, true]) {
      const delivery = fixture({ freight: 20 });
      await assign(delivery);
      const adjustment = await propose(delivery, more);
      if (accepted) assert.equal((await decision(delivery, adjustment.id, "accept")).status, 200);
      const before = stored(delivery);
      const proposalBefore = (await inspectAdjustment(delivery)).body.adjustment;
      assert.equal((await cancel(delivery, other)).status, 404);
      const responses = await Promise.all([ride(delivery, "collect"), cancel(delivery)]);
      assert.deepEqual(responses.map(({ status }) => status), [409, 200]);
      await assertVoluntaryCancellation(delivery, adjustment, accepted);
      const proposalAfter = (await inspectAdjustment(delivery)).body.adjustment;
      assert.equal(proposalAfter.decidedAt, proposalBefore.decidedAt);
      assert.deepEqual(proposalAfter.original, proposalBefore.original);
      assert.deepEqual(proposalAfter.proposed, proposalBefore.proposed);
      assert.deepEqual(stored(delivery).items, before.items);
      assert.equal(stored(delivery).order.version, before.order.version);
      assert.deepEqual(ledger(delivery).filter(({ type }) => type === "refund").map(({ amount }) => amount), [100, 20]);
      assert.equal((await request("/courier/deliveries/current", courier)).body.delivery, null);
    }
  });

  await context.test("cancelar concorre com aceite e pagamento sem deixar proposta aberta ou saldo", async () => {
    const pending = fixture({ freight: 20 });
    const first = await propose(pending, more);
    const [acceptance, cancellation] = await Promise.all([decision(pending, first.id, "accept"), cancel(pending)]);
    assert.equal(cancellation.status, 200);
    assert.ok([200, 409].includes(acceptance.status));
    await assertVoluntaryCancellation(pending, first, acceptance.status === 200);
    assert.equal(stored(pending).order.items_total_cents, 100);

    const awaiting = fixture({ freight: 20 });
    const second = await propose(awaiting, more);
    assert.equal((await decision(awaiting, second.id, "accept")).status, 200);
    const [payment, close] = await Promise.all([decision(awaiting, second.id, "pay"), cancel(awaiting)]);
    assert.equal(close.status, 200);
    assert.ok([200, 409].includes(payment.status));
    const applied = payment.status === 200;
    const view = close.body.delivery;
    assert.equal(view.orderOfficialStatus, "CANCELADO");
    assert.equal(view.adjustment.state, applied ? "applied" : "cancelled");
    assert.equal(view.adjustment.decision, "accepted");
    assert.equal(view.collectionBlocked, false);
    assert.equal(view.financial.refundStatus, "full");
    assert.equal(stored(awaiting).order.items_total_cents, applied ? 101 : 100);
    assert.equal(stored(awaiting).order.version, applied ? 5 : 4);
    assert.deepEqual(ledger(awaiting).filter(({ type }) => type === "refund")
      .map(({ amount }) => amount), [applied ? 101 : 100, 20]);
    assert.equal(attempts(awaiting).length, 0);
    const settledLedger = ledger(awaiting);
    assert.equal((await decision(awaiting, second.id, "pay")).status, 409);
    assert.deepEqual(ledger(awaiting), settledLedger);
  });

  await context.test("falha de refund voluntário restaura ajuste aberto, aceite, eventos e atribuição", async () => {
    const delivery = fixture({ freight: 20 });
    await assign(delivery);
    const { id } = await propose(delivery, more);
    assert.equal((await decision(delivery, id, "accept")).status, 200);
    const before = { state: stored(delivery), ledger: ledger(delivery), history: history(delivery),
      adjustment: (await inspectAdjustment(delivery)).body.adjustment };
    db.exec(`CREATE TRIGGER deny_voluntary_freight_refund BEFORE INSERT ON financial_entries
      WHEN NEW.delivery_id = ${delivery.deliveryId} AND NEW.reason = 'client_cancelled_before_pickup'
        AND NEW.component = 'freight' BEGIN SELECT RAISE(ABORT, 'forced refund failure'); END`);
    try {
      assert.equal((await cancel(delivery)).status, 500);
      assert.deepEqual(stored(delivery), before.state);
      assert.deepEqual(ledger(delivery), before.ledger);
      assert.deepEqual(history(delivery), before.history);
      assert.deepEqual((await inspectAdjustment(delivery)).body.adjustment, before.adjustment);
    } finally {
      db.exec("DROP TRIGGER deny_voluntary_freight_refund");
    }
    assert.equal((await cancel(delivery)).status, 200);
  });

  await context.test("elegibilidade confirma primeira coleta, inclusive depois de revalidar", async () => {
    const delivery = fixture({ freight: 20 });
    const check = async (expected) => {
      for (const path of [companyPath(delivery), `/company/deliveries/${delivery.deliveryId}`]) {
        const { status, body } = await request(path, owner);
        assert.equal(status, 200);
        const state = body.delivery ?? body;
        assert.equal(state.canPropose, expected);
        assert.equal(state.canCloseUnavailable, expected);
      }
    };
    await check(true);
    await assign(delivery);
    assert.equal((await ride(delivery, "collect")).status, 200);
    await check(false);
    assert.equal((await ride(delivery, "arrive-destination")).status, 200);
    assert.equal((await ride(delivery, "external-obstruction", { description: "Acesso bloqueado." })).status, 200);
    assert.equal((await ride(delivery, "report-return")).status, 200);
    assert.equal((await request(companyPath(delivery, "confirm-return"), owner, {})).status, 200);
    const { id: revalidationId } = db.prepare("SELECT id FROM delivery_revalidations WHERE delivery_id = ?")
      .get(delivery.deliveryId);
    assert.equal((await request(companyPath(delivery, "revalidate"), owner, {
      revalidationId, release: true, verificationResult: "Acesso restabelecido.",
    })).status, 200);
    assert.equal(stored(delivery).operation.status, "available");
    await check(false);
    assert.equal((await proposal(delivery, equal)).status, 409);
    assert.equal((await closeUnavailable(delivery)).status, 409);
    assert.equal(attempts(delivery).length, 1);
  });

  await context.test("falha do segundo lançamento reverte decisão, cancelamento e primeiro refund", async () => {
    const delivery = fixture({ freight: 20 });
    const { id } = await propose(delivery, less);
    const before = stored(delivery);
    const entries = ledger(delivery);
    db.exec(`CREATE TRIGGER deny_test_freight_refund BEFORE INSERT ON financial_entries
      WHEN NEW.delivery_id = ${delivery.deliveryId} AND NEW.entry_type = 'refund' AND NEW.component = 'freight'
      BEGIN SELECT RAISE(ABORT, 'forced refund failure'); END`);
    try {
      assert.equal((await decision(delivery, id, "reject")).status, 500);
      assert.deepEqual(stored(delivery), before);
      assert.deepEqual(ledger(delivery), entries);
      assert.equal(events(delivery, "order_adjustment_rejected").length, 0);
      assert.equal((await request(clientPath(delivery) + "/adjustment", client)).body.adjustment.state, "pending");
    } finally {
      db.exec("DROP TRIGGER deny_test_freight_refund");
    }
    assert.equal((await decision(delivery, id, "reject")).status, 200);
  });

  await context.test("cancelamento comum aceita ledger ajustado e permanece CANCELADO", async () => {
    const delivery = fixture();
    const first = await propose(delivery, less);
    assert.equal((await decision(delivery, first.id, "accept")).status, 200);
    const cancelled = await request(clientPath(delivery) + "/cancel", client, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.delivery.orderOfficialStatus, "CANCELADO");
    assert.deepEqual(ledger(delivery).filter(({ type }) => type === "refund").map(({ amount }) => amount), [1, 99]);
  });

  await context.test("cancelamento pós-coleta usa o saldo após refund de ajuste", async () => {
    const delivery = fixture({ freight: 21 });
    await assign(delivery);
    const adjustment = await propose(delivery, less);
    assert.equal((await decision(delivery, adjustment.id, "accept")).status, 200);
    assert.equal((await ride(delivery, "collect", { pickupVersion: 5 })).status, 200);
    const cancelled = await request(clientPath(delivery) + "/cancel", client, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.deepEqual(ledger(delivery).filter(({ type }) => type === "refund").map(({ amount }) => amount),
      [1, 99, 11]);
    assert.equal((await ride(delivery, "report-return")).status, 200);
    assert.equal((await request(companyPath(delivery, "confirm-return"), owner, {})).status, 200);
  });

  await context.test("bootstrap repetido preserva ajustes e verifica chaves estrangeiras", async () => {
    const pending = fixture();
    const proposal = await propose(pending, equal);
    const withoutValidation = () => db.prepare(`SELECT COUNT(*) AS count FROM order_adjustments a
      WHERE NOT EXISTS (SELECT 1 FROM order_adjustment_validations v WHERE v.adjustment_id = a.id)`)
      .get().count;
    const legacyCount = withoutValidation();
    assert.ok(legacyCount > 0);
    const statements = `import assert from 'node:assert/strict';
      import { db } from './src/database.js';
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.ok(db.prepare("SELECT COUNT(*) AS count FROM order_adjustments WHERE state = 'applied'").get().count >= 6);
      db.close();`;
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, ["--input-type=module", "-e", statements], { stdio: "pipe" });
    }
    assert.equal(withoutValidation(), legacyCount);
    assert.equal((await decision(pending, proposal.id, "accept")).status, 200);
  });
});
