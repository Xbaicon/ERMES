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

async function renderedDelivery(role, selected) {
  const { panel, elements } = panelFixture();
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: () => panel, addEventListener() {} };
  try {
    await setupDeliveryPanel({ role,
      api: async (path) => {
        if (path.endsWith("/availability")) return { isOnline: true };
        if (path.endsWith("/financial-entries")) return { entries: [], totalReceivedCents: 0 };
        if (path.endsWith("/available")) return { deliveries: [] };
        if (path.endsWith("/deliveries")) return { deliveries: [selected] };
        return { delivery: selected };
      },
      escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      showMessage() {},
    });
    elements.get("[data-delivery-list]").listener("click")({
      target: { closest: () => ({ dataset: { deliveryId: String(selected.id) } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return elements.get("[data-delivery-detail]").innerHTML;
  } finally { globalThis.document = originalDocument; }
}

test("motoboy vê complemento e ponto de coleta também durante o retorno", async () => {
  for (const status of ["heading_to_pickup", "returning", "awaiting_return_confirmation"]) {
    const html = await renderedDelivery("courier", { ...delivery, status,
      destination: { street: "Rua X", number: "123", complement: "Apartamento 905", neighborhood: "Bairro Y", city: "Salvador", state: "BA" },
      pickupAddress: { street: "Rua da Coleta", number: "7", complement: "<Portaria>" },
    });
    assert.match(html, /Rua X, 123, Apartamento 905, Bairro Y, Salvador, BA/);
    assert.match(html, /Ponto de coleta \/ devolução:<\/strong> Rua da Coleta, 7, &lt;Portaria&gt;/);
    assert.doesNotMatch(html, /<Portaria>/);
  }
});

test("painel não inventa complemento nem origem ausentes", async () => {
  const html = await renderedDelivery("courier", { ...delivery, status: "returning",
    destination: { street: "Rua X", number: "123", complement: "" }, pickupAddress: {},
  });
  assert.match(html, /Destino:<\/strong> Rua X, 123<\/p>/);
  assert.doesNotMatch(html, /Ponto de coleta|Apartamento|undefined|null/);
});

test("ações são isoladas por papel em todos os estados operacionais", async () => {
  const courierActions = {
    available: ["accept"], heading_to_pickup: ["arrive-pickup", "fail"],
    awaiting_pickup: ["collect", "fail"], in_transit: ["arrive-destination", "fail"],
    awaiting_confirmation: ["fail", "confirm", "occurrences"], returning: ["report-return"],
    awaiting_return_confirmation: [], completed: [], cancelled: [], returned: [],
  };
  for (const [status, expectedCourier] of Object.entries(courierActions)) {
    for (const role of ["client", "company", "courier"]) {
      const expected = role === "courier" ? expectedCourier
        : role === "client" ? (["available", "heading_to_pickup", "awaiting_pickup", "in_transit", "awaiting_confirmation"].includes(status) ? ["cancel"] : [])
          : ["available", "heading_to_pickup", "awaiting_pickup"].includes(status) ? ["product-unavailable"]
            : status === "awaiting_return_confirmation" ? ["confirm-return"] : [];
      const html = await renderedDelivery(role, { ...delivery, status });
      assert.deepEqual([...html.matchAll(/data-delivery-action="([^"]+)"/g)].map((match) => match[1]), expected, `${role}: ${status}`);
    }
  }
});

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
