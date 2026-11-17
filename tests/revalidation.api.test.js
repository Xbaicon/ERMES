import test from "node:test";
import { Worker } from 'node:worker_threads';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const destination = JSON.stringify({
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Centro",
  street: "Rua Um", number: "10", complement: "",
});

test("impedimento externo e revalidação da Baseline 0.2", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-revalidation-"));
  process.env.ERMES_DB_PATH = join(directory, "test.sqlite");
  process.env.NODE_ENV = "production";
  const { server, startServer } = await import(`../src/server.js?deliveries=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  const { hashPassword } = await import("../src/security.js");
  const { createDeliveryForEligibleOrderInTransaction } = await import("../src/delivery-creation.js");
  const { createDeliveryAttemptInTransaction } = await import("../src/delivery-attempts.js");
  const { createDeliveryOccurrenceInTransaction } = await import("../src/delivery-occurrences.js");
  const { recordPaymentInTransaction,
    recordClientCancellationAfterExternalObstructionInTransaction } = await import("../src/finance.js");
  const { cancelClientDelivery } = await import("../src/delivery-operations.js");
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
  function createDelivery(companyId = company1, clientId = client1, { freightCents = null } = {}) {
    const recipient = JSON.stringify({ type: "self",
      name: db.prepare("SELECT full_name AS fullName FROM users WHERE id = ?").get(clientId).fullName });
    const orderId = Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json, items_total_cents,
       freight_total_cents, payment_status, payment_paid_at, confirmed_at)
      VALUES (?, ?, 'confirmed', ?, ?, 1000, ?, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(clientId, companyId, destination, recipient, freightCents).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, unit_weight_kg)
      VALUES (?, ?, 1, 1000, 1)`).run(orderId, product);
    return transaction(() => {
      const result = createDeliveryForEligibleOrderInTransaction(orderId);
      recordPaymentInTransaction(db, {
        id: orderId, clientId, itemsTotalCents: 1000,
        freightTotalCents: freightCents,
        paymentPaidAt: db.prepare("SELECT payment_paid_at AS value FROM orders WHERE id = ?")
          .get(orderId).value,
      }, result.delivery.id);
      return result;
    });
  }
  const post = (cookie, id, action, body = {}) => request(`/api/courier/deliveries/${id}/${action}`,
    { cookie, method: "POST", body });
  const rows = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE delivery_id = ? ORDER BY id`).all(id).map(r => ({ ...r }));
  const snapshot = (id) => ({
    delivery: { ...db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) },
    attempts: rows('delivery_attempts', id), occurrences: rows('delivery_occurrences', id),
    events: rows('delivery_events', id), revalidations: rows('delivery_revalidations', id),
    finances: rows('financial_entries', id),
  });
  const legacyMutation = (triggerNames, mutate) => {
    const saved = triggerNames.map(name => db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name).sql);
    try {
      for (const name of triggerNames) db.exec(`DROP TRIGGER ${name}`);
      mutate();
    } finally { for (const sql of saved) db.exec(sql); }
  };
  const companyAction = (id, action, body = {}, cookie = cookies.company1) => request(
    `/api/company/deliveries/${id}/${action}`, { method: 'POST', body, cookie });
  const cancel = (id, cookie = cookies.client1) => request(`/api/client/deliveries/${id}/cancel`,
    { method: 'POST', body: {}, cookie });
  const releaseBody = (id) => ({ revalidationId: rows('delivery_revalidations', id).at(-1).id,
    release: true, verificationResult: 'Acesso verificado pela empresa e liberado.' });
  async function atDestination(options = {}) {
    const item = createDelivery(company1, client1, options);
    for (const action of ['accept', 'arrive-pickup', 'collect', 'arrive-destination']) {
      assert.equal((await post(cookies.courier1, item.delivery.id, action)).status, 200);
    }
    return item;
  }
  async function obstruct(item) {
    const result = await post(cookies.courier1, item.delivery.id, 'external-obstruction', {
      description: 'Rua interditada, sem alternativa segura disponível.',
    });
    assert.equal(result.status, 200);
    return (await result.json()).delivery;
  }
  async function awaiting(options = {}) {
    const item = await atDestination(options);
    await obstruct(item);
    assert.equal((await post(cookies.courier1, item.delivery.id, 'report-return')).status, 200);
    assert.equal((await companyAction(item.delivery.id, 'confirm-return')).status, 200);
    return item;
  }

  await context.test('impedimento, retorno, revalidação e nova coleta preservam identidade e financeiro', async () => {
    const item = await atDestination(); const id = item.delivery.id;
    const initial = snapshot(id);
    const delivery = await obstruct(item);
    assert.equal(delivery.status, 'returning');
    assert.equal(delivery.officialStatus, 'RETORNO_AO_ESTABELECIMENTO');
    let state = snapshot(id);
    assert.equal(state.occurrences.length, 1);
    const occurrence = state.occurrences[0];
    assert.equal(occurrence.type, 'temporary_external_obstruction');
    assert.equal(occurrence.delivery_attempt_id, state.attempts[0].id);
    assert.equal(occurrence.responsibility, null);
    assert.equal(state.attempts[0].status, 'returning');
    assert.equal(state.attempts[0].ended_at, null);
    assert.equal(state.revalidations.length, 0);
    const beforeRepeat = snapshot(id);
    assert.equal((await post(cookies.courier1, id, 'external-obstruction', { description: 'Repetido' })).status, 409);
    assert.deepEqual(snapshot(id), beforeRepeat);
    assert.equal((await companyAction(id, 'confirm-return')).status, 409);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    const returned = await companyAction(id, 'confirm-return');
    assert.equal(returned.status, 200);
    const companyDelivery = (await returned.json()).delivery;
    assert.equal(companyDelivery.officialStatus, 'AGUARDANDO_REVALIDACAO');
    assert.equal(companyDelivery.orderOfficialStatus, 'CONFIRMADO');
    assert.equal(companyDelivery.status, 'awaiting_revalidation');
    assert.equal(companyDelivery.revalidations[0].description, occurrence.description);
    assert.equal(companyDelivery.revalidations[0].receiverName, 'empresa1@ermes.local');
    assert.equal('confirmationCode' in companyDelivery, false);
    state = snapshot(id);
    assert.equal(state.delivery.courier_id, null);
    assert.equal(state.attempts[0].status, 'closed_unsuccessfully');
    assert.equal(state.attempts[0].end_nature, 'recoverable');
    assert.equal(state.revalidations[0].received_by_user_id, companyUser1);
    assert.ok(state.revalidations[0].received_at);
    assert.equal(state.revalidations[0].verified_at, null);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(item.delivery.orderId).status, 'confirmed');
    assert.equal((await post(cookies.courier1, id, 'accept')).status, 409);
    const available = await (await request('/api/courier/deliveries/available', { cookie: cookies.courier1 })).json();
    assert.ok(!available.deliveries.some(d => d.id === id));
    await request(`/api/client/orders/${item.delivery.orderId}/chat`, { method: 'POST', cookie: cookies.client1,
      body: { message: 'A rua foi liberada. Pode liberar a entrega.' } });
    assert.equal(snapshot(id).delivery.status, 'awaiting_revalidation');
    const classification = await request(`/api/company/delivery-occurrences/${occurrence.id}/classify`, {
      cookie: cookies.company1, method: 'POST', body: { responsibility: 'INDEFINIDO' },
    });
    assert.equal(classification.status, 200);
    const classified = rows('delivery_occurrences', id);
    const beforeRelease = snapshot(id);
    const release = await companyAction(id, 'revalidate', releaseBody(id));
    assert.equal(release.status, 200);
    assert.equal((await release.json()).delivery.officialStatus, 'DISPONIVEL');
    state = snapshot(id);
    assert.deepEqual(state.attempts, beforeRelease.attempts);
    assert.deepEqual(state.occurrences, classified);
    assert.deepEqual(state.finances, initial.finances);
    assert.equal(state.revalidations[0].verified_by_user_id, companyUser1);
    assert.ok(state.revalidations[0].verified_at);
    assert.equal(state.revalidations[0].verification_result, releaseBody(id).verificationResult);
    assert.equal(state.delivery.confirmation_code_hash, initial.delivery.confirmation_code_hash);
    assert.equal(state.delivery.confirmation_code_ciphertext, initial.delivery.confirmation_code_ciphertext);
    const afterRelease = snapshot(id);
    assert.equal((await companyAction(id, 'revalidate', releaseBody(id))).status, 409);
    assert.deepEqual(snapshot(id), afterRelease);
    for (const action of ['accept', 'arrive-pickup']) {
      assert.equal((await post(cookies.courier1, id, action)).status, 200);
      assert.equal(rows('delivery_attempts', id).length, 1);
    }
    assert.equal((await post(cookies.courier1, id, 'collect')).status, 200);
    const attempts = rows('delivery_attempts', id);
    assert.deepEqual(attempts.map(a => [a.attempt_number, a.status, a.invalid_code_attempts]),
      [[1, 'closed_unsuccessfully', 0], [2, 'active', 0]]);
    assert.deepEqual(attempts[0], beforeRelease.attempts[0]);
    assert.equal((await post(cookies.courier1, id, 'arrive-destination')).status, 200);
    const clientView = await (await request(`/api/client/deliveries/${id}`, { cookie: cookies.client1 })).json();
    assert.equal(clientView.delivery.confirmationCode, item.confirmationCode);
    assert.equal((await post(cookies.courier1, id, 'confirm', { code: item.confirmationCode })).status, 200);
  });

  await context.test('autorização, corpo estrito e revalidationId cruzado não alteram nenhum ciclo', async () => {
    const first = await awaiting(), second = await awaiting();
    const a = first.delivery.id, b = second.delivery.id;
    const foreign = createDelivery(company2, client2);
    const foreignId = foreign.delivery.id;
    for (const action of ['accept', 'arrive-pickup', 'collect', 'arrive-destination']) {
      assert.equal((await post(cookies.otherCourier, foreignId, action)).status, 200);
    }
    assert.equal((await post(cookies.otherCourier, foreignId, 'external-obstruction', { description: 'Bloqueio externo' })).status, 200);
    assert.equal((await post(cookies.otherCourier, foreignId, 'report-return')).status, 200);
    assert.equal((await companyAction(foreignId, 'confirm-return', {}, cookies.company2)).status, 200);
    const foreignBefore = snapshot(foreignId);
    assert.equal((await companyAction(a, 'revalidate', releaseBody(foreignId))).status, 404);
    assert.equal((await companyAction(foreignId, 'revalidate', releaseBody(foreignId))).status, 404);
    assert.deepEqual(snapshot(foreignId), foreignBefore);
    const body = releaseBody(a);
    const beforeA = snapshot(a), beforeB = snapshot(b);
    assert.equal((await companyAction(a, 'revalidate', releaseBody(b))).status, 404);
    assert.deepEqual(snapshot(a), beforeA);
    assert.deepEqual(snapshot(b), beforeB);
    const pending = releaseBody(b); const before = snapshot(b);
    for (const cookie of [cookies.client1, cookies.courier1]) {
      assert.equal((await companyAction(b, 'revalidate', pending, cookie)).status, 403);
    }
    assert.equal((await request(`/api/company/deliveries/${b}/revalidate`, { method: 'POST', body: pending })).status, 401);
    assert.equal((await companyAction(b, 'revalidate', pending, cookies.company2)).status, 404);
    assert.equal((await companyAction(b, 'revalidate', { ...pending, revalidationId: body.revalidationId })).status, 404);
    assert.equal((await companyAction(a, 'revalidate', pending, cookies.company2)).status, 404);
    for (const invalid of [null, [], {}, { ...pending, release: false }, { ...pending, verificationResult: ' ' },
      { ...pending, verificationResult: 'x'.repeat(2001) }, { ...pending, evidence: {} },
      { ...pending, revalidationId: '1' }, { ...pending, revalidationId: 0 }]) {
      assert.equal((await companyAction(b, 'revalidate', invalid)).status, 400);
    }
    assert.deepEqual(snapshot(b), before);
    assert.deepEqual(beforeB, before);
    assert.equal((await companyAction(a, 'revalidate', body)).status, 200);
    assert.equal((await companyAction(b, 'revalidate', pending)).status, 200);
    assert.equal(beforeA.delivery.status, 'awaiting_revalidation');
  });

  await context.test('validação do impedimento e dados legados incompletos não geram mutação', async () => {
    const item = await atDestination(), id = item.delivery.id;
    const before = snapshot(id);
    for (const body of [{}, { description: '' }, { description: 'x'.repeat(501) },
      { description: 'Rua bloqueada', evidence: {} }]) {
      assert.equal((await post(cookies.courier1, id, 'external-obstruction', body)).status, 400);
    }
    assert.equal((await post(cookies.courier1, id, 'occurrences', { type: 'address_problem' })).status, 409);
    assert.deepEqual(snapshot(id), before);
    db.prepare('DELETE FROM delivery_attempts WHERE delivery_id = ?').run(id);
    const legacy = snapshot(id);
    assert.equal((await post(cookies.courier1, id, 'external-obstruction', { description: 'Rua bloqueada' })).status, 409);
    assert.deepEqual(snapshot(id), legacy);
    // This intentionally inconsistent fixture is terminalized only to free the test courier.
    db.prepare("UPDATE deliveries SET status = 'returned', courier_id = NULL WHERE id = ?").run(id);
  });

  await context.test('revalidação rejeita retorno incompleto e tentativa aberta sem alteração parcial', async () => {
    const item = await awaiting(), id = item.delivery.id;
    const body = releaseBody(id);
    const returnedAt = snapshot(id).delivery.returned_at;
    db.prepare('UPDATE deliveries SET returned_at = NULL WHERE id = ?').run(id);
    const incomplete = snapshot(id);
    assert.equal((await companyAction(id, 'revalidate', body)).status, 409);
    assert.deepEqual(snapshot(id), incomplete);
    db.prepare('UPDATE deliveries SET returned_at = ? WHERE id = ?').run(returnedAt, id);
    const inserted = db.prepare(`INSERT INTO delivery_attempts(delivery_id, attempt_number, courier_id, status)
      VALUES (?,2,?,'active')`).run(id,courier1).lastInsertRowid;
    const open = snapshot(id);
    assert.equal((await companyAction(id, 'revalidate', body)).status, 409);
    assert.deepEqual(snapshot(id), open);
    db.prepare('DELETE FROM delivery_attempts WHERE id = ?').run(inserted);
    assert.equal((await companyAction(id, 'revalidate', body)).status, 200);
  });

  await context.test('falha em qualquer evento novo desfaz o ciclo inteiro, e permite retomada', async () => {
    const item = await atDestination(), id = item.delivery.id;
    async function failsAtomically(event, operation) {
      const before = snapshot(id);
      db.exec(`CREATE TRIGGER forced_new_event BEFORE INSERT ON delivery_events
        WHEN NEW.event_type = '${event}' BEGIN SELECT RAISE(ABORT, 'forced revalidation event failure'); END;`);
      try { assert.equal((await operation()).status, 500); } finally { db.exec('DROP TRIGGER forced_new_event'); }
      assert.deepEqual(snapshot(id), before);
    }
    await failsAtomically('temporary_external_obstruction', () => post(cookies.courier1, id, 'external-obstruction', { description: 'Rua bloqueada' }));
    await obstruct(item);
    await post(cookies.courier1, id, 'report-return');
    await failsAtomically('delivery_awaiting_revalidation', () => companyAction(id, 'confirm-return'));
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
    await failsAtomically('delivery_revalidated', () => companyAction(id, 'revalidate', releaseBody(id)));
    assert.equal((await companyAction(id, 'revalidate', releaseBody(id))).status, 200);
  });

  await context.test('duas liberações concorrentes produzem uma autorização e um evento', async () => {
    const item = await awaiting(), id = item.delivery.id;
    const before = snapshot(id);
    const responses = await Promise.all([companyAction(id, 'revalidate', releaseBody(id)), companyAction(id, 'revalidate', releaseBody(id))]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const after = snapshot(id);
    assert.equal(after.events.filter(e => e.event_type === 'delivery_revalidated').length, 1);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.finances, before.finances);
  });
  async function race(operations) {
    const workers = operations.map(operation => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const operations = await import(workerData.operationsUrl);
        const { db } = await import(workerData.databaseUrl);
        parentPort.postMessage({ ready: true });
        parentPort.once('message', () => {
          try {
            operations[workerData.operation.name](...workerData.operation.args);
            parentPort.postMessage({ status: 200 });
          } catch (error) {
            parentPort.postMessage({ status: error.statusCode || 500, message: error.message });
          } finally { db.close(); parentPort.close(); }
        });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { operation,
      operationsUrl: new URL('../src/delivery-operations.js', import.meta.url).href,
      databaseUrl: new URL('../src/database.js', import.meta.url).href,
    } }));
    try {
      const results = [];
      await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', message => {
          if (message.ready) resolve();
        });
        results.push(new Promise((done, fail) => {
          worker.on('error', fail);
          worker.on('message', message => { if (!message.ready) done(message); });
        }));
      })));
      for (const worker of workers) worker.postMessage('go');
      return await Promise.all(results);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  }
  await context.test('conexões SQLite concorrentes serializam duas revalidações', async () => {
    const item = await awaiting(), id = item.delivery.id;
    const op = { name: 'revalidateDelivery', args: [id, companyUser1, company1, releaseBody(id)] };
    const before = snapshot(id);
    const responses = await race([op, op]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409], JSON.stringify(responses));
    const state = snapshot(id);
    assert.equal(state.delivery.status, 'available');
    assert.equal(state.events.filter(e => e.event_type === 'delivery_revalidated').length, 1);
    assert.deepEqual(state.attempts, before.attempts);
  });
  await context.test('aceite concorrente nunca atribui motoboy enquanto aguarda revalidação', async () => {
    const item = await awaiting(), id = item.delivery.id;
    const before = snapshot(id);
    const responses = await race([
      { name: 'revalidateDelivery', args: [id, companyUser1, company1, releaseBody(id)] },
      { name: 'acceptDelivery', args: [id, courier1, company1, {}] },
    ]);
    assert.equal(responses[0].status, 200, JSON.stringify(responses));
    assert.ok([200,409].includes(responses[1].status), JSON.stringify(responses));
    const state = snapshot(id);
    assert.deepEqual(state.attempts, before.attempts);
    assert.deepEqual(state.finances, before.finances);
    assert.equal(state.events.filter(e => e.event_type === 'delivery_revalidated').length, 1);
    if (responses[1].status === 200) {
      assert.equal(state.delivery.status, 'heading_to_pickup');
      assert.equal(state.delivery.courier_id, courier1);
      const events = state.events.map(e => e.event_type);
      assert.ok(events.indexOf('delivery_revalidated') < events.lastIndexOf('delivery_accepted'));
      assert.equal((await post(cookies.courier1, id, 'fail', { reason: 'Liberando fixture antes de coleta' })).status, 200);
    } else {
      assert.equal(state.delivery.status, 'available');
      assert.equal(state.delivery.courier_id, null);
    }
  });

  await context.test('cancelamento externo devolve products e freight integralmente sem distribution', async () => {
    const item = await atDestination({ freightCents: 101 }), id = item.delivery.id;
    const atDestinationLedger = snapshot(id).finances;
    await obstruct(item);
    assert.deepEqual(snapshot(id).finances, atDestinationLedger);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    assert.deepEqual(snapshot(id).finances, atDestinationLedger);
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
    const before = snapshot(id);
    assert.deepEqual(before.finances, atDestinationLedger);
    const pending = await (await request(`/api/client/deliveries/${id}`, { cookie: cookies.client1 })).json();
    assert.equal(pending.delivery.financial.refundStatus, 'none');
    assert.equal(pending.delivery.orderOfficialStatus, 'CONFIRMADO');
    assert.deepEqual(pending.delivery.financial.pending, ['freight_distribution_rule_undefined']);
    const result = await cancel(id);
    assert.equal(result.status, 200);
    const view = (await result.json()).delivery;
    assert.equal(view.status, 'cancelled');
    assert.equal(view.officialStatus, 'CANCELADA');
    assert.equal(view.orderOfficialStatus, 'CANCELADO');
    assert.equal(view.financial.paymentStatus, 'paid');
    assert.equal(view.financial.refundStatus, 'full');
    assert.equal(view.financial.refundedTotalCents, 1101);
    assert.deepEqual(view.financial.pending, ['freight_distribution_rule_undefined']);
    const after = snapshot(id);
    assert.equal(after.delivery.courier_id, null);
    assert.equal(after.delivery.return_reason, 'temporary_external_obstruction');
    assert.equal(after.delivery.returned_at, before.delivery.returned_at);
    assert.equal(after.delivery.confirmation_code_hash, before.delivery.confirmation_code_hash);
    assert.equal(after.delivery.confirmation_code_ciphertext, before.delivery.confirmation_code_ciphertext);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.occurrences, before.occurrences);
    assert.deepEqual(after.revalidations, before.revalidations);
    assert.equal(after.revalidations[0].verified_at, null);
    assert.equal(after.events.at(-1).event_type, 'client_cancelled_after_external_obstruction');
    assert.equal(after.events.at(-1).actor_user_id, client1);
    assert.deepEqual(JSON.parse(after.events.at(-1).details_json), {
      revalidationId: before.revalidations[0].id, occurrenceId: before.occurrences[0].id,
    });
    assert.deepEqual(after.finances.filter(e => e.entry_type === 'refund')
      .map(e => [e.component, e.amount_cents, e.reason]), [
        ['products', 1000, 'client_cancelled_after_external_obstruction'],
        ['freight', 101, 'client_cancelled_after_external_obstruction'],
      ]);
    assert.equal(after.finances.filter(e => e.entry_type === 'distribution').length, 0);
    assert.equal(db.prepare('SELECT order_blocked_until AS value FROM users WHERE id = ?').get(client1).value, null);
    assert.equal((await companyAction(id, 'revalidate', releaseBody(id))).status, 409);
    assert.equal((await cancel(id)).status, 409);
    assert.deepEqual(snapshot(id), after);
  });

  await context.test('frete NULL sem pagamento de freight reembolsa apenas products', async () => {
    const item = await awaiting(), id = item.delivery.id;
    const result = await cancel(id);
    assert.equal(result.status, 200);
    const view = (await result.json()).delivery;
    assert.equal(view.financial.refundStatus, 'full');
    assert.equal(view.financial.refundedTotalCents, 1000);
    assert.deepEqual(snapshot(id).finances.filter(e => e.entry_type === 'refund')
      .map(e => [e.component, e.amount_cents]), [['products', 1000]]);
  });

  await context.test('refund anterior compatível completa somente saldo e mantém idempotência', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    db.prepare("UPDATE deliveries SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type)
      VALUES (?, ?, 'client_cancelled_after_external_obstruction')`).run(id, client1);
    db.prepare(`INSERT INTO financial_entries (order_id, delivery_id, entry_type, component,
      party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 300,
        'client_cancelled_after_external_obstruction', ?)`)
      .run(item.delivery.orderId, id, client1, `prior:${id}:products`);
    transaction(() => recordClientCancellationAfterExternalObstructionInTransaction(db, { id }));
    const after = snapshot(id);
    assert.deepEqual(after.finances.filter(e => e.entry_type === 'refund')
      .map(e => [e.component, e.amount_cents]), [
        ['products', 300], ['products', 700], ['freight', 101],
      ]);
    transaction(() => recordClientCancellationAfterExternalObstructionInTransaction(db, { id }));
    assert.deepEqual(snapshot(id), after);
  });

  await context.test('cancelamento e revalidação concorrentes têm apenas um vencedor', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    const responses = await race([
      { name: 'cancelClientDelivery', args: [id, client1, {}] },
      { name: 'revalidateDelivery', args: [id, companyUser1, company1, releaseBody(id)] },
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409], JSON.stringify(responses));
    const state = snapshot(id);
    const cancelled = state.delivery.status === 'cancelled';
    assert.ok(cancelled || state.delivery.status === 'available');
    assert.equal(state.revalidations[0].verified_at === null, cancelled);
    assert.equal(state.events.filter(e => e.event_type === 'client_cancelled_after_external_obstruction').length,
      cancelled ? 1 : 0);
    assert.equal(state.finances.filter(e => e.entry_type === 'refund').length, cancelled ? 2 : 0);
  });

  await context.test('revalidação vencedora bloqueia o cancelamento especial posterior', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    assert.equal((await companyAction(id, 'revalidate', releaseBody(id))).status, 200);
    const before = snapshot(id);
    assert.equal((await cancel(id)).status, 409);
    assert.deepEqual(snapshot(id), before);
    assert.equal(before.delivery.status, 'available');
    assert.ok(before.revalidations[0].verified_at);
    assert.equal(before.finances.filter(e => e.entry_type === 'refund').length, 0);
  });

  await context.test('bootstrap repetido atualiza trigger sem criar dinheiro no banco existente', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    assert.equal((await cancel(id)).status, 200);
    const before = snapshot(id);
    const trigger = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'financial_entry_valid_kind_insert'`).get().sql;
    assert.match(trigger, /client_cancelled_after_external_obstruction/);
    for (let pass = 0; pass < 2; pass++) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import { db } from './src/database.js'; db.close();"], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshot(id), before);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    }
  });

  await context.test('ocorrência legítima de tentativa anterior não bloqueia o ciclo externo atual', async () => {
    const item = await atDestination({ freightCents: 101 }), id = item.delivery.id;
    assert.equal((await post(cookies.courier1, id, 'fail', { reason: 'Pneu furou' })).status, 200);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
    for (const action of ['accept', 'arrive-pickup', 'collect', 'arrive-destination']) {
      assert.equal((await post(cookies.courier1, id, action)).status, 200);
    }
    await obstruct(item);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
    const before = snapshot(id);
    assert.deepEqual(before.occurrences.map(o => o.type), [
      'courier_failure_after_pickup', 'temporary_external_obstruction',
    ]);
    assert.notEqual(before.occurrences[0].delivery_attempt_id, before.occurrences[1].delivery_attempt_id);
    const response = await cancel(id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).delivery.financial.refundStatus, 'full');
    assert.deepEqual(snapshot(id).attempts, before.attempts);
  });

  await context.test('ciclo externo anterior já verificado não bloqueia ciclo externo atual', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    assert.equal((await companyAction(id, 'revalidate', releaseBody(id))).status, 200);
    for (const action of ['accept', 'arrive-pickup', 'collect', 'arrive-destination']) {
      assert.equal((await post(cookies.courier1, id, action)).status, 200);
    }
    await obstruct(item);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
    const before = snapshot(id);
    assert.equal(before.revalidations.length, 2);
    assert.ok(before.revalidations[0].verified_at);
    assert.equal(before.revalidations[1].verified_at, null);
    assert.equal((await cancel(id)).status, 200);
    assert.deepEqual(snapshot(id).attempts, before.attempts);
    assert.equal(snapshot(id).revalidations[1].verified_at, null);
  });

  for (const type of ['recipient_absent', 'recipient_refused', 'confirmation_failed',
    'address_problem', 'courier_failure_before_pickup', 'courier_failure_after_pickup']) {
    await context.test(`ocorrência ${type} na mesma tentativa bloqueia operação e trigger`, async () => {
      const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
      const attemptId = rows('delivery_revalidations', id)[0].delivery_attempt_id;
      db.prepare(`INSERT INTO delivery_occurrences
        (delivery_id, delivery_attempt_id, type, description, reported_by_user_id)
        VALUES (?, ?, ?, 'Histórico contraditório', ?)`).run(id, attemptId, type, courier1);
      const before = snapshot(id);
      assert.equal(before.delivery.status, 'awaiting_revalidation');
      assert.equal(before.delivery.cancelled_at, null);
      assert.equal(before.revalidations[0].verified_at, null);
      assert.equal(before.attempts[0].status, 'closed_unsuccessfully');
      assert.equal((await cancel(id)).status, 500);
      assert.deepEqual(snapshot(id), before);
      assert.equal(before.finances.filter(e => e.entry_type === 'distribution').length, 0);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE deliveries SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(id);
        db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type)
          VALUES (?, ?, 'client_cancelled_after_external_obstruction')`).run(id, client1);
        for (const component of ['products', 'freight']) {
          assert.throws(() => db.prepare(`INSERT INTO financial_entries
            (order_id, delivery_id, entry_type, component, party_type, party_user_id,
              amount_cents, reason, idempotency_key)
            VALUES (?, ?, 'refund', ?, 'client', ?, 1,
              'client_cancelled_after_external_obstruction', ?)`)
            .run(item.delivery.orderId, id, component, client1,
              `contradictory:${id}:${component}`), /invalid financial entry kind/);
        }
      } finally { db.exec('ROLLBACK'); }
      assert.deepEqual(snapshot(id), before);
    });
  }

  await context.test('pending pós-coleta com ou sem payments exige reconciliação e rollback', async () => {
    const without = await awaiting({ freightCents: 101 }), id = without.delivery.id;
    legacyMutation(['order_payment_ledger_regression_update', 'financial_entries_append_only_delete'], () => {
      db.prepare('DELETE FROM financial_entries WHERE order_id = ?').run(without.delivery.orderId);
      db.prepare("UPDATE orders SET payment_status = 'pending', payment_paid_at = NULL WHERE id = ?")
        .run(without.delivery.orderId);
    });
    const before = snapshot(id);
    assert.throws(() => cancelClientDelivery(id, client1, {}), { code: 'FINANCIAL_RECONCILIATION_REQUIRED' });
    assert.deepEqual(snapshot(id), before);
    const withPayment = await awaiting({ freightCents: 101 }), paidId = withPayment.delivery.id;
    legacyMutation(['order_payment_ledger_regression_update'], () => {
      db.prepare("UPDATE orders SET payment_status = 'pending' WHERE id = ?")
        .run(withPayment.delivery.orderId);
    });
    const beforePaid = snapshot(paidId);
    assert.throws(() => cancelClientDelivery(paidId, client1, {}), { code: 'FINANCIAL_RECONCILIATION_REQUIRED' });
    assert.deepEqual(snapshot(paidId), beforePaid);
  });

  await context.test('autorização do cancelamento externo não muda estado nem ledger', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    const before = snapshot(id);
    assert.equal((await request(`/api/client/deliveries/${id}/cancel`,
      { method: 'POST', body: {} })).status, 401);
    assert.equal((await cancel(id, cookies.company1)).status, 403);
    assert.equal((await cancel(id, cookies.client2)).status, 404);
    assert.deepEqual(snapshot(id), before);
  });

  await context.test('inconsistência de pagamento e de ciclo não cancela nem altera ledger', async () => {
    const corrupt = async (mutate) => {
      const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
      legacyMutation(['financial_entries_append_only_delete', 'financial_entries_append_only_update'],
        () => mutate(item));
      const before = snapshot(id);
      assert.throws(() => cancelClientDelivery(id, client1, {}),
        { code: 'FINANCIAL_RECONCILIATION_REQUIRED' });
      assert.deepEqual(snapshot(id), before);
    };
    await corrupt(item => db.prepare(`DELETE FROM financial_entries WHERE order_id = ? AND component = 'products'`)
      .run(item.delivery.orderId));
    await corrupt(item => db.prepare(`DELETE FROM financial_entries WHERE order_id = ? AND component = 'freight'`)
      .run(item.delivery.orderId));
    await corrupt(item => db.prepare(`UPDATE financial_entries SET amount_cents = 999
      WHERE order_id = ? AND component = 'products'`).run(item.delivery.orderId));
    await corrupt(item => db.prepare(`UPDATE orders SET freight_total_cents = NULL WHERE id = ?`)
      .run(item.delivery.orderId));
    await corrupt(item => db.prepare(`UPDATE delivery_attempts SET end_nature = 'terminal'
      WHERE delivery_id = ?`).run(item.delivery.id));
    await corrupt(item => db.prepare(`UPDATE deliveries SET returned_at = NULL WHERE id = ?`)
      .run(item.delivery.id));
    await corrupt(item => db.prepare(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, courier_id, status) VALUES (?, 2, ?, 'active')`)
      .run(item.delivery.id, courier2));
    await corrupt(item => legacyMutation(['revalidation_delete_forbidden'], () => db.prepare(
      'DELETE FROM delivery_revalidations WHERE delivery_id = ?').run(item.delivery.id)));
    await corrupt(item => {
      const foreign = createDelivery();
      legacyMutation(['revalidation_receipt_immutable'], () => db.prepare(
        'UPDATE delivery_revalidations SET delivery_id = ? WHERE delivery_id = ?')
        .run(foreign.delivery.id, item.delivery.id));
    });
    await corrupt(item => legacyMutation(['delivery_occurrences_report_immutable'], () => db.prepare(
      "UPDATE delivery_occurrences SET type = 'recipient_absent' WHERE delivery_id = ?")
      .run(item.delivery.id)));
    await corrupt(item => db.prepare(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, courier_id, status, ended_at, end_reason, end_nature)
      VALUES (?, 2, ?, 'closed_unsuccessfully', CURRENT_TIMESTAMP,
        'temporary_external_obstruction', 'recoverable')`).run(item.delivery.id, courier2));
  });

  await context.test('antes do retorno físico não usa a regra especial', async () => {
    const item = await atDestination({ freightCents: 101 }), id = item.delivery.id;
    await obstruct(item);
    const before = snapshot(id);
    assert.equal((await cancel(id)).status, 409);
    assert.deepEqual(snapshot(id), before);
    assert.equal((await post(cookies.courier1, id, 'report-return')).status, 200);
    const reported = snapshot(id);
    assert.equal((await cancel(id)).status, 409);
    assert.deepEqual(snapshot(id), reported);
    assert.equal((await companyAction(id, 'confirm-return')).status, 200);
  });

  await context.test('falhas de products e freight fazem rollback integral', async () => {
    for (const component of ['products', 'freight']) {
      const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
      const before = snapshot(id);
      db.exec(`CREATE TRIGGER forced_external_refund BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = 'refund' AND NEW.reason = 'client_cancelled_after_external_obstruction'
          AND NEW.component = '${component}'
        BEGIN SELECT RAISE(ABORT, 'forced refund failure'); END;`);
      try { assert.equal((await cancel(id)).status, 500); }
      finally { db.exec('DROP TRIGGER forced_external_refund'); }
      assert.deepEqual(snapshot(id), before);
      assert.equal((await cancel(id)).status, 200);
    }
  });

  await context.test('gatilho permite refunds coerentes e rejeita distribution para todos', async () => {
    const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
    assert.throws(() => db.prepare(`INSERT INTO financial_entries (order_id, delivery_id,
      entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, 1,
        'client_cancelled_after_external_obstruction', ?)`)
      .run(item.delivery.orderId, id, client1, `too-early:${id}`), /invalid financial entry kind/);
    assert.equal((await cancel(id)).status, 200);
    for (const [party, userId, companyId] of [
      ['courier', courier1, null], ['company', null, company1], ['ermes', null, null],
    ]) {
      assert.throws(() => db.prepare(`INSERT INTO financial_entries (order_id, delivery_id,
        entry_type, component, party_type, party_user_id, party_company_id, amount_cents,
        reason, idempotency_key) VALUES (?, ?, 'distribution', 'freight', ?, ?, ?, 1, ?, ?)`)
        .run(item.delivery.orderId, id, party, userId, companyId,
          'client_cancelled_after_external_obstruction', `invalid:${id}:${party}`));
    }
    assert.equal(snapshot(id).finances.filter(e => e.entry_type === 'distribution').length, 0);
  });

  await context.test('over-refund e colisão semântica exigem reconciliação', async () => {
    const terminal = async () => {
      const item = await awaiting({ freightCents: 101 }), id = item.delivery.id;
      db.prepare("UPDATE deliveries SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      db.prepare(`INSERT INTO delivery_events (delivery_id, actor_user_id, event_type)
        VALUES (?, ?, 'client_cancelled_after_external_obstruction')`).run(id, client1);
      return item;
    };
    const insertRefund = (item, amount, key) => db.prepare(`INSERT INTO financial_entries
      (order_id, delivery_id, entry_type, component, party_type, party_user_id,
        amount_cents, reason, idempotency_key)
      VALUES (?, ?, 'refund', 'products', 'client', ?, ?,
        'client_cancelled_after_external_obstruction', ?)`)
      .run(item.delivery.orderId, item.delivery.id, client1, amount, key);
    const over = await terminal();
    legacyMutation(['financial_entry_over_refund_insert'], () =>
      insertRefund(over, 1001, `prior:${over.delivery.id}:over`));
    const beforeOver = snapshot(over.delivery.id);
    assert.throws(() => transaction(() =>
      recordClientCancellationAfterExternalObstructionInTransaction(db, { id: over.delivery.id })),
    { code: 'FINANCIAL_RECONCILIATION_REQUIRED' });
    assert.deepEqual(snapshot(over.delivery.id), beforeOver);
    const collision = await terminal();
    insertRefund(collision, 1,
      `delivery:${collision.delivery.id}:client-cancelled-after-external-obstruction:refund-products`);
    const beforeCollision = snapshot(collision.delivery.id);
    assert.throws(() => transaction(() =>
      recordClientCancellationAfterExternalObstructionInTransaction(db, { id: collision.delivery.id })),
    { code: 'FINANCIAL_RECONCILIATION_REQUIRED' });
    assert.deepEqual(snapshot(collision.delivery.id), beforeCollision);
  });


});
