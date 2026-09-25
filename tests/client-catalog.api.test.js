import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("API de consulta do catálogo pelo cliente", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-client-catalog-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "development";

  const { server, startServer } = await import(`../src/server.js?client-catalog=${Date.now()}`);
  const { db } = await import("../src/database.js");
  await startServer(0);
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login(email, password = "Senha123!") {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }

  function request(path, cookie) {
    return fetch(`${base}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  }

  const clientRegistration = await fetch(`${base}/api/auth/register/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullName: "Cliente do catálogo",
      email: "cliente.catalogo@ermes.local",
      birthDate: "1990-01-01",
      password: "Senha123!",
    }),
  });
  assert.equal(clientRegistration.status, 201);
  const clientCookie = await login("cliente.catalogo@ermes.local");
  const companyCookie = await login("empresa@ermes.local", "Ermes123!");

  const courierRegistration = await fetch(`${base}/api/company/couriers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: companyCookie },
    body: JSON.stringify({
      fullName: "Motoboy do catálogo",
      email: "motoboy.catalogo@ermes.local",
      cpf: "111.444.777-35",
      phone: "71999999999",
      vehicleType: "motorcycle",
      password: "Senha123!",
    }),
  });
  assert.equal(courierRegistration.status, 201);
  const courierCookie = await login("motoboy.catalogo@ermes.local");

  const seedPasswordHash = db.prepare("SELECT password_hash AS passwordHash FROM users WHERE email = ?")
    .get("empresa@ermes.local").passwordHash;
  db.prepare(`INSERT INTO users (role, full_name, email, password_hash)
              VALUES ('platform_admin', ?, ?, ?)`)
    .run("Administrador do catálogo", "admin.catalogo@ermes.local", seedPasswordHash);
  const adminCookie = await login("admin.catalogo@ermes.local", "Ermes123!");

  const seedCompany = db.prepare("SELECT id, name FROM companies WHERE cnpj = ?").get("00000000000191");
  const unavailableProduct = db.prepare(`INSERT INTO products
      (company_id, name, description, price_cents, unit_weight_kg, is_available)
      VALUES (?, ?, ?, ?, ?, 0)`)
    .run(seedCompany.id, "Produto indisponível", "Não deve ser exposto.", 5000, 1);

  const otherCompanyId = Number(db.prepare(`INSERT INTO companies (name, cnpj, email)
      VALUES (?, ?, ?)`)
    .run("Outra Empresa", "00000000000272", "outra.empresa@ermes.local").lastInsertRowid);
  const otherProductId = Number(db.prepare(`INSERT INTO products
      (company_id, name, description, price_cents, unit_weight_kg)
      VALUES (?, ?, ?, ?, ?)`)
    .run(otherCompanyId, "Produto exclusivo", "Pertence à outra empresa.", 2590, 0.75).lastInsertRowid);

  const emptyCompanyId = Number(db.prepare(`INSERT INTO companies (name, cnpj, email)
      VALUES (?, ?, ?)`)
    .run("Empresa Sem Produtos", "00000000000353", "sem.produtos@ermes.local").lastInsertRowid);
  const blockedCompanyId = Number(db.prepare(`INSERT INTO companies (name, cnpj, email, status)
      VALUES (?, ?, ?, 'blocked')`)
    .run("Empresa Bloqueada", "00000000000434", "bloqueada@ermes.local").lastInsertRowid);
  db.prepare(`INSERT INTO products (company_id, name, price_cents, unit_weight_kg)
              VALUES (?, ?, ?, ?)`)
    .run(blockedCompanyId, "Produto de empresa bloqueada", 1000, 1);

  await context.test("bloqueia as duas consultas sem sessão", async () => {
    for (const path of ["/api/client/companies", `/api/client/companies/${seedCompany.id}/products`]) {
      const response = await request(path);
      assert.equal(response.status, 401);
    }
  });

  await context.test("bloqueia empresa, motoboy e administrador", async () => {
    for (const cookie of [companyCookie, courierCookie, adminCookie]) {
      for (const path of ["/api/client/companies", `/api/client/companies/${seedCompany.id}/products`]) {
        const response = await request(path, cookie);
        assert.equal(response.status, 403);
      }
    }
  });

  await context.test("não mantém o catálogo disponível nas antigas rotas públicas", async () => {
    assert.equal((await request("/api/companies")).status, 404);
    assert.equal((await request(`/api/companies/${seedCompany.id}/products`)).status, 404);
  });

  await context.test("lista somente empresas ativas com projeção mínima", async () => {
    const response = await request("/api/client/companies", clientCookie);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.companies.map(({ name }) => name), [
      "Empresa Demonstrativa",
      "Empresa Sem Produtos",
      "Outra Empresa",
    ]);
    for (const company of body.companies) assert.deepEqual(Object.keys(company).sort(), ["id", "name"]);
  });

  await context.test("retorna somente produtos disponíveis da empresa escolhida", async () => {
    const response = await request(`/api/client/companies/${seedCompany.id}/products`, clientCookie);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.company, { id: seedCompany.id, name: seedCompany.name });
    assert.equal(body.products.length, 2);
    assert.equal(body.products.some(({ id }) => id === Number(unavailableProduct.lastInsertRowid)), false);
    assert.equal(body.products.some(({ id }) => id === otherProductId), false);
    for (const product of body.products) {
      assert.deepEqual(Object.keys(product).sort(), ["description", "id", "name", "priceCents", "unitWeightKg"]);
    }
  });

  await context.test("não mistura produtos entre empresas", async () => {
    const response = await request(`/api/client/companies/${otherCompanyId}/products`, clientCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      company: { id: otherCompanyId, name: "Outra Empresa" },
      products: [{
        id: otherProductId,
        name: "Produto exclusivo",
        description: "Pertence à outra empresa.",
        priceCents: 2590,
        unitWeightKg: 0.75,
      }],
    });
  });

  await context.test("retorna lista vazia para empresa sem produtos disponíveis", async () => {
    const response = await request(`/api/client/companies/${emptyCompanyId}/products`, clientCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      company: { id: emptyCompanyId, name: "Empresa Sem Produtos" },
      products: [],
    });
  });

  await context.test("não permite consultar diretamente uma empresa bloqueada", async () => {
    const response = await request(`/api/client/companies/${blockedCompanyId}/products`, clientCookie);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Empresa não encontrada." });
  });

  await context.test("diferencia empresa inexistente de identificador malformado", async () => {
    const missing = await request("/api/client/companies/999999/products", clientCookie);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Empresa não encontrada." });

    for (const value of [
      "abc", "1.5", "0", "-1", "01", "+1", "1e0", "%20", "%00", "%31",
      "1%2F2", "constructor", "__proto__", "9007199254740992", "9".repeat(500),
    ]) {
      const malformed = await request(`/api/client/companies/${value}/products`, clientCookie);
      assert.equal(malformed.status, 400);
      const body = await malformed.json();
      assert.deepEqual(body, { error: "Identificador de empresa inválido." });
      assert.doesNotMatch(JSON.stringify(body), /sqlite|sql|constraint/i);
    }
  });

  await context.test("rejeita caminhos inesperados sem interpretar outro identificador", async () => {
    for (const path of [
      "/api/client/companies//products",
      `/api/client/companies/${seedCompany.id}/products/extra`,
      `/api/client/companies/${seedCompany.id}//products`,
    ]) {
      const response = await request(path, clientCookie);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Rota de API não encontrada." });
    }
  });

  await context.test("retorna resposta previsível quando não há empresas ativas", async () => {
    db.prepare("UPDATE companies SET status = 'blocked'").run();
    const response = await request("/api/client/companies", clientCookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { companies: [] });
  });
});
