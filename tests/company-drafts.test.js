import test from "node:test";
import assert from "node:assert/strict";
import { setupCompanyDrafts } from "../public/js/company-drafts.js";

function element() {
  const listeners = new Map();
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    innerHTML: "",
    dataset: {},
    attributes: new Map(),
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() {},
    listener(type) { return listeners.get(type); },
  };
}

test("erro ao consultar detalhe permanece visível e libera nova tentativa", async () => {
  const selectors = [
    "[data-company-drafts-list]", "[data-company-drafts-status]", "[data-company-drafts-reload]",
    "[data-company-draft-detail]", "[data-company-draft-title]", "[data-company-draft-address]",
    "[data-company-draft-recipient]",
    "[data-company-draft-items]", "[data-company-draft-subtotal]", "[data-company-draft-weight]",
    "[data-company-draft-message]", "[data-company-draft-confirm]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-company-drafts-list]");
  const reload = elements.get("[data-company-drafts-reload]");
  const detail = elements.get("[data-company-draft-detail]");
  const message = elements.get("[data-company-draft-message]");
  let listCalls = 0;
  try {
    await setupCompanyDrafts({
      api: async (path) => {
        if (path === "/api/company/orders/drafts") {
          listCalls += 1;
          return { drafts: [{ id: 7, status: "draft", version: 1, itemCount: 1, itemsTotalCents: 1000, weightKg: 1 }] };
        }
        throw new Error("Pedido não está mais disponível.");
      },
      money: (value) => String(value),
      escapeHtml: (value) => String(value),
      showMessage: (target, value) => { target.textContent = value; target.hidden = false; },
    });

    list.listener("click")({ target: { closest: () => ({ dataset: { companyDraftId: "7" } }) } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(detail.hidden, true);
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, "Pedido não está mais disponível.");
    assert.equal(reload.disabled, false);
    await reload.listener("click")();
    assert.equal(listCalls, 2);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("confirmacao envia a versao analisada, bloqueia duplo clique e atualiza a lista", async () => {
  const selectors = [
    "[data-company-drafts-list]", "[data-company-drafts-status]", "[data-company-drafts-reload]",
    "[data-company-draft-detail]", "[data-company-draft-title]", "[data-company-draft-address]",
    "[data-company-draft-recipient]",
    "[data-company-draft-items]", "[data-company-draft-subtotal]", "[data-company-draft-weight]",
    "[data-company-draft-message]", "[data-company-draft-confirm]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-company-drafts-list]");
  const detail = elements.get("[data-company-draft-detail]");
  const confirmButton = elements.get("[data-company-draft-confirm]");
  const message = elements.get("[data-company-draft-message]");
  const order = {
    id: 7, status: "draft", version: 3,
    items: [{ productId: 1, name: "Produto", quantity: 2, unitPriceCents: 1000, unitWeightKg: 0.5 }],
    itemsTotalCents: 2000, weightKg: 1,
    destinationSnapshot: { postalCode: "01001000", state: "SP", city: "Sao Paulo",
      neighborhood: "Centro", street: "Rua Um", number: "10", complement: "" },
    recipientSnapshot: { type: "self", name: "Cliente Teste" },
  };
  let completeConfirmation;
  const confirmationCalls = [];
  try {
    await setupCompanyDrafts({
      api: async (path, options) => {
        if (path === "/api/company/orders/drafts") {
          return { drafts: [{ id: 7, status: "draft", version: 3,
            itemCount: 1, itemsTotalCents: 2000, weightKg: 1 }] };
        }
        if (path === "/api/company/orders/7" && !options) return { order };
        if (path === "/api/company/orders/7/confirm") {
          confirmationCalls.push({ path, options });
          return new Promise((resolve) => { completeConfirmation = resolve; });
        }
        throw new Error(`Chamada inesperada: ${path}`);
      },
      money: (value) => String(value),
      escapeHtml: (value) => String(value),
      showMessage: (target, value, type) => {
        target.textContent = value; target.className = type || "error"; target.hidden = false;
      },
    });

    list.listener("click")({ target: { closest: () => ({ dataset: { companyDraftId: "7" } }) } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(confirmButton.hidden, false);
    const first = confirmButton.listener("click")();
    const duplicate = confirmButton.listener("click")();
    assert.equal(confirmButton.disabled, true);
    assert.equal(confirmationCalls.length, 1);
    assert.deepEqual(JSON.parse(confirmationCalls[0].options.body), { version: 3 });
    assert.equal(confirmationCalls[0].options.method, "POST");
    await duplicate;
    completeConfirmation({ order: { ...order, status: "confirmed", confirmedAt: "2026-10-01 12:00:00" } });
    await first;

    assert.equal(detail.hidden, true);
    assert.equal(confirmButton.hidden, true);
    assert.equal(list.innerHTML, "");
    assert.equal(message.hidden, false);
    assert.match(message.textContent, /confirmado comercialmente/i);
    assert.equal(message.className, "success");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("conflito recarrega a versao atual antes de permitir nova confirmacao", async () => {
  const selectors = [
    "[data-company-drafts-list]", "[data-company-drafts-status]", "[data-company-drafts-reload]",
    "[data-company-draft-detail]", "[data-company-draft-title]", "[data-company-draft-address]",
    "[data-company-draft-recipient]",
    "[data-company-draft-items]", "[data-company-draft-subtotal]", "[data-company-draft-weight]",
    "[data-company-draft-message]", "[data-company-draft-confirm]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-company-drafts-list]");
  const confirmButton = elements.get("[data-company-draft-confirm]");
  const message = elements.get("[data-company-draft-message]");
  const versions = [];
  let detailVersion = 1;
  try {
    await setupCompanyDrafts({
      api: async (path, options) => {
        if (path === "/api/company/orders/drafts") return { drafts: [{ id: 8, status: "draft",
          version: detailVersion, itemCount: 1, itemsTotalCents: 1000, weightKg: 1 }] };
        if (path === "/api/company/orders/8") return { order: {
          id: 8, status: "draft", version: detailVersion,
          items: [{ productId: 1, name: "Produto", quantity: detailVersion,
            unitPriceCents: 1000, unitWeightKg: 1 }],
          itemsTotalCents: 1000 * detailVersion, weightKg: detailVersion,
          destinationSnapshot: { postalCode: "01001000", state: "SP", city: "Sao Paulo",
            neighborhood: "Centro", street: "Rua Um", number: "10", complement: "" },
          recipientSnapshot: { type: "other", name: "Porteiro Teste" },
        } };
        if (path === "/api/company/orders/8/confirm") {
          const version = JSON.parse(options.body).version;
          versions.push(version);
          if (versions.length === 1) {
            detailVersion = 2;
            throw Object.assign(
              new Error("O pedido foi alterado pelo cliente. Recarregue a versao atual antes de confirmar."),
              { status: 409 },
            );
          }
          return { order: { id: 8, status: "confirmed" } };
        }
        throw new Error(`Chamada inesperada: ${path}`);
      },
      money: (value) => String(value),
      escapeHtml: (value) => String(value),
      showMessage: (target, value) => { target.textContent = value; target.hidden = false; },
    });

    list.listener("click")({ target: { closest: () => ({ dataset: { companyDraftId: "8" } }) } });
    await new Promise((resolve) => setImmediate(resolve));
    await confirmButton.listener("click")();
    assert.deepEqual(versions, [1]);
    assert.match(message.textContent, /alterado pelo cliente/i);
    assert.equal(confirmButton.hidden, false);
    await confirmButton.listener("click")();
    assert.deepEqual(versions, [1, 2]);
  } finally {
    globalThis.document = originalDocument;
  }
});
