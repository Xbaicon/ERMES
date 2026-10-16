const WEIGHT_LIMIT_KG = 12;

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateLine(item) {
  if (!validPositiveInteger(item.productId)
    || !validPositiveInteger(item.quantity)
    || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0
    || !Number.isFinite(item.unitWeightKg) || item.unitWeightKg <= 0) {
    throw new Error("O pedido retornado pelo servidor contém um item inválido.");
  }
}

export function createDraftEditor(initialOrder) {
  let order;
  let items = new Map();
  let persistedItems = new Map();

  const lines = () => [...items.values()].map((item) => ({ ...item }));
  const totalsFor = (collection) => {
    let subtotal = 0n;
    let weightKg = 0;
    for (const item of collection.values()) {
      subtotal += BigInt(item.unitPriceCents) * BigInt(item.quantity);
      weightKg += item.unitWeightKg * item.quantity;
    }
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(weightKg)) {
      throw new Error("A edição excede os limites seguros. Reduza as quantidades.");
    }
    return { itemsTotalCents: Number(subtotal), weightKg };
  };
  const totals = () => totalsFor(items);
  const replace = (nextOrder) => {
    if (!nextOrder || !validPositiveInteger(nextOrder.id) || nextOrder.status !== "draft"
      || !nextOrder.company || !validPositiveInteger(nextOrder.company.id)
      || !Array.isArray(nextOrder.items) || !nextOrder.items.length
      || !nextOrder.destinationSnapshot || typeof nextOrder.destinationSnapshot !== "object"
      || Array.isArray(nextOrder.destinationSnapshot)
      || !nextOrder.recipientSnapshot || !["self", "other"].includes(nextOrder.recipientSnapshot.type)
      || typeof nextOrder.recipientSnapshot.name !== "string" || !nextOrder.recipientSnapshot.name.trim()) {
      throw new Error("A resposta do pedido é inválida. Recarregue a página.");
    }
    const nextItems = new Map();
    for (const item of nextOrder.items) {
      validateLine(item);
      if (nextItems.has(item.productId)) throw new Error("A resposta do pedido contém produto repetido.");
      nextItems.set(item.productId, { ...item });
    }
    totalsFor(nextItems);
    order = { ...nextOrder, company: { ...nextOrder.company },
      destinationSnapshot: { ...nextOrder.destinationSnapshot },
      recipientSnapshot: { ...nextOrder.recipientSnapshot } };
    items = nextItems;
    persistedItems = new Map([...nextItems].map(([productId, item]) => [productId, { ...item }]));
  };
  const setQuantity = (productId, quantity) => {
    if (!validPositiveInteger(quantity)) throw new Error("A quantidade deve ser um inteiro positivo.");
    const item = items.get(productId);
    if (!item) return;
    const previous = item.quantity;
    item.quantity = quantity;
    try { totals(); } catch (error) { item.quantity = previous; throw error; }
  };

  replace(initialOrder);
  return {
    get id() { return order.id; },
    get company() { return { ...order.company }; },
    get destinationSnapshot() { return { ...order.destinationSnapshot }; },
    get recipientSnapshot() { return { ...order.recipientSnapshot }; },
    lines,
    totals,
    setQuantity,
    add(product) {
      if (!validPositiveInteger(product.id)
        || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0
        || !Number.isFinite(product.unitWeightKg) || product.unitWeightKg <= 0) {
        throw new Error("Os dados deste produto são inválidos. Recarregue os produtos.");
      }
      const existing = items.get(product.id);
      if (existing) return setQuantity(product.id, existing.quantity + 1);
      const persisted = persistedItems.get(product.id);
      items.set(product.id, persisted ? { ...persisted, quantity: 1 } : {
        productId: product.id, name: product.name, quantity: 1,
        unitPriceCents: product.priceCents, unitWeightKg: product.unitWeightKg,
      });
      try { totals(); } catch (error) { items.delete(product.id); throw error; }
    },
    remove(productId) { items.delete(productId); },
    payload() {
      return { items: lines().map(({ productId, quantity }) => ({ productId, quantity })) };
    },
    replace,
  };
}

