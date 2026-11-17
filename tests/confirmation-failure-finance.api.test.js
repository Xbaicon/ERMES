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

test("financeiro de confirmation_failed na classificação — Baseline 0.2", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-confirmation-finance-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?finance=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  const { hashPassword } = await import("../src/security.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
  const {
    backfillFinancialEntries, insertFinancialEntryInTransaction, orderRefundSummary,
    recordPaymentInTransaction, recordConfirmationFailureFinancialConsequencesInTransaction,
  } = await import("../src/finance.js");
  const { classifyDeliveryOccurrence } = await import("../src/delivery-occurrences.js");
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

  function createDelivery({ freightCents = 101, itemsCents = 2000 } = {}) {
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
  const responsibilities = ["CLIENTE", "MOTOBOY", "SISTEMA", "INDEFINIDO"];
  const rawLedger = (item) => db.prepare("SELECT * FROM financial_entries WHERE order_id = ? ORDER BY id").all(item.orderId);
  const occurrence = (item) => db.prepare("SELECT * FROM delivery_occurrences WHERE delivery_id = ? AND type = 'confirmation_failed'").get(item.delivery.id);
  const operational = (item) => ({
    delivery: db.prepare("SELECT * FROM deliveries WHERE id = ?").get(item.delivery.id),
    attempts: db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY id").all(item.delivery.id),
    order: db.prepare("SELECT * FROM orders WHERE id = ?").get(item.orderId),
  });
  const snapshot = (item) => ({
    ...operational(item), occurrence: occurrence(item), ledger: rawLedger(item),
    events: db.prepare("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id").all(item.delivery.id),
  });
  const classify = (item, responsibility, cookie = cookies.company1) => request(
    `/api/company/delivery-occurrences/${occurrence(item).id}/classify`,
    { method: "POST", cookie, body: { responsibility, analysisResult: "Análise financeira após retorno." } },
  );
  const classifyDirect = (item, responsibility) => classifyDeliveryOccurrence(
    occurrence(item).id, companyUser1, company1, { responsibility, analysisResult: "Análise financeira após retorno." },
  );
  const clientDetail = async (item) => {
    const response = await request(`/api/client/deliveries/${item.delivery.id}`, { cookie: cookies.client1 });
    assert.equal(response.status, 200);
    return (await response.json()).delivery;
  };
  async function failCodes(item) {
    await advanceToDestination(item);
    const before = rawLedger(item);
    const wrong = item.confirmationCode === "111111" ? "222222" : "111111";
    for (let i = 0; i < 3; i++) {
      assert.equal((await postCourier(item.delivery.id, "confirm", { code: wrong })).status, 422);
      assert.deepEqual(rawLedger(item), before);
    }
    return item;
  }
  async function finishReturn(item) {
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    const before = rawLedger(item);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    assert.deepEqual(rawLedger(item), before);
    assert.equal(occurrence(item).responsibility, null);
    return item;
  }
  const terminal = async (options) => finishReturn(await failCodes(createDelivery(options)));
  function priorRefund(item, component, amountCents, idempotencyKey = `prior:${item.orderId}:${component}`) {
    insertFinancialEntryInTransaction(db, {
      orderId: item.orderId, deliveryId: item.delivery.id, entryType: "refund", component,
      partyType: "client", partyId: client1, amountCents, reason: "product_unavailable", idempotencyKey,
    });
  }
  // Somente fixtures de histórico corrompido: restaura integralmente os triggers
  // após a mutação para exercitar as proteções reais da classificação.
  function corruptLedger(work) {
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'financial_entries'").all();
    try {
      for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
      work();
    } finally {
      for (const { sql } of triggers) db.exec(sql);
    }
  }
  async function rejectUnchanged(item, responsibility, status = 500, cookie = cookies.company1) {
    const before = snapshot(item);
    if (status === 500) {
      assert.throws(() => classifyDirect(item, responsibility), { code: "FINANCIAL_RECONCILIATION_REQUIRED" });
      assert.deepEqual(snapshot(item), before);
    }
    const response = await classify(item, responsibility, cookie);
    assert.equal(response.status, status);
    assert.deepEqual(snapshot(item), before);
  }
  function refunds(item, component) {
    return ledger(item.orderId).filter((e) => e.entryType === "refund" && e.component === component)
      .reduce((sum, e) => sum + e.amountCents, 0);
  }
  function assertNoDistribution(item) {
    assert.equal(ledger(item.orderId).filter((e) => e.entryType === "distribution" && e.reason === "confirmation_failed").length, 0);
  }

  await context.test("retorno não classificado não gera financeiro; gates e autorização preservados", async () => {
    const item = await failCodes(createDelivery());
    await rejectUnchanged(item, "CLIENTE", 409);
    assert.equal((await postCourier(item.delivery.id, "report-return")).status, 200);
    await rejectUnchanged(item, "SISTEMA", 409);
    assert.equal((await request(`/api/company/deliveries/${item.delivery.id}/confirm-return`, {
      cookie: cookies.company1, method: "POST", body: {},
    })).status, 200);
    const detail = await clientDetail(item);
    assert.equal(detail.status, "returned");
    assert.equal(detail.officialStatus, "NAO_REALIZADA");
    assert.equal(detail.orderOfficialStatus, "ENCERRADO");
    assert.equal(detail.financial.refundStatus, "none");
    assert.ok(detail.financial.pending.includes("confirmation_failure_classification_required"));
    assert.equal(ledger(item.orderId).filter((e) => e.reason === "confirmation_failed").length, 0);
    for (const [cookie, status] of [[null, 401], [cookies.client1, 403], [cookies.courier1, 403], [cookies.company2, 404]]) {
      await rejectUnchanged(item, "CLIENTE", status, cookie);
    }
    await rejectUnchanged(item, "EMPRESA", 400);
    const original = operational(item).delivery.return_reported_at;
    db.prepare("UPDATE deliveries SET return_reported_at = NULL WHERE id = ?").run(item.delivery.id);
    await rejectUnchanged(item, "CLIENTE", 409);
    db.prepare("UPDATE deliveries SET return_reported_at = ? WHERE id = ?").run(original, item.delivery.id);
  });

  await context.test("startup não recompõe refunds de histórico classificado; projeção exige reconciliação", async () => {
    const item = await terminal();
    db.prepare(`UPDATE delivery_occurrences SET responsibility = 'SISTEMA', classified_by_user_id = ?,
      classified_at = CURRENT_TIMESTAMP WHERE id = ?`).run(companyUser1, occurrence(item).id);
    db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type, details_json)
      VALUES (?, ?, 'occurrence_classified', ?)`)
      .run(item.delivery.id, companyUser1, JSON.stringify({ occurrenceId: occurrence(item).id, responsibility: "SISTEMA" }));
    const before = snapshot(item);
    transaction(() => backfillFinancialEntries(db));
    assert.deepEqual(snapshot(item), before);
    const startup = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const { db } = await import('./src/database.js'); db.close();"], {
      cwd: process.cwd(), env: process.env, encoding: "utf8",
    });
    assert.equal(startup.status, 0, startup.stderr);
    assert.deepEqual(snapshot(item), before);
    const response = await request(`/api/client/deliveries/${item.delivery.id}`, { cookie: cookies.client1 });
    assert.equal(response.status, 500);
    assert.deepEqual(snapshot(item), before);
  });

  for (const responsibility of responsibilities) {
    await context.test(`${responsibility}: consequência do cliente, estados intactos e zero distribuição`, async () => {
      const item = await terminal();
      const before = operational(item);
      assert.equal((await classify(item, responsibility)).status, 200);
      assert.deepEqual(operational(item), before);
      assert.equal(occurrence(item).responsibility, responsibility);
      assert.equal(refunds(item, "products"), 2000);
      assert.equal(refunds(item, "freight"), responsibility === "CLIENTE" ? 0 : 101);
      assertNoDistribution(item);
      const detail = await clientDetail(item);
      assert.equal(detail.financial.refundStatus, responsibility === "CLIENTE" ? "partial" : "full");
      assert.equal(detail.officialStatus, "NAO_REALIZADA");
      assert.equal(detail.orderOfficialStatus, "ENCERRADO");
      assert.deepEqual(detail.financial.pending, ["freight_distribution_rule_undefined"]);
      assert.equal(detail.financial.paidTotalCents - detail.financial.refundedTotalCents,
        responsibility === "CLIENTE" ? 101 : 0);
      assert.deepEqual(rawLedger(item).filter((e) => e.reason === "confirmation_failed").map((e) => e.idempotency_key),
        ["products", ...(responsibility === "CLIENTE" ? [] : ["freight"])].map((c) => `delivery:${item.delivery.id}:confirmation-failed:refund-${c}`));
      const complete = snapshot(item);
      transaction(() => recordConfirmationFailureFinancialConsequencesInTransaction(db, occurrence(item).id, responsibility));
      assert.deepEqual(snapshot(item), complete);
      await rejectUnchanged(item, responsibility, 409);
      assert.throws(() => transaction(() => recordConfirmationFailureFinancialConsequencesInTransaction(db, occurrence(item).id, "EMPRESA")),
        { code: "FINANCIAL_RECONCILIATION_REQUIRED" });
      assert.throws(() => transaction(() => recordConfirmationFailureFinancialConsequencesInTransaction(db, occurrence(item).id,
        responsibility === "CLIENTE" ? "SISTEMA" : "CLIENTE")), { code: "FINANCIAL_RECONCILIATION_REQUIRED" });
    });
    for (const full of [false, true]) {
      await context.test(`${responsibility}: refunds anteriores ${full ? "integrais" : "parciais"} são acumulados`, async () => {
        const item = await terminal();
        priorRefund(item, "products", full ? 2000 : 400);
        if (responsibility !== "CLIENTE") priorRefund(item, "freight", full ? 101 : 1);
        const before = rawLedger(item);
        assert.equal((await classify(item, responsibility)).status, 200);
        assert.deepEqual(rawLedger(item).slice(0, before.length), before);
        assert.equal(refunds(item, "products"), 2000);
        assert.equal(refunds(item, "freight"), responsibility === "CLIENTE" ? 0 : 101);
        const added = rawLedger(item).slice(before.length);
        assert.deepEqual(added.map((e) => [e.component, e.amount_cents]), full ? []
          : [["products", 1600], ...(responsibility === "CLIENTE" ? [] : [["freight", 100]])]);
        assertNoDistribution(item);
      });
    }
    await context.test(`${responsibility}: frete NULL sem pagamento não inventa valor`, async () => {
      const item = await terminal({ freightCents: null });
      assert.equal((await classify(item, responsibility)).status, 200);
      assert.equal(refunds(item, "products"), 2000);
      assert.equal(refunds(item, "freight"), 0);
      assertNoDistribution(item);
      const detail = await clientDetail(item);
      assert.equal(detail.financial.paidFreightCents, null);
      assert.ok(detail.financial.pending.includes("freight_amount_unavailable"));
      assert.equal(detail.financial.refundStatus, "full");
    });
    for (const [label, mutate] of [
      ["frete conhecido sem pagamento", (item) => corruptLedger(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ? AND component = 'freight'").run(item.orderId))],
      ["frete divergente", (item) => db.prepare("UPDATE orders SET freight_total_cents = 102 WHERE id = ?").run(item.orderId)],
      ["frete NULL com pagamento", (item) => db.prepare("UPDATE orders SET freight_total_cents = NULL WHERE id = ?").run(item.orderId)],
    ]) {
      await context.test(`${responsibility}: ${label} exige reconciliação e rollback`, async () => {
        const item = await terminal();
        mutate(item);
        await rejectUnchanged(item, responsibility);
      });
    }
  }

  for (const [label, mutate] of [
    ["products sem pagamento", (item) => corruptLedger(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ? AND component = 'products'").run(item.orderId))],
    ["products divergente", (item) => db.prepare("UPDATE orders SET items_total_cents = 1999 WHERE id = ?").run(item.orderId)],
    ["products pagamento duplicado", (item) => corruptLedger(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'payment', 'products', 'client', ?, 2000, 'simulated_payment', ?)`)
      .run(item.orderId, item.delivery.id, client1, `duplicate:${item.orderId}`))],
    ["products valor inválido", (item) => corruptLedger(() => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      try { db.prepare("UPDATE financial_entries SET amount_cents = -1 WHERE order_id = ? AND component = 'products'").run(item.orderId); }
      finally { db.exec("PRAGMA ignore_check_constraints = OFF"); }
    })],
    ["pagamento com componente incompatível", (item) => corruptLedger(() => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      try { db.prepare("UPDATE financial_entries SET component = 'other' WHERE order_id = ? AND component = 'products'").run(item.orderId); }
      finally { db.exec("PRAGMA ignore_check_constraints = OFF"); }
    })],
    ["frete pagamento duplicado", (item) => corruptLedger(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'payment', 'freight', 'client', ?, 101, 'simulated_payment', ?)`)
      .run(item.orderId, item.delivery.id, client1, `duplicate-freight:${item.orderId}`))],
    ["CLIENTE com refund anterior de frete", (item) => priorRefund(item, "freight", 1)],
    ["products over-refund", (item) => corruptLedger(() => priorRefund(item, "products", 2001))],
    ["freight over-refund", (item) => corruptLedger(() => priorRefund(item, "freight", 102))],
    ["colisão de chave com outro conteúdo", (item) => priorRefund(item, "products", 400, `delivery:${item.delivery.id}:confirmation-failed:refund-products`)],
  ]) {
    await context.test(`${label}: erro financeiro preserva classificação e ledger`, async () => {
      const item = await terminal();
      mutate(item);
      await rejectUnchanged(item, label.includes("CLIENTE") ? "CLIENTE" : "SISTEMA");
    });
  }

  for (const reason of ["confirmation_failed", "delivery_completed", "recipient_absent", "client_cancelled_after_pickup"]) {
    await context.test(`distribuição incompatível de ${reason} bloqueia a classificação`, async () => {
      const item = await terminal();
      corruptLedger(() => db.prepare(`INSERT INTO financial_entries
        (order_id, delivery_id, entry_type, component, party_type, amount_cents, reason, idempotency_key)
        VALUES (?, ?, 'distribution', 'freight', 'ermes', 1, ?, ?)`)
        .run(item.orderId, item.delivery.id, reason, `historical:${item.orderId}`));
      await rejectUnchanged(item, "SISTEMA");
    });
  }
  await context.test("remuneração histórica de outra natureza não é corrupção automática", async () => {
    const item = await terminal();
    corruptLedger(() => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'distribution', 'freight', 'ermes', 1, 'historical_attempt_cost', ?)`)
      .run(item.orderId, item.delivery.id, `historical:${item.orderId}`));
    const before = rawLedger(item);
    assert.equal((await classify(item, "SISTEMA")).status, 200);
    assert.deepEqual(rawLedger(item).slice(0, before.length), before);
    assert.equal(refunds(item, "freight"), 101);
    assertNoDistribution(item);
  });

  for (const component of ["products", "freight"]) {
    await context.test(`falha no INSERT refund ${component} desfaz classificação, evento e ambos os refunds`, async () => {
      const item = await terminal();
      const before = snapshot(item);
      db.exec(`CREATE TRIGGER fail_confirmation_refund BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = 'refund' AND NEW.reason = 'confirmation_failed' AND NEW.component = '${component}'
        BEGIN
          ${component === "freight" ? `SELECT RAISE(ABORT, 'missing product refund') WHERE NOT EXISTS (
            SELECT 1 FROM financial_entries WHERE order_id = NEW.order_id
              AND entry_type = 'refund' AND component = 'products' AND reason = 'confirmation_failed');` : ""}
          SELECT RAISE(ABORT, 'forced ${component} refund failure');
        END;`);
      try {
        assert.throws(() => classifyDirect(item, "MOTOBOY"), new RegExp(`forced ${component} refund failure`));
        assert.deepEqual(snapshot(item), before);
        assert.equal((await classify(item, "MOTOBOY")).status, 500);
        assert.deepEqual(snapshot(item), before);
        const oc = occurrence(item);
        for (const field of ["responsibility", "classified_by_user_id", "classified_at", "analysis_result"]) assert.equal(oc[field], null);
      } finally { db.exec("DROP TRIGGER fail_confirmation_refund"); }
      assert.equal((await classify(item, "MOTOBOY")).status, 200);
      assert.equal(refunds(item, "products"), 2000);
      assert.equal(refunds(item, "freight"), 101);
    });
  }

  await context.test("triggers exigem classificação; CLIENTE não pode receber refund de frete; ledger append-only", async () => {
    const item = await terminal();
    const insert = (component, partyId = client1, amountCents = 1, deliveryId = item.delivery.id, reason = "confirmation_failed") => insertFinancialEntryInTransaction(db, {
      orderId: item.orderId, deliveryId, entryType: "refund", component, partyType: "client", partyId,
      amountCents, reason, idempotencyKey: `trigger:${item.orderId}:${component}:${partyId}:${amountCents}:${deliveryId}`,
    });
    assert.throws(() => insert("products"), /invalid financial entry kind/);
    assert.throws(() => insert("freight"), /invalid financial entry kind/);
    assert.equal((await classify(item, "CLIENTE")).status, 200);
    assert.throws(() => insert("freight"), /invalid financial entry kind/);
    assert.throws(() => insert("products", client2, 0), /refund does not match/);
    assert.throws(() => insert("products"), /refund exceeds/);
    const other = createDelivery();
    assert.throws(() => insert("products", client1, 0, other.delivery.id, "product_unavailable"), /financial entry delivery does not belong to order/);
    const before = rawLedger(item);
    assert.throws(() => db.prepare("UPDATE financial_entries SET amount_cents = 0 WHERE order_id = ?").run(item.orderId), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM financial_entries WHERE order_id = ?").run(item.orderId), /append-only/);
    assert.deepEqual(rawLedger(item), before);
    assert.throws(() => insertFinancialEntryInTransaction(db, {
      orderId: item.orderId, deliveryId: item.delivery.id, entryType: "distribution", component: "freight",
      partyType: "ermes", partyId: null, amountCents: 1, reason: "confirmation_failed", idempotencyKey: "forbidden-distribution",
    }), /invalid financial entry kind|beneficiary/);
  });


});
