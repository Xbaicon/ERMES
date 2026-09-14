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
});
