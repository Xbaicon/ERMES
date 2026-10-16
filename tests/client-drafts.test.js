import test from "node:test";
import assert from "node:assert/strict";
import { createDraftEditor, createDraftSaver, setupClientDrafts } from "../public/js/client-drafts.js";

function element() {
  const listeners = new Map();
  return {
    hidden: false, disabled: false, textContent: "", className: "", innerHTML: "",
    dataset: {}, attributes: new Map(),
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() {},
    listener(type) { return listeners.get(type); },
  };
}

const order = {
  id: 7,
  status: "draft",
  company: { id: 2, name: "Empresa A" },
  items: [{
    productId: 10, name: "Produto preservado", quantity: 2,
    unitPriceCents: 1990, unitWeightKg: 0.5,
  }],
  itemsTotalCents: 3980,
  weightKg: 1,
  destinationSnapshot: {
    postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé",
    street: "Praça da Sé", number: "10", complement: "",
  },
  recipientSnapshot: { type: "self", name: "Cliente Teste" },
};

test("editor altera quantidades, remove e adiciona produtos calculando a prévia", () => {
  const editor = createDraftEditor(order);
  editor.setQuantity(10, 3);
  editor.add({ id: 20, name: "Produto novo", priceCents: 700, unitWeightKg: 0.25 });
  editor.add({ id: 20, name: "Produto novo alterado", priceCents: 999, unitWeightKg: 9 });
  assert.deepEqual(editor.payload(), { items: [
    { productId: 10, quantity: 3 }, { productId: 20, quantity: 2 },
  ] });
  assert.deepEqual(editor.totals(), { itemsTotalCents: 7370, weightKg: 2 });
  const existingNewItem = editor.lines().find(({ productId }) => productId === 20);
  assert.equal(existingNewItem.unitPriceCents, 700);
  assert.equal(existingNewItem.unitWeightKg, 0.25);
  editor.remove(10);
  editor.add({ id: 10, name: "Produto atual", priceCents: 9999, unitWeightKg: 4 });
  const restored = editor.lines().find(({ productId }) => productId === 10);
  assert.equal(restored.unitPriceCents, 1990);
  assert.equal(restored.unitWeightKg, 0.5);
  editor.remove(10);
  assert.deepEqual(editor.payload(), { items: [{ productId: 20, quantity: 2 }] });
});

test("editor rejeita quantidades inseguras sem perder a versão visual", () => {
  const editor = createDraftEditor(order);
  for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => editor.setQuantity(10, quantity), /inteiro positivo/);
  }
  assert.throws(() => editor.setQuantity(10, Number.MAX_SAFE_INTEGER), /limites seguros/);
  assert.deepEqual(editor.payload(), { items: [{ productId: 10, quantity: 2 }] });
});

test("salvamento simultâneo envia uma requisição e aplica a representação normalizada", async () => {
  const editor = createDraftEditor(order);
  editor.setQuantity(10, 3);
  let complete;
  const calls = [];
  const saver = createDraftSaver(editor, (path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = saver.save();
  const duplicate = saver.save();
  assert.equal(saver.pending, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/client/orders/7/items");
  assert.deepEqual(JSON.parse(calls[0].options.body), { items: [{ productId: 10, quantity: 3 }] });
  assert.equal(await duplicate, null);

  const normalized = { ...order, items: [{ ...order.items[0], quantity: 3 }], itemsTotalCents: 5970, weightKg: 1.5 };
  complete({ order: normalized });
  assert.deepEqual(await first, normalized);
  assert.equal(saver.pending, false);
  assert.deepEqual(editor.totals(), { itemsTotalCents: 5970, weightKg: 1.5 });
});

test("falha da API preserva integralmente a edição visual para nova tentativa", async () => {
  const editor = createDraftEditor(order);
  editor.setQuantity(10, 4);
  editor.add({ id: 20, name: "Produto novo", priceCents: 700, unitWeightKg: 0.25 });
  const before = editor.lines();
  let calls = 0;
  const saver = createDraftSaver(editor, async () => {
    calls += 1;
    if (calls === 1) throw new Error("Produto indisponível");
    return { order: { ...order, items: before, itemsTotalCents: 8660, weightKg: 2.25 } };
  });
  await assert.rejects(saver.save(), /Produto indisponível/);
  assert.equal(saver.pending, false);
  assert.deepEqual(editor.lines(), before);
  assert.ok(await saver.save());
});

test("interface informa quando a empresa confirma enquanto o cliente editava", async () => {
  const selectors = [
    "[data-client-drafts-list]", "[data-client-drafts-status]", "[data-client-drafts-reload]",
    "[data-client-draft-detail]", "[data-client-draft-title]", "[data-client-draft-company]",
    "[data-client-draft-address]", "[data-client-draft-recipient]",
    "[data-client-draft-items]", "[data-client-draft-subtotal]",
    "[data-client-draft-weight]", "[data-client-draft-editor-status]", "[data-client-draft-message]",
    "[data-client-draft-products]", "[data-client-draft-products-status]", "[data-client-draft-save]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-client-drafts-list]");
  const save = elements.get("[data-client-draft-save]");
  const title = elements.get("[data-client-draft-title]");
  const editorStatus = elements.get("[data-client-draft-editor-status]");
  const message = elements.get("[data-client-draft-message]");
  try {
    await setupClientDrafts({
      api: async (path) => {
        if (path === "/api/client/orders/drafts") return { drafts: [{
          id: order.id, status: "draft", company: order.company, itemCount: 1,
          itemsTotalCents: order.itemsTotalCents, weightKg: order.weightKg,
        }] };
        if (path === `/api/client/orders/${order.id}`) return { order };
        if (path === `/api/client/companies/${order.company.id}/products`) return { products: [] };
        if (path === `/api/client/orders/${order.id}/items`) {
          throw Object.assign(new Error("Este pedido n\u00e3o est\u00e1 mais em estado draft."), { status: 409 });
        }
        throw new Error(`Chamada inesperada: ${path}`);
      },
      money: (value) => String(value),
      escapeHtml: (value) => String(value),
      showMessage: (target, value) => { target.textContent = value; target.hidden = false; },
    });

    list.listener("click")({ target: { closest: () => ({ dataset: { clientDraftId: String(order.id) } }) } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(save.disabled, false);
    await save.listener("click")();
    assert.match(title.textContent, /confirmado pela empresa/i);
    assert.match(editorStatus.textContent, /n.o est. mais dispon.vel para edi..o/i);
    assert.match(message.textContent, /empresa confirmou/i);
    assert.equal(save.disabled, true);
    assert.equal(list.innerHTML, "");
  } finally {
    globalThis.document = originalDocument;
  }
});
