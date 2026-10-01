import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = {
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé",
  street: "Praça da Sé", number: "10", complement: "Apto 2",
};

test("API de consulta de pedidos draft pela empresa", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-company-drafts-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import("../src/server.js?company-drafts=" + Date.now());
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const base = "http://127.0.0.1:" + server.address().port;
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
      fullName: "Cliente de teste", email, birthDate: "1990-01-01", password: "Senha123!",
    } });
    assert.equal(response.status, 201);
    return login(email);
  }
  async function createDraft(cookie, companyId, items) {
    const response = await request("/api/client/orders", {
      cookie, method: "POST", body: { companyId, items },
    });
    assert.equal(response.status, 201);
    return (await response.json()).order;
  }

  const clientCookie = await registerClient("empresa-drafts.cliente@ermes.local");
  assert.equal((await request("/api/client/default-address", {
    cookie: clientCookie, method: "PUT", body: address,
  })).status, 200);
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  const firstCompany = db.prepare("SELECT id, name FROM companies WHERE cnpj = ?").get("00000000000191");
  const products = db.prepare("SELECT id FROM products WHERE company_id = ? ORDER BY id").all(firstCompany.id);
  const ownDraft = await createDraft(clientCookie, firstCompany.id, [{ productId: products[0].id, quantity: 2 }]);
  const confirmedDraft = await createDraft(clientCookie, firstCompany.id, [{ productId: products[1].id, quantity: 1 }]);
  db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(confirmedDraft.id);

  const passwordHash = db.prepare("SELECT password_hash AS value FROM users WHERE email = ?")
    .get("empresa@ermes.local").value;
  const otherCompany = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)")
    .run("Empresa isolada", "00000000000272", "isolada@ermes.local").lastInsertRowid);
  db.prepare("INSERT INTO users (company_id, role, full_name, email, password_hash) VALUES (?, 'company', ?, ?, ?)")
    .run(otherCompany, "Responsável isolado", "isolada.acesso@ermes.local", passwordHash);
  const otherProduct = Number(db.prepare("INSERT INTO products (company_id, name, price_cents, unit_weight_kg) VALUES (?, ?, ?, ?)")
    .run(otherCompany, "Produto isolado", 900, 0.25).lastInsertRowid);
  const otherDraft = await createDraft(clientCookie, otherCompany, [{ productId: otherProduct, quantity: 3 }]);
  const otherCompanyCookie = await login("isolada.acesso@ermes.local", "Ermes123!");
  const emptyCompany = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)")
    .run("Empresa sem drafts", "00000000000353", "vazia@ermes.local").lastInsertRowid);
  db.prepare("INSERT INTO users (company_id, role, full_name, email, password_hash) VALUES (?, 'company', ?, ?, ?)")
    .run(emptyCompany, "Responsável vazio", "vazia.acesso@ermes.local", passwordHash);
  const emptyCompanyCookie = await login("vazia.acesso@ermes.local", "Ermes123!");
  db.prepare("INSERT INTO users (role, full_name, email, password_hash) VALUES ('platform_admin', ?, ?, ?)")
    .run("Administrador", "empresa-drafts.admin@ermes.local", passwordHash);
  db.prepare("INSERT INTO users (company_id, role, full_name, email, password_hash) VALUES (?, 'courier', ?, ?, ?)")
    .run(firstCompany.id, "Motoboy", "empresa-drafts.courier@ermes.local", passwordHash);
  const adminCookie = await login("empresa-drafts.admin@ermes.local", "Ermes123!");
  const courierCookie = await login("empresa-drafts.courier@ermes.local", "Ermes123!");

  await context.test("exige empresa autenticada antes de processar a rota", async () => {
    const paths = ["/api/company/orders/drafts", "/api/company/orders/" + ownDraft.id, "/api/company/orders/not-an-id"];
    for (const path of paths) {
      assert.equal((await request(path)).status, 401);
      for (const cookie of [clientCookie, courierCookie, adminCookie]) {
        assert.equal((await request(path, { cookie })).status, 403);
      }
    }
  });

  await context.test("lista somente drafts associados à empresa e retorna vazio de forma previsível", async () => {
    const response = await request("/api/company/orders/drafts", { cookie: companyCookie });
    assert.equal(response.status, 200);
    const { drafts } = await response.json();
    assert.deepEqual(drafts.map(({ id }) => id), [ownDraft.id]);
    assert.deepEqual(Object.keys(drafts[0]).sort(), [
      "id", "itemCount", "itemsTotalCents", "status", "version", "weightKg",
    ]);
    assert.equal(drafts[0].version, 1);
    assert.equal(drafts[0].itemsTotalCents, 3980);
    assert.equal(drafts[0].weightKg, 1);
    assert.deepEqual((await (await request("/api/company/orders/drafts", { cookie: otherCompanyCookie })).json()).drafts
      .map(({ id }) => id), [otherDraft.id]);
    assert.deepEqual(await (await request("/api/company/orders/drafts", { cookie: emptyCompanyCookie })).json(), {
      drafts: [],
    });
  });

  await context.test("detalha apenas o draft próprio com projeção comercial mínima e sem mutação", async () => {
    const beforeOrder = { ...db.prepare("SELECT * FROM orders WHERE id = ?").get(ownDraft.id) };
    const beforeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(ownDraft.id)
      .map((item) => ({ ...item }));
    const response = await request("/api/company/orders/" + ownDraft.id, { cookie: companyCookie });
    assert.equal(response.status, 200);
    const { order } = await response.json();
    assert.deepEqual(Object.keys(order).sort(), [
      "destinationSnapshot", "id", "items", "itemsTotalCents", "status", "version", "weightKg",
    ]);
    assert.equal(order.id, ownDraft.id);
    assert.equal(order.status, "draft");
    assert.equal(order.version, 1);
    assert.deepEqual(order.destinationSnapshot, address);
    assert.deepEqual(order.items, ownDraft.items);
    assert.equal(order.itemsTotalCents, 3980);
    assert.equal(order.weightKg, 1);
    assert.doesNotMatch(JSON.stringify(order), /clientId|email|password|session|payment|freight|route/i);
    assert.deepEqual({ ...db.prepare("SELECT * FROM orders WHERE id = ?").get(ownDraft.id) }, beforeOrder);
    assert.deepEqual(db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(ownDraft.id)
      .map((item) => ({ ...item })), beforeItems);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 0);
  });

  await context.test("aceita somente GET e nenhuma consulta altera dados persistidos", async () => {
    const tableSnapshot = () => ({
      orders: db.prepare("SELECT * FROM orders ORDER BY id").all().map((row) => ({ ...row })),
      items: db.prepare("SELECT * FROM order_items ORDER BY id").all().map((row) => ({ ...row })),
      deliveries: db.prepare("SELECT * FROM deliveries ORDER BY id").all().map((row) => ({ ...row })),
    });
    const before = tableSnapshot();
    assert.equal((await request("/api/company/orders/drafts", { cookie: companyCookie })).status, 200);
    assert.equal((await request("/api/company/orders/" + ownDraft.id, { cookie: companyCookie })).status, 200);
    for (const path of ["/api/company/orders/drafts", "/api/company/orders/" + ownDraft.id]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        assert.equal((await request(path, { cookie: companyCookie, method })).status, 404);
      }
    }
    assert.deepEqual(tableSnapshot(), before);
  });

  await context.test("isola empresas, oculta inexistentes e informa conflito apenas do pedido próprio", async () => {
    assert.equal((await request("/api/company/orders/" + otherDraft.id, { cookie: companyCookie })).status, 404);
    assert.equal((await request("/api/company/orders/999999", { cookie: companyCookie })).status, 404);
    assert.equal((await request("/api/company/orders/" + confirmedDraft.id, { cookie: companyCookie })).status, 409);
  });

  await context.test("rejeita identificadores malformados e caminhos inesperados", async () => {
    const invalid = ["0", "-1", "1.5", "01", "+1", "1e0", "constructor", "toString", "__proto__",
      "9007199254740992", "%31", "%2B1", "%31e0", "%63onstructor", "%5F%5Fproto%5F%5F"];
    for (const value of invalid) {
      assert.equal((await request("/api/company/orders/" + value, { cookie: companyCookie })).status, 400);
    }
    for (const path of ["/api/company/orders/" + ownDraft.id + "/", "/api/company/orders/" + ownDraft.id + "/items",
      "/api/company/orders/drafts/extra", "/api/company/orders//"]) {
      assert.equal((await request(path, { cookie: companyCookie })).status, 404);
    }
  });

  await context.test("não expõe detalhes internos quando o snapshot persistido é inválido", async () => {
    const original = db.prepare("SELECT destination_snapshot_json AS value FROM orders WHERE id = ?").get(ownDraft.id).value;
    db.prepare("UPDATE orders SET destination_snapshot_json = ? WHERE id = ?").run("{inválido", ownDraft.id);
    try {
      const response = await request("/api/company/orders/" + ownDraft.id, { cookie: companyCookie });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Erro interno." });
    } finally {
      db.prepare("UPDATE orders SET destination_snapshot_json = ? WHERE id = ?").run(original, ownDraft.id);
    }
  });
});
