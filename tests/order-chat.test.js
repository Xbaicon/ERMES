import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SUGGESTIONS, normalizeChatMessages, renderChatMessages, setupOrderChat,
} from "../public/js/order-chat.js";

function element() {
  const listeners = new Map();
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", className: "", value: "",
    dataset: {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listener(type) { return [...(listeners.get(type) || [])][0]; },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    async dispatch(type, event = {}) {
      await Promise.all([...(listeners.get(type) || [])].map((listener) => listener(event)));
    },
    querySelectorAll() { return []; },
    focus() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function chat(orderId, messages, readOnly = false) {
  return { chat: {
    orderId, orderStatus: "confirmed", deliveryStatus: readOnly ? "completed" : "in_transit",
    readOnly, messages,
  } };
}

function message(id, text) {
  return { id, senderRole: "client", message: text, sentAt: `2026-10-20 10:00:0${id}` };
}

function chatHarness() {
  const selectors = [
    "[data-chat-order-list]", "[data-chat-order-list-status]", "[data-chat-reload]",
    "[data-chat-detail]", "[data-chat-title]", "[data-chat-messages]", "[data-chat-status]",
    "[data-chat-form]", "[data-chat-input]", "[data-chat-send]", "[data-chat-suggestions]",
    "[data-chat-message]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  elements.get("[data-chat-message]").hidden = true;
  const panel = {
    hidden: true,
    querySelector: (selector) => elements.get(selector),
  };
  const documentElement = element();
  documentElement.querySelector = () => panel;
  documentElement.hidden = false;
  let nextTimer = 1;
  const timers = new Map();
  return {
    elements, panel, document: documentElement, timers,
    scheduleInterval(callback) {
      const handle = nextTimer++;
      timers.set(handle, callback);
      return handle;
    },
    cancelInterval(handle) { timers.delete(handle); },
    runTimer() {
      const callback = [...timers.values()][0];
      return callback?.();
    },
    orderClick(orderId) {
      return elements.get("[data-chat-order-list]").dispatch("click", {
        target: { closest: () => ({ dataset: { chatOrderId: String(orderId) } }) },
      });
    },
  };
}

test("mensagens predefinidas são exatamente as decisões da Baseline 0.1", () => {
  assert.deepEqual([...CHAT_SUGGESTIONS.client], [
    "Olá, gostaria de tirar uma dúvida sobre o pedido.",
    "Gostaria de confirmar a disponibilidade dos produtos.",
    "Preciso informar algo sobre a entrega.",
  ]);
  assert.deepEqual([...CHAT_SUGGESTIONS.company], [
    "Olá! Como podemos ajudar?",
    "Seu pedido está sendo analisado.",
    "Precisamos confirmar uma informação do seu pedido.",
    "O produto solicitado está indisponível.",
  ]);
});

test("polling repetido normaliza a ordem e não duplica mensagens", () => {
  const response = [
    { id: 2, senderRole: "company", message: "Segunda", sentAt: "2026-10-20 10:00:00" },
    { id: 1, senderRole: "client", message: "Primeira", sentAt: "2026-10-20 10:00:00" },
    { id: 2, senderRole: "company", message: "Segunda", sentAt: "2026-10-20 10:00:00" },
  ];
  const firstPoll = normalizeChatMessages(response);
  const secondPoll = normalizeChatMessages(response);
  assert.deepEqual(firstPoll.map(({ id }) => id), [1, 2]);
  assert.deepEqual(secondPoll, firstPoll);
});

test("renderização escapa conteúdo e mantém identificação do remetente", () => {
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = renderChatMessages([
    { id: 1, senderRole: "client", message: "<img src=x onerror=alert(1)>",
      sentAt: "2026-10-20 10:00:00" },
    { id: 2, senderRole: "company", message: "Resposta", sentAt: "2026-10-20 10:00:01" },
  ], "client", escapeHtml);
  assert.match(html, /Você/);
  assert.match(html, /Empresa/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/data-chat-message-id=/g) || []).length, 2);
});

test("falha temporária do polling preserva histórico já renderizado", async () => {
  const selectors = [
    "[data-chat-order-list]", "[data-chat-order-list-status]", "[data-chat-reload]",
    "[data-chat-detail]", "[data-chat-title]", "[data-chat-messages]", "[data-chat-status]",
    "[data-chat-form]", "[data-chat-input]", "[data-chat-send]", "[data-chat-suggestions]",
    "[data-chat-message]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const panel = {
    hidden: true,
    querySelector: (selector) => elements.get(selector),
  };
  const originalDocument = globalThis.document;
  let scheduled;
  let failPolling = false;
  const messages = [{
    id: 1, senderRole: "client", message: "Persistida", sentAt: "2026-10-20 10:00:00",
  }];
  globalThis.document = {
    hidden: false,
    querySelector: () => panel,
    addEventListener() {},
    removeEventListener() {},
  };
  let instance;
  try {
    instance = await setupOrderChat({
      role: "client",
      api: async (path) => {
        if (path === "/api/client/order-chats") return { orders: [{
          orderId: 7, orderStatus: "draft", deliveryStatus: null,
          readOnly: false, hasMessages: true,
        }] };
        if (path === "/api/client/orders/7/chat") {
          if (failPolling) throw new Error("falha temporária");
          return { chat: {
            orderId: 7, orderStatus: "draft", deliveryStatus: null,
            readOnly: false, messages,
          } };
        }
        throw new Error(`Chamada inesperada: ${path}`);
      },
      escapeHtml: (value) => String(value),
      showMessage() {},
      scheduleInterval: (callback) => { scheduled = callback; return 1; },
      cancelInterval() {},
    });
    elements.get("[data-chat-order-list]").listener("click")({
      target: { closest: () => ({ dataset: { chatOrderId: "7" } }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const history = elements.get("[data-chat-messages]");
    const rendered = history.innerHTML;
    assert.equal((rendered.match(/data-chat-message-id=/g) || []).length, 1);

    failPolling = true;
    await scheduled();
    assert.equal(history.innerHTML, rendered);
    assert.match(elements.get("[data-chat-status]").textContent, /falha temporária/);

    failPolling = false;
    await scheduled();
    assert.equal(history.innerHTML, rendered);
    assert.equal((history.innerHTML.match(/data-chat-message-id=/g) || []).length, 1);
  } finally {
    instance?.dispose();
    globalThis.document = originalDocument;
  }
});

test("resposta antiga da mesma conversa não substitui histórico ou terminalidade mais novos", async () => {
  const harness = chatHarness();
  const originalDocument = globalThis.document;
  const oldResponse = deferred();
  const newResponse = deferred();
  const responses = [chat(7, [message(1, "Inicial")]), oldResponse.promise, newResponse.promise];
  globalThis.document = harness.document;
  let instance;
  try {
    instance = await setupOrderChat({
      role: "client",
      api: async (path) => {
        if (path.endsWith("/order-chats")) return { orders: [{
          orderId: 7, orderStatus: "confirmed", deliveryStatus: "in_transit",
          readOnly: false, hasMessages: true,
        }] };
        return responses.shift();
      },
      escapeHtml: (value) => String(value),
      showMessage() {},
      scheduleInterval: harness.scheduleInterval,
      cancelInterval: harness.cancelInterval,
    });
    await harness.orderClick(7);
    const oldPoll = harness.runTimer();
    await new Promise((resolve) => setImmediate(resolve));
    const reload = harness.elements.get("[data-chat-reload]").dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    newResponse.resolve(chat(7, [message(1, "Inicial"), message(2, "Nova")], true));
    await reload;
    oldResponse.resolve(chat(7, [message(1, "Inicial"), message(2, "Antiga")]));
    await oldPoll;

    const history = harness.elements.get("[data-chat-messages]").innerHTML;
    assert.match(history, /Nova/);
    assert.doesNotMatch(history, /Antiga/);
    assert.equal(harness.elements.get("[data-chat-input]").disabled, true);
    assert.match(harness.elements.get("[data-chat-status]").textContent, /somente para consulta/);
  } finally {
    instance?.dispose();
    globalThis.document = originalDocument;
  }
});

test("troca A para B descarta resposta e erro atrasados da conversa anterior", async () => {
  const harness = chatHarness();
  const originalDocument = globalThis.document;
  const firstA = deferred();
  const firstB = deferred();
  const responses = new Map([[7, [firstA.promise]], [8, [firstB.promise]]]);
  globalThis.document = harness.document;
  let instance;
  try {
    instance = await setupOrderChat({
      role: "client",
      api: async (path) => {
        if (path.endsWith("/order-chats")) return { orders: [7, 8].map((orderId) => ({
          orderId, orderStatus: "confirmed", deliveryStatus: "in_transit",
          readOnly: false, hasMessages: true,
        })) };
        const orderId = Number(path.match(/orders\/(\d+)/)[1]);
        return responses.get(orderId).shift();
      },
      escapeHtml: (value) => String(value),
      showMessage() {},
      scheduleInterval: harness.scheduleInterval,
      cancelInterval: harness.cancelInterval,
    });
    const loadingA = harness.orderClick(7);
    await new Promise((resolve) => setImmediate(resolve));
    const loadingB = harness.orderClick(8);
    firstB.resolve(chat(8, [message(2, "Conversa B")]));
    await loadingB;
    firstA.resolve(chat(7, [message(1, "Resposta atrasada A")]));
    await loadingA;

    assert.match(harness.elements.get("[data-chat-title]").textContent, /#8/);
    assert.match(harness.elements.get("[data-chat-messages]").innerHTML, /Conversa B/);
    assert.doesNotMatch(harness.elements.get("[data-chat-messages]").innerHTML, /atrasada A/);

    const failingA = deferred();
    responses.get(7).push(failingA.promise);
    const staleFailure = harness.orderClick(7);
    await new Promise((resolve) => setImmediate(resolve));
    responses.get(8).push(chat(8, [message(3, "B atual")]));
    await harness.orderClick(8);
    failingA.reject(new Error("erro atrasado de A"));
    await staleFailure;
    assert.doesNotMatch(harness.elements.get("[data-chat-status]").textContent, /erro atrasado/);
    assert.match(harness.elements.get("[data-chat-messages]").innerHTML, /B atual/);
  } finally {
    instance?.dispose();
    globalThis.document = originalDocument;
  }
});

test("troca A para B para A não aceita resposta da primeira geração de A", async () => {
  const harness = chatHarness();
  const originalDocument = globalThis.document;
  const firstA = deferred();
  const responseB = deferred();
  const secondA = deferred();
  const responses = new Map([[7, [firstA.promise, secondA.promise]], [8, [responseB.promise]]]);
  globalThis.document = harness.document;
  let instance;
  try {
    instance = await setupOrderChat({
      role: "client",
      api: async (path) => {
        if (path.endsWith("/order-chats")) return { orders: [7, 8].map((orderId) => ({
          orderId, orderStatus: "confirmed", deliveryStatus: "in_transit",
          readOnly: false, hasMessages: true,
        })) };
        const orderId = Number(path.match(/orders\/(\d+)/)[1]);
        return responses.get(orderId).shift();
      },
      escapeHtml: (value) => String(value),
      showMessage() {},
      scheduleInterval: harness.scheduleInterval,
      cancelInterval: harness.cancelInterval,
    });
    const loadingFirstA = harness.orderClick(7);
    await new Promise((resolve) => setImmediate(resolve));
    const loadingB = harness.orderClick(8);
    await new Promise((resolve) => setImmediate(resolve));
    const loadingSecondA = harness.orderClick(7);
    secondA.resolve(chat(7, [message(3, "Segunda seleção A")]));
    await loadingSecondA;
    firstA.resolve(chat(7, [message(1, "Primeira seleção A")]));
    responseB.resolve(chat(8, [message(2, "Resposta B")]));
    await Promise.all([loadingFirstA, loadingB]);

    const history = harness.elements.get("[data-chat-messages]").innerHTML;
    assert.match(history, /Segunda seleção A/);
    assert.doesNotMatch(history, /Primeira seleção A|Resposta B/);
  } finally {
    instance?.dispose();
    globalThis.document = originalDocument;
  }
});

test("polling serializa atualizações e respeita visibilidade e dispose", async () => {
  const harness = chatHarness();
  const originalDocument = globalThis.document;
  const pendingPoll = deferred();
  const pendingAfterDispose = deferred();
  const chatResponses = [
    chat(7, [message(1, "Inicial")]),
    pendingPoll.promise,
    chat(7, [message(2, "Retomada")]),
    pendingAfterDispose.promise,
  ];
  let chatCalls = 0;
  globalThis.document = harness.document;
  let instance;
  try {
    instance = await setupOrderChat({
      role: "client",
      api: async (path) => {
        if (path.endsWith("/order-chats")) return { orders: [{
          orderId: 7, orderStatus: "confirmed", deliveryStatus: "in_transit",
          readOnly: false, hasMessages: true,
        }] };
        chatCalls += 1;
        return chatResponses.shift();
      },
      escapeHtml: (value) => String(value),
      showMessage() {},
      scheduleInterval: harness.scheduleInterval,
      cancelInterval: harness.cancelInterval,
    });
    await harness.orderClick(7);
    assert.equal(harness.timers.size, 1);
    const firstPoll = harness.runTimer();
    const overlappingPoll = harness.runTimer();
    await overlappingPoll;
    assert.equal(chatCalls, 2);
    pendingPoll.resolve(chat(7, [message(1, "Inicial"), message(2, "Poll concluído")]));
    await firstPoll;

    harness.document.hidden = true;
    await harness.document.dispatch("visibilitychange");
    assert.equal(harness.timers.size, 0);
    harness.document.hidden = false;
    await harness.document.dispatch("visibilitychange");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.timers.size, 1);
    await harness.document.dispatch("visibilitychange");
    assert.equal(harness.timers.size, 1);

    const pollAfterResume = harness.runTimer();
    await new Promise((resolve) => setImmediate(resolve));
    const renderedBeforeDispose = harness.elements.get("[data-chat-messages]").innerHTML;
    instance.dispose();
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.document.listenerCount("visibilitychange"), 0);
    pendingAfterDispose.resolve(chat(7, [message(4, "Não deve aparecer")]));
    await pollAfterResume;
    assert.equal(harness.elements.get("[data-chat-messages]").innerHTML, renderedBeforeDispose);
    await harness.document.dispatch("visibilitychange");
    assert.equal(harness.timers.size, 0);
  } finally {
    instance?.dispose();
    globalThis.document = originalDocument;
  }
});

test("segunda inicialização descarta a anterior sem duplicar listeners, submits ou polls", async () => {
  const harness = chatHarness();
  const originalDocument = globalThis.document;
  let postCalls = 0;
  const api = async (path, options = {}) => {
    if (path.endsWith("/order-chats")) return { orders: [{
      orderId: 7, orderStatus: "confirmed", deliveryStatus: "in_transit",
      readOnly: false, hasMessages: true,
    }] };
    if (options.method === "POST") {
      postCalls += 1;
      return { message: message(2, "Enviada") };
    }
    return chat(7, [message(1, "Inicial")]);
  };
  globalThis.document = harness.document;
  let first;
  let second;
  try {
    first = await setupOrderChat({
      role: "client", api, escapeHtml: (value) => String(value), showMessage() {},
      scheduleInterval: harness.scheduleInterval, cancelInterval: harness.cancelInterval,
    });
    second = await setupOrderChat({
      role: "client", api, escapeHtml: (value) => String(value), showMessage() {},
      scheduleInterval: harness.scheduleInterval, cancelInterval: harness.cancelInterval,
    });
    assert.equal(harness.elements.get("[data-chat-form]").listenerCount("submit"), 1);
    assert.equal(harness.elements.get("[data-chat-order-list]").listenerCount("click"), 1);
    assert.equal(harness.document.listenerCount("visibilitychange"), 1);
    await harness.orderClick(7);
    assert.equal(harness.timers.size, 1);
    harness.elements.get("[data-chat-input]").value = "Mensagem única";
    await harness.elements.get("[data-chat-form]").dispatch("submit", { preventDefault() {} });
    assert.equal(postCalls, 1);
    first.stop();
    assert.equal(harness.timers.size, 1);
  } finally {
    second?.dispose();
    first?.dispose();
    globalThis.document = originalDocument;
  }
});
