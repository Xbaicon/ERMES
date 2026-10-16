export function createCart() {
  let company = null;
  const items = new Map();

  const lines = () => [...items.values()].map((item) => ({ ...item }));
  const totals = () => {
    let subtotal = 0n;
    let weightKg = 0;
    for (const item of items.values()) {
      subtotal += BigInt(item.priceCents) * BigInt(item.quantity);
      weightKg += item.unitWeightKg * item.quantity;
    }
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(weightKg)) {
      throw new Error("O carrinho excede os limites seguros. Reduza as quantidades.");
    }
    return { subtotalCents: Number(subtotal), weightKg };
  };
  const setQuantity = (productId, quantity) => {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("A quantidade deve ser um inteiro positivo.");
    const item = items.get(productId);
    if (!item) return;
    const previous = item.quantity;
    item.quantity = quantity;
    try { totals(); } catch (error) { item.quantity = previous; throw error; }
  };

  return {
    get company() { return company ? { ...company } : null; },
    lines,
    totals,
    add(selectedCompany, product) {
      if (company && company.id !== selectedCompany.id) {
        throw new Error("Esvazie o carrinho antes de trocar de empresa.");
      }
      if (!Number.isSafeInteger(product.id) || product.id <= 0
        || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0
        || !Number.isFinite(product.unitWeightKg) || product.unitWeightKg <= 0) {
        throw new Error("Os dados deste produto são inválidos. Recarregue o catálogo.");
      }
      const previous = items.get(product.id);
      if (previous) {
        setQuantity(product.id, previous.quantity + 1);
      } else {
        items.set(product.id, {
          productId: product.id, name: product.name, priceCents: product.priceCents,
          unitWeightKg: product.unitWeightKg, quantity: 1,
        });
        try { totals(); } catch (error) { items.delete(product.id); throw error; }
      }
      company = { id: selectedCompany.id, name: selectedCompany.name };
    },
    setQuantity,
    remove(productId) {
      items.delete(productId);
      if (!items.size) company = null;
    },
    clear() { items.clear(); company = null; },
  };
}

export function createCartSubmitter(cart, api) {
  let pending = false;
  return {
    get pending() { return pending; },
    async submit(orderOptions = {}) {
      if (pending) return null;
      const lines = cart.lines();
      if (!lines.length || cart.totals().weightKg > 12 + Number.EPSILON * 12) return null;
      pending = true;
      try {
        const { order } = await api("/api/client/orders", {
          method: "POST",
          body: JSON.stringify({
            companyId: cart.company.id,
            items: lines.map(({ productId, quantity }) => ({ productId, quantity })),
            ...orderOptions,
          }),
        });
        if (!order || !Number.isSafeInteger(order.id) || order.status !== "draft") {
          throw new Error("A resposta do pedido é inválida. Recarregue a página antes de tentar novamente.");
        }
        cart.clear();
        return order;
      } finally {
        pending = false;
      }
    },
  };
}

