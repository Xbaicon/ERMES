export async function setupCompanyDrafts({ api, money, escapeHtml, showMessage }) {
  const list = document.querySelector("[data-company-drafts-list]");
  const listStatus = document.querySelector("[data-company-drafts-status]");
  const reloadButton = document.querySelector("[data-company-drafts-reload]");
  const detail = document.querySelector("[data-company-draft-detail]");
  const title = document.querySelector("[data-company-draft-title]");
  const address = document.querySelector("[data-company-draft-address]");
  const recipient = document.querySelector("[data-company-draft-recipient]");
  const items = document.querySelector("[data-company-draft-items]");
  const subtotal = document.querySelector("[data-company-draft-subtotal]");
  const weight = document.querySelector("[data-company-draft-weight]");
  const message = document.querySelector("[data-company-draft-message]");
  const confirmButton = document.querySelector("[data-company-draft-confirm]");
  let drafts = [];
  let selectedId = null;
  let selectedOrder = null;
  let listLoading = false;
  let detailLoading = false;
  let confirmationLoading = false;
  let selectionVersion = 0;

  const busy = () => listLoading || detailLoading || confirmationLoading;
  const setStatus = (element, value, type = "") => {
    element.textContent = value;
    element.className = `catalog-status${type ? ` ${type}` : ""}`;
  };
  const formatAddress = (value) => [
    `${value.street}, ${value.number}`,
    value.complement,
    value.neighborhood,
    `${value.city} - ${value.state}`,
    `CEP ${value.postalCode}`,
  ].filter(Boolean).join(" · ");

  function renderConfirmation() {
    confirmButton.hidden = !selectedOrder || selectedOrder.status !== "draft";
    confirmButton.disabled = busy() || confirmButton.hidden;
    confirmButton.textContent = confirmationLoading ? "Confirmando pedido..." : "Confirmar pedido";
  }

  function renderList() {
    list.innerHTML = drafts.map((draft) => `
      <button class="catalog-company-button${draft.id === selectedId ? " selected" : ""}" type="button"
              data-company-draft-id="${draft.id}" aria-pressed="${draft.id === selectedId}"
              ${busy() ? "disabled" : ""}>
        <span>Pedido #${draft.id}</span>
        <small>${draft.itemCount} item(ns) · ${money(draft.itemsTotalCents)} · ${draft.weightKg.toLocaleString("pt-BR")} kg</small>
      </button>`).join("");
    reloadButton.disabled = busy();
    renderConfirmation();
  }

  function renderDetail(order) {
    selectedOrder = order;
    title.textContent = `Pedido #${order.id}`;
    address.textContent = formatAddress(order.destinationSnapshot);
    recipient.textContent = order.recipientSnapshot.type === "self"
      ? `Próprio cliente: ${order.recipientSnapshot.name}`
      : `Outra pessoa: ${order.recipientSnapshot.name}`;
    items.innerHTML = order.items.map((item) => `
      <div class="cart-item">
        <div><strong>${escapeHtml(item.name)}</strong><small>Quantidade: ${item.quantity} · ${money(item.unitPriceCents)} · ${item.unitWeightKg.toLocaleString("pt-BR")} kg por unidade</small></div>
      </div>`).join("");
    subtotal.textContent = money(order.itemsTotalCents);
    weight.textContent = `${order.weightKg.toLocaleString("pt-BR", { maximumFractionDigits: 6 })} kg`;
    renderConfirmation();
  }

  async function loadDrafts() {
    if (busy()) return;
    listLoading = true;
    list.setAttribute("aria-busy", "true");
    setStatus(listStatus, "Carregando pedidos em rascunho.");
    renderList();
    try {
      const result = await api("/api/company/orders/drafts");
      drafts = result.drafts;
      if (selectedId && !drafts.some((draft) => draft.id === selectedId)) {
        selectedId = null;
        selectedOrder = null;
        detail.hidden = true;
      }
      setStatus(listStatus, drafts.length
        ? `${drafts.length} pedido(s) em rascunho para análise.`
        : "Não há pedidos em rascunho para análise.");
    } catch (error) {
      drafts = [];
      selectedId = null;
      selectedOrder = null;
      detail.hidden = true;
      setStatus(listStatus, error.message, "error");
    } finally {
      listLoading = false;
      list.setAttribute("aria-busy", "false");
      renderList();
    }
  }

  async function loadDraft(orderId) {
    if (busy()) return;
    const version = ++selectionVersion;
    selectedId = orderId;
    selectedOrder = null;
    detailLoading = true;
    detail.hidden = false;
    detail.setAttribute("aria-busy", "true");
    message.hidden = true;
    title.textContent = `Carregando pedido #${orderId}.`;
    address.textContent = "";
    items.innerHTML = "";
    renderList();
    try {
      const result = await api(`/api/company/orders/${orderId}`);
      if (version !== selectionVersion) return;
      renderDetail(result.order);
      title.focus();
    } catch (error) {
      if (version !== selectionVersion) return;
      selectedId = null;
      selectedOrder = null;
      detail.hidden = true;
      showMessage(message, error.message);
    } finally {
      if (version === selectionVersion) {
        detailLoading = false;
        detail.setAttribute("aria-busy", "false");
        renderList();
      }
    }
  }

  async function confirmDraft() {
    if (busy() || !selectedOrder || selectedOrder.status !== "draft") return;
    const { id, version } = selectedOrder;
    confirmationLoading = true;
    detail.setAttribute("aria-busy", "true");
    message.hidden = true;
    renderList();
    let refreshMessage = null;
    try {
      const { order } = await api(`/api/company/orders/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      drafts = drafts.filter((draft) => draft.id !== id);
      selectedId = null;
      selectedOrder = null;
      detail.hidden = true;
      setStatus(listStatus, drafts.length
        ? `${drafts.length} pedido(s) em rascunho para an\u00e1lise.`
        : "N\u00e3o h\u00e1 pedidos em rascunho para an\u00e1lise.");
      showMessage(message, `Pedido #${order.id} confirmado comercialmente.`, "success");
    } catch (error) {
      if (error.status === 409) refreshMessage = error.message;
      showMessage(message, error.message);
    } finally {
      confirmationLoading = false;
      detail.setAttribute("aria-busy", "false");
      renderList();
    }
    if (refreshMessage) {
      await loadDrafts();
      if (drafts.some((draft) => draft.id === id)) await loadDraft(id);
      showMessage(message, refreshMessage);
    }
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-company-draft-id]");
    if (button) loadDraft(Number(button.dataset.companyDraftId));
  });
  reloadButton.addEventListener("click", loadDrafts);
  confirmButton.addEventListener("click", confirmDraft);

  await loadDrafts();
}
