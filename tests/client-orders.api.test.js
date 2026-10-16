import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = {
  postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé",
  street: "Praça da Sé", number: "10", complement: "Apto 2",
};

test("criação de pedidos draft do cliente", async (context) => {
  process.env.ERMES_DB_PATH = join(mkdtempSync(join(tmpdir(), "ermes-orders-test-")), "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?orders=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function registerClient(email) {
    const response = await fetch(`${base}/api/auth/register/client`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: email, email, birthDate: "1990-01-01", password: "Senha123!" }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  }
  async function login(email, password = "Senha123!") {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  function postOrder(cookie, body, raw = false) {
    return fetch(`${base}/api/client/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ? body : JSON.stringify(body),
    });
  }
  async function putAddress(cookie, value) {
    const response = await fetch(`${base}/api/client/default-address`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
  }
  const firstId = await registerClient("primeiro.pedido@ermes.local");
  const firstCookie = await login("primeiro.pedido@ermes.local");
  const secondId = await registerClient("segundo.pedido@ermes.local");
  const secondCookie = await login("segundo.pedido@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  const courierRegistration = await fetch(`${base}/api/company/couriers`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: companyCookie },
    body: JSON.stringify({ fullName: "Motoboy teste", email: "motoboy.pedido@ermes.local",
      cpf: "111.444.777-35", phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!" }),
  });
  assert.equal(courierRegistration.status, 201);
  const courierCookie = await login("motoboy.pedido@ermes.local");
  const passwordHash = db.prepare("SELECT password_hash AS hash FROM users WHERE email = ?").get("empresa@ermes.local").hash;
  db.prepare("INSERT INTO users (role, full_name, email, password_hash) VALUES ('platform_admin', ?, ?, ?)")
    .run("Admin teste", "admin.pedido@ermes.local", passwordHash);
  const adminCookie = await login("admin.pedido@ermes.local", "Ermes123!");

  const companyId = db.prepare("SELECT id FROM companies WHERE cnpj = ?").get("00000000000191").id;
  const seedProducts = db.prepare("SELECT id, price_cents AS priceCents, unit_weight_kg AS weight FROM products WHERE company_id = ? ORDER BY id").all(companyId);
  const body = { companyId, items: [{ productId: seedProducts[0].id, quantity: 2 }] };
  const otherCompanyId = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)")
    .run("Outra Empresa", "00000000000272", "outra.pedido@ermes.local").lastInsertRowid);
  const otherProductId = Number(db.prepare("INSERT INTO products (company_id, name, price_cents, unit_weight_kg) VALUES (?, ?, ?, ?)")
    .run(otherCompanyId, "Outro produto", 700, 0.25).lastInsertRowid);
  const unavailableId = Number(db.prepare("INSERT INTO products (company_id, name, price_cents, unit_weight_kg, is_available) VALUES (?, ?, ?, ?, 0)")
    .run(companyId, "Indisponível", 500, 0.2).lastInsertRowid);
  const exactWeightId = Number(db.prepare("INSERT INTO products (company_id, name, price_cents, unit_weight_kg) VALUES (?, ?, ?, ?)")
    .run(companyId, "Peso decimal", 1, 0.1).lastInsertRowid);
  const expensiveId = Number(db.prepare("INSERT INTO products (company_id, name, price_cents, unit_weight_kg) VALUES (?, ?, ?, ?)")
    .run(companyId, "Preço alto", Number.MAX_SAFE_INTEGER, 0.1).lastInsertRowid);

  const counts = () => ({
    orders: db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,
    items: db.prepare("SELECT COUNT(*) AS n FROM order_items").get().n,
    deliveries: db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n,
  });

  await context.test("bloqueia ausência de sessão e papéis diferentes de cliente", async () => {
    assert.equal((await postOrder(null, body)).status, 401);
    for (const cookie of [companyCookie, courierCookie, adminCookie]) {
      assert.equal((await postOrder(cookie, body)).status, 403);
    }
    assert.deepEqual(counts(), { orders: 0, items: 0, deliveries: 0 });
  });

  await context.test("rejeita criação sem endereço padrão", async () => {
    const response = await postOrder(firstCookie, body);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /endereço padrão/i);
    assert.equal(counts().orders, 0);
  });

  await context.test("rejeita corpo inválido, itens vazios, campos extras e identificadores externos", async () => {
    const invalidBodies = [null, [], 1, {}, { companyId, items: [] },
      { ...body, clientId: secondId }, { ...body, userId: secondId },
      ...["status", "priceCents", "unitWeightKg", "freightTotalCents", "destinationSnapshot", "routeSnapshot", "itemsTotalCents"]
        .map((field) => ({ ...body, [field]: "intruso" })),
      ...["status", "priceCents", "unitWeightKg", "clientId", "productName"].map((field) => ({
        ...body, items: [{ ...body.items[0], [field]: "intruso" }],
      })),
      { ...body, constructor: "intruso" }, { ...body, ["__proto__"]: "intruso" },
      { ...body, items: [body.items[0], body.items[0]] },
    ];
    for (const value of invalidBodies) {
      const response = await postOrder(firstCookie, value);
      assert.equal(response.status, 400, JSON.stringify(value));
    }
    assert.equal((await postOrder(firstCookie, "{broken", true)).status, 400);
    assert.deepEqual(counts(), { orders: 0, items: 0, deliveries: 0 });
  });

  await context.test("rejeita companyId, productId e quantidade inválidos", async () => {
    const invalidIds = [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalidIds) {
      assert.equal((await postOrder(firstCookie, { ...body, companyId: value })).status, 400);
      assert.equal((await postOrder(firstCookie, { ...body, items: [{ productId: value, quantity: 1 }] })).status, 400);
      assert.equal((await postOrder(firstCookie, { ...body, items: [{ productId: seedProducts[0].id, quantity: value }] })).status, 400);
    }
    assert.equal(counts().orders, 0);
  });

  await putAddress(firstCookie, address);
  await putAddress(secondCookie, { ...address, number: "99" });

  await context.test("cria um draft com um item, recálculo e endereço da sessão", async () => {
    const response = await postOrder(firstCookie, body);
    assert.equal(response.status, 201);
    const { order } = await response.json();
    const { id, items, ...summary } = order;
    assert.deepEqual(summary, {
      status: "draft", company: { id: companyId, name: "Empresa Demonstrativa" },
      itemsTotalCents: 3980, weightKg: 1, destinationSnapshot: address,
      recipientSnapshot: { type: "self", name: "primeiro.pedido@ermes.local" },
    });
    assert.ok(Number.isSafeInteger(id));
    assert.deepEqual(items, [{ productId: seedProducts[0].id, name: "Produto demonstrativo",
      quantity: 2, unitPriceCents: 1990, unitWeightKg: 0.5 }]);
    const persisted = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
    assert.equal(persisted.client_id, firstId);
    assert.equal(persisted.company_id, companyId);
    assert.equal(persisted.status, "draft");
    assert.equal(persisted.items_total_cents, 3980);
    assert.deepEqual(JSON.parse(persisted.destination_snapshot_json), address);
    assert.equal(persisted.route_snapshot_json, null);
    assert.equal(persisted.freight_total_cents, null);
    assert.equal(counts().deliveries, 0);
  });

  await context.test("cria vários itens, preserva snapshots de preço, peso e endereço", async () => {
    const response = await postOrder(firstCookie, { companyId, items: [
      { productId: seedProducts[0].id, quantity: 2 },
      { productId: seedProducts[1].id, quantity: 3 },
    ] });
    assert.equal(response.status, 201);
    const { order } = await response.json();
    assert.equal(order.itemsTotalCents, 17750);
    assert.equal(order.weightKg, 4.75);
    const savedItems = db.prepare("SELECT product_id, quantity, unit_price_cents, unit_weight_kg FROM order_items WHERE order_id = ? ORDER BY product_id").all(order.id);
    assert.deepEqual(savedItems.map(({ product_id, quantity, unit_price_cents, unit_weight_kg }) =>
      [product_id, quantity, unit_price_cents, unit_weight_kg]), [
      [seedProducts[0].id, 2, 1990, 0.5], [seedProducts[1].id, 3, 4590, 1.25],
    ]);
    db.prepare("UPDATE products SET price_cents = ?, unit_weight_kg = ? WHERE id = ?").run(2500, 0.75, seedProducts[0].id);
    await putAddress(firstCookie, { ...address, number: "20" });
    const oldOrder = db.prepare("SELECT items_total_cents, destination_snapshot_json FROM orders WHERE id = ?").get(order.id);
    const oldItem = db.prepare("SELECT unit_price_cents, unit_weight_kg FROM order_items WHERE order_id = ? AND product_id = ?")
      .get(order.id, seedProducts[0].id);
    assert.equal(oldOrder.items_total_cents, 17750);
    assert.equal(JSON.parse(oldOrder.destination_snapshot_json).number, "10");
    assert.equal(oldItem.unit_price_cents, 1990);
    assert.equal(oldItem.unit_weight_kg, 0.5);
    const latest = await postOrder(firstCookie, { companyId, items: [{ productId: seedProducts[0].id, quantity: 1 }] });
    assert.equal(latest.status, 201);
    const current = (await latest.json()).order;
    assert.equal(current.itemsTotalCents, 2500);
    assert.equal(current.weightKg, 0.75);
    assert.equal(current.destinationSnapshot.number, "20");
  });

  await context.test("aceita exatamente 12 kg e rejeita peso maior com orientação", async () => {
    const exact = await postOrder(firstCookie, { companyId, items: [{ productId: exactWeightId, quantity: 120 }] });
    assert.equal(exact.status, 201);
    assert.equal((await exact.json()).order.weightKg, 12);
    const before = counts();
    const excess = await postOrder(firstCookie, { companyId, items: [{ productId: exactWeightId, quantity: 121 }] });
    assert.equal(excess.status, 400);
    assert.match((await excess.json()).error, /reduza.*remova/i);
    assert.deepEqual(counts(), before);
  });

  await context.test("rejeita subtotal que excede inteiro seguro", async () => {
    const before = counts();
    const response = await postOrder(firstCookie, { companyId, items: [{ productId: expensiveId, quantity: 2 }] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /limite seguro/i);
    assert.deepEqual(counts(), before);
  });

  await context.test("rejeita produto inexistente, indisponível e de outra empresa", async () => {
    for (const [productId, expectedStatus] of [[999999, 404], [unavailableId, 409], [otherProductId, 409]]) {
      const before = counts();
      const response = await postOrder(firstCookie, { companyId, items: [
        { productId: seedProducts[1].id, quantity: 1 }, { productId, quantity: 1 },
      ] });
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(counts(), before);
    }
  });

  await context.test("rejeita empresa inexistente e bloqueada", async () => {
    assert.equal((await postOrder(firstCookie, { companyId: 999999, items: [{ productId: otherProductId, quantity: 1 }] })).status, 404);
    db.prepare("UPDATE companies SET status = 'blocked' WHERE id = ?").run(otherCompanyId);
    assert.equal((await postOrder(firstCookie, { companyId: otherCompanyId, items: [{ productId: otherProductId, quantity: 1 }] })).status, 404);
  });

  await context.test("falha ao gravar o segundo item desfaz pedido e primeiro item", async () => {
    db.exec(`CREATE TRIGGER fail_second_item BEFORE INSERT ON order_items
             WHEN NEW.product_id = ${seedProducts[1].id}
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    const before = counts();
    try {
      const response = await postOrder(firstCookie, { companyId, items: [
        { productId: seedProducts[0].id, quantity: 1 }, { productId: seedProducts[1].id, quantity: 1 },
      ] });
      assert.equal(response.status, 500);
      assert.doesNotMatch(JSON.stringify(await response.json()), /forced failure|sqlite|trigger/i);
      assert.deepEqual(counts(), before);
    } finally {
      db.exec("DROP TRIGGER fail_second_item");
    }
  });

  await context.test("isola clientes e usa somente endereço do cliente autenticado", async () => {
    const response = await postOrder(secondCookie, body);
    assert.equal(response.status, 201);
    const { order } = await response.json();
    assert.equal(order.destinationSnapshot.number, "99");
    const row = db.prepare("SELECT client_id, destination_snapshot_json FROM orders WHERE id = ?").get(order.id);
    assert.equal(row.client_id, secondId);
    assert.equal(JSON.parse(row.destination_snapshot_json).number, "99");
    assert.equal(counts().deliveries, 0);
  });
});
