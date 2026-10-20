export const CHAT_SUGGESTIONS = Object.freeze({
  client: Object.freeze([
    "Olá, gostaria de tirar uma dúvida sobre o pedido.",
    "Gostaria de confirmar a disponibilidade dos produtos.",
    "Preciso informar algo sobre a entrega.",
  ]),
  company: Object.freeze([
    "Olá! Como podemos ajudar?",
    "Seu pedido está sendo analisado.",
    "Precisamos confirmar uma informação do seu pedido.",
    "O produto solicitado está indisponível.",
  ]),
});

const POLLING_INTERVAL_MS = 5000;
const activeChatInstances = new WeakMap();

export function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("O histórico retornado pelo servidor é inválido.");
  const unique = new Map();
  for (const message of messages) {
    if (!message || !Number.isSafeInteger(message.id) || message.id <= 0
      || !["client", "company"].includes(message.senderRole)
      || typeof message.message !== "string" || typeof message.sentAt !== "string") {
      throw new Error("O histórico retornado pelo servidor é inválido.");
    }
    unique.set(message.id, { ...message });
  }
  return [...unique.values()].sort((left, right) => left.id - right.id);
}

export function renderChatMessages(messages, currentRole, escapeHtml) {
  const normalized = normalizeChatMessages(messages);
  if (!normalized.length) return '<p class="empty-copy">Nenhuma mensagem neste pedido.</p>';
  return `<ol class="chat-message-list">${normalized.map((message) => {
    const own = message.senderRole === currentRole;
    const sender = own ? "Você" : message.senderRole === "client" ? "Cliente" : "Empresa";
    return `<li class="chat-message${own ? " own" : ""}" data-chat-message-id="${message.id}">
      <strong>${sender}</strong>
      <p>${escapeHtml(message.message)}</p>
      <time>${escapeHtml(message.sentAt)}</time>
    </li>`;
  }).join("")}</ol>`;
}

function statusLabel(order) {
  const delivery = order.deliveryStatus ? ` · entrega: ${order.deliveryStatus}` : "";
  return `${order.orderStatus}${delivery}${order.readOnly ? " · somente leitura" : ""}`;
}

