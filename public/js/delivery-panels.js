const labels = Object.freeze({
  available: "Disponível", heading_to_pickup: "A caminho da coleta",
  awaiting_pickup: "Aguardando coleta", in_transit: "Em transporte",
  awaiting_confirmation: "Aguardando confirmação", returning: "Em retorno",
  awaiting_return_confirmation: "Aguardando confirmação do retorno",
  completed: "Finalizada", cancelled: "Cancelada", returned: "Retornada",
});

function address(value = {}) {
  return [value.street, value.number, value.neighborhood, value.city, value.state]
    .filter(Boolean).join(", ");
}

function actions(role, delivery, courierCanAccept) {
  if (role === "client" && ["available", "heading_to_pickup", "awaiting_pickup", "in_transit", "awaiting_confirmation"].includes(delivery.status)) {
    return '<button class="button button-outline button-small" data-delivery-action="cancel">Cancelar entrega</button>';
  }
  if (role === "company") {
    if (["available", "heading_to_pickup", "awaiting_pickup"].includes(delivery.status)) {
      return '<button class="button button-outline button-small" data-delivery-action="product-unavailable">Produto indisponível</button>';
    }
    if (delivery.status === "awaiting_return_confirmation") {
      return '<button class="button button-dark button-small" data-delivery-action="confirm-return">Confirmar retorno recebido</button>';
    }
    return "";
  }
  const simple = {
    available: ["accept", courierCanAccept ? "Aceitar entrega" : "Aceite indisponível"],
    heading_to_pickup: ["arrive-pickup", "Registrar chegada à coleta"],
    awaiting_pickup: ["collect", "Registrar coleta"],
    in_transit: ["arrive-destination", "Registrar chegada ao destino"],
    returning: ["report-return", "Registrar devolução à empresa"],
  }[delivery.status];
  let html = simple ? `<button class="button button-dark button-small" data-delivery-action="${simple[0]}" ${delivery.status === "available" && !courierCanAccept ? "disabled" : ""}>${simple[1]}</button>` : "";
  if (["heading_to_pickup", "awaiting_pickup", "in_transit", "awaiting_confirmation"].includes(delivery.status)) {
    html += '<input data-delivery-failure-reason aria-label="Motivo da falha" placeholder="Motivo da falha" maxlength="500" />'
      + '<button class="button button-outline button-small" data-delivery-action="fail">Registrar falha</button>';
  }
  if (delivery.status === "awaiting_confirmation") {
    html += '<input data-delivery-code inputmode="numeric" maxlength="6" aria-label="Código de confirmação" placeholder="Código de 6 dígitos" />'
      + '<button class="button button-dark button-small" data-delivery-action="confirm">Validar e finalizar</button>'
      + '<select data-delivery-occurrence aria-label="Ocorrência"><option value="recipient_absent">Destinatário ausente</option><option value="recipient_refused">Destinatário recusou</option><option value="address_problem">Endereço informado incorreto</option></select>'
      + '<button class="button button-outline button-small" data-delivery-action="occurrences">Registrar ocorrência</button>';
  }
  return html;
}

