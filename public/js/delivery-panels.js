const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatMoney(cents) {
  const amount = Number(cents);
  if (!Number.isSafeInteger(amount)) return currency.format(NaN);
  const absolute = BigInt(Math.abs(amount));
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  const signedWhole = amount < 0 ? (whole === 0n ? -0 : -whole) : whole;
  return currency.formatToParts(signedWhole)
    .map((part) => part.type === "fraction" ? fraction : part.value).join("");
}

const labels = Object.freeze({
  available: "Disponível", heading_to_pickup: "A caminho da coleta",
  awaiting_pickup: "Aguardando coleta", in_transit: "Em transporte",
  awaiting_confirmation: "Aguardando confirmação", returning: "Em retorno",
  awaiting_return_confirmation: "Aguardando confirmação do retorno",
  completed: "Finalizada", cancelled: "Cancelada", returned: "Retornada",
  awaiting_revalidation: "Aguardando revalidação pela empresa",
});

function address(value = {}) {
  return [value.street, value.number, value.complement, value.neighborhood, value.city, value.state, value.postalCode]
    .filter(Boolean).join(", ");
}

const pendingLabels = Object.freeze({
  freight_amount_unavailable: "O efeito sobre o frete aguarda um valor de frete legitimamente preservado.",
  freight_payment_reconciliation_required: "O frete preservado exige reconciliação com o histórico de pagamento.",
  freight_distribution_rule_undefined: "A distribuição interna do frete permanece pendente na Baseline 0.1.",
  client_cancellation_before_pickup_refund_rule_undefined: "A Baseline 0.1 não definiu o reembolso do cancelamento antes da coleta.",
});
const paymentStatusLabels = Object.freeze({
  pending: "Pendente", paid: "Pago",
});
const refundStatusLabels = Object.freeze({
  none: "Sem reembolso", partial: "Parcial", full: "Integral",
});

function financialDetails(role, financial, money, escapeHtml) {
  if (!financial) return "";
  if (role === "client") {
    const paidFreight = financial.paidFreightCents === null
      ? "frete sem valor preservado" : money(financial.paidFreightCents);
    const refunds = financial.refunds.length
      ? financial.refunds.map((entry) => `<li>${entry.component === "products" ? "Produtos" : "Frete"}: <strong>${money(entry.amountCents)}</strong></li>`).join("")
      : "<li>Nenhum reembolso registrado.</li>";
    return `<div class="delivery-financial"><h4>Financeiro</h4>
      <p class="form-copy"><strong>Situação:</strong> ${escapeHtml(paymentStatusLabels[financial.paymentStatus] || financial.paymentStatus)}</p>
      <p class="form-copy"><strong>Reembolso:</strong> ${escapeHtml(refundStatusLabels[financial.refundStatus] || financial.refundStatus)}</p>
      <p class="form-copy"><strong>Pagamento preservado:</strong> produtos ${financial.paidItemsCents === null ? "não registrado" : money(financial.paidItemsCents)} · frete ${paidFreight}</p>
      <ul>${refunds}</ul><p class="form-copy"><strong>Total reembolsado:</strong> ${money(financial.refundedTotalCents)}</p>
      ${financial.pending.map((item) => `<p class="form-copy">${escapeHtml(pendingLabels[item] || item)}</p>`).join("")}</div>`;
  }
  const distributions = financial.distributions.length
    ? financial.distributions.map((entry) => `<li>Frete: <strong>${money(entry.amountCents)}</strong></li>`).join("")
    : "<li>Nenhuma parcela registrada.</li>";
  return `<div class="delivery-financial"><h4>Financeiro</h4><ul>${distributions}</ul>
    <p class="form-copy"><strong>Total destinado a este perfil:</strong> ${money(financial.totalReceivedCents)}</p>
    ${financial.pending.map((item) => `<p class="form-copy">${escapeHtml(pendingLabels[item] || item)}</p>`).join("")}</div>`;
}

const adjustmentLabels = {
  pending: "Aguardando decisão do cliente", awaiting_payment: "Aguardando pagamento da diferença",
  applied: "Aceita e aplicada", rejected: "Rejeitada pelo cliente",
  cancelled: "Encerrada pelo cancelamento voluntário do pedido",
};