export async function setupOrderChat({
  role, api, escapeHtml, showMessage,
  scheduleInterval = globalThis.setInterval,
  cancelInterval = globalThis.clearInterval,
}) {
  if (!["client", "company"].includes(role)) return null;
  const panel = document.querySelector(`[data-order-chat-panel="${role}"]`);
  if (!panel) return null;
  activeChatInstances.get(panel)?.dispose();
  panel.hidden = false;
  const list = panel.querySelector("[data-chat-order-list]");
  const listStatus = panel.querySelector("[data-chat-order-list-status]");
  const reload = panel.querySelector("[data-chat-reload]");
  const detail = panel.querySelector("[data-chat-detail]");
  const title = panel.querySelector("[data-chat-title]");
  const history = panel.querySelector("[data-chat-messages]");
  const status = panel.querySelector("[data-chat-status]");
  const form = panel.querySelector("[data-chat-form]");
  const input = panel.querySelector("[data-chat-input]");
  const send = panel.querySelector("[data-chat-send]");
  const suggestions = panel.querySelector("[data-chat-suggestions]");
  const messageBox = panel.querySelector("[data-chat-message]");
  const basePath = `/api/${role}`;
  let orders = [];
  let selectedOrderId = null;
  let currentChat = null;
  let pollHandle = null;
  let periodicRequest = null;
  let sending = false;
  let active = true;
  let selectionGeneration = 0;
  let chatRequestGeneration = 0;
  let ordersRequestGeneration = 0;

  const selectedOrder = () => orders.find(({ orderId }) => orderId === selectedOrderId) || null;
  const updateComposer = () => {
    const readOnly = currentChat?.readOnly !== false;
    input.disabled = readOnly || sending;
    send.disabled = readOnly || sending || !input.value.trim();
    suggestions.querySelectorAll("button").forEach((button) => {
      button.disabled = readOnly || sending;
    });
  };
  const renderOrders = () => {
    list.innerHTML = orders.length ? orders.map((order) => `
      <button class="catalog-company-button${order.orderId === selectedOrderId ? " selected" : ""}"
              type="button" data-chat-order-id="${order.orderId}"
              aria-pressed="${order.orderId === selectedOrderId}">
        <span>Pedido #${order.orderId}</span>
        <small>${escapeHtml(statusLabel(order))}${order.hasMessages ? " · com mensagens" : ""}</small>
      </button>`).join("") : '<p class="empty-copy">Nenhum pedido disponível para conversa.</p>';
    listStatus.textContent = orders.length
      ? `${orders.length} pedido(s) disponível(is).` : "Você ainda não possui pedidos para conversa.";
  };
  const stopPolling = () => {
    if (pollHandle !== null) cancelInterval(pollHandle);
    pollHandle = null;
  };
  const invalidateSelection = () => {
    selectionGeneration += 1;
    chatRequestGeneration += 1;
    periodicRequest = null;
  };
  const isCurrentRequest = (orderId, selection, request) => active
    && selectedOrderId === orderId
    && selectionGeneration === selection
    && chatRequestGeneration === request;
  const loadChat = async ({ silent = false } = {}) => {
    if (!active || selectedOrderId === null) return false;
    const orderId = selectedOrderId;
    const selection = selectionGeneration;
    const request = ++chatRequestGeneration;
    try {
      const { chat } = await api(`${basePath}/orders/${orderId}/chat`);
      if (!isCurrentRequest(orderId, selection, request) || chat.orderId !== orderId) return false;
      currentChat = chat;
      const order = selectedOrder();
      if (order) Object.assign(order, {
        orderStatus: chat.orderStatus,
        deliveryStatus: chat.deliveryStatus,
        readOnly: chat.readOnly,
        hasMessages: chat.messages.length > 0,
      });
      title.textContent = `Conversa do Pedido #${chat.orderId}`;
      status.textContent = chat.readOnly
        ? "Pedido encerrado: o histórico permanece disponível somente para consulta."
        : "Conversa disponível para cliente e empresa.";
      history.innerHTML = renderChatMessages(chat.messages, role, escapeHtml);
      detail.hidden = false;
      renderOrders();
      updateComposer();
      return true;
    } catch (error) {
      if (!isCurrentRequest(orderId, selection, request)) return false;
      if (!silent) showMessage(messageBox, error.message);
      status.textContent = `Não foi possível atualizar agora: ${error.message}`;
      return false;
    }
  };
  const poll = async () => {
    if (!active || selectedOrderId === null || document.hidden) return;
    if (periodicRequest?.selection === selectionGeneration) return;
    const token = { selection: selectionGeneration };
    periodicRequest = token;
    try {
      await loadChat({ silent: true });
    } finally {
      if (periodicRequest === token) periodicRequest = null;
    }
  };
  const startPolling = () => {
    stopPolling();
    if (!active || selectedOrderId === null || document.hidden) return;
    pollHandle = scheduleInterval(() => poll(), POLLING_INTERVAL_MS);
  };
  const loadOrders = async () => {
    if (!active) return;
    const request = ++ordersRequestGeneration;
    reload.disabled = true;
    try {
      const result = await api(`${basePath}/order-chats`);
      if (!active || request !== ordersRequestGeneration) return;
      orders = result.orders;
      if (selectedOrderId !== null && !selectedOrder()) {
        invalidateSelection();
        selectedOrderId = null;
        currentChat = null;
        detail.hidden = true;
        stopPolling();
      }
      renderOrders();
    } catch (error) {
      if (!active || request !== ordersRequestGeneration) return;
      listStatus.textContent = error.message;
      listStatus.className = "catalog-status error";
    } finally {
      if (active && request === ordersRequestGeneration) reload.disabled = false;
    }
  };

  suggestions.innerHTML = CHAT_SUGGESTIONS[role].map((suggestion) => `
    <button class="button button-outline button-small" type="button"
            data-chat-suggestion="${escapeHtml(suggestion).replaceAll("&quot;", "&#34;")}">
      ${escapeHtml(suggestion)}
    </button>`).join("");
  const handleSuggestionClick = (event) => {
    if (!active) return;
    const button = event.target.closest("[data-chat-suggestion]");
    if (!button || button.disabled || currentChat?.readOnly !== false) return;
    input.value = button.dataset.chatSuggestion;
    input.focus();
    updateComposer();
  };
  const handleOrderClick = async (event) => {
    if (!active) return;
    const button = event.target.closest("[data-chat-order-id]");
    if (!button) return;
    const orderId = Number(button.dataset.chatOrderId);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return;
    invalidateSelection();
    selectedOrderId = orderId;
    currentChat = null;
    renderOrders();
    await loadChat();
    startPolling();
  };
  const handleInput = () => {
    if (active) updateComposer();
  };
  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!active || sending || currentChat?.readOnly !== false || !input.value.trim()) return;
    const orderId = selectedOrderId;
    const selection = selectionGeneration;
    const message = input.value;
    sending = true;
    updateComposer();
    messageBox.hidden = true;
    try {
      await api(`${basePath}/orders/${orderId}/chat`, {
        method: "POST", body: JSON.stringify({ message }),
      });
      if (!active || selectedOrderId !== orderId || selectionGeneration !== selection) return;
      input.value = "";
      await loadChat();
    } catch (error) {
      if (active && selectedOrderId === orderId && selectionGeneration === selection) {
        showMessage(messageBox, error.message);
      }
    } finally {
      sending = false;
      if (active) updateComposer();
    }
  };
  const handleReload = async () => {
    if (!active) return;
    await loadOrders();
    await loadChat({ silent: true });
  };
  const handleVisibilityChange = () => {
    if (!active) return;
    if (document.hidden) stopPolling();
    else if (selectedOrderId !== null) {
      poll();
      startPolling();
    }
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    invalidateSelection();
    ordersRequestGeneration += 1;
    stopPolling();
    suggestions.removeEventListener("click", handleSuggestionClick);
    list.removeEventListener("click", handleOrderClick);
    input.removeEventListener("input", handleInput);
    form.removeEventListener("submit", handleSubmit);
    reload.removeEventListener("click", handleReload);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (activeChatInstances.get(panel)?.dispose === dispose) activeChatInstances.delete(panel);
  };
  const instance = { dispose, stop: dispose };

  suggestions.addEventListener("click", handleSuggestionClick);
  list.addEventListener("click", handleOrderClick);
  input.addEventListener("input", handleInput);
  form.addEventListener("submit", handleSubmit);
  reload.addEventListener("click", handleReload);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  activeChatInstances.set(panel, instance);

  detail.hidden = true;
  updateComposer();
  await loadOrders();
  return instance;
}