export async function setupClientCatalog({ api, money, escapeHtml, showMessage, user }) {
  const companiesList = document.querySelector("[data-client-companies-list]");
  const companiesStatus = document.querySelector("[data-client-companies-status]");
  const productsList = document.querySelector("[data-client-products-list]");
  const productsStatus = document.querySelector("[data-client-products-status]");
  const productsTitle = document.querySelector("[data-client-products-title]");
  const cartItems = document.querySelector("[data-client-cart-items]");
  const cartStatus = document.querySelector("[data-client-cart-status]");
  const cartCompany = document.querySelector("[data-client-cart-company]");
  const cartSubtotal = document.querySelector("[data-client-cart-subtotal]");
  const cartWeight = document.querySelector("[data-client-cart-weight]");
  const cartMessage = document.querySelector("[data-client-cart-message]");
  const clearButton = document.querySelector("[data-client-cart-clear]");
  const submitButton = document.querySelector("[data-client-cart-submit]");
  const destinationTypes = [...document.querySelectorAll("[data-client-destination-type]")];
  const manualAddress = document.querySelector("[data-client-manual-address]");
  const addressFields = [...document.querySelectorAll("[data-order-address-field]")];
  const recipientTypes = [...document.querySelectorAll("[data-client-recipient-type]")];
  const otherRecipient = document.querySelector("[data-client-other-recipient]");
  const recipientName = document.querySelector("[data-client-recipient-name]");
  const destinationSummary = document.querySelector("[data-client-order-destination-summary]");
  const recipientSummary = document.querySelector("[data-client-order-recipient-summary]");
  const cart = createCart();
  const submitter = createCartSubmitter(cart, api);
  let defaultAddress = null;
  let defaultAddressLoading = true;
  let defaultAddressRevision = 0;
  let companies = [];
  let selectedCompanyId = null;
  let currentProducts = [];
  let productsLoading = false;

  const formatAddress = (value) => [
    `${value.street}, ${value.number}`,
    value.complement,
    value.neighborhood,
    `${value.city} - ${value.state}`,
    `CEP ${value.postalCode}`,
  ].filter(Boolean).join(" • ");
  const selectedValue = (inputs) => inputs.find(({ checked }) => checked)?.value;
  const manualAddressValue = () => Object.fromEntries(addressFields.map((input) => [
    input.dataset.orderAddressField, input.value,
  ]));
  const orderOptions = () => {
    const destinationType = selectedValue(destinationTypes);
    const recipientType = selectedValue(recipientTypes);
    return {
      destination: destinationType === "manual"
        ? { type: "manual", address: manualAddressValue() }
        : { type: "default" },
      recipient: recipientType === "other"
        ? { type: "other", name: recipientName.value }
        : { type: "self" },
    };
  };
  const destinationIsValid = (options) => {
    if (options.destination.type === "default" && !defaultAddress) return false;
    if (options.destination.type === "manual") {
      const required = ["postalCode", "state", "city", "neighborhood", "street", "number"];
      if (required.some((field) => !String(options.destination.address[field] || "").trim())) return false;
      if (!/^\d{8}$/.test(String(options.destination.address.postalCode).replace(/\D/g, ""))) return false;
      if (!/^[A-Za-z]{2}$/.test(String(options.destination.address.state).trim())) return false;
    }
    return true;
  };
  const recipientIsValid = (options) => options.recipient.type !== "other"
    || Boolean(options.recipient.name.trim());
  const optionsAreValid = () => {
    const options = orderOptions();
    return destinationIsValid(options) && recipientIsValid(options);
  };
  const renderOrderOptions = () => {
    const options = orderOptions();
    const usesManualAddress = options.destination.type === "manual";
    const usesOtherRecipient = options.recipient.type === "other";
    manualAddress.hidden = !usesManualAddress;
    otherRecipient.hidden = !usesOtherRecipient;
    for (const input of addressFields) {
      input.required = usesManualAddress && input.dataset.orderAddressField !== "complement";
      input.disabled = submitter.pending;
    }
    recipientName.required = usesOtherRecipient;
    recipientName.disabled = submitter.pending;
    destinationTypes.forEach((input) => { input.disabled = submitter.pending; });
    recipientTypes.forEach((input) => { input.disabled = submitter.pending; });
    if (usesManualAddress) {
      const value = options.destination.address;
      destinationSummary.textContent = destinationIsValid(options)
        ? formatAddress({ ...value, postalCode: value.postalCode.replace(/\D/g, ""), state: value.state.trim().toUpperCase() })
        : "Preencha o endereço alternativo completo.";
    } else if (defaultAddressLoading) {
      destinationSummary.textContent = "Carregando endereço padrão.";
    } else {
      destinationSummary.textContent = defaultAddress
        ? formatAddress(defaultAddress)
        : "Cadastre um endereço padrão ou informe outro endereço.";
    }
    recipientSummary.textContent = usesOtherRecipient
      ? (options.recipient.name.trim() || "Informe o nome da outra pessoa.")
      : (user?.fullName || "Você");
  };

  const setStatus = (element, message, type = "") => {
    element.textContent = message;
    element.className = `catalog-status${type ? ` ${type}` : ""}`;
  };
  const escapeAttribute = (value) => escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const updateControls = () => {
    companiesList.querySelectorAll("button").forEach((button) => {
      button.disabled = productsLoading || submitter.pending;
    });
    productsList.querySelectorAll("button").forEach((button) => { button.disabled = submitter.pending; });
  };
  const renderCompanies = () => {
    companiesList.innerHTML = companies.map((company) => `
      <button class="catalog-company-button${company.id === selectedCompanyId ? " selected" : ""}"
              type="button" data-client-company-id="${company.id}"
              aria-pressed="${company.id === selectedCompanyId}">${escapeHtml(company.name)}</button>`).join("");
    updateControls();
  };
  const renderProducts = (products) => {
    productsList.innerHTML = products.map((product) => `
      <article class="catalog-product">
        <h4>${escapeHtml(product.name)}</h4>
        ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ""}
        <p class="catalog-product-meta"><span>${money(product.priceCents)}</span><span>${Number(product.unitWeightKg).toLocaleString("pt-BR")} kg</span></p>
        <button class="button button-outline button-small" type="button" data-add-product="${product.id}"
                aria-label="Adicionar ${escapeAttribute(product.name)} ao carrinho">Adicionar ao carrinho</button>
      </article>`).join("");
    updateControls();
  };
  const renderCart = () => {
    const lines = cart.lines();
    const { subtotalCents, weightKg } = cart.totals();
    const exceedsWeightLimit = weightKg > 12 + Number.EPSILON * 12;
    cartCompany.textContent = cart.company ? `Empresa: ${cart.company.name}` : "Nenhuma empresa selecionada para o carrinho.";
    cartItems.innerHTML = lines.map((item) => `
      <div class="cart-item">
        <div><strong>${escapeHtml(item.name)}</strong><small>${money(item.priceCents)} · ${Number(item.unitWeightKg).toLocaleString("pt-BR")} kg por unidade</small></div>
        <div class="cart-item-actions">
          <button class="button button-outline button-small" type="button" data-cart-action="decrease" data-product-id="${item.productId}"
                  aria-label="Diminuir quantidade de ${escapeAttribute(item.name)}" ${item.quantity === 1 || submitter.pending ? "disabled" : ""}>−</button>
          <span aria-label="Quantidade de ${escapeAttribute(item.name)}: ${item.quantity}">${item.quantity}</span>
          <button class="button button-outline button-small" type="button" data-cart-action="increase" data-product-id="${item.productId}"
                  aria-label="Aumentar quantidade de ${escapeAttribute(item.name)}" ${submitter.pending ? "disabled" : ""}>+</button>
          <button class="button button-outline button-small" type="button" data-cart-action="remove" data-product-id="${item.productId}"
                  aria-label="Remover ${escapeAttribute(item.name)}" ${submitter.pending ? "disabled" : ""}>Remover</button>
        </div>
      </div>`).join("");
    cartSubtotal.textContent = money(subtotalCents);
    cartWeight.textContent = `${weightKg.toLocaleString("pt-BR", { maximumFractionDigits: 6 })} kg`;
    setStatus(cartStatus, !lines.length ? "Carrinho vazio."
      : exceedsWeightLimit ? "Peso acima de 12 kg. Reduza quantidades ou remova itens." : `${lines.length} produto(s) no carrinho.`, exceedsWeightLimit ? "error" : "");
    submitButton.disabled = submitter.pending || !lines.length || exceedsWeightLimit;
    if (!optionsAreValid()) submitButton.disabled = true;
    submitButton.textContent = submitter.pending ? "Criando pedido…" : "Criar pedido draft";
    clearButton.disabled = submitter.pending || !lines.length;
    cartItems.setAttribute("aria-busy", String(submitter.pending));
    renderOrderOptions();
    updateControls();
  };

  companiesList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-client-company-id]");
    if (!button || productsLoading || submitter.pending) return;
    const company = companies.find(({ id }) => id === Number(button.dataset.clientCompanyId));
    if (company) loadCompanyProducts(company);
  });
  productsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-product]");
    if (!button || productsLoading || submitter.pending) return;
    const company = companies.find(({ id }) => id === selectedCompanyId);
    const product = currentProducts.find(({ id }) => id === Number(button.dataset.addProduct));
    if (!company || !product) return;
    cartMessage.hidden = true;
    try { cart.add(company, product); renderCart(); }
    catch (error) { showMessage(cartMessage, error.message); }
  });
  cartItems.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cart-action]");
    if (!button || submitter.pending) return;
    const productId = Number(button.dataset.productId);
    const line = cart.lines().find(({ productId: id }) => id === productId);
    if (!line) return;
    cartMessage.hidden = true;
    try {
      if (button.dataset.cartAction === "remove") cart.remove(productId);
      if (button.dataset.cartAction === "increase") cart.setQuantity(productId, line.quantity + 1);
      if (button.dataset.cartAction === "decrease") cart.setQuantity(productId, line.quantity - 1);
      renderCart();
    } catch (error) { showMessage(cartMessage, error.message); }
  });
  clearButton.addEventListener("click", () => {
    if (submitter.pending) return;
    cart.clear();
    cartMessage.hidden = true;
    renderCart();
  });
  for (const input of [...destinationTypes, ...recipientTypes]) {
    input.addEventListener("change", renderCart);
  }
  for (const input of [...addressFields, recipientName]) {
    input.addEventListener("input", renderCart);
  }
  document.addEventListener("ermes:default-address-changed", (event) => {
    defaultAddressRevision += 1;
    defaultAddress = event.detail?.defaultAddress || null;
    defaultAddressLoading = false;
    renderCart();
  });
  submitButton.addEventListener("click", async () => {
    if (submitter.pending || !cart.lines().length || cart.totals().weightKg > 12 + Number.EPSILON * 12) return;
    if (!optionsAreValid()) {
      const options = orderOptions();
      showMessage(cartMessage, options.destination.type === "default" && !defaultAddress
        ? "Cadastre um endereço padrão ou escolha informar outro endereço."
        : "Revise o destino e o destinatário antes de criar o pedido.");
      return;
    }
    cartMessage.hidden = true;
    const operation = submitter.submit(orderOptions());
    renderCart();
    try {
      const order = await operation;
      showMessage(cartMessage, `Pedido draft #${order.id} criado. Subtotal: ${money(order.itemsTotalCents)}; peso: ${order.weightKg.toLocaleString("pt-BR")} kg.`, "success");
    } catch (error) {
      showMessage(cartMessage, error.message);
    } finally {
      renderCart();
    }
  });

  async function loadCompanyProducts(company) {
    if (productsLoading || submitter.pending || company.id === selectedCompanyId) return;
    selectedCompanyId = company.id;
    currentProducts = [];
    productsLoading = true;
    renderCompanies();
    productsList.innerHTML = "";
    productsTitle.textContent = `Produtos de ${company.name}`;
    setStatus(productsStatus, "Carregando produtos…");
    try {
      const result = await api(`/api/client/companies/${company.id}/products`);
      currentProducts = result.products;
      renderProducts(currentProducts);
      setStatus(productsStatus, currentProducts.length
        ? `${currentProducts.length} produto(s) disponível(is).`
        : "Esta empresa não possui produtos disponíveis no momento.");
    } catch (error) {
      selectedCompanyId = null;
      renderCompanies();
      productsTitle.textContent = "Não foi possível carregar os produtos";
      setStatus(productsStatus, error.message, "error");
    } finally {
      productsLoading = false;
      updateControls();
    }
  }

  renderCart();
  const addressLoadRevision = defaultAddressRevision;
  try {
    const result = await api("/api/client/default-address");
    if (defaultAddressRevision === addressLoadRevision) defaultAddress = result.defaultAddress;
  } catch (error) {
    showMessage(cartMessage, `Não foi possível carregar o endereço padrão. ${error.message}`);
  } finally {
    defaultAddressLoading = false;
    renderCart();
  }
  companiesList.setAttribute("aria-busy", "true");
  try {
    ({ companies } = await api("/api/client/companies"));
    renderCompanies();
    if (companies.length) {
      setStatus(companiesStatus, `${companies.length} empresa(s) disponível(is).`);
    } else {
      setStatus(companiesStatus, "Nenhuma empresa está disponível no momento.");
      productsTitle.textContent = "Nenhuma empresa disponível";
      setStatus(productsStatus, "Não há catálogo para consultar no momento.");
    }
  } catch (error) {
    companies = [];
    companiesList.innerHTML = "";
    setStatus(companiesStatus, `Não foi possível carregar as empresas. ${error.message}`, "error");
    productsTitle.textContent = "Catálogo indisponível";
    setStatus(productsStatus, "Recarregue a página para tentar novamente.", "error");
  } finally {
    companiesList.setAttribute("aria-busy", "false");
  }
}
