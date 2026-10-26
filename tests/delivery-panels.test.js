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

function panelFixture({ courierFinancial = false } = {}) {
  const elements = new Map([
    ["[data-delivery-list]", element()], ["[data-delivery-detail]", element()],
    ["[data-delivery-message]", element()], ["[data-delivery-reload]", element()],
  ]);
  if (courierFinancial) elements.set("[data-courier-financial]", element());
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
        : { delivery: { ...delivery, confirmationCode: "042731", financial: {
          paymentStatus: "paid", refundStatus: "partial", paidAt: "2026-10-01 10:00:00",
          paidItemsCents: 2000, paidFreightCents: 1001, paidTotalCents: 3001,
          refunds: [{ component: "products", amountCents: 2000 },
            { component: "freight", amountCents: 501 }],
          refundedTotalCents: 2501, pending: [],
        } } },
      escapeHtml: (value) => String(value),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /Código de confirmação/);
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /042731/);
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /Total reembolsado/);
    assert.match(elements.get("[data-delivery-detail]").innerHTML, /R\$ 25\.01/);
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

test("motoboy visualiza a própria atribuição e veículo depois do aceite", async () => {
  const { panel, elements } = panelFixture();
  const originalDocument = globalThis.document;
  const currentDelivery = {
    ...delivery,
    status: "heading_to_pickup",
    courier: {
      fullName: "Motoboy Teste",
      vehicleType: "motorcycle",
      vehicleIdentifier: "Moto vermelha",
      plate: "ABC1D23",
    },
  };
  globalThis.document = {
    querySelector: () => panel,
    addEventListener() {},
  };
  try {
    await setupDeliveryPanel({
      role: "courier",
      api: async (path) => ({
        "/api/courier/deliveries/available": { deliveries: [] },
        "/api/courier/deliveries/current": { delivery: currentDelivery },
        "/api/courier/availability": { isOnline: true },
      })[path],
      escapeHtml: (value) => String(value),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const html = elements.get("[data-delivery-detail]").innerHTML;
    assert.match(html, /Motoboy:<\/strong> Motoboy Teste/);
    assert.match(html, /motorcycle · Moto vermelha · ABC1D23/);
    assert.doesNotMatch(html, /Ainda não atribuído/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("falha da projeção financeira não bloqueia painel do motoboy e é escapada", async () => {
  const { panel, elements } = panelFixture({ courierFinancial: true });
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => panel,
    addEventListener() {},
  };
  const escapeHtml = (value) => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    await setupDeliveryPanel({
      role: "courier",
      api: async (path) => {
        if (path === "/api/courier/financial-entries") throw new Error("<falha financeira>");
        return ({
          "/api/courier/deliveries/available": { deliveries: [delivery] },
          "/api/courier/deliveries/current": { delivery: null },
          "/api/courier/availability": { isOnline: true },
        })[path];
      },
      escapeHtml,
      showMessage() {},
    });
    assert.match(elements.get("[data-delivery-list]").innerHTML, /Entrega #8/);
    const financial = elements.get("[data-courier-financial]").innerHTML;
    assert.match(financial, /R\$ 0\.00/);
    assert.match(financial, /&lt;falha financeira&gt;/);
    assert.doesNotMatch(financial, /<falha financeira>/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("empresa visualiza projeção vazia e pendência financeira escapada", async () => {
  const { panel, elements } = panelFixture();
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => panel,
    addEventListener() {},
  };
  const escapeHtml = (value) => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  try {
    await setupDeliveryPanel({
      role: "company",
      api: async (path) => path === "/api/company/deliveries"
        ? { deliveries: [delivery] }
        : { delivery: { ...delivery, financial: {
          distributions: [], totalReceivedCents: 0, pending: ["<pendente>"],
        } } },
      escapeHtml,
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const html = elements.get("[data-delivery-detail]").innerHTML;
    assert.match(html, /Nenhuma parcela registrada/);
    assert.match(html, /R\$ 0\.00/);
    assert.match(html, /&lt;pendente&gt;/);
    assert.doesNotMatch(html, /<pendente>/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("cliente distingue frete desconhecido de zero e ausência de reembolso", async () => {
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
        : { delivery: { ...delivery, financial: {
          paymentStatus: "paid", refundStatus: "none", paidAt: "2026-10-01 10:00:00",
          paidItemsCents: 2000, paidFreightCents: null, paidTotalCents: 2000,
          refunds: [], refundedTotalCents: 0, pending: ["freight_amount_unavailable"],
        } } },
      escapeHtml: (value) => String(value),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: "8" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const html = elements.get("[data-delivery-detail]").innerHTML;
    assert.match(html, /frete sem valor preservado/);
    assert.match(html, /Nenhum reembolso registrado/);
    assert.match(html, /Sem reembolso/);
  } finally {
    globalThis.document = originalDocument;
  }
});
