import test from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_EVENT_TYPES,
  DELIVERY_STATES,
  INITIAL_DELIVERY_EVENT_TYPE,
  INITIAL_DELIVERY_STATE,
  NORMAL_DELIVERY_TRANSITIONS,
  canTransitionDelivery,
  getNormalDeliveryTransition,
  isDeliveryState,
} from "../src/deliveries.js";

const normalFlow = [
  DELIVERY_STATES.AVAILABLE,
  DELIVERY_STATES.HEADING_TO_PICKUP,
  DELIVERY_STATES.AWAITING_PICKUP,
  DELIVERY_STATES.IN_TRANSIT,
  DELIVERY_STATES.AWAITING_CONFIRMATION,
  DELIVERY_STATES.COMPLETED,
];

test("centraliza estados normais e estados terminais reservados", () => {
  assert.deepEqual(Object.values(DELIVERY_STATES), [
    "available",
    "heading_to_pickup",
    "awaiting_pickup",
    "in_transit",
    "awaiting_confirmation",
    "returning",
    "awaiting_return_confirmation",
    "completed",
    "cancelled",
    "returned",
  ]);
  assert.equal(INITIAL_DELIVERY_STATE, DELIVERY_STATES.AVAILABLE);
  assert.equal(Object.isFrozen(DELIVERY_STATES), true);
  for (const state of Object.values(DELIVERY_STATES)) assert.equal(isDeliveryState(state), true);
  for (const value of [undefined, null, 0, "", "AVAILABLE", "cancelled ", "unknown"]) {
    assert.equal(isDeliveryState(value), false);
  }
});

test("centraliza eventos normais e ocorrências definidas na Baseline 0.1", () => {
  assert.deepEqual(Object.values(DELIVERY_EVENT_TYPES), [
    "delivery_created",
    "delivery_accepted",
    "courier_arrived_at_pickup",
    "order_collected",
    "courier_arrived_at_destination",
    "delivery_completed",
    "confirmation_code_invalid",
    "confirmation_failed",
    "courier_failed_before_pickup",
    "courier_failed_after_pickup",
    "client_cancelled_before_pickup",
    "client_cancelled_after_pickup",
    "recipient_absent",
    "recipient_refused",
    "address_problem",
    "product_unavailable",
    "return_reported",
    "return_confirmed",
    "delivery_reavailable",
  ]);
  assert.equal(INITIAL_DELIVERY_EVENT_TYPE, DELIVERY_EVENT_TYPES.CREATED);
  assert.equal(Object.isFrozen(DELIVERY_EVENT_TYPES), true);
  assert.equal(new Set(Object.values(DELIVERY_EVENT_TYPES)).size,
    Object.values(DELIVERY_EVENT_TYPES).length);
});

test("define a matriz completa do fluxo normal e seu evento correspondente", () => {
  const expectedEvents = [
    DELIVERY_EVENT_TYPES.ACCEPTED,
    DELIVERY_EVENT_TYPES.ARRIVED_AT_PICKUP,
    DELIVERY_EVENT_TYPES.COLLECTED,
    DELIVERY_EVENT_TYPES.ARRIVED_AT_DESTINATION,
    DELIVERY_EVENT_TYPES.COMPLETED,
  ];
  assert.equal(Object.isFrozen(NORMAL_DELIVERY_TRANSITIONS), true);
  assert.equal(NORMAL_DELIVERY_TRANSITIONS.length, normalFlow.length - 1);

  for (let index = 0; index < normalFlow.length - 1; index += 1) {
    const transition = NORMAL_DELIVERY_TRANSITIONS[index];
    assert.equal(Object.isFrozen(transition), true);
    assert.deepEqual(transition, {
      from: normalFlow[index],
      to: normalFlow[index + 1],
      eventType: expectedEvents[index],
    });
    assert.equal(canTransitionDelivery(transition.from, transition.to), true);
    assert.equal(getNormalDeliveryTransition(transition.from, transition.to), transition);
  }
});

test("rejeita exaustivamente atalhos, retrocessos, repeticoes e estados reservados", () => {
  const permitted = new Set(NORMAL_DELIVERY_TRANSITIONS.map(({ from, to }) => `${from}:${to}`));
  const states = Object.values(DELIVERY_STATES);

  for (const from of states) {
    for (const to of states) {
      const key = `${from}:${to}`;
      if (permitted.has(key)) continue;
      assert.equal(canTransitionDelivery(from, to), false, key);
      assert.throws(() => getNormalDeliveryTransition(from, to), {
        name: "RangeError",
        message: `Transição normal de entrega não permitida: ${from} -> ${to}.`,
      });
    }
  }
});

test("rejeita estado desconhecido antes de avaliar uma transicao", () => {
  for (const value of [undefined, null, 0, "", "AVAILABLE", "cancelled ", "unknown"]) {
    assert.throws(() => canTransitionDelivery(value, DELIVERY_STATES.AVAILABLE), {
      name: "RangeError",
      message: /Estado de entrega inválido em fromState/,
    });
    assert.throws(() => getNormalDeliveryTransition(DELIVERY_STATES.AVAILABLE, value), {
      name: "RangeError",
      message: /Estado de entrega inválido em toState/,
    });
  }
});
