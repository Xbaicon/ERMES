(function () {
  "use strict";

  const page = document.body.dataset.page;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
    return data;
  }

  function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function formatCpf(value) {
    return onlyDigits(value).slice(0, 11)
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }

  function formatCnpj(value) {
    return onlyDigits(value).slice(0, 14)
      .replace(/(\d{2})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1/$2")
      .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
  }

  function formatPhone(value) {
    const digits = onlyDigits(value).slice(0, 11);
    return digits.length <= 10
      ? digits.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d{1,4})$/, "$1-$2")
      : digits.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2");
  }

  function setMessage(element, message, type = "error") {
    if (!element) return;
    element.textContent = message;
    element.className = `form-message ${type}`;
    element.hidden = false;
  }

  function clearMessage(element) {
    if (!element) return;
    element.hidden = true;
    element.textContent = "";
  }

  function setLoading(button, loading) {
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
  }

  function serialize(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function setupCommon() {
    document.querySelectorAll("[data-current-year]").forEach((element) => {
      element.textContent = new Date().getFullYear();
    });
    document.querySelectorAll("[data-password-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (!input) return;
        const revealing = input.type === "password";
        input.type = revealing ? "text" : "password";
        button.textContent = revealing ? "Ocultar" : "Mostrar";
      });
    });
    document.querySelectorAll("[data-mask]").forEach((input) => {
      input.addEventListener("input", () => {
        if (input.dataset.mask === "cpf") input.value = formatCpf(input.value);
        if (input.dataset.mask === "cnpj") input.value = formatCnpj(input.value);
        if (input.dataset.mask === "phone") input.value = formatPhone(input.value);
        if (input.dataset.mask === "postal-code") input.value = onlyDigits(input.value).slice(0, 8).replace(/(\d{5})(\d)/, "$1-$2");
      });
    });
  }

  async function setupHome() {
    const menuButton = document.querySelector(".menu-toggle");
    const menu = document.querySelector(".main-nav");
    menuButton?.addEventListener("click", () => {
      const open = menuButton.getAttribute("aria-expanded") === "true";
      menuButton.setAttribute("aria-expanded", String(!open));
      menuButton.setAttribute("aria-label", open ? "Abrir menu" : "Fechar menu");
      menu?.classList.toggle("open", !open);
      document.body.classList.toggle("menu-open", !open);
    });

    const { user } = await api("/api/auth/me").catch(() => ({ user: null }));
    const actions = document.querySelector("[data-auth-actions]");
    if (user && actions) {
      const firstName = user.fullName.split(/\s+/)[0];
      actions.innerHTML = `<span class="user-greeting">Olá, ${escapeHtml(firstName)}</span><a class="button button-dark button-small" href="pages/painel.html">Meu painel</a>`;
    }
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = String(value || "");
    return element.innerHTML;
  }

  function setupLogin() {
    const form = document.getElementById("login-form");
    const message = document.querySelector("[data-form-message]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearMessage(message);
      if (!form.reportValidity()) return;
      const body = serialize(form);
      body.rememberMe = document.getElementById("remember-me").checked;
      const button = form.querySelector("[data-submit-button]");
      setLoading(button, true);
      try {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify(body) });
        setMessage(message, "Acesso autorizado. Abrindo seu painel…", "success");
        window.setTimeout(() => { window.location.href = "painel.html"; }, 450);
      } catch (error) {
        setMessage(message, error.message);
        setLoading(button, false);
      }
    });

    const dialog = document.getElementById("reset-dialog");
    document.querySelector("[data-open-reset]")?.addEventListener("click", () => dialog?.showModal());
    document.querySelectorAll("[data-close-reset]").forEach((button) => button.addEventListener("click", () => dialog?.close()));
  }

  function setupClientRegistration() {
    const form = document.getElementById("client-register-form");
    const message = document.querySelector("[data-form-message]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearMessage(message);
      if (!form.reportValidity()) return;
      const body = serialize(form);
      if (body.password !== body.confirmPassword) return setMessage(message, "As senhas não coincidem.");
      const button = form.querySelector("[data-submit-button]");
      setLoading(button, true);
      try {
        await api("/api/auth/register/client", { method: "POST", body: JSON.stringify(body) });
        setMessage(message, "Conta criada. Abrindo o login…", "success");
        window.setTimeout(() => { window.location.href = "login.html"; }, 650);
      } catch (error) {
        setMessage(message, error.message);
        setLoading(button, false);
      }
    });
  }

  function setupCompanyRegistration() {
    const form = document.getElementById("company-register-form");
    const message = document.querySelector("[data-form-message]");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearMessage(message);
      if (!form.reportValidity()) return;
      const body = serialize(form);
      if (body.password !== body.passwordConfirm) return setMessage(message, "As senhas não coincidem.");
      body.address = {
        postalCode: body.postalCode,
        state: String(body.state || "").toUpperCase(),
        city: body.city,
        neighborhood: body.neighborhood,
        street: body.street,
        number: body.number,
        complement: body.complement,
      };
      const button = form.querySelector("[data-submit-button]");
      setLoading(button, true);
      try {
        await api("/api/auth/register/company", { method: "POST", body: JSON.stringify(body) });
        setMessage(message, "Empresa cadastrada. Abrindo o login…", "success");
        window.setTimeout(() => { window.location.href = "login.html"; }, 650);
      } catch (error) {
        setMessage(message, error.message);
        setLoading(button, false);
      }
    });
  }

  setupCommon();
  if (page === "home") setupHome();
  if (page === "login") setupLogin();
  if (page === "cliente") setupClientRegistration();
  if (page === "empresa") setupCompanyRegistration();
})();
