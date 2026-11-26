import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('submissão versionada e decisão comercial empresarial', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ermes-commercial-'));
  process.env.ERMES_DB_PATH = join(directory, 'test.sqlite');
  process.env.NODE_ENV = 'development';
  const { server, startServer } = await import('../src/server.js');
  const { db } = await import('../src/database.js');
  await startServer(0);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (path, cookie, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const company = db.prepare('SELECT id FROM companies LIMIT 1').get().id;
  const product = db.prepare('SELECT id FROM products WHERE company_id = ? LIMIT 1').get(company).id;
  const owner = (await request('/api/auth/login', null, { email: 'empresa@ermes.local', password: 'Ermes123!' })).cookie;
  const hash = db.prepare('SELECT password_hash FROM users LIMIT 1').get().password_hash;
  const attendantId = Number(db.prepare(`INSERT INTO users (company_id, role, company_profile, full_name, email, password_hash)
    VALUES (?, 'company', 'ATENDENTE', 'Atendente teste', 'attendant@commercial.test', ?)`).run(company, hash).lastInsertRowid);
  const attendant = (await request('/api/auth/login', null, { email: 'attendant@commercial.test', password: 'Ermes123!' })).cookie;
  async function client(email) {
    assert.equal((await request('/api/auth/register/client', null, {
      fullName: 'Cliente teste', email, birthDate: '1990-01-01', password: 'Teste123!',
    })).status, 201);
    const cookie = (await request('/api/auth/login', null, { email, password: 'Teste123!' })).cookie;
    assert.equal((await request('/api/client/default-address', cookie, {
      postalCode: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Centro',
      street: 'Rua Teste', number: '1', complement: '',
    }, 'PUT')).status, 200);
    return cookie;
  }
  const customer = await client('customer@commercial.test');
  const stranger = await client('stranger@commercial.test');
  const create = async () => {
    const response = await request('/api/client/orders', customer, { companyId: company, items: [{ productId: product, quantity: 1 }] });
    assert.equal(response.status, 201); return response.body.order.id;
  };
  const read = async id => (await request(`/api/client/orders/${id}`, customer)).body.order;
  const submit = (id, version = 1, cookie = customer) => request(`/api/client/orders/${id}/submit`, cookie, { version });
  const confirm = (id, version = 1, cookie = owner) => request(`/api/company/orders/${id}/confirm`, cookie, { version });
  const reject = (id, cookie = owner, reason = 'Não podemos atender', version = 1) => request(`/api/company/orders/${id}/reject`, cookie, { version, reason });
  const edit = (id, quantity = 2) => request(`/api/client/orders/${id}/items`, customer,
    { items: [{ productId: product, quantity }] }, 'PUT');
  const snapshot = id => ({
    order: db.prepare('SELECT * FROM orders WHERE id = ?').get(id),
    submissions: db.prepare('SELECT * FROM order_submissions WHERE order_id = ?').all(id),
    rejections: db.prepare('SELECT * FROM order_rejections WHERE order_id = ?').all(id),
    deliveries: db.prepare('SELECT * FROM deliveries WHERE order_id = ?').all(id),
    finances: db.prepare('SELECT * FROM financial_entries WHERE order_id = ?').all(id),
  });
  await t.test('montagem não é confirmável nem aparece na fila; submissão é explícita e por proprietário', async () => {
    const id = await create();
    assert.equal((await read(id)).officialStatus, 'EM_MONTAGEM');
    assert.equal((await confirm(id)).status, 409);
    assert.equal((await reject(id)).status, 409);
    assert.equal((await submit(id, 1, stranger)).status, 404);
    assert.equal((await request('/api/company/orders/drafts', owner)).body.drafts.some(o => o.id === id), false);
    assert.equal((await submit(id)).status, 200);
    assert.equal((await read(id)).officialStatus, 'AGUARDANDO_CONFIRMACAO');
    assert.equal((await request('/api/company/orders/drafts', owner)).body.drafts.some(o => o.id === id), true);
    const before = snapshot(id);
    assert.equal((await submit(id)).status, 200);
    assert.deepEqual(snapshot(id), before);
  });
  await t.test('edição invalida submissão sem apagar histórico; ressubmissão habilita confirmação', async () => {
    const id = await create(); await submit(id);
    assert.equal((await edit(id, 1)).status, 200);
    assert.equal((await read(id)).officialStatus, 'AGUARDANDO_CONFIRMACAO');
    assert.equal((await edit(id)).status, 200);
    const order = await read(id);
    assert.equal(order.version, 2); assert.equal(order.officialStatus, 'EM_MONTAGEM');
    assert.equal(snapshot(id).submissions.length, 1);
    assert.equal((await confirm(id, 1)).status, 409);
    assert.equal((await confirm(id, 2)).status, 409);
    assert.equal((await submit(id, 1)).status, 409);
    assert.equal((await submit(id, 2)).status, 200);
    assert.equal((await confirm(id, 2)).status, 200);
    assert.equal(snapshot(id).submissions.length, 2);
    assert.equal((await edit(id)).status, 409);
  });
  for (const [label, cookie] of [['RESPONSAVEL', owner], ['ATENDENTE', attendant]]) {
    await t.test(`${label} recusa com auditoria imutável e chat somente leitura`, async () => {
      const id = await create(); await submit(id);
      for (const reason of ['', ' ', 4, 'a'.repeat(501)]) assert.equal((await reject(id, cookie, reason)).status, 400);
      assert.equal((await reject(id, customer)).status, 403);
      assert.equal((await reject(id, cookie)).status, 200);
      const order = await read(id), before = snapshot(id);
      assert.equal(order.officialStatus, 'RECUSADO');
      assert.equal(order.rejection.companyId, company);
      if (label === 'ATENDENTE') assert.equal(order.rejection.actorUserId, attendantId);
      assert.equal(before.deliveries.length, 0); assert.equal(before.finances.length, 0);
      assert.equal(before.order.payment_status, 'pending');
      assert.equal((await reject(id, owner, 'Outro motivo')).status, 200);
      assert.equal((await confirm(id)).status, 409); assert.equal((await submit(id)).status, 409);
      assert.equal((await edit(id)).status, 409);
      assert.equal((await request(`/api/client/orders/${id}/pay`, customer, {})).status, 409);
      assert.equal((await request(`/api/client/orders/${id}/chat`, customer)).body.chat.readOnly, true);
      assert.equal((await request(`/api/company/orders/${id}/chat`, cookie, { message: 'não gravar' })).status, 409);
      assert.throws(() => db.prepare("UPDATE order_rejections SET reason = 'outro' WHERE order_id = ?").run(id), /immutable/);
      assert.throws(() => db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(id), /final|rejection/);
      assert.deepEqual(snapshot(id), before);
    });
  }
  await t.test('empresa alheia não recusa nem consulta decisão', async () => {
    const other = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES ('Outra', '123', 'other@commercial.test')").run().lastInsertRowid);
    db.prepare(`INSERT INTO users (company_id, role, company_profile, full_name, email, password_hash)
      VALUES (?, 'company', 'RESPONSAVEL', 'Outro', 'other@commercial.test', ?)`).run(other, hash);
    const cookie = (await request('/api/auth/login', null, { email: 'other@commercial.test', password: 'Ermes123!' })).cookie;
    const id = await create(); await submit(id); const before = snapshot(id);
    assert.equal((await reject(id, cookie)).status, 404); assert.deepEqual(snapshot(id), before);
  });
  await t.test('submissões HTTP concorrentes registram uma única evidência', async () => {
    const id = await create();
    assert.deepEqual((await Promise.all([submit(id), submit(id), submit(id)])).map(r => r.status), [200, 200, 200]);
    assert.equal(snapshot(id).submissions.length, 1);
  });
  await t.test('edição concorrente com confirmação não confirma versão invalidada', async () => {
    for (let i = 0; i < 4; i++) {
      const id = await create(); await submit(id);
      const results = await Promise.all(i % 2 ? [confirm(id), edit(id)] : [edit(id), confirm(id)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const stored = snapshot(id).order;
      assert.ok((stored.status === 'confirmed' && stored.version === 1) || (stored.status === 'draft' && stored.version === 2));
    }
  });
  await t.test('confirmação × recusa concorrentes permitem exatamente uma decisão', async () => {
    for (let i = 0; i < 6; i++) {
      const id = await create(); await submit(id);
      const results = await Promise.all(i % 2 ? [confirm(id), reject(id)] : [reject(id), confirm(id)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const state = snapshot(id);
      assert.equal(state.rejections.length, state.order.status === 'rejected' ? 1 : 0);
      assert.equal(state.deliveries.length, 0); assert.equal(state.finances.length, 0);
      assert.ok(['confirmed', 'rejected'].includes(state.order.status));
    }
  });
  await t.test('banco existente e bootstrap repetido preservam evidências e drafts sem submissão', async () => {
    const id = await create(), before = snapshot(id);
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import { db } from './src/database.js'; console.log(JSON.stringify(db.prepare('PRAGMA foreign_key_check').all())); db.close();"],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '[]');
      assert.deepEqual(snapshot(id), before);
    }
    assert.equal((await read(id)).officialStatus, 'EM_MONTAGEM');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
