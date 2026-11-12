import test from "node:test";
import assert from "node:assert/strict";
import { officialDeliveryStatus, officialOrderStatus } from "../src/official-statuses.js";

test("projeta estados oficiais da Entrega sem inferir causa de retorno", () => {
  const states = {
    available: "DISPONIVEL",
    heading_to_pickup: "EM_DESLOCAMENTO_PARA_COLETA",
    awaiting_pickup: "AGUARDANDO_COLETA",
    in_transit: "EM_TRANSPORTE",
    awaiting_confirmation: "AGUARDANDO_CONFIRMACAO",
    returning: "RETORNO_AO_ESTABELECIMENTO",
    awaiting_return_confirmation: "RETORNO_AO_ESTABELECIMENTO",
    awaiting_revalidation: "AGUARDANDO_REVALIDACAO",
    completed: "FINALIZADA",
    cancelled: "CANCELADA",
  };
  for (const [state, expected] of Object.entries(states)) {
    assert.equal(officialDeliveryStatus(state), expected, state);
  }
  assert.equal(officialDeliveryStatus("returned", "client_cancelled_after_pickup"), "CANCELADA");
  assert.equal(officialDeliveryStatus("returned", "recipient_absent"), "NAO_REALIZADA");
  assert.equal(officialDeliveryStatus("returned", "recipient_refused"), "NAO_REALIZADA");
  assert.equal(officialDeliveryStatus("returned"), null);
  for (const unrelated of [
    "return_confirmed", "confirmation_failed", "temporary_external_obstruction",
    "courier_failed_after_pickup",
  ]) {
    assert.equal(officialDeliveryStatus("returned", unrelated), null, unrelated);
  }
});

test("projeta estados oficiais do Pedido somente com evidência suficiente", () => {
  assert.equal(officialOrderStatus("draft"), "EM_MONTAGEM");
  assert.equal(officialOrderStatus("confirmed", "available"), "CONFIRMADO");
  assert.equal(officialOrderStatus("confirmed", "completed"), "CONCLUIDO");
  assert.equal(officialOrderStatus("confirmed", "cancelled", "client_cancelled_before_pickup"), "CANCELADO");
  assert.equal(officialOrderStatus("confirmed", "returned", "client_cancelled_after_pickup"), "CANCELADO");
  assert.equal(officialOrderStatus("confirmed", "returned", "recipient_absent"), "ENCERRADO");
  assert.equal(officialOrderStatus("confirmed", "returned", "recipient_refused"), "ENCERRADO");
  assert.equal(officialOrderStatus("confirmed", "returned"), null);
  for (const unrelated of [
    "return_confirmed", "confirmation_failed", "temporary_external_obstruction",
    "courier_failed_after_pickup",
  ]) {
    assert.equal(officialOrderStatus("confirmed", "returned", unrelated), null, unrelated);
  }
});
