export async function setupCompanyDrafts({ api, money, escapeHtml, showMessage }) {
  const list = document.querySelector("[data-company-drafts-list]");
  const listStatus = document.querySelector("[data-company-drafts-status]");
  const reloadButton = document.querySelector("[data-company-drafts-reload]");
  const detail = document.querySelector("[data-company-draft-detail]");
  const title = document.querySelector("[data-company-draft-title]");
  const address = document.querySelector("[data-company-draft-address]");
  const items = document.querySelector("[data-company-draft-items]");
  const subtotal = document.querySelector("[data-company-draft-subtotal]");
  const weight = document.querySelector("[data-company-draft-weight]");
  const message = document.querySelector("[data-company-draft-message]");
  let drafts = [];
  let selectedId = null;
  let listLoading = false;
  let detailLoading = false;
  let selectionVersion = 0;

  const busy = () => listLoading || detailLoading;
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

  function renderList() {
    list.innerHTML = drafts.map((draft) => `
      <button class="catalog-company-button${draft.id === selectedId ? " selected" : ""}" type="button"
              data-company-draft-id="${draft.id}" aria-pressed="${draft.id === selectedId}"
              ${busy() ? "disabled" : ""}>
        <span>Pedido #${draft.id}</span>
        <small>${draft.itemCount} item(ns) · ${money(draft.itemsTotalCents)} · ${draft.weightKg.toLocaleString("pt-BR")} kg</small>
      </button>`).join("");
    reloadButton.disabled = busy();
  }

  function renderDetail(order) {
    title.textContent = `Pedido #${order.id}`;
    address.textContent = formatAddress(order.destinationSnapshot);
    items.innerHTML = order.items.map((item) => `
      <div class="cart-item">
        <div><strong>${escapeHtml(item.name)}</strong><small>Quantidade: ${item.quantity} · ${money(item.unitPriceCents)} · ${item.unitWeightKg.toLocaleString("pt-BR")} kg por unidade</small></div>
      </div>`).join("");
    subtotal.textContent = money(order.itemsTotalCents);
    weight.textContent = `${order.weightKg.toLocaleString("pt-BR", { maximumFractionDigits: 6 })} kg`;
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
        detail.hidden = true;
      }
      setStatus(listStatus, drafts.length
        ? `${drafts.length} pedido(s) em rascunho para análise.`
        : "Não há pedidos em rascunho para análise.");
    } catch (error) {
      drafts = [];
      selectedId = null;
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

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-company-draft-id]");
    if (button) loadDraft(Number(button.dataset.companyDraftId));
  });
  reloadButton.addEventListener("click", loadDrafts);

  await loadDrafts();
}