function adjustmentDetails(role, delivery, money, escapeHtml) {
  if (role === "courier") return delivery.collectionBlocked
    ? '<p class="form-copy" role="status">Coleta bloqueada enquanto o ajuste comercial está em aberto.</p>' : "";
  const { adjustment, unavailability } = delivery;
  const closure = unavailability
    ? '<p class="form-copy">Pedido encerrado por indisponibilidade. Responsabilidade da empresa.</p>' : "";
  if (!adjustment) return closure;
  const composition = (label, snapshot) => `<h5>${label}</h5>
    <ul>${snapshot.items.map((item) => `<li>${item.quantity} × ${escapeHtml(item.name)} · ${money(item.unitPriceCents)} por unidade</li>`).join("")}</ul>
    <p class="form-copy">Subtotal ${money(snapshot.subtotalCents)} · ${snapshot.weightKg} kg · Frete ${snapshot.freightTotalCents === null ? "sem valor calculado" : money(snapshot.freightTotalCents)}</p>`;
  const delta = adjustment.differenceCents;
  const difference = delta === 0 ? "Sem diferença de preço"
    : delta > 0 ? `Acréscimo de ${money(delta)}` : `Reembolso de ${money(-delta)}`;
  const decisions = role !== "client" ? "" : adjustment.requiresPayment
    ? '<button type="button" class="button button-dark button-small" data-delivery-action="adjustment-pay">Confirmar pagamento simulado da diferença</button>'
    : adjustment.state === "pending"
      ? '<button type="button" class="button button-dark button-small" data-delivery-action="adjustment-accept">Aceitar proposta</button>'
        + '<button type="button" class="button button-outline button-small" data-delivery-action="adjustment-reject">Rejeitar proposta e encerrar</button>'
      : "";
  return `<section><h4>Ajuste por indisponibilidade</h4>
    <p class="form-copy">${adjustmentLabels[adjustment.state]}${adjustment.state === "cancelled" && adjustment.decision === "accepted"
      ? " após aceite da proposta" : ""} · ${difference}</p>
    ${composition("Composição original", adjustment.original)}
    ${composition("Composição proposta", adjustment.proposed)}
    <div class="delivery-actions">${decisions}</div>${closure}</section>`;
}

function actions(role, delivery, courierCanAccept) {
  if (role === "client" && ["available", "heading_to_pickup", "awaiting_pickup", "in_transit", "awaiting_confirmation"].includes(delivery.status)) {
    return '<button class="button button-outline button-small" data-delivery-action="cancel">Cancelar entrega</button>';
  }
  if (role === "client") return "";
  if (role === "company") {
    const propose = delivery.canPropose
      ? '<button type="button" class="button button-dark button-small" data-delivery-action="adjustment-edit">Propor ajuste por indisponibilidade</button>' : "";
    const close = delivery.canCloseUnavailable
      ? '<button type="button" class="button button-outline button-small" data-delivery-action="product-unavailable">Encerrar por indisponibilidade</button>' : "";
    if (propose || close) return propose + close;
    if (delivery.status === "awaiting_return_confirmation") {
      return '<button class="button button-dark button-small" data-delivery-action="confirm-return">Confirmar retorno recebido</button>';
    }
    return "";
  }
  if (role !== "courier" || delivery.collectionBlocked) return "";
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
      + '<select data-delivery-occurrence aria-label="Ocorrência"><option value="recipient_absent">Destinatário ausente</option><option value="recipient_refused">Destinatário recusou</option></select>'
      + '<button class="button button-outline button-small" data-delivery-action="occurrences">Registrar ocorrência</button>';
  }
  return html;
}

