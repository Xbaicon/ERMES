// Projeções derivadas: status legado continua sendo a única fonte persistida.
export const ORDER_OFFICIAL_STATUSES = Object.freeze([
  "EM_MONTAGEM", "AGUARDANDO_CONFIRMACAO", "CONFIRMADO", "CONCLUIDO",
  "ENCERRADO", "CANCELADO", "RECUSADO",
]);
export const DELIVERY_OFFICIAL_STATUSES = Object.freeze([
  "DISPONIVEL", "EM_DESLOCAMENTO_PARA_COLETA", "AGUARDANDO_COLETA",
  "EM_TRANSPORTE", "AGUARDANDO_CONFIRMACAO", "RETORNO_AO_ESTABELECIMENTO",
  "AGUARDANDO_REVALIDACAO", "FINALIZADA", "CANCELADA", "NAO_REALIZADA",
]);
const deliveryStatuses = Object.freeze({
  available: "DISPONIVEL", heading_to_pickup: "EM_DESLOCAMENTO_PARA_COLETA",
  awaiting_pickup: "AGUARDANDO_COLETA", in_transit: "EM_TRANSPORTE",
  awaiting_confirmation: "AGUARDANDO_CONFIRMACAO", returning: "RETORNO_AO_ESTABELECIMENTO",
  awaiting_return_confirmation: "RETORNO_AO_ESTABELECIMENTO",
  awaiting_revalidation: "AGUARDANDO_REVALIDACAO", completed: "FINALIZADA", cancelled: "CANCELADA",
});
const cancelledReturnEvents = new Set(["client_cancelled_after_pickup"]);
const unsuccessfulReturnEvents = new Set(["recipient_absent", "recipient_refused"]);

export function officialDeliveryStatus(status, terminalEvent = null) {
  // returned não prova causa/semântica terminal suficiente para migração global.
  if (status === "returned" && cancelledReturnEvents.has(terminalEvent)) return "CANCELADA";
  if (status === "returned" && unsuccessfulReturnEvents.has(terminalEvent)) return "NAO_REALIZADA";
  return Object.hasOwn(deliveryStatuses, status) ? deliveryStatuses[status] : null;
}
export function officialOrderStatus(status, deliveryStatus = null, terminalEvent = null) {
  if (status === "draft") return "EM_MONTAGEM";
  if (status !== "confirmed") return null;
  if (deliveryStatus === "completed") return "CONCLUIDO";
  if ((deliveryStatus === "cancelled" && terminalEvent === "client_cancelled_before_pickup")
    || (deliveryStatus === "returned" && cancelledReturnEvents.has(terminalEvent))) return "CANCELADO";
  if (deliveryStatus === "returned" && unsuccessfulReturnEvents.has(terminalEvent)) return "ENCERRADO";
  if (deliveryStatus === "cancelled" || deliveryStatus === "returned") return null;
  if (deliveryStatus !== null && officialDeliveryStatus(deliveryStatus) === null) return null;
  return "CONFIRMADO";
}
