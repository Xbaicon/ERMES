import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const addressInput = {
  postalCode: "01.001-000",
  state: " sp ",
  city: " São Paulo ",
  neighborhood: " Sé ",
  street: " Praça da Sé ",
  number: " 10 ",
  complement: " Apto 2 ",
};

const normalizedAddress = {
  postalCode: "01001000",
  state: "SP",
  city: "São Paulo",
  neighborhood: "Sé",
  street: "Praça da Sé",
  number: "10",
  complement: "Apto 2",
};

test("API do endereço padrão do cliente", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-client-address-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";

  const { server, startServer } = await import(`../src/server.js?client-address=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function registerClient(name, email) {
    const response = await fetch(`${base}/api/auth/register/client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: name, email, birthDate: "1990-01-01", password: "Senha123!" }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  }

  async function login(email, password = "Senha123!") {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }

  function requestAddress(method, cookie, body) {
    return fetch(`${base}/api/client/default-address`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  const firstClientId = await registerClient("Primeiro cliente", "primeiro.cliente@ermes.local");
  const firstClientCookie = await login("primeiro.cliente@ermes.local");
  const secondClientId = await registerClient("Segundo cliente", "segundo.cliente@ermes.local");
  const secondClientCookie = await login("segundo.cliente@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");

  const courierResponse = await fetch(`${base}/api/company/couriers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: companyCookie },
    body: JSON.stringify({
      fullName: "Motoboy endereço", email: "motoboy.endereco@ermes.local", cpf: "111.444.777-35",
      phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!",
    }),
  });
  assert.equal(courierResponse.status, 201);
  const courierCookie = await login("motoboy.endereco@ermes.local");

  const seedPasswordHash = db.prepare("SELECT password_hash AS passwordHash FROM users WHERE email = ?")
    .get("empresa@ermes.local").passwordHash;
  db.prepare(`INSERT INTO users (role, full_name, email, password_hash)
              VALUES ('platform_admin', ?, ?, ?)`)
    .run("Administrador de teste", "admin.endereco@ermes.local", seedPasswordHash);
  const adminCookie = await login("admin.endereco@ermes.local", "Ermes123!");

  await context.test("consulta autenticada retorna null quando não há endereço", async () => {
    const response = await requestAddress("GET", firstClientCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { defaultAddress: null });
  });

  await context.test("bloqueia GET e PUT sem sessão", async () => {
    for (const [method, body] of [["GET", undefined], ["PUT", addressInput]]) {
      const response = await requestAddress(method, null, body);
      assert.equal(response.status, 401);
    }
  });

  await context.test("bloqueia empresa, motoboy e administrador", async () => {
    for (const cookie of [companyCookie, courierCookie, adminCookie]) {
      for (const [method, body] of [["GET", undefined], ["PUT", addressInput]]) {
        const response = await requestAddress(method, cookie, body);
        assert.equal(response.status, 403);
      }
    }
  });

  await context.test("cadastra e devolve o endereço normalizado", async () => {
    const response = await requestAddress("PUT", firstClientCookie, addressInput);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { defaultAddress: normalizedAddress });
    const persisted = db.prepare("SELECT * FROM client_default_addresses WHERE client_id = ?").get(firstClientId);
    assert.equal(persisted.postal_code, "01001000");
    assert.equal(persisted.state, "SP");
    assert.equal(persisted.city, "São Paulo");
  });

  await context.test("mantém a integridade da chave estrangeira do proprietário", () => {
    const foreignKey = db.prepare("PRAGMA foreign_key_list(client_default_addresses)").get();
    assert.equal(foreignKey.table, "users");
    assert.equal(foreignKey.from, "client_id");
    assert.equal(foreignKey.to, "id");
    assert.equal(foreignKey.on_delete, "CASCADE");
    assert.throws(() => db.prepare(`INSERT INTO client_default_addresses
                                      (client_id, postal_code, state, city, neighborhood, street, number)
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(999999, "01001000", "SP", "São Paulo", "Sé", "Praça da Sé", "1"), /FOREIGN KEY/);
  });

  await context.test("rejeita corpo, obrigatórios, formatos e campos inesperados", async () => {
    for (const body of [
      null,
      [],
      { ...addressInput, city: undefined },
      { ...addressInput, neighborhood: "   " },
      { ...addressInput, postalCode: "1234-567" },
      { ...addressInput, state: "S1" },
      { ...addressInput, unexpected: "valor" },
      { ...addressInput, constructor: "intruso" },
      { ...addressInput, toString: "intruso" },
      { ...addressInput, ["__proto__"]: "intruso" },
    ]) {
      const response = await requestAddress("PUT", firstClientCookie, body);
      assert.equal(response.status, 400);
    }
  });

  await context.test("rejeita identificadores externos sem alterar o proprietário", async () => {
    for (const identifier of [{ userId: secondClientId }, { clientId: secondClientId }]) {
      const response = await requestAddress("PUT", firstClientCookie, { ...addressInput, ...identifier });
      assert.equal(response.status, 400);
    }
    const response = await requestAddress("GET", firstClientCookie);
    assert.deepEqual(await response.json(), { defaultAddress: normalizedAddress });
  });

  const companyId = db.prepare("SELECT id FROM companies ORDER BY id LIMIT 1").get().id;
  const snapshotJson = JSON.stringify(normalizedAddress);
  const orderId = Number(db.prepare(`INSERT INTO orders (client_id, company_id, destination_snapshot_json)
                                     VALUES (?, ?, ?)`).run(firstClientId, companyId, snapshotJson).lastInsertRowid);

  const replacementInput = {
    postalCode: "40020-000",
    state: "ba",
    city: " Salvador ",
    neighborhood: " Comércio ",
    street: " Avenida da França ",
    number: " s/n ",
  };
  const replacementAddress = {
    postalCode: "40020000",
    state: "BA",
    city: "Salvador",
    neighborhood: "Comércio",
    street: "Avenida da França",
    number: "s/n",
    complement: "",
  };

  await context.test("substitui integralmente mantendo apenas um endereço por cliente", async () => {
    const response = await requestAddress("PUT", firstClientCookie, replacementInput);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { defaultAddress: replacementAddress });
    const count = db.prepare("SELECT count(*) AS total FROM client_default_addresses WHERE client_id = ?")
      .get(firstClientId).total;
    assert.equal(count, 1);
    const consulted = await requestAddress("GET", firstClientCookie);
    assert.deepEqual(await consulted.json(), { defaultAddress: replacementAddress });
  });

  await context.test("preserva o snapshot de destino de pedido anterior", () => {
    const order = db.prepare("SELECT destination_snapshot_json AS snapshot FROM orders WHERE id = ?").get(orderId);
    assert.equal(order.snapshot, snapshotJson);
    assert.deepEqual(JSON.parse(order.snapshot), normalizedAddress);
  });

  await context.test("isola os endereços de dois clientes", async () => {
    const before = await requestAddress("GET", secondClientCookie);
    assert.deepEqual(await before.json(), { defaultAddress: null });

    const secondAddress = { ...addressInput, postalCode: "30110-012", state: "mg", city: "Belo Horizonte" };
    const saved = await requestAddress("PUT", secondClientCookie, secondAddress);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).defaultAddress.postalCode, "30110012");

    const firstAddress = await requestAddress("GET", firstClientCookie);
    assert.deepEqual(await firstAddress.json(), { defaultAddress: replacementAddress });
    assert.equal(db.prepare("SELECT count(*) AS total FROM client_default_addresses").get().total, 2);
  });
});
