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
    const companiesBefore = await (await fetch(`${base}/api/companies`)).json();
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
    const companiesAfter = await (await fetch(`${base}/api/companies`)).json();
    assert.deepEqual(companiesAfter, companiesBefore);
  });
});
