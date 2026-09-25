import test from "node:test";
import assert from "node:assert/strict";
import { createCart, createCartSubmitter } from "../public/js/client-cart.js";

const company = { id: 1, name: "Empresa A" };
const product = { id: 10, name: "Produto", priceCents: 1990, unitWeightKg: 0.5 };

test("carrinho agrega o mesmo produto e atualiza subtotal e peso ao alterar quantidade", () => {
  const cart = createCart();
  cart.add(company, product);
  cart.add(company, product);
  assert.deepEqual(cart.lines().map(({ productId, quantity }) => ({ productId, quantity })), [{ productId: 10, quantity: 2 }]);
  assert.deepEqual(cart.totals(), { subtotalCents: 3980, weightKg: 1 });
  cart.setQuantity(10, 3);
  assert.deepEqual(cart.totals(), { subtotalCents: 5970, weightKg: 1.5 });
  cart.remove(10);
  assert.deepEqual(cart.lines(), []);
  assert.equal(cart.company, null);
});

test("carrinho recusa mistura de empresas até ser esvaziado", () => {
  const cart = createCart();
  cart.add(company, product);
  assert.throws(() => cart.add({ id: 2, name: "Empresa B" }, { ...product, id: 20 }), /Esvazie o carrinho/);
  assert.equal(cart.company.id, 1);
  cart.clear();
  cart.add({ id: 2, name: "Empresa B" }, { ...product, id: 20 });
  assert.equal(cart.company.id, 2);
});

test("carrinho rejeita quantidade insegura sem perder o estado anterior", () => {
  const cart = createCart();
  cart.add(company, product);
  for (const quantity of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cart.setQuantity(10, quantity), /inteiro positivo/);
  }
  assert.throws(() => cart.setQuantity(10, Number.MAX_SAFE_INTEGER), /limites seguros/);
  assert.equal(cart.lines()[0].quantity, 1);
  assert.deepEqual(cart.totals(), { subtotalCents: 1990, weightKg: 0.5 });
});

test("envio simultâneo faz uma requisição e limpa o carrinho só após confirmação", async () => {
  const cart = createCart();
  cart.add(company, product);
  let complete;
  const calls = [];
  const submitter = createCartSubmitter(cart, (path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = submitter.submit();
  const duplicate = submitter.submit();
  assert.equal(submitter.pending, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { companyId: 1, items: [{ productId: 10, quantity: 1 }] });
  assert.deepEqual(cart.lines().map(({ quantity }) => quantity), [1]);
  assert.equal(await duplicate, null);
  complete({ order: { id: 42, status: "draft" } });
  assert.deepEqual(await first, { id: 42, status: "draft" });
  assert.equal(submitter.pending, false);
  assert.deepEqual(cart.lines(), []);
});

test("erro de envio preserva itens para correção ou nova tentativa", async () => {
  const cart = createCart();
  cart.add(company, product);
  let calls = 0;
  const submitter = createCartSubmitter(cart, async () => {
    calls += 1;
    if (calls === 1) throw new Error("Produto indisponível");
    return { order: { id: 43, status: "draft" } };
  });
  await assert.rejects(submitter.submit(), /Produto indisponível/);
  assert.equal(submitter.pending, false);
  assert.equal(cart.lines().length, 1);
  assert.deepEqual(await submitter.submit(), { id: 43, status: "draft" });
  assert.deepEqual(cart.lines(), []);
});
