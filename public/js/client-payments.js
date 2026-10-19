export function createPaymentSubmitter(orderId, api) {
  let pending = false;
  return {
    get pending() { return pending; },
    async pay() {
      if (pending) return null;
      pending = true;
      try {
        const result = await api(`/api/client/orders/${orderId}/pay`, {
          method: "POST",
          body: "{}",
        });
        return result;
      } finally {
        pending = false;
      }
    },
  };
}

export async function setupClientPayments({ api, money, escapeHtml, showMessage }) {
  const list = document.querySelector("[data-client-payments-list]");
  const listStatus = document.querySelector("[data-client-payments-status]");
  const reloadButton = document.querySelector("[data-client-payments-reload]");
  const detail = document.querySelector("[data-client-payment-detail]");
  const title = document.querySelector("[data-client-payment-title]");
  const company = document.querySelector("[data-client-payment-company]");
  const status = document.querySelector("[data-client-payment-status]");
  const confirmedAt = document.querySelector("[data-client-payment-confirmed-at]");
  const paidAt = document.querySelector("[data-client-payment-paid-at]");
  const recipient = document.querySelector("[data-client-payment-recipient]");
  const items = document.querySelector("[data-client-payment-items]");
  const subtotal = document.querySelector("[data-client-payment-subtotal]");
  const freight = document.querySelector("[data-client-payment-freight]");
  const message = document.querySelector("[data-client-payment-message]");
  const payButton = document.querySelector("[data-client-payment-pay]");
  let orders = [];
  let selectedOrder = null;
  let selectedId = null;
  let submitter = null;
  let listLoading = false;
  let detailLoading = false;

  const busy = () => listLoading || detailLoading || submitter?.pending;
  const setStatus = (element, value, type = "") => {
    element.textContent = value;
    element.className = `catalog-status${type ? ` ${type}` : ""}`;
  };
  const paymentLabels = Object.freeze({
    pending: "Pagamento simulado pendente",
    paid: "Pagamento simulado confirmado",
  });
  const refundLabels = Object.freeze({
    none: "Sem reembolso",
    partial: "Reembolso parcial",
    full: "Reembolso integral",
  });
  const paymentLabel = (paymentStatus) => paymentLabels[paymentStatus] || paymentStatus;
  const orderFinancialLabel = (order) => order.refundStatus && order.refundStatus !== "none"
    ? `${paymentLabel(order.paymentStatus)} · ${refundLabels[order.refundStatus]}`
    : paymentLabel(order.paymentStatus);

  const renderList = () => {
    list.innerHTML = orders.map((order) => `
      <button class="catalog-company-button${order.id === selectedId ? " selected" : ""}" type="button"
              data-client-payment-order-id="${order.id}" aria-pressed="${order.id === selectedId}"
              ${busy() ? "disabled" : ""}>
        <span>Pedido #${order.id} • ${escapeHtml(order.company.name)}</span>
        <small>${escapeHtml(orderFinancialLabel(order))} • ${money(order.itemsTotalCents)}</small>
      </button>`).join("");
    reloadButton.disabled = busy();
  };

  const renderDetail = () => {
    if (!selectedOrder) return;
    title.textContent = `Pedido #${selectedOrder.id}`;
    company.textContent = selectedOrder.company.name;
    setStatus(status, orderFinancialLabel(selectedOrder),
      selectedOrder.paymentStatus === "pending" ? "" : "success");
    confirmedAt.textContent = selectedOrder.confirmedAt;
    paidAt.textContent = selectedOrder.paymentPaidAt || "Ainda não confirmado";
    recipient.textContent = selectedOrder.recipientSnapshot.type === "self"
      ? `Você (${selectedOrder.recipientSnapshot.name})`
      : `Outra pessoa: ${selectedOrder.recipientSnapshot.name}`;
    items.innerHTML = selectedOrder.items.map((item) => `
      <div class="cart-item">
        <div><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} unidade(s) • ${money(item.unitPriceCents)} cada</small></div>
        <strong>${money(item.unitPriceCents * item.quantity)}</strong>
      </div>`).join("");
    subtotal.textContent = money(selectedOrder.itemsTotalCents);
    freight.textContent = selectedOrder.freightTotalCents === null
      ? "Ainda não definido"
      : money(selectedOrder.freightTotalCents);
    payButton.hidden = selectedOrder.paymentStatus !== "pending";
    payButton.disabled = busy();
    payButton.textContent = submitter?.pending ? "Processando pagamento simulado." : "Confirmar pagamento simulado";
    detail.setAttribute("aria-busy", String(busy()));
    renderList();
  };

  async function loadOrders() {
    if (busy()) return;
    listLoading = true;
    list.setAttribute("aria-busy", "true");
    renderList();
    setStatus(listStatus, "Carregando pedidos confirmados.");
    try {
      ({ orders } = await api("/api/client/orders/confirmed"));
      if (selectedId && !orders.some(({ id }) => id === selectedId)) {
        selectedId = null;
        selectedOrder = null;
        submitter = null;
        detail.hidden = true;
      }
      setStatus(listStatus, orders.length
        ? `${orders.length} pedido(s) confirmado(s).`
        : "Você não possui pedidos confirmados para pagamento.");
    } catch (error) {
      orders = [];
      setStatus(listStatus, error.message, "error");
    } finally {
      listLoading = false;
      list.setAttribute("aria-busy", "false");
      renderList();
    }
  }

  async function loadOrder(orderId) {
    if (busy()) return;
    detailLoading = true;
    selectedId = orderId;
    selectedOrder = null;
    submitter = null;
    message.hidden = true;
    detail.hidden = false;
    title.textContent = `Carregando pedido #${orderId}.`;
    items.innerHTML = "";
    payButton.hidden = true;
    renderList();
    try {
      const result = await api(`/api/client/orders/confirmed/${orderId}`);
      selectedOrder = result.order;
      submitter = createPaymentSubmitter(orderId, api);
      renderDetail();
      title.focus();
    } catch (error) {
      selectedId = null;
      selectedOrder = null;
      submitter = null;
      detail.hidden = true;
      showMessage(message, error.message);
    } finally {
      detailLoading = false;
      detail.setAttribute("aria-busy", "false");
      if (selectedOrder) renderDetail();
      else renderList();
    }
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-client-payment-order-id]");
    if (button) loadOrder(Number(button.dataset.clientPaymentOrderId));
  });
  reloadButton.addEventListener("click", loadOrders);
  payButton.addEventListener("click", async () => {
    if (!selectedOrder || selectedOrder.paymentStatus !== "pending" || busy()) return;
    message.hidden = true;
    const operation = submitter.pay();
    renderDetail();
    try {
      const result = await operation;
      if (!result) return;
      const { order, confirmationCode } = result;
      selectedOrder = order;
      const summary = orders.find(({ id }) => id === order.id);
      if (summary) Object.assign(summary, {
        paymentStatus: order.paymentStatus,
        refundStatus: order.refundStatus,
        refundedTotalCents: order.refundedTotalCents,
        paymentPaidAt: order.paymentPaidAt,
      });
      renderDetail();
      showMessage(message, confirmationCode
        ? `Pagamento confirmado. Código da entrega: ${confirmationCode}. Guarde-o e repasse somente ao destinatário autorizado.`
        : `Pagamento simulado do pedido #${order.id} confirmado.`, "success");
      if (typeof CustomEvent !== "undefined") {
        document.dispatchEvent?.(new CustomEvent("ermes:delivery-changed"));
      }
    } catch (error) {
      const orderId = selectedId;
      if (error.status === 409 && orderId) await loadOrder(orderId);
      if (selectedOrder) renderDetail();
      showMessage(message, error.status === 409
        ? `A situação do pedido mudou. ${error.message}`
        : error.message);
    }
  });

  await loadOrders();
}
