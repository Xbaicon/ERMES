import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentSubmitter, setupClientPayments } from "../public/js/client-payments.js";

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

const pendingOrder = {
  id: 7,
  status: "confirmed",
  company: { id: 2, name: "Empresa A" },
  paymentStatus: "pending",
  paymentPaidAt: null,
  confirmedAt: "2026-10-01 10:00:00",
  items: [{ productId: 10, name: "Produto", quantity: 2, unitPriceCents: 1990, unitWeightKg: 0.5 }],
  itemsTotalCents: 3980,
  freightTotalCents: null,
  weightKg: 1,
  destinationSnapshot: {
    postalCode: "01001000", state: "SP", city: "Sao Paulo", neighborhood: "Centro",
    street: "Rua Um", number: "10", complement: "",
  },
};

const summary = {
  id: pendingOrder.id,
  status: "confirmed",
  company: pendingOrder.company,
  paymentStatus: "pending",
  paymentPaidAt: null,
  confirmedAt: pendingOrder.confirmedAt,
  itemCount: 1,
  itemsTotalCents: pendingOrder.itemsTotalCents,
  freightTotalCents: null,
  weightKg: 1,
};

const selectors = [
  "[data-client-payments-list]", "[data-client-payments-status]", "[data-client-payments-reload]",
  "[data-client-payment-detail]", "[data-client-payment-title]", "[data-client-payment-company]",
  "[data-client-payment-status]", "[data-client-payment-confirmed-at]", "[data-client-payment-paid-at]",
  "[data-client-payment-items]", "[data-client-payment-subtotal]", "[data-client-payment-freight]",
  "[data-client-payment-message]", "[data-client-payment-pay]",
];

test("envio de pagamento bloqueia requisicoes concorrentes no navegador", async () => {
  let complete;
  const calls = [];
  const submitter = createPaymentSubmitter(7, (path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = submitter.pay();
  const duplicate = submitter.pay();
  assert.equal(submitter.pending, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/client/orders/7/pay");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.equal(await duplicate, null);
  complete({ order: { ...pendingOrder, paymentStatus: "paid", paymentPaidAt: "2026-10-01 10:05:00" } });
  assert.equal((await first).order.paymentStatus, "paid");
  assert.equal(submitter.pending, false);
});

test("interface mostra pagamento pendente, preserva frete indefinido e atualiza para paid", async () => {
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-client-payments-list]");
  const detail = elements.get("[data-client-payment-detail]");
  const paymentStatus = elements.get("[data-client-payment-status]");
  const freight = elements.get("[data-client-payment-freight]");
  const payButton = elements.get("[data-client-payment-pay]");
  const message = elements.get("[data-client-payment-message]");
  const calls = [];
  try {
    await setupClientPayments({
      api: async (path, options) => {
        calls.push({ path, options });
        if (path === "/api/client/orders/confirmed") return { orders: [{ ...summary }] };
        if (path === "/api/client/orders/confirmed/7") return { order: { ...pendingOrder } };
        if (path === "/api/client/orders/7/pay") return { order: {
          ...pendingOrder, paymentStatus: "paid", paymentPaidAt: "2026-10-01 10:05:00",
        } };
        throw new Error(`Chamada inesperada: ${path}`);
      },
      money: (value) => `R$ ${value}`,
      escapeHtml: (value) => String(value),
      showMessage: (target, value, type = "error") => {
        target.textContent = value; target.className = type; target.hidden = false;
      },
    });

    assert.match(list.innerHTML, /Pagamento simulado pendente/);
    list.listener("click")({ target: { closest: () => ({ dataset: { clientPaymentOrderId: "7" } }) } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(detail.hidden, false);
    assert.match(paymentStatus.textContent, /pendente/i);
    assert.equal(freight.textContent, "Ainda não definido");
    assert.equal(payButton.hidden, false);
    await payButton.listener("click")();
    assert.match(paymentStatus.textContent, /confirmado/i);
    assert.equal(payButton.hidden, true);
    assert.equal(message.className, "success");
    assert.match(message.textContent, /pagamento simulado.*confirmado/i);
    assert.equal(calls.filter(({ path }) => path === "/api/client/orders/7/pay").length, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("conflito de pagamento recarrega o estado confirmado atual", async () => {
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  const list = elements.get("[data-client-payments-list]");
  const payButton = elements.get("[data-client-payment-pay]");
  const paymentStatus = elements.get("[data-client-payment-status]");
  const message = elements.get("[data-client-payment-message]");
  let detailCalls = 0;
  try {
    await setupClientPayments({
      api: async (path) => {
        if (path === "/api/client/orders/confirmed") return { orders: [{ ...summary }] };
        if (path === "/api/client/orders/confirmed/7") {
          detailCalls += 1;
          return { order: detailCalls === 1 ? { ...pendingOrder } : {
            ...pendingOrder, paymentStatus: "paid", paymentPaidAt: "2026-10-01 10:05:00",
          } };
        }
        if (path === "/api/client/orders/7/pay") {
          throw Object.assign(new Error("O pagamento foi alterado."), { status: 409 });
        }
        throw new Error(`Chamada inesperada: ${path}`);
      },
      money: (value) => String(value),
      escapeHtml: (value) => String(value),
      showMessage: (target, value) => { target.textContent = value; target.hidden = false; },
    });

    list.listener("click")({ target: { closest: () => ({ dataset: { clientPaymentOrderId: "7" } }) } });
    await new Promise((resolve) => setImmediate(resolve));
    await payButton.listener("click")();
    assert.equal(detailCalls, 2);
    assert.match(paymentStatus.textContent, /confirmado/i);
    assert.equal(payButton.hidden, true);
    assert.match(message.textContent, /situa..o do pedido mudou/i);
  } finally {
    globalThis.document = originalDocument;
  }
});
