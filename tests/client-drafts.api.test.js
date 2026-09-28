import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = { postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé",
  street: "Praça da Sé", number: "10", complement: "Apto 2" };

test("consulta e edição dos pedidos draft do cliente", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-drafts-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?drafts=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, method = "GET", body, raw = false } = {}) => fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  });
  async function register(email) {
    const response = await request("/api/auth/register/client", { method: "POST",
      body: { fullName: email, email, birthDate: "1990-01-01", password: "Senha123!" } });
    assert.equal(response.status, 201); return (await response.json()).id;
  }
  async function login(email, password = "Senha123!") {
    const response = await request("/api/auth/login", { method: "POST", body: { email, password } });
    assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0];
  }
  async function saveAddress(cookie, value) {
    assert.equal((await request("/api/client/default-address", { cookie, method: "PUT", body: value })).status, 200);
  }
  async function createDraft(cookie, companyId, items) {
    const response = await request("/api/client/orders", { cookie, method: "POST", body: { companyId, items } });
    assert.equal(response.status, 201); return (await response.json()).order;
  }
  const update = (cookie, id, items, body = { items }) => request(`/api/client/orders/${id}/items`,
    { cookie, method: "PUT", body });
  const rows = (id) => db.prepare(`SELECT product_id AS productId, quantity,
    unit_price_cents AS unitPriceCents, unit_weight_kg AS unitWeightKg
    FROM order_items WHERE order_id = ? ORDER BY id`).all(id).map((row) => ({ ...row }));

  const firstId = await register("drafts.primeiro@ermes.local");
  const secondId = await register("drafts.segundo@ermes.local");
  const firstCookie = await login("drafts.primeiro@ermes.local");
  const secondCookie = await login("drafts.segundo@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  assert.equal((await request("/api/company/couriers", { cookie: companyCookie, method: "POST", body: {
    fullName: "Motoboy drafts", email: "motoboy.drafts@ermes.local", cpf: "111.444.777-35",
    phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!" } })).status, 201);
  const courierCookie = await login("motoboy.drafts@ermes.local");
  const hash = db.prepare("SELECT password_hash AS value FROM users WHERE email = ?").get("empresa@ermes.local").value;
  db.prepare("INSERT INTO users (role, full_name, email, password_hash) VALUES ('platform_admin', ?, ?, ?)")
    .run("Admin drafts", "admin.drafts@ermes.local", hash);
  const adminCookie = await login("admin.drafts@ermes.local", "Ermes123!");
  await saveAddress(firstCookie, address);
  await saveAddress(secondCookie, { ...address, number: "99" });

  const company = db.prepare("SELECT id, name FROM companies WHERE cnpj = ?").get("00000000000191");
  const products = db.prepare("SELECT id FROM products WHERE company_id = ? ORDER BY id").all(company.id);
  const addProduct = (companyId, name, price, weight, available = 1) => Number(db.prepare(`INSERT INTO products
    (company_id, name, price_cents, unit_weight_kg, is_available) VALUES (?, ?, ?, ?, ?)`)
    .run(companyId, name, price, weight, available).lastInsertRowid);
  const newProduct = addProduct(company.id, "Produto novo", 700, 0.25);
  const decimalProduct = addProduct(company.id, "Peso decimal", 10, 0.1);
  const unavailableProduct = addProduct(company.id, "Indisponível", 500, 0.2, 0);
  const expensiveProduct = addProduct(company.id, "Preço máximo", Number.MAX_SAFE_INTEGER, 0.1);
  const otherCompany = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)")
    .run("Outra Empresa", "00000000000272", "outra.drafts@ermes.local").lastInsertRowid);
  const otherProduct = addProduct(otherCompany, "Produto alheio", 800, 0.3);
  const firstDraft = await createDraft(firstCookie, company.id, [{ productId: products[0].id, quantity: 2 }]);
  const secondDraft = await createDraft(secondCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
  const confirmed = await createDraft(firstCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
  db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(confirmed.id);

  await context.test("autentica antes de identificadores e corpos", async () => {
    const valid = [["GET", "/api/client/orders/drafts", undefined], ["GET", `/api/client/orders/${firstDraft.id}`, undefined],
      ["PUT", `/api/client/orders/${firstDraft.id}/items`, { items: [{ productId: products[0].id, quantity: 1 }] }]];
    for (const [method, path, body] of valid) {
      assert.equal((await request(path, { method, body })).status, 401);
      for (const cookie of [companyCookie, courierCookie, adminCookie])
        assert.equal((await request(path, { cookie, method, body })).status, 403);
    }
    assert.equal((await request("/api/client/orders/not-an-id")).status, 401);
    assert.equal((await request("/api/client/orders/not-an-id/items", { method: "PUT", body: "{broken", raw: true })).status, 401);
    for (const cookie of [companyCookie, courierCookie, adminCookie]) {
      assert.equal((await request("/api/client/orders/not-an-id", { cookie })).status, 403);
      assert.equal((await request("/api/client/orders/not-an-id/items", { cookie, method: "PUT", body: "{broken", raw: true })).status, 403);
    }
  });

  await context.test("lista e consulta somente drafts próprios", async () => {
    const drafts = (await (await request("/api/client/orders/drafts", { cookie: firstCookie })).json()).drafts;
    assert.deepEqual(drafts.map(({ id }) => id), [firstDraft.id]);
    assert.deepEqual(drafts[0].company, { ...company });
    assert.equal(drafts[0].itemsTotalCents, 3980); assert.equal(drafts[0].weightKg, 1);
    assert.deepEqual((await (await request("/api/client/orders/drafts", { cookie: secondCookie })).json()).drafts
      .map(({ id }) => id), [secondDraft.id]);
    const own = (await (await request(`/api/client/orders/${firstDraft.id}`, { cookie: firstCookie })).json()).order;
    assert.deepEqual(own.destinationSnapshot, address); assert.deepEqual(own.items, firstDraft.items);
    assert.equal((await request(`/api/client/orders/${secondDraft.id}`, { cookie: firstCookie })).status, 404);
    assert.equal((await request("/api/client/orders/999999", { cookie: firstCookie })).status, 404);
  });

  await context.test("rejeita IDs malformados, codificados e caminhos inesperados", async () => {
    const invalid = ["0", "-1", "1.5", "01", "+1", "1e0", "abc", "constructor", "toString", "__proto__",
      "9007199254740992", "%31", "%2B1", "%2D1", "%31e0", "%63onstructor", "%74oString",
      "%5F%5Fproto%5F%5F", "%2F", "%00"];
    for (const value of invalid) {
      assert.equal((await request(`/api/client/orders/${value}`, { cookie: firstCookie })).status, 400);
      assert.equal((await update(firstCookie, value, [{ productId: products[0].id, quantity: 1 }])).status, 400);
    }
    assert.equal((await update(firstCookie, "drafts", [{ productId: products[0].id, quantity: 1 }])).status, 400);
    const unexpected = [["GET", `/api/client/orders/${firstDraft.id}/`], ["GET", `/api/client/orders/${firstDraft.id}/extra`],
      ["GET", "/api/client/orders/drafts/extra"], ["GET", "/api/client/orders//"],
      ["PUT", `/api/client/orders/${firstDraft.id}/items/`], ["PUT", `/api/client/orders/${firstDraft.id}/items/extra`],
      ["PUT", "/api/client/orders//items"]];
    for (const [method, path] of unexpected) {
      const response = await request(path, { cookie: firstCookie, method,
        ...(method === "PUT" ? { body: { items: [{ productId: products[0].id, quantity: 1 }] } } : {}) });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: "Rota de API não encontrada." });
    }
  });

  await context.test("bloqueia estado não draft e valida representação completa", async () => {
    assert.equal((await request(`/api/client/orders/${confirmed.id}`, { cookie: firstCookie })).status, 409);
    assert.equal((await update(firstCookie, confirmed.id, [{ productId: products[1].id, quantity: 2 }])).status, 409);
    const item = { productId: products[0].id, quantity: 1 };
    const invalidBodies = [null, [], {}, { items: [] }, { items: [item], clientId: secondId }, { items: [item], userId: secondId },
      { items: [item], companyId: company.id }, { items: [item], status: "draft" }, { items: [item], destinationSnapshot: address },
      { items: [item], freightTotalCents: 1 }, { items: [item], routeSnapshot: {} }, { items: [item], constructor: "x" },
      { items: [item], toString: "x" }, { items: [item], ["__proto__"]: "x" }, { items: [item, item] },
      { items: [{ ...item, priceCents: 1 }] }, { items: [{ ...item, unitWeightKg: 1 }] },
      { items: [{ ...item, constructor: "x" }] }, { items: [{ ...item, ["__proto__"]: "x" }] },
      { items: [{ productId: products[0].id }] }, { items: [{ quantity: 1 }] }, { items: [null] }];
    for (const body of invalidBodies) {
      const before = rows(firstDraft.id); const response = await update(firstCookie, firstDraft.id, undefined, body);
      assert.equal(response.status, 400, JSON.stringify(body)); assert.deepEqual(rows(firstDraft.id), before);
    }
    for (const value of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await update(firstCookie, firstDraft.id, [{ productId: products[0].id, quantity: value }])).status, 400);
      assert.equal((await update(firstCookie, firstDraft.id, [{ productId: value, quantity: 1 }])).status, 400);
    }
  });

  await context.test("não expõe detalhes de erro interno não SQLite", async () => {
    const original = db.prepare("SELECT destination_snapshot_json AS value FROM orders WHERE id = ?").get(firstDraft.id).value;
    db.prepare("UPDATE orders SET destination_snapshot_json = ? WHERE id = ?").run("{invalid", firstDraft.id);
    try {
      const response = await request(`/api/client/orders/${firstDraft.id}`, { cookie: firstCookie });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Erro interno." });
    } finally {
      db.prepare("UPDATE orders SET destination_snapshot_json = ? WHERE id = ?").run(original, firstDraft.id);
    }
  });

  await context.test("preserva snapshots existentes e captura valores de produto novo", async () => {
    const rawDestination = db.prepare("SELECT destination_snapshot_json AS value FROM orders WHERE id = ?").get(firstDraft.id).value;
    db.prepare("UPDATE products SET price_cents = 2500, unit_weight_kg = 0.75 WHERE id = ?").run(products[0].id);
    await saveAddress(firstCookie, { ...address, number: "20" });
    const response = await update(firstCookie, firstDraft.id, [{ productId: products[0].id, quantity: 3 },
      { productId: newProduct, quantity: 2 }]);
    assert.equal(response.status, 200); const order = (await response.json()).order;
    assert.equal(order.itemsTotalCents, 7370); assert.equal(order.weightKg, 2);
    assert.deepEqual(order.items.map(({ productId, quantity, unitPriceCents, unitWeightKg }) =>
      ({ productId, quantity, unitPriceCents, unitWeightKg })), [
      { productId: products[0].id, quantity: 3, unitPriceCents: 1990, unitWeightKg: 0.5 },
      { productId: newProduct, quantity: 2, unitPriceCents: 700, unitWeightKg: 0.25 }]);
    assert.equal(db.prepare("SELECT destination_snapshot_json AS value FROM orders WHERE id = ?").get(firstDraft.id).value, rawDestination);
    db.prepare("UPDATE products SET price_cents = 900, unit_weight_kg = 0.5 WHERE id = ?").run(newProduct);
    const preserved = (await (await update(firstCookie, firstDraft.id, [{ productId: products[0].id, quantity: 1 },
      { productId: newProduct, quantity: 3 }])).json()).order;
    assert.equal(preserved.itemsTotalCents, 4090); assert.equal(preserved.weightKg, 1.25);
    assert.equal(preserved.items[1].unitPriceCents, 700); assert.equal(preserved.items[1].unitWeightKg, 0.25);
    const removed = (await (await update(firstCookie, firstDraft.id, [{ productId: products[0].id, quantity: 1 }])).json()).order;
    assert.deepEqual(removed.items.map(({ productId }) => productId), [products[0].id]);
  });

  await context.test("mantém precisão, limite e produtos confiáveis", async () => {
    const exact = await createDraft(firstCookie, company.id, [{ productId: decimalProduct, quantity: 1 }]);
    assert.equal((await (await update(firstCookie, exact.id, [{ productId: decimalProduct, quantity: 120 }])).json()).order.weightKg, 12);
    const before = rows(exact.id); const excess = await update(firstCookie, exact.id, [{ productId: decimalProduct, quantity: 121 }]);
    assert.equal(excess.status, 400); assert.match((await excess.json()).error, /reduza.*remova/i); assert.deepEqual(rows(exact.id), before);
    const expensive = await createDraft(firstCookie, company.id, [{ productId: expensiveProduct, quantity: 1 }]);
    assert.equal((await update(firstCookie, expensive.id, [{ productId: expensiveProduct, quantity: 2 }])).status, 400);
    const draft = await createDraft(firstCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    for (const [id, status] of [[999999, 404], [unavailableProduct, 409], [otherProduct, 409]]) {
      const old = rows(draft.id); const response = await update(firstCookie, draft.id,
        [{ productId: products[1].id, quantity: 2 }, { productId: id, quantity: 1 }]);
      assert.equal(response.status, status); assert.deepEqual(rows(draft.id), old);
    }
  });

  await context.test("falha após DELETE restaura byte a byte a versão anterior", async () => {
    const draft = await createDraft(firstCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    const oldItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(draft.id).map((row) => ({ ...row }));
    const oldOrder = { ...db.prepare("SELECT * FROM orders WHERE id = ?").get(draft.id) };
    db.exec(`CREATE TRIGGER fail_second_item BEFORE INSERT ON order_items WHEN NEW.product_id = ${newProduct}
             BEGIN SELECT RAISE(ABORT, 'forced draft failure'); END`);
    try {
      const response = await update(firstCookie, draft.id, [{ productId: products[1].id, quantity: 2 },
        { productId: newProduct, quantity: 1 }]);
      assert.equal(response.status, 500); assert.doesNotMatch(JSON.stringify(await response.json()), /forced|sqlite|trigger/i);
      assert.deepEqual(db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(draft.id)
        .map((row) => ({ ...row })), oldItems);
      assert.deepEqual({ ...db.prepare("SELECT * FROM orders WHERE id = ?").get(draft.id) }, oldOrder);
    } finally { db.exec("DROP TRIGGER fail_second_item"); }
  });

  await context.test("mudança de estado durante substituição causa conflito e rollback", async () => {
    const draft = await createDraft(firstCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    const oldItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(draft.id).map((row) => ({ ...row }));
    const oldOrder = { ...db.prepare("SELECT * FROM orders WHERE id = ?").get(draft.id) };
    db.exec(`CREATE TRIGGER confirm_draft_after_delete AFTER DELETE ON order_items WHEN OLD.order_id = ${draft.id}
             BEGIN UPDATE orders SET status = 'confirmed' WHERE id = OLD.order_id; END`);
    try {
      const response = await update(firstCookie, draft.id, [{ productId: products[1].id, quantity: 2 }]);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "Este pedido não está mais em estado draft." });
      assert.deepEqual(db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(draft.id)
        .map((row) => ({ ...row })), oldItems);
      assert.deepEqual({ ...db.prepare("SELECT * FROM orders WHERE id = ?").get(draft.id) }, oldOrder);
    } finally { db.exec("DROP TRIGGER confirm_draft_after_delete"); }
  });

  await context.test("não altera outro cliente nem cria entrega", async () => {
    assert.equal((await update(firstCookie, secondDraft.id, [{ productId: products[1].id, quantity: 5 }])).status, 404);
    assert.equal(db.prepare("SELECT client_id AS value FROM orders WHERE id = ?").get(secondDraft.id).value, secondId);
    assert.deepEqual(rows(secondDraft.id), [{ productId: products[1].id, quantity: 1,
      unitPriceCents: 4590, unitWeightKg: 1.25 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 0);
    assert.equal(db.prepare("SELECT client_id AS value FROM orders WHERE id = ?").get(firstDraft.id).value, firstId);
  });
});
