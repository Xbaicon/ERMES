(function () {
  "use strict";

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Operação não concluída.");
    return data;
  }

  function money(cents) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents) / 100);
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = String(value || "");
    return element.innerHTML;
  }

  function showMessage(element, message, type = "error") {
    element.textContent = message;
    element.className = `form-message ${type}`;
    element.hidden = false;
  }

  function masks() {
    const digits = (value) => String(value || "").replace(/\D/g, "");
    document.querySelectorAll("[data-mask]").forEach((input) => input.addEventListener("input", () => {
      const raw = digits(input.value);
      if (input.dataset.mask === "cpf") input.value = raw.slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
      if (input.dataset.mask === "phone") input.value = raw.slice(0, 11).replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2");
    }));
  }

  async function loadProducts() {
    const list = document.querySelector("[data-products-list]");
    const { products } = await api("/api/company/products");
    list.innerHTML = products.length ? products.map((product) => `
      <article class="list-item">
        <div><strong>${escapeHtml(product.name)}</strong><small>${money(product.priceCents)} · ${product.unitWeightKg} kg</small></div>
        <button class="status-pill ${product.isAvailable ? "active" : ""}" data-product-id="${product.id}" data-product-available="${product.isAvailable}">${product.isAvailable ? "Disponível" : "Indisponível"}</button>
      </article>`).join("") : '<p class="empty-copy">Nenhum produto cadastrado.</p>';
    list.querySelectorAll("[data-product-id]").forEach((button) => button.addEventListener("click", async () => {
      await api(`/api/company/products/${button.dataset.productId}`, { method: "PATCH", body: JSON.stringify({ isAvailable: button.dataset.productAvailable !== "true" }) });
      await loadProducts();
    }));
  }

  async function loadCouriers() {
    const list = document.querySelector("[data-couriers-list]");
    const { couriers } = await api("/api/company/couriers");
    list.innerHTML = couriers.length ? couriers.map((courier) => `
      <article class="list-item"><div><strong>${escapeHtml(courier.fullName)}</strong><small>${escapeHtml(courier.vehicleType)} · ${escapeHtml(courier.email)}</small></div><span class="status-pill ${courier.isOnline ? "active" : ""}">${courier.isOnline ? "Online" : "Offline"}</span></article>`).join("") : '<p class="empty-copy">Nenhum motoboy vinculado.</p>';
  }

  function setupCompany() {
    document.querySelectorAll("[data-company-panel]").forEach((element) => { element.hidden = false; });
    const productForm = document.querySelector("[data-product-form]");
    productForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(productForm));
      const message = document.querySelector("[data-product-message]");
      try {
        await api("/api/company/products", { method: "POST", body: JSON.stringify({ name: data.name, description: data.description, priceCents: Math.round(Number(data.price) * 100), unitWeightKg: Number(data.unitWeightKg) }) });
        productForm.reset();
        showMessage(message, "Produto cadastrado.", "success");
        await loadProducts();
      } catch (error) { showMessage(message, error.message); }
    });

    const courierForm = document.querySelector("[data-courier-form]");
    courierForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(courierForm));
      const message = document.querySelector("[data-courier-message]");
      try {
        await api("/api/company/couriers", { method: "POST", body: JSON.stringify(body) });
        courierForm.reset();
        showMessage(message, "Motoboy vinculado à empresa.", "success");
        await loadCouriers();
      } catch (error) { showMessage(message, error.message); }
    });
    Promise.all([loadProducts(), loadCouriers()]).catch(console.error);
  }

  async function setupCourier() {
    document.querySelector("[data-courier-panel]").hidden = false;
    const button = document.querySelector("[data-availability-toggle]");
    const title = document.querySelector("[data-availability-title]");
    let { isOnline } = await api("/api/courier/availability");
    const render = () => {
      title.textContent = isOnline ? "Você está online" : "Você está offline";
      button.textContent = isOnline ? "Ficar offline" : "Ficar online";
      button.classList.toggle("button-outline", isOnline);
      button.classList.toggle("button-dark", !isOnline);
    };
    render();
    button.addEventListener("click", async () => {
      ({ isOnline } = await api("/api/courier/availability", { method: "PATCH", body: JSON.stringify({ isOnline: !isOnline }) }));
      render();
    });
  }

  async function main() {
    masks();
    const { user } = await api("/api/auth/me");
    if (!user) return window.location.replace("login.html");
    document.querySelector("[data-user-name]").textContent = user.fullName;
    const copy = {
      company: ["ÁREA DA EMPRESA", "Operação da empresa", "Gerencie o catálogo e os motoboys vinculados ao estabelecimento."],
      courier: ["ÁREA DO MOTOBOY", "Sua jornada de entregas", "Controle sua disponibilidade e acompanhe as próximas etapas do fluxo."],
      client: ["ÁREA DO CLIENTE", "Seus pedidos", "Consulte empresas e acompanhe suas solicitações de entrega."],
    }[user.role] || ["PAINEL", "ERMES", "Acesso autenticado."];
    document.querySelector("[data-role-label]").textContent = copy[0];
    document.querySelector("[data-dashboard-title]").textContent = copy[1];
    document.querySelector("[data-dashboard-description]").textContent = copy[2];
    if (user.role === "company") setupCompany();
    if (user.role === "courier") setupCourier();
    if (user.role === "client") document.querySelector("[data-client-panel]").hidden = false;
  }

  document.querySelector("[data-logout]").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    window.location.replace("login.html");
  });
  main().catch((error) => {
    console.error(error);
    window.location.replace("login.html");
  });
})();