export async function setupDeliveryPanel({ role, api, escapeHtml, showMessage,
  money = formatMoney }) {
  const panel = document.querySelector(`[data-delivery-panel="${role}"]`);
  if (!panel) return;
  panel.hidden = false;
  const list = panel.querySelector("[data-delivery-list]");
  const detail = panel.querySelector("[data-delivery-detail]");
  const message = panel.querySelector("[data-delivery-message]");
  const reload = panel.querySelector("[data-delivery-reload]");
  const courierFinancial = panel.querySelector("[data-courier-financial]");
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
      ${role === "courier" && selected.pickupAddress && address(selected.pickupAddress) ? `<p class="form-copy"><strong>Ponto de coleta / devolução:</strong> ${escapeHtml(address(selected.pickupAddress))}</p>` : ""}
      ${selected.recipient ? `<p class="form-copy"><strong>Destinatário:</strong> ${escapeHtml(selected.recipient.type === "self"
        ? `Próprio cliente: ${selected.recipient.name}` : `Outra pessoa: ${selected.recipient.name}`)}</p>` : ""}
      ${selected.client ? `<p class="form-copy"><strong>Cliente:</strong> ${escapeHtml(selected.client.fullName)}${selected.client.phone ? ` · ${escapeHtml(selected.client.phone)}` : ""}</p>` : ""}
      <p class="form-copy"><strong>Motoboy:</strong> ${escapeHtml(selected.courier?.fullName || "Ainda não atribuído")}</p>
      ${selected.courier ? `<p class="form-copy"><strong>Veículo:</strong> ${escapeHtml([selected.courier.vehicleType, selected.courier.vehicleIdentifier, selected.courier.plate].filter(Boolean).join(" · "))}</p>` : ""}
      ${selected.confirmationCode ? `<p class="confirmation-code"><strong>Código de confirmação:</strong> <code>${escapeHtml(selected.confirmationCode)}</code></p>` : ""}
      ${financialDetails(role, selected.financial, money, escapeHtml)}
      ${adjustmentDetails(role, selected, money, escapeHtml)}
      <div class="delivery-actions">${actions(role, selected, courierCanAccept)}</div>
      <div data-adjustment-editor></div>
      ${selected.status === "awaiting_revalidation" ? '<p class="form-copy">Retorno recebido. A empresa precisa verificar a viabilidade e autorizar a liberação.</p>' : ""}
      <h4>Histórico</h4>
      <ol class="delivery-events">${events.map((item) => `<li><strong>${escapeHtml(item.eventType)}</strong><small>${escapeHtml(item.occurredAt)}</small></li>`).join("")}</ol>`;
  };

  async function load() {
    message.hidden = true;
    if (role === "courier") {
      const [available, current, availability, earnings] = await Promise.all([
        api("/api/courier/deliveries/available"), api("/api/courier/deliveries/current"),
        api("/api/courier/availability"),
        api("/api/courier/financial-entries").catch((error) => ({
          entries: [], totalReceivedCents: 0, unavailableMessage: error.message,
        })),
      ]);
      if (courierFinancial) {
        const financialEntries = Array.isArray(earnings?.entries) ? earnings.entries : [];
        courierFinancial.innerHTML = `<h3>Remunerações registradas</h3>
          <p class="form-copy"><strong>Total:</strong> ${money(earnings?.totalReceivedCents ?? 0)}</p>
          ${earnings?.unavailableMessage
    ? `<p class="empty-copy">Informações financeiras indisponíveis: ${escapeHtml(earnings.unavailableMessage)}</p>`
    : financialEntries.length ? `<ul>${financialEntries.map((entry) => `<li>Entrega #${entry.deliveryId}: <strong>${money(entry.amountCents)}</strong><small>${escapeHtml(entry.occurredAt)}</small></li>`).join("")}</ul>` : '<p class="empty-copy">Nenhuma remuneração registrada.</p>'}`;
      }
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
  async function openAdjustmentEditor(deliveryId) {
    const [{ orderVersion, currentItems, canPropose }, { products }] = await Promise.all([
      api(`/api/company/deliveries/${deliveryId}/adjustment`), api("/api/company/products"),
    ]);
    if (selected?.id !== deliveryId) return;
    if (!canPropose) throw new Error("A entrega não permite uma nova proposta.");
    const options = new Map(products.filter(({ isAvailable }) => isAvailable)
      .map(({ id, name }) => [id, { name, quantity: 0 }]));
    for (const { productId, name, quantity } of currentItems) options.set(productId, { name, quantity });
    detail.querySelector("[data-adjustment-editor]").innerHTML = `<form data-adjustment-form data-order-version="${orderVersion}">
      <h4>Montar proposta</h4>
      <p class="form-copy">Informe a quantidade final de cada produto. Use zero para remover ou omitir um item.</p>
      ${Array.from(options, ([id, item]) => `<label>${escapeHtml(item.name)}
        <input type="number" min="0" step="1" value="${item.quantity}" required data-adjustment-product="${id}">
      </label>`).join("")}
      <button class="button button-dark button-small">Enviar proposta</button></form>`;
  }

  detail.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-adjustment-form]");
    if (!form || role !== "company" || !selected) return;
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      const items = Array.from(form.querySelectorAll("[data-adjustment-product]"), (input) => ({
        productId: Number(input.dataset.adjustmentProduct), quantity: Number(input.value),
      })).filter(({ quantity }) => quantity !== 0);
      await api(`/api/company/deliveries/${selected.id}/adjustment`, {
        method: "POST", body: JSON.stringify({ version: Number(form.dataset.orderVersion), items }),
      });
      await load();
      showMessage(message, "Proposta enviada ao cliente.", "success");
    } catch (error) {
      showMessage(message, error.message);
    } finally {
      submit.disabled = false;
    }
  });

  detail.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delivery-action]");
    if (!button || !selected) return;
    const action = button.dataset.deliveryAction;
    const prefixes = { client: "/api/client", company: "/api/company", courier: "/api/courier" };
    let body = {};
    if (action === "product-unavailable" && selected.orderVersion != null) {
      body = { version: selected.orderVersion };
    }
    if (action === "collect" && selected.pickupVersion != null) {
      body = { pickupVersion: selected.pickupVersion };
    }
    if (action === "confirm") body = { code: detail.querySelector("[data-delivery-code]").value };
    if (action === "fail") body = { reason: detail.querySelector("[data-delivery-failure-reason]").value };
    if (action === "occurrences") body = { type: detail.querySelector("[data-delivery-occurrence]").value };
    button.disabled = true;
    try {
      if (action === "adjustment-edit") {
        await openAdjustmentEditor(selected.id);
        return;
      }
      const endpoint = action.startsWith("adjustment-")
        ? `adjustment/${selected.adjustment.id}/${action.slice("adjustment-".length)}` : action;
      const result = await api(`${prefixes[role]}/deliveries/${selected.id}/${endpoint}`, {
        method: "POST", body: JSON.stringify(body),
      });
      selected = result.delivery ?? selected;
      await load();
      showMessage(message, action === "confirm" ? "Entrega finalizada." : "Operação registrada.", "success");
    } catch (error) {
      await load().catch(() => {});
      showMessage(message, error.message);
    } finally {
      button.disabled = false;
    }
  });
  reload.addEventListener("click", () => load().catch((error) => showMessage(message, error.message)));
  document.addEventListener("ermes:delivery-changed", () => load().catch(() => {}));
  await load();
}