export async function setupDeliveryPanel({ role, api, escapeHtml, showMessage }) {
  const panel = document.querySelector(`[data-delivery-panel="${role}"]`);
  if (!panel) return;
  panel.hidden = false;
  const list = panel.querySelector("[data-delivery-list]");
  const detail = panel.querySelector("[data-delivery-detail]");
  const message = panel.querySelector("[data-delivery-message]");
  const reload = panel.querySelector("[data-delivery-reload]");
  let deliveries = [];
  let selected = null;
  let courierCanAccept = false;

  const renderList = () => {
    list.innerHTML = deliveries.length ? deliveries.map((delivery) => `
      <button class="catalog-company-button" type="button" data-delivery-id="${delivery.id}">
        <span>Entrega #${delivery.id} · Pedido #${delivery.orderId}</span>
        <small>${escapeHtml(labels[delivery.status] || delivery.status)}</small>
      </button>`).join("") : '<p class="empty-copy">Nenhuma entrega para acompanhar.</p>';
  };
  const renderDetail = () => {
    if (!selected) { detail.hidden = true; return; }
    detail.hidden = false;
    const events = selected.events || [];
    detail.innerHTML = `
      <h3>Entrega #${selected.id}</h3>
      <p class="catalog-status success"><strong>${escapeHtml(labels[selected.status] || selected.status)}</strong></p>
      <p class="form-copy"><strong>Pedido:</strong> #${selected.orderId} · <strong>Empresa:</strong> ${escapeHtml(selected.company.name)}</p>
      ${selected.destination ? `<p class="form-copy"><strong>Destino:</strong> ${escapeHtml(address(selected.destination))}</p>` : ""}
      ${selected.recipient ? `<p class="form-copy"><strong>Destinatário:</strong> ${escapeHtml(selected.recipient.type === "self"
        ? `Próprio cliente: ${selected.recipient.name}` : `Outra pessoa: ${selected.recipient.name}`)}</p>` : ""}
      ${selected.client ? `<p class="form-copy"><strong>Cliente:</strong> ${escapeHtml(selected.client.fullName)}${selected.client.phone ? ` · ${escapeHtml(selected.client.phone)}` : ""}</p>` : ""}
      <p class="form-copy"><strong>Motoboy:</strong> ${escapeHtml(selected.courier?.fullName || "Ainda não atribuído")}</p>
      ${selected.courier ? `<p class="form-copy"><strong>Veículo:</strong> ${escapeHtml([selected.courier.vehicleType, selected.courier.vehicleIdentifier, selected.courier.plate].filter(Boolean).join(" · "))}</p>` : ""}
      ${selected.confirmationCode ? `<p class="confirmation-code"><strong>Código de confirmação:</strong> <code>${escapeHtml(selected.confirmationCode)}</code></p>` : ""}
      <div class="delivery-actions">${actions(role, selected, courierCanAccept)}</div>
      <h4>Histórico</h4>
      <ol class="delivery-events">${events.map((item) => `<li><strong>${escapeHtml(item.eventType)}</strong><small>${escapeHtml(item.occurredAt)}</small></li>`).join("")}</ol>`;
  };

  async function load() {
    message.hidden = true;
    if (role === "courier") {
      const [available, current, availability] = await Promise.all([
        api("/api/courier/deliveries/available"), api("/api/courier/deliveries/current"),
        api("/api/courier/availability"),
      ]);
      courierCanAccept = availability.isOnline && current.delivery === null;
      deliveries = [...(current.delivery ? [current.delivery] : []), ...available.deliveries];
      if (selected) selected = deliveries.find(({ id }) => id === selected.id) || current.delivery || null;
    } else {
      ({ deliveries } = await api(`/api/${role}/deliveries`));
      if (selected) selected = deliveries.find(({ id }) => id === selected.id) || null;
    }
    renderList();
    if (selected) await open(selected.id);
    else renderDetail();
  }

  async function open(id) {
    if (role === "courier") {
      const { delivery } = await api("/api/courier/deliveries/current");
      selected = delivery?.id === id ? delivery : deliveries.find((item) => item.id === id) || null;
    } else ({ delivery: selected } = await api(`/api/${role}/deliveries/${id}`));
    renderDetail();
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delivery-id]");
    if (button) open(Number(button.dataset.deliveryId)).catch((error) => showMessage(message, error.message));
  });
  detail.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delivery-action]");
    if (!button || !selected) return;
    const action = button.dataset.deliveryAction;
    const prefixes = { client: "/api/client", company: "/api/company", courier: "/api/courier" };
    let body = {};
    if (action === "confirm") body = { code: detail.querySelector("[data-delivery-code]").value };
    if (action === "fail") body = { reason: detail.querySelector("[data-delivery-failure-reason]").value };
    if (action === "occurrences") body = { type: detail.querySelector("[data-delivery-occurrence]").value };
    button.disabled = true;
    try {
      const result = await api(`${prefixes[role]}/deliveries/${selected.id}/${action}`, {
        method: "POST", body: JSON.stringify(body),
      });
      selected = result.delivery;
      showMessage(message, action === "confirm" ? "Entrega finalizada." : "Operação registrada.", "success");
      await load();
    } catch (error) {
      await load().catch(() => {});
      showMessage(message, error.message);
    }
  });
  reload.addEventListener("click", () => load().catch((error) => showMessage(message, error.message)));
  document.addEventListener("ermes:delivery-changed", () => load().catch(() => {}));
  await load();
}
