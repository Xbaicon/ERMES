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
    "[data-company-draft-items]", "[data-company-draft-subtotal]", "[data-company-draft-weight]",
    "[data-company-draft-message]",
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
          return { drafts: [{ id: 7, status: "draft", itemCount: 1, itemsTotalCents: 1000, weightKg: 1 }] };
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
