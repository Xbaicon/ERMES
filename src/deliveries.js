export const DELIVERY_STATES = Object.freeze({
  AVAILABLE: "available",
  HEADING_TO_PICKUP: "heading_to_pickup",
  AWAITING_PICKUP: "awaiting_pickup",
  IN_TRANSIT: "in_transit",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  RETURNING: "returning",
  AWAITING_RETURN_CONFIRMATION: "awaiting_return_confirmation",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  RETURNED: "returned",
});

export const DELIVERY_EVENT_TYPES = Object.freeze({
  CREATED: "delivery_created",
  ACCEPTED: "delivery_accepted",
  ARRIVED_AT_PICKUP: "courier_arrived_at_pickup",
  COLLECTED: "order_collected",
  ARRIVED_AT_DESTINATION: "courier_arrived_at_destination",
  COMPLETED: "delivery_completed",
  CONFIRMATION_CODE_INVALID: "confirmation_code_invalid",
  CONFIRMATION_FAILED: "confirmation_failed",
  COURIER_FAILED_BEFORE_PICKUP: "courier_failed_before_pickup",
  COURIER_FAILED_AFTER_PICKUP: "courier_failed_after_pickup",
  CLIENT_CANCELLED_BEFORE_PICKUP: "client_cancelled_before_pickup",
  CLIENT_CANCELLED_AFTER_PICKUP: "client_cancelled_after_pickup",
  RECIPIENT_ABSENT: "recipient_absent",
  RECIPIENT_REFUSED: "recipient_refused",
  ADDRESS_PROBLEM: "address_problem",
  PRODUCT_UNAVAILABLE: "product_unavailable",
  RETURN_REPORTED: "return_reported",
  RETURN_CONFIRMED: "return_confirmed",
  REAVAILABLE: "delivery_reavailable",
});

export const INITIAL_DELIVERY_STATE = DELIVERY_STATES.AVAILABLE;
export const INITIAL_DELIVERY_EVENT_TYPE = DELIVERY_EVENT_TYPES.CREATED;

export const NORMAL_DELIVERY_TRANSITIONS = Object.freeze([
  Object.freeze({
    from: DELIVERY_STATES.AVAILABLE,
    to: DELIVERY_STATES.HEADING_TO_PICKUP,
    eventType: DELIVERY_EVENT_TYPES.ACCEPTED,
  }),
  Object.freeze({
    from: DELIVERY_STATES.HEADING_TO_PICKUP,
    to: DELIVERY_STATES.AWAITING_PICKUP,
    eventType: DELIVERY_EVENT_TYPES.ARRIVED_AT_PICKUP,
  }),
  Object.freeze({
    from: DELIVERY_STATES.AWAITING_PICKUP,
    to: DELIVERY_STATES.IN_TRANSIT,
    eventType: DELIVERY_EVENT_TYPES.COLLECTED,
  }),
  Object.freeze({
    from: DELIVERY_STATES.IN_TRANSIT,
    to: DELIVERY_STATES.AWAITING_CONFIRMATION,
    eventType: DELIVERY_EVENT_TYPES.ARRIVED_AT_DESTINATION,
  }),
  Object.freeze({
    from: DELIVERY_STATES.AWAITING_CONFIRMATION,
    to: DELIVERY_STATES.COMPLETED,
    eventType: DELIVERY_EVENT_TYPES.COMPLETED,
  }),
]);

const deliveryStateValues = new Set(Object.values(DELIVERY_STATES));
const normalTransitionByStates = new Map(NORMAL_DELIVERY_TRANSITIONS.map((transition) => [
  `${transition.from}:${transition.to}`,
  transition,
]));

export function isDeliveryState(value) {
  return typeof value === "string" && deliveryStateValues.has(value);
}

function requireDeliveryState(value, field) {
  if (!isDeliveryState(value)) {
    throw new RangeError(`Estado de entrega inválido em ${field}: ${String(value)}.`);
  }
  return value;
}

export function canTransitionDelivery(fromState, toState) {
  const from = requireDeliveryState(fromState, "fromState");
  const to = requireDeliveryState(toState, "toState");
  return normalTransitionByStates.has(`${from}:${to}`);
}

export function getNormalDeliveryTransition(fromState, toState) {
  const from = requireDeliveryState(fromState, "fromState");
  const to = requireDeliveryState(toState, "toState");
  const transition = normalTransitionByStates.get(`${from}:${to}`);
  if (!transition) {
    throw new RangeError(`Transição normal de entrega não permitida: ${from} -> ${to}.`);
  }
  return transition;
}
