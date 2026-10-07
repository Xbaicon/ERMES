import test from "node:test";
import assert from "node:assert/strict";
import { setupDeliveryPanel } from "../public/js/delivery-panels.js";

function element() {
  const listeners = new Map();
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", dataset: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    listener(type) { return listeners.get(type); },
  };
}

function panelFixture() {
  const elements = new Map([
    ["[data-delivery-list]", element()], ["[data-delivery-detail]", element()],
    ["[data-delivery-message]", element()], ["[data-delivery-reload]", element()],
  ]);
  return { panel: { hidden: true, querySelector: (selector) => elements.get(selector) }, elements };
}

const delivery = {
  id: 8, orderId: 12, status: "available", invalidCodeAttempts: 0,
  company: { id: 2, name: "Empresa" }, courier: null, events: [],
};

test("cliente recupera e visualiza o código ao reabrir o detalhe da entrega", async () => {
  const { panel, elements } = panelFixture();
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => panel,
    addEventListener() {},
  };
  try {
    await setupDeliveryPanel({
      role: "client",
      api: async (path) => path === "/api/client/deliveries"
        ? { deliveries: [delivery] }
        : { delivery: { ...delivery, confirmationCode: "042731" } },
      escapeHtml: (value) => String(value),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /Código de confirmação/);
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /042731/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("motoboy offline visualiza a entrega disponível sem receber ação de aceite habilitada", async () => {
  const { panel, elements } = panelFixture();
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => panel,
    addEventListener() {},
  };
  try {
    await setupDeliveryPanel({
      role: "courier",
      api: async (path) => ({
        "/api/courier/deliveries/available": { deliveries: [delivery] },
        "/api/courier/deliveries/current": { delivery: null },
        "/api/courier/availability": { isOnline: false },
      })[path],
      escapeHtml: (value) => String(value),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const html = elements.get("[data-delivery-detail]").innerHTML;
    assert.match(html, /Aceite indisponível/);
    assert.match(html, /data-delivery-action="accept" disabled/);
  } finally {
    globalThis.document = originalDocument;
  }
});