export function createDraftSaver(editor, api) {
  let pending = false;
  return {
    get pending() { return pending; },
    async save() {
      if (pending || !editor.lines().length) return null;
      pending = true;
      try {
        const { order } = await api(`/api/client/orders/${editor.id}/items`, {
          method: "PUT",
          body: JSON.stringify(editor.payload()),
        });
        editor.replace(order);
        return order;
      } finally {
        pending = false;
      }
    },
  };
}

export async function setupClientDrafts({ api, money, escapeHtml, showMessage }) {
  const list = document.querySelector("[data-client-drafts-list]");
  const listStatus = document.querySelector("[data-client-drafts-status]");
  const reloadButton = document.querySelector("[data-client-drafts-reload]");
  const detail = document.querySelector("[data-client-draft-detail]");
  const title = document.querySelector("[data-client-draft-title]");
  const company = document.querySelector("[data-client-draft-company]");
  const address = document.querySelector("[data-client-draft-address]");
  const recipient = document.querySelector("[data-client-draft-recipient]");
  const itemsContainer = document.querySelector("[data-client-draft-items]");
  const subtotal = document.querySelector("[data-client-draft-subtotal]");
  const weight = document.querySelector("[data-client-draft-weight]");
  const editorStatus = document.querySelector("[data-client-draft-editor-status]");
  const message = document.querySelector("[data-client-draft-message]");
  const products = document.querySelector("[data-client-draft-products]");
  const productsStatus = document.querySelector("[data-client-draft-products-status]");
  const saveButton = document.querySelector("[data-client-draft-save]");
  let drafts = [];
  let editor = null;
  let saver = null;
  let availableProducts = [];
  let listLoading = false;
  let detailLoading = false;

  const setStatus = (element, value, type = "") => {
    element.textContent = value;
    element.className = `catalog-status${type ? ` ${type}` : ""}`;
  };
  const escapeAttribute = (value) => escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const formatAddress = (value) => [
    `${value.street}, ${value.number}`,
    value.complement,
    value.neighborhood,
    `${value.city} - ${value.state}`,
    `CEP ${value.postalCode}`,
  ].filter(Boolean).join(" · ");
  const selectedId = () => editor?.id || null;
  const busy = () => listLoading || detailLoading || saver?.pending;

  const renderList = () => {
    list.innerHTML = drafts.map((draft) => `
      <button class="catalog-company-button${draft.id === selectedId() ? " selected" : ""}" type="button"
              data-client-draft-id="${draft.id}" aria-pressed="${draft.id === selectedId()}"
              ${busy() ? "disabled" : ""}>
        <span>Pedido #${draft.id} · ${escapeHtml(draft.company.name)}</span>
        <small>${draft.itemCount} item(ns) · ${money(draft.itemsTotalCents)} · ${draft.weightKg.toLocaleString("pt-BR")} kg</small>
      </button>`).join("");
    reloadButton.disabled = busy();
  };
  const updateDraftSummary = (order) => {
    const current = drafts.find(({ id }) => id === order.id);
    if (!current) return;
    Object.assign(current, {
      itemCount: order.items.length,
      itemsTotalCents: order.itemsTotalCents,
      weightKg: order.weightKg,
    });
  };
  const renderEditor = () => {
    if (!editor) return;
    const lines = editor.lines();
    const totals = editor.totals();
    const exceedsLimit = totals.weightKg > WEIGHT_LIMIT_KG + Number.EPSILON * WEIGHT_LIMIT_KG;
    title.textContent = `Pedido #${editor.id}`;
    company.textContent = editor.company.name;
    address.textContent = formatAddress(editor.destinationSnapshot);
    recipient.textContent = editor.recipientSnapshot.type === "self"
      ? `Você (${editor.recipientSnapshot.name})`
      : `Outra pessoa: ${editor.recipientSnapshot.name}`;
    itemsContainer.innerHTML = lines.map((item) => `
      <div class="cart-item">
        <div><strong>${escapeHtml(item.name)}</strong><small>${money(item.unitPriceCents)} · ${item.unitWeightKg.toLocaleString("pt-BR")} kg por unidade</small></div>
        <div class="cart-item-actions">
          <button class="button button-outline button-small" type="button" data-draft-action="decrease" data-product-id="${item.productId}"
                  aria-label="Diminuir quantidade de ${escapeAttribute(item.name)}" ${item.quantity === 1 || saver.pending ? "disabled" : ""}>−</button>
          <span aria-label="Quantidade de ${escapeAttribute(item.name)}: ${item.quantity}">${item.quantity}</span>
          <button class="button button-outline button-small" type="button" data-draft-action="increase" data-product-id="${item.productId}"
                  aria-label="Aumentar quantidade de ${escapeAttribute(item.name)}" ${saver.pending ? "disabled" : ""}>+</button>
          <button class="button button-outline button-small" type="button" data-draft-action="remove" data-product-id="${item.productId}"
                  aria-label="Remover ${escapeAttribute(item.name)}" ${saver.pending ? "disabled" : ""}>Remover</button>
        </div>
      </div>`).join("");
    subtotal.textContent = money(totals.itemsTotalCents);
    weight.textContent = `${totals.weightKg.toLocaleString("pt-BR", { maximumFractionDigits: 6 })} kg`;
    setStatus(editorStatus, !lines.length ? "O pedido precisa manter ao menos um item."
      : exceedsLimit ? "Peso acima de 12 kg. Reduza quantidades ou remova itens."
        : `${lines.length} produto(s) na edição.`, !lines.length || exceedsLimit ? "error" : "");
    products.innerHTML = availableProducts.map((product) => `
      <article class="catalog-product">
        <h4>${escapeHtml(product.name)}</h4>
        <p class="catalog-product-meta"><span>${money(product.priceCents)}</span><span>${product.unitWeightKg.toLocaleString("pt-BR")} kg</span></p>
        <button class="button button-outline button-small" type="button" data-draft-add-product="${product.id}"
                aria-label="Adicionar ${escapeAttribute(product.name)} ao pedido" ${saver.pending ? "disabled" : ""}>Adicionar ao pedido</button>
      </article>`).join("");
    saveButton.disabled = saver.pending || !lines.length || exceedsLimit;
    saveButton.textContent = saver.pending ? "Salvando…" : "Salvar alterações";
    itemsContainer.setAttribute("aria-busy", String(saver.pending));
    renderList();
  };

  async function loadDrafts() {
    if (listLoading || detailLoading || saver?.pending) return;
    listLoading = true;
    list.setAttribute("aria-busy", "true");
    renderList();
    setStatus(listStatus, "Carregando pedidos em rascunho…");
    try {
      ({ drafts } = await api("/api/client/orders/drafts"));
      renderList();
      setStatus(listStatus, drafts.length
        ? `${drafts.length} pedido(s) em rascunho.`
        : "Você não possui pedidos em rascunho.");
    } catch (error) {
      drafts = [];
      list.innerHTML = "";
      setStatus(listStatus, error.message, "error");
    } finally {
      listLoading = false;
      list.setAttribute("aria-busy", "false");
      renderList();
    }
  }

  async function loadDraft(orderId) {
    if (busy()) return;
    detailLoading = true;
    message.hidden = true;
    detail.hidden = false;
    detail.setAttribute("aria-busy", "true");
    saveButton.disabled = true;
    title.textContent = `Carregando pedido #${orderId}…`;
    itemsContainer.innerHTML = "";
    products.innerHTML = "";
    renderList();
    try {
      const result = await api(`/api/client/orders/${orderId}`);
      editor = createDraftEditor(result.order);
      saver = createDraftSaver(editor, api);
      try {
        const catalog = await api(`/api/client/companies/${editor.company.id}/products`);
        availableProducts = catalog.products;
        setStatus(productsStatus, availableProducts.length
          ? `${availableProducts.length} produto(s) disponível(is) para esta empresa.`
          : "Esta empresa não possui produtos disponíveis para adicionar.");
      } catch (error) {
        availableProducts = [];
        setStatus(productsStatus, `Não foi possível carregar produtos para adicionar. ${error.message}`, "error");
      }
      renderEditor();
      title.focus();
    } catch (error) {
      editor = null;
      saver = null;
      availableProducts = [];
      title.textContent = "Não foi possível carregar o pedido";
      showMessage(message, error.message);
    } finally {
      detailLoading = false;
      detail.setAttribute("aria-busy", "false");
      renderList();
    }
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-client-draft-id]");
    if (button) loadDraft(Number(button.dataset.clientDraftId));
  });
  reloadButton.addEventListener("click", loadDrafts);
  itemsContainer.addEventListener("click", (event) => {
    const button = event.target.closest("[data-draft-action]");
    if (!button || !editor || detailLoading || saver.pending) return;
    const productId = Number(button.dataset.productId);
    const line = editor.lines().find((item) => item.productId === productId);
    if (!line) return;
    message.hidden = true;
    try {
      if (button.dataset.draftAction === "remove") editor.remove(productId);
      if (button.dataset.draftAction === "increase") editor.setQuantity(productId, line.quantity + 1);
      if (button.dataset.draftAction === "decrease") editor.setQuantity(productId, line.quantity - 1);
      renderEditor();
    } catch (error) { showMessage(message, error.message); }
  });
  products.addEventListener("click", (event) => {
    const button = event.target.closest("[data-draft-add-product]");
    if (!button || !editor || detailLoading || saver.pending) return;
    const product = availableProducts.find(({ id }) => id === Number(button.dataset.draftAddProduct));
    if (!product) return;
    message.hidden = true;
    try { editor.add(product); renderEditor(); }
    catch (error) { showMessage(message, error.message); }
  });
  saveButton.addEventListener("click", async () => {
    if (!editor || detailLoading || saver.pending || !editor.lines().length
      || editor.totals().weightKg > WEIGHT_LIMIT_KG + Number.EPSILON * WEIGHT_LIMIT_KG) return;
    message.hidden = true;
    const operation = saver.save();
    renderEditor();
    try {
      const order = await operation;
      updateDraftSummary(order);
      renderEditor();
      showMessage(message, `Pedido #${order.id} atualizado com sucesso.`, "success");
    } catch (error) {
      if (error.status === 409 && /n\u00e3o est\u00e1 mais em estado draft/i.test(error.message)) {
        const orderId = editor.id;
        drafts = drafts.filter((draft) => draft.id !== orderId);
        editor = null;
        saver = null;
        availableProducts = [];
        title.textContent = `Pedido #${orderId} confirmado pela empresa`;
        itemsContainer.innerHTML = "";
        products.innerHTML = "";
        setStatus(editorStatus, "Este pedido n\u00e3o est\u00e1 mais dispon\u00edvel para edi\u00e7\u00e3o.", "error");
        setStatus(productsStatus, "A edi\u00e7\u00e3o foi encerrada pela confirma\u00e7\u00e3o comercial.");
        saveButton.disabled = true;
        saveButton.textContent = "Edi\u00e7\u00e3o indispon\u00edvel";
        renderList();
        showMessage(message, "A empresa confirmou este pedido. Os itens n\u00e3o podem mais ser alterados.");
      } else {
        renderEditor();
        showMessage(message, error.message);
      }
    }
  });

  await loadDrafts();
}
