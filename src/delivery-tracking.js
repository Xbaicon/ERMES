import { db, transaction } from "./database.js";

const MOVING = new Set(["heading_to_pickup", "in_transit", "returning"]);
const TERMINAL = new Set(["completed", "cancelled", "returned"]);
const CAPTURE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const positionSelect = `SELECT id, period_id AS periodId, courier_id AS courierId,
  latitude, longitude, accuracy_meters AS accuracyMeters,
  captured_at AS capturedAt, received_at AS receivedAt
  FROM delivery_tracking_positions`;

function trackingError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function readSnapshot(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function requireDelivery(deliveryId) {
  const delivery = db.prepare(`SELECT d.id, d.status, d.courier_id AS courierId,
    o.client_id AS clientId, o.company_id AS companyId
    FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`).get(deliveryId);
  if (!delivery) throw trackingError("Entrega não encontrada.", 404);
  return delivery;
}

function currentPeriod(deliveryId) {
  return db.prepare(`SELECT id, delivery_id AS deliveryId, courier_id AS courierId,
    started_at AS startedAt FROM delivery_tracking_periods
    WHERE delivery_id = ? AND ended_at IS NULL`).get(deliveryId) || null;
}

function requirePosition(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["latitude", "longitude", "capturedAt", "accuracyMeters"].includes(key))) {
    throw trackingError("Informe uma posição geográfica válida.", 400);
  }
  for (const [name, minimum, maximum] of [["latitude", -90, 90], ["longitude", -180, 180]]) {
    if (typeof body[name] !== "number" || !Number.isFinite(body[name])
      || body[name] < minimum || body[name] > maximum) {
      throw trackingError(`${name} inválida.`, 400);
    }
  }
  if (Object.hasOwn(body, "accuracyMeters") && (typeof body.accuracyMeters !== "number"
    || !Number.isFinite(body.accuracyMeters) || body.accuracyMeters < 0)) {
    throw trackingError("Precisão estimada inválida.", 400);
  }
  if (typeof body.capturedAt !== "string" || !CAPTURE_TIME.test(body.capturedAt)
    || !Number.isFinite(Date.parse(body.capturedAt))
    || new Date(body.capturedAt).toISOString() !== body.capturedAt) {
    throw trackingError("Horário de captura inválido; use ISO 8601 UTC com milissegundos.", 400);
  }
  return body;
}

export function recordTrackingPosition(deliveryId, courierId, companyId, body, currentSessionUser) {
  const input = requirePosition(body);
  return transaction(() => {
    const authenticated = currentSessionUser();
    if (!authenticated || authenticated.role !== "courier"
      || authenticated.id !== courierId || authenticated.companyId !== companyId) {
      throw trackingError("Autenticação necessária.", 401);
    }
    const delivery = requireDelivery(deliveryId);
    const courier = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'courier'
      AND company_id = ? AND status = 'active'`).get(courierId, companyId);
    if (!courier || delivery.companyId !== companyId || delivery.courierId !== courierId) {
      throw trackingError("Entrega não encontrada.", 404);
    }
    const period = currentPeriod(deliveryId);
    if (!MOVING.has(delivery.status) || !period || period.courierId !== courierId) {
      throw trackingError("A Entrega não está em período rastreável.");
    }
    const receivedAt = new Date().toISOString();
    if (input.capturedAt < period.startedAt
      || Date.parse(input.capturedAt) > Date.parse(receivedAt) + 30_000) {
      throw trackingError("A captura não pertence ao período atual ou excede o relógio do servidor.", 400);
    }
    const result = db.prepare(`INSERT INTO delivery_tracking_positions
      (delivery_id, period_id, courier_id, latitude, longitude, accuracy_meters,
        captured_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_id, courier_id, captured_at, latitude, longitude) DO NOTHING`)
      .run(deliveryId, period.id, courierId, input.latitude, input.longitude,
        input.accuracyMeters ?? null, input.capturedAt, receivedAt);
    const position = result.changes
      ? db.prepare(`${positionSelect} WHERE id = ?`).get(result.lastInsertRowid)
      : db.prepare(`${positionSelect} WHERE period_id = ? AND courier_id = ?
          AND captured_at = ? AND latitude = ? AND longitude = ?`)
        .get(period.id, courierId, input.capturedAt, input.latitude, input.longitude);
    return { position, duplicate: !result.changes };
  });
}

function trackingSnapshot(deliveryId, delivery) {
  const periods = db.prepare(`SELECT p.id, p.courier_id AS courierId,
    u.full_name AS courierName, p.started_at AS startedAt,
    p.ended_at AS endedAt, p.end_kind AS endKind
    FROM delivery_tracking_periods p JOIN users u ON u.id = p.courier_id
    WHERE p.delivery_id = ? ORDER BY p.id`).all(deliveryId);
  const positions = db.prepare(`${positionSelect} WHERE delivery_id = ?
    ORDER BY captured_at, id`).all(deliveryId);
  const latest = db.prepare(`${positionSelect} WHERE delivery_id = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1`).get(deliveryId) || null;
  const period = currentPeriod(deliveryId);
  const now = Date.now();
  const freshnessAt = latest ? Math.min(Date.parse(latest.capturedAt), Date.parse(latest.receivedAt)) : null;
  const state = TERMINAL.has(delivery.status) ? "ended"
    : period ? (!latest || latest.periodId !== period.id ? "unavailable"
      : now - freshnessAt >= 120_000 ? "stale" : "updated")
      : periods.length ? "paused" : "unavailable";
  return {
    deliveryId, state, activePeriodId: period?.id ?? null,
    latestPosition: latest,
    periods: periods.map((item) => ({
      ...item, positions: positions.filter((position) => position.periodId === item.id),
    })),
  };
}

export function getTrackingForParticipant(deliveryId, user) {
  return readSnapshot(() => {
    const delivery = requireDelivery(deliveryId);
    const participant = db.prepare(`SELECT id, role, status, company_id AS companyId,
      company_profile AS companyProfile FROM users WHERE id = ?`).get(user.id);
    if (!participant || participant.status !== "active" || participant.role !== user.role
      || (participant.role === "client"
      ? delivery.clientId !== participant.id || TERMINAL.has(delivery.status)
      : participant.role === "company"
        ? delivery.companyId !== participant.companyId
          || !["RESPONSAVEL", "ATENDENTE"].includes(participant.companyProfile)
        : true)) {
      throw trackingError("Entrega não encontrada.", 404);
    }
    if (user.role !== "client" && user.role !== "company") {
      throw trackingError("Acesso negado.", 403);
    }
    return trackingSnapshot(deliveryId, delivery);
  });
}

export function getCourierTrackingState(deliveryId, courierId, companyId) {
  return readSnapshot(() => {
    const delivery = requireDelivery(deliveryId);
    if (delivery.courierId !== courierId || delivery.companyId !== companyId
      || TERMINAL.has(delivery.status)
      || !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'courier'
        AND company_id = ? AND status = 'active'`).get(courierId, companyId)) {
      throw trackingError("Entrega não encontrada.", 404);
    }
    const snapshot = trackingSnapshot(deliveryId, delivery);
    return { deliveryId, state: snapshot.state, activePeriodId: snapshot.activePeriodId };
  });
}
