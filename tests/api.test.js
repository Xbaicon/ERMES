import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("servidor responde, autentica e protege rotas da empresa", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-api-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";

  const { server, startServer } = await import(`../src/server.js?test=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", baseline: "0.1" });

  const denied = await fetch(`${base}/api/company/products`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "empresa@ermes.local", password: "Ermes123!" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const products = await fetch(`${base}/api/company/products`, { headers: { Cookie: cookie } });
  assert.equal(products.status, 200);
  assert.equal((await products.json()).products.length, 2);

  const duplicateEmailMessage = "Este e-mail já está cadastrado. Use outro e-mail ou faça login.";

  await context.test("cadastro de cliente rejeita e-mail de acesso existente sem expor SQLite", async () => {
    const response = await fetch(`${base}/api/auth/register/client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Cliente de teste",
        email: " EMPRESA@ERMES.LOCAL ",
        birthDate: "1990-01-01",
        password: "Senha123!",
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, { error: duplicateEmailMessage });
    assert.doesNotMatch(JSON.stringify(body), /sqlite|constraint failed|users\.email/i);
  });

  await context.test("cadastro de empresa rejeita e-mail de acesso existente sem criar empresa", async () => {
    const companiesBefore = db.prepare("SELECT id, name FROM companies ORDER BY id").all();
    const response = await fetch(`${base}/api/auth/register/company`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: "Empresa de teste",
        cnpj: "11.222.333/0001-81",
        companyEmail: "contato@outra.local",
        responsibleName: "Responsável de teste",
        cpf: "111.444.777-35",
        accessEmail: " EMPRESA@ERMES.LOCAL ",
        password: "Senha123!",
        address: { postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé", street: "Praça da Sé", number: "1" },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body, { error: duplicateEmailMessage });
    assert.doesNotMatch(JSON.stringify(body), /sqlite|constraint failed|users\.email/i);
    const companiesAfter = db.prepare("SELECT id, name FROM companies ORDER BY id").all();
    assert.deepEqual(companiesAfter, companiesBefore);
  });

  await context.test("consulta a configuração tarifária da empresa autenticada em reais", async () => {
    const response = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      freightConfig: {
        under1Kg: "3.00", from1To3Kg: "5.00", from3To8Kg: "9.00",
        from8To12Kg: "12.00", perKm: "0.50", perMinute: "0.30",
      },
    });
  });

  await context.test("bloqueia a configuração tarifária sem sessão", async () => {
    const response = await fetch(`${base}/api/company/freight-config`);
    assert.equal(response.status, 401);
  });

  const clientRegistration = await fetch(`${base}/api/auth/register/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: "Cliente tarifário", email: "cliente.tarifario@ermes.local", birthDate: "1990-01-01", password: "Senha123!" }),
  });
  assert.equal(clientRegistration.status, 201);
  const clientLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cliente.tarifario@ermes.local", password: "Senha123!" }),
  });
  const clientCookie = clientLogin.headers.get("set-cookie").split(";")[0];

  await context.test("bloqueia papel de cliente na configuração tarifária", async () => {
    const response = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: clientCookie } });
    assert.equal(response.status, 403);
  });

  const courierRegistration = await fetch(`${base}/api/company/couriers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ fullName: "Motoboy tarifário", email: "motoboy.tarifario@ermes.local", cpf: "111.444.777-35", phone: "71999999999", vehicleType: "motorcycle", password: "Senha123!" }),
  });
  assert.equal(courierRegistration.status, 201);
  const courierLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "motoboy.tarifario@ermes.local", password: "Senha123!" }),
  });
  const courierCookie = courierLogin.headers.get("set-cookie").split(";")[0];

  await context.test("bloqueia papel de motoboy na configuração tarifária", async () => {
    const response = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: courierCookie } });
    assert.equal(response.status, 403);
  });

  await context.test("atualiza tarifas em reais, converte para centavos e persiste", async () => {
    const update = await fetch(`${base}/api/company/freight-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ under1Kg: "3.45", perKm: "0.75" }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual((await update.json()).freightConfig, {
      under1Kg: "3.45", from1To3Kg: "5.00", from3To8Kg: "9.00",
      from8To12Kg: "12.00", perKm: "0.75", perMinute: "0.30",
    });
    const quote = await fetch(`${base}/api/freight/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ weightKg: 0.5, distanceKm: 2, estimatedMinutes: 0 }),
    });
    const quoteBody = await quote.json();
    assert.equal(quote.status, 200);
    assert.equal(quoteBody.quote.weightCents, 345);
    assert.equal(quoteBody.quote.perKmCents, 75);
    assert.equal(quoteBody.quote.totalCents, 495);
    const persisted = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: cookie } });
    assert.equal((await persisted.json()).freightConfig.perKm, "0.75");
  });

  for (const [name, body] of [
    ["valores negativos", { perKm: "-0.01" }],
    ["valores malformados", { perKm: "R$ 0,50" }],
    ["mais de duas casas decimais", { perKm: "0.001" }],
    ["valores acima do limite seguro", { perKm: "90071992547409.92" }],
    ["campos inesperados", { companyId: 999, perKm: "0.50" }],
    ["PATCH sem campos válidos", {}],
    ["tentativa de editar maxWeightKg", { maxWeightKg: "99.00" }],
    ["propriedade herdada constructor", { constructor: "0.50" }],
    ["propriedade herdada toString", { toString: "0.50" }],
    ["propriedade herdada __proto__", { ["__proto__"]: "0.50" }],
  ]) {
    await context.test(`rejeita ${name}`, async () => {
      const response = await fetch(`${base}/api/company/freight-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    });
  }

  await context.test("rejeita cotação acima de 12 kg", async () => {
    const response = await fetch(`${base}/api/freight/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ weightKg: 12.001, distanceKm: 1, estimatedMinutes: 1 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /excede o limite de 12 kg/);
  });

  const secondCompanyRegistration = await fetch(`${base}/api/auth/register/company`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyName: "Segunda empresa", cnpj: "11.222.333/0001-81", companyEmail: "contato@segunda.local",
      responsibleName: "Responsável segunda", cpf: "123.456.789-09", accessEmail: "segunda@ermes.local", password: "Senha123!",
      address: { postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé", street: "Praça da Sé", number: "2" },
    }),
  });
  assert.equal(secondCompanyRegistration.status, 201);
  await secondCompanyRegistration.json();
  const secondCompanyLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "segunda@ermes.local", password: "Senha123!" }),
  });
  const secondCompanyCookie = secondCompanyLogin.headers.get("set-cookie").split(";")[0];

  await context.test("isola os parâmetros entre empresas e rejeita identificador externo", async () => {
    const attemptedUpdate = await fetch(`${base}/api/company/freight-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: secondCompanyCookie },
      body: JSON.stringify({ companyId: 1, perKm: "9.99" }),
    });
    assert.equal(attemptedUpdate.status, 400);
    const secondConfig = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: secondCompanyCookie } });
    assert.equal((await secondConfig.json()).freightConfig.perKm, "0.50");
    const firstConfig = await fetch(`${base}/api/company/freight-config`, { headers: { Cookie: cookie } });
    assert.equal((await firstConfig.json()).freightConfig.perKm, "0.75");
  });
});
