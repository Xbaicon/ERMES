import test from "node:test";
import { Worker } from 'node:worker_threads';
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const rows = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE delivery_id = ? ORDER BY id`).all(id).map(r => ({ ...r }));
  const snapshot = (id) => ({
    delivery: { ...db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) },
    attempts: rows('delivery_attempts', id), occurrences: rows('delivery_occurrences', id),
    events: rows('delivery_events', id), revalidations: rows('delivery_revalidations', id),
    finances: rows('financial_entries', id),
  });
  const companyAction = (id, action, body = {}, cookie = cookies.company1) => request(
    `/api/company/deliveries/${id}/${action}`, { method: 'POST', body, cookie });
  const releaseBody = (id) => ({ revalidationId: rows('delivery_revalidations', id).at(-1).id,
    release: true, verificationResult: 'Acesso verificado pela empresa e liberado.' });
  async function atDestination() {
    const item = createDelivery();
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
  async function awaiting() {
    const item = await atDestination();
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

});
