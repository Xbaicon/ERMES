import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const address = {
  postalCode: "01001000", state: "SP", city: "Sao Paulo", neighborhood: "Centro",
  street: "Rua Um", number: "10", complement: "",
};

test("confirmacao comercial de pedido pela empresa", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-order-confirmation-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?company-confirmation=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
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
      fullName: "Cliente confirmacao", email, birthDate: "1990-01-01", password: "Senha123!",
    } });
    assert.equal(response.status, 201);
    const cookie = await login(email);
    assert.equal((await request("/api/client/default-address", {
      cookie, method: "PUT", body: address,
    })).status, 200);
    return cookie;
  }
  async function createDraft(cookie, companyId, items) {
    const response = await request("/api/client/orders", {
      cookie, method: "POST", body: { companyId, items },
    });
    assert.equal(response.status, 201);
    return (await response.json()).order;
  }
  const confirm = (cookie, orderId, version, body = { version }) => request(
    `/api/company/orders/${orderId}/confirm`, { cookie, method: "POST", body },
  );
  const storedOrder = (orderId) => ({ ...db.prepare(`SELECT id, status, version,
    destination_snapshot_json AS destinationSnapshotJson,
    route_snapshot_json AS routeSnapshotJson, items_total_cents AS itemsTotalCents,
    freight_total_cents AS freightTotalCents, payment_status AS paymentStatus,
    confirmed_at AS confirmedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM orders WHERE id = ?`).get(orderId) });
  const storedItems = (orderId) => db.prepare(`SELECT product_id AS productId, quantity,
    unit_price_cents AS unitPriceCents, unit_weight_kg AS unitWeightKg
    FROM order_items WHERE order_id = ? ORDER BY id`).all(orderId).map((row) => ({ ...row }));

  const clientCookie = await registerClient("confirmacao.cliente@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  const company = db.prepare("SELECT id FROM companies WHERE cnpj = ?").get("00000000000191");
  const products = db.prepare("SELECT id FROM products WHERE company_id = ? ORDER BY id").all(company.id);
  const ownDraft = await createDraft(clientCookie, company.id, [
    { productId: products[0].id, quantity: 1 },
  ]);

  const passwordHash = db.prepare("SELECT password_hash AS value FROM users WHERE email = ?")
    .get("empresa@ermes.local").value;
  const otherCompanyId = Number(db.prepare("INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)")
    .run("Empresa B", "00000000000272", "empresa.b@ermes.local").lastInsertRowid);
  db.prepare("INSERT INTO users (company_id, role, full_name, email, password_hash) VALUES (?, 'company', ?, ?, ?)")
    .run(otherCompanyId, "Responsavel B", "empresa.b.acesso@ermes.local", passwordHash);
  const otherProductId = Number(db.prepare(`INSERT INTO products
    (company_id, name, price_cents, unit_weight_kg) VALUES (?, ?, ?, ?)`)
    .run(otherCompanyId, "Produto B", 800, 0.25).lastInsertRowid);
  const otherCompanyCookie = await login("empresa.b.acesso@ermes.local", "Ermes123!");
  const otherDraft = await createDraft(clientCookie, otherCompanyId, [
    { productId: otherProductId, quantity: 1 },
  ]);

  await context.test("exige autenticacao e papel de empresa", async () => {
    assert.equal((await confirm(null, ownDraft.id, 1)).status, 401);
    assert.equal((await confirm(clientCookie, ownDraft.id, 1)).status, 403);
    assert.equal(storedOrder(ownDraft.id).status, "draft");
  });

  await context.test("valida identificador, corpo, existencia e ownership", async () => {
    for (const value of ["0", "-1", "1.5", "01", "+1", "1e0", "abc", "9007199254740992"])
      assert.equal((await confirm(companyCookie, value, 1)).status, 400);
    for (const body of [null, [], {}, { version: 0 }, { version: -1 }, { version: 1.5 },
      { version: "1" }, { version: 1, confirmedAt: "2026-01-01" }, { version: 1, status: "confirmed" }]) {
      assert.equal((await confirm(companyCookie, ownDraft.id, undefined, body)).status, 400);
    }
    assert.equal((await confirm(companyCookie, 999999, 1)).status, 404);
    assert.equal((await confirm(companyCookie, otherDraft.id, 1)).status, 404);
    assert.equal((await confirm(otherCompanyCookie, ownDraft.id, 1)).status, 404);
  });

  await context.test("incrementa a versao somente quando a edicao comercial muda", async () => {
    const draft = await createDraft(clientCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    const same = await request(`/api/client/orders/${draft.id}/items`, {
      cookie: clientCookie, method: "PUT", body: { items: [{ productId: products[1].id, quantity: 1 }] },
    });
    assert.equal(same.status, 200);
    assert.equal(storedOrder(draft.id).version, 1);
    const changed = await request(`/api/client/orders/${draft.id}/items`, {
      cookie: clientCookie, method: "PUT", body: { items: [{ productId: products[1].id, quantity: 2 }] },
    });
    assert.equal(changed.status, 200);
    assert.equal(storedOrder(draft.id).version, 2);
  });

  await context.test("rejeita versao analisada desatualizada sem alteracao parcial", async () => {
    const detail = await request(`/api/company/orders/${ownDraft.id}`, { cookie: companyCookie });
    assert.equal(detail.status, 200);
    const analyzed = (await detail.json()).order;
    assert.equal(analyzed.version, 1);
    const edit = await request(`/api/client/orders/${ownDraft.id}/items`, {
      cookie: clientCookie, method: "PUT",
      body: { items: [{ productId: products[0].id, quantity: 2 }] },
    });
    assert.equal(edit.status, 200);
    const before = { order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id) };
    assert.equal(before.order.version, 2);

    const response = await confirm(companyCookie, ownDraft.id, analyzed.version);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /alterado pelo cliente/i);
    assert.deepEqual({ order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id) }, before);
    assert.equal(before.order.confirmedAt, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 0);
  });

  await context.test("confirma o snapshot atual sem depender da disponibilidade posterior do produto", async () => {
    const detail = (await (await request(`/api/company/orders/${ownDraft.id}`, {
      cookie: companyCookie,
    })).json()).order;
    const before = { order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id) };
    db.prepare("UPDATE products SET is_available = 0 WHERE id = ?").run(products[0].id);

    const response = await confirm(companyCookie, ownDraft.id, detail.version);
    assert.equal(response.status, 200);
    const { order } = await response.json();
    assert.equal(order.status, "confirmed");
    assert.equal(order.version, detail.version);
    assert.match(order.confirmedAt, /^\d{4}-\d{2}-\d{2} /);
    assert.deepEqual(order.items, detail.items);
    assert.equal(order.itemsTotalCents, detail.itemsTotalCents);
    assert.equal(order.weightKg, detail.weightKg);
    assert.deepEqual(order.destinationSnapshot, detail.destinationSnapshot);

    const persisted = storedOrder(ownDraft.id);
    assert.equal(persisted.status, "confirmed");
    assert.equal(persisted.version, before.order.version);
    assert.equal(persisted.confirmedAt, order.confirmedAt);
    assert.equal(persisted.routeSnapshotJson, before.order.routeSnapshotJson);
    assert.equal(persisted.freightTotalCents, before.order.freightTotalCents);
    assert.equal(persisted.paymentStatus, before.order.paymentStatus);
    assert.equal(persisted.destinationSnapshotJson, before.order.destinationSnapshotJson);
    assert.equal(persisted.itemsTotalCents, before.order.itemsTotalCents);
    assert.deepEqual(storedItems(ownDraft.id), before.items);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'payments'")
      .get().value, 0);

    const drafts = (await (await request("/api/company/orders/drafts", { cookie: companyCookie })).json()).drafts;
    assert.equal(drafts.some(({ id }) => id === ownDraft.id), false);
    assert.equal((await request(`/api/client/orders/${ownDraft.id}`, { cookie: clientCookie })).status, 409);
    const blockedEdit = await request(`/api/client/orders/${ownDraft.id}/items`, {
      cookie: clientCookie, method: "PUT",
      body: { items: [{ productId: products[0].id, quantity: 1 }] },
    });
    assert.equal(blockedEdit.status, 409);
    assert.match((await blockedEdit.json()).error, /n.o est. mais em estado draft/i);
  });

  await context.test("repete a confirmacao de forma idempotente", async () => {
    const before = { order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value };
    const response = await confirm(companyCookie, ownDraft.id, before.order.version);
    assert.equal(response.status, 200);
    const repeated = (await response.json()).order;
    assert.equal(repeated.status, "confirmed");
    assert.equal(repeated.confirmedAt, before.order.confirmedAt);
    assert.deepEqual({ order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value }, before);
  });

  await context.test("rejeita versao antiga depois de confirmar uma versao mais nova", async () => {
    const before = { order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value };
    assert.equal(before.order.version, 2);

    const response = await confirm(companyCookie, ownDraft.id, 1);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /vers.o analisada.*vers.o confirmada/i);
    assert.deepEqual({ order: storedOrder(ownDraft.id), items: storedItems(ownDraft.id),
      deliveries: db.prepare("SELECT COUNT(*) AS value FROM deliveries").get().value }, before);
  });

  await context.test("rejeita estado incompativel, falta de itens e peso acima do limite", async () => {
    const incompatible = await createDraft(clientCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(incompatible.id);
    assert.equal((await confirm(companyCookie, incompatible.id, 1)).status, 409);
    assert.equal(storedOrder(incompatible.id).confirmedAt, null);

    const empty = await createDraft(clientCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    db.prepare("DELETE FROM order_items WHERE order_id = ?").run(empty.id);
    assert.equal((await confirm(companyCookie, empty.id, 1)).status, 409);
    assert.equal(storedOrder(empty.id).status, "draft");

    const overweight = await createDraft(clientCookie, company.id, [{ productId: products[1].id, quantity: 1 }]);
    db.prepare("UPDATE order_items SET unit_weight_kg = 13 WHERE order_id = ?").run(overweight.id);
    const before = storedOrder(overweight.id);
    assert.equal((await confirm(companyCookie, overweight.id, 1)).status, 409);
    assert.deepEqual(storedOrder(overweight.id), before);
  });
});
