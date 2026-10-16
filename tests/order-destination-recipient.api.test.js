import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultAddress = {
  postalCode: "01001000",
  state: "SP",
  city: "São Paulo",
  neighborhood: "Sé",
  street: "Praça da Sé",
  number: "10",
  complement: "Apto 2",
};

const normalizedManualAddress = {
  postalCode: "20040002",
  state: "RJ",
  city: "Rio de Janeiro",
  neighborhood: "Centro",
  street: "Rua da Assembleia",
  number: "25",
  complement: "Portaria B",
};

test("destino e destinatário preservados no pedido", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-order-destination-recipient-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";
  const { server, startServer } = await import(`../src/server.js?destination-recipient=${Date.now()}`);
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
  async function registerClient(fullName, email) {
    const response = await request("/api/auth/register/client", { method: "POST", body: {
      fullName, email, birthDate: "1990-01-01", password: "Senha123!",
    } });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  }
  async function login(email, password = "Senha123!") {
    const response = await request("/api/auth/login", { method: "POST", body: { email, password } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const postOrder = (cookie, body) => request("/api/client/orders", {
    cookie, method: "POST", body,
  });

  const clientId = await registerClient("Cliente Original", "destino.cliente@ermes.local");
  const clientCookie = await login("destino.cliente@ermes.local");
  assert.equal((await request("/api/client/default-address", {
    cookie: clientCookie, method: "PUT", body: defaultAddress,
  })).status, 200);
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");
  const company = db.prepare("SELECT id FROM companies WHERE cnpj = ?").get("00000000000191");
  const products = db.prepare("SELECT id FROM products WHERE company_id = ? ORDER BY id").all(company.id);
  const baseBody = { companyId: company.id, items: [{ productId: products[0].id, quantity: 1 }] };
  let selfOrder;
  let manualOrder;

  await context.test("mantém o fluxo anterior como endereço padrão e próprio cliente", async () => {
    const response = await postOrder(clientCookie, baseBody);
    assert.equal(response.status, 201);
    const { order } = await response.json();
    selfOrder = order;
    assert.deepEqual(order.destinationSnapshot, defaultAddress);
    assert.deepEqual(order.recipientSnapshot, { type: "self", name: "Cliente Original" });
    const stored = db.prepare(`SELECT destination_snapshot_json AS destination,
      recipient_snapshot_json AS recipient FROM orders WHERE id = ?`).get(order.id);
    assert.deepEqual(JSON.parse(stored.destination), defaultAddress);
    assert.deepEqual(JSON.parse(stored.recipient), { type: "self", name: "Cliente Original" });
  });

  await context.test("normaliza endereço manual, preserva outro destinatário e não altera cadastros", async () => {
    const usersBefore = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
    const response = await postOrder(clientCookie, {
      ...baseBody,
      destination: { type: "manual", address: {
        postalCode: "20.040-002", state: " rj ", city: " Rio de Janeiro ",
        neighborhood: " Centro ", street: " Rua da Assembleia ", number: " 25 ",
        complement: " Portaria B ",
      } },
      recipient: { type: "other", name: "  Pessoa Autorizada  " },
    });
    assert.equal(response.status, 201);
    manualOrder = (await response.json()).order;
    assert.deepEqual(manualOrder.destinationSnapshot, normalizedManualAddress);
    assert.deepEqual(manualOrder.recipientSnapshot, { type: "other", name: "Pessoa Autorizada" });
    assert.deepEqual((await (await request("/api/client/default-address", { cookie: clientCookie })).json())
      .defaultAddress, defaultAddress);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM users").get().total, usersBefore);
  });

  await context.test("endereço manual funciona sem endereço padrão e telefone não é requisito", async () => {
    await registerClient("Cliente sem padrão", "manual.sem.padrao@ermes.local");
    const cookie = await login("manual.sem.padrao@ermes.local");
    const response = await postOrder(cookie, {
      ...baseBody,
      destination: { type: "manual", address: normalizedManualAddress },
      recipient: { type: "other", name: "Destinatário sem telefone" },
    });
    assert.equal(response.status, 201);
    const { order } = await response.json();
    assert.deepEqual(order.recipientSnapshot, { type: "other", name: "Destinatário sem telefone" });
  });

  await context.test("rejeita escolhas inválidas e todos os campos inesperados", async () => {
    const invalidBodies = [
      { ...baseBody, destination: null },
      { ...baseBody, destination: { type: "gps" } },
      { ...baseBody, destination: { type: "default", address: defaultAddress } },
      { ...baseBody, destination: { type: "manual" } },
      { ...baseBody, destination: { type: "manual", address: { ...normalizedManualAddress, city: "" } } },
      { ...baseBody, destination: { type: "manual", address: { ...normalizedManualAddress, latitude: -22 } } },
      { ...baseBody, recipient: null },
      { ...baseBody, recipient: { type: "unknown" } },
      { ...baseBody, recipient: { type: "other" } },
      { ...baseBody, recipient: { type: "other", name: "   " } },
      { ...baseBody, recipient: { type: "other", name: "Pessoa", phone: "11999999999" } },
      { ...baseBody, recipient: { type: "self", name: "Nome injetado" } },
    ];
    for (const body of invalidBodies) {
      const response = await postOrder(clientCookie, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });

  await context.test("snapshots resistem a cadastro, endereço e edição posterior dos itens", async () => {
    db.prepare("UPDATE users SET full_name = ? WHERE id = ?").run("Cliente Renomeado", clientId);
    assert.equal((await request("/api/client/default-address", {
      cookie: clientCookie, method: "PUT", body: { ...defaultAddress, number: "999" },
    })).status, 200);
    const update = await request(`/api/client/orders/${manualOrder.id}/items`, {
      cookie: clientCookie,
      method: "PUT",
      body: { items: [{ productId: products[0].id, quantity: 2 }, { productId: products[1].id, quantity: 1 }] },
    });
    assert.equal(update.status, 200);
    const { order } = await update.json();
    assert.deepEqual(order.destinationSnapshot, normalizedManualAddress);
    assert.deepEqual(order.recipientSnapshot, { type: "other", name: "Pessoa Autorizada" });
    const preservedSelf = await request(`/api/client/orders/${selfOrder.id}`, { cookie: clientCookie });
    assert.equal(preservedSelf.status, 200);
    const historical = (await preservedSelf.json()).order;
    assert.deepEqual(historical.destinationSnapshot, defaultAddress);
    assert.deepEqual(historical.recipientSnapshot, { type: "self", name: "Cliente Original" });
  });

  await context.test("preserva isolamento e snapshots até a Entrega operacional", async () => {
    await registerClient("Cliente Alheio", "destino.alheio@ermes.local");
    const foreignClientCookie = await login("destino.alheio@ermes.local");
    assert.equal((await request(`/api/client/orders/${manualOrder.id}`, {
      cookie: foreignClientCookie,
    })).status, 404);

    const passwordHash = db.prepare("SELECT password_hash AS value FROM users WHERE email = ?")
      .get("empresa@ermes.local").value;
    const otherCompanyId = Number(db.prepare(
      "INSERT INTO companies (name, cnpj, email) VALUES (?, ?, ?)",
    ).run("Empresa Alheia", "00000000000434", "empresa.alheia@ermes.local").lastInsertRowid);
    db.prepare(`INSERT INTO users (company_id, role, full_name, email, password_hash)
                VALUES (?, 'company', ?, ?, ?)`)
      .run(otherCompanyId, "Responsável Alheio", "acesso.alheio@ermes.local", passwordHash);
    const foreignCompanyCookie = await login("acesso.alheio@ermes.local", "Ermes123!");
    assert.equal((await request(`/api/company/orders/${manualOrder.id}`, {
      cookie: foreignCompanyCookie,
    })).status, 404);

    const companyDetail = await request(`/api/company/orders/${manualOrder.id}`, { cookie: companyCookie });
    assert.equal(companyDetail.status, 200);
    const currentDraft = (await companyDetail.json()).order;
    assert.deepEqual(currentDraft.destinationSnapshot, normalizedManualAddress);
    assert.deepEqual(currentDraft.recipientSnapshot, { type: "other", name: "Pessoa Autorizada" });

    const confirmation = await request(`/api/company/orders/${manualOrder.id}/confirm`, {
      cookie: companyCookie, method: "POST", body: { version: currentDraft.version },
    });
    assert.equal(confirmation.status, 200);
    const confirmed = (await confirmation.json()).order;
    assert.deepEqual(confirmed.destinationSnapshot, normalizedManualAddress);
    assert.deepEqual(confirmed.recipientSnapshot, { type: "other", name: "Pessoa Autorizada" });

    const paidResponse = await request(`/api/client/orders/${manualOrder.id}/pay`, {
      cookie: clientCookie, method: "POST", body: {},
    });
    assert.equal(paidResponse.status, 200);
    const paid = await paidResponse.json();
    assert.equal(paid.order.paymentStatus, "paid");
    assert.deepEqual(paid.order.destinationSnapshot, normalizedManualAddress);
    assert.deepEqual(paid.order.recipientSnapshot, { type: "other", name: "Pessoa Autorizada" });

    const deliveryResponse = await request(`/api/client/deliveries/${paid.delivery.id}`, {
      cookie: clientCookie,
    });
    assert.equal(deliveryResponse.status, 200);
    const delivery = (await deliveryResponse.json()).delivery;
    assert.deepEqual(delivery.destination, normalizedManualAddress);
    assert.deepEqual(delivery.recipient, { type: "other", name: "Pessoa Autorizada" });

    const courierResponse = await request("/api/company/couriers", {
      cookie: companyCookie, method: "POST", body: {
        fullName: "Motoboy Destino", email: "motoboy.destino@ermes.local",
        cpf: "111.444.777-35", phone: "71999999999", vehicleType: "motorcycle",
        vehicleIdentifier: "Moto teste", plate: "ABC1D23", cnh: "12345678900", password: "Senha123!",
      },
    });
    assert.equal(courierResponse.status, 201);
    const courierCookie = await login("motoboy.destino@ermes.local");
    assert.equal((await request("/api/courier/availability", {
      cookie: courierCookie, method: "PATCH", body: { isOnline: true },
    })).status, 200);
    assert.equal((await request(`/api/courier/deliveries/${paid.delivery.id}/accept`, {
      cookie: courierCookie, method: "POST", body: {},
    })).status, 200);
    const current = await request("/api/courier/deliveries/current", { cookie: courierCookie });
    assert.equal(current.status, 200);
    const courierDelivery = (await current.json()).delivery;
    assert.deepEqual(courierDelivery.destination, normalizedManualAddress);
    assert.deepEqual(courierDelivery.recipient, { type: "other", name: "Pessoa Autorizada" });
    assert.equal(Object.hasOwn(courierDelivery.recipient, "phone"), false);
  });
});
