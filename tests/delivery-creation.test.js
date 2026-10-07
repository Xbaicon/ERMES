import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("criação persistente e idempotente da entrega", async (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-delivery-creation-test-"));
  process.env.ERMES_DB_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.NODE_ENV = "production";

  const { createDeliveryForEligibleOrder, createDeliveryForEligibleOrderInTransaction } = await import(`../src/delivery-creation.js?test=${Date.now()}`);
  const { db, transaction } = await import("../src/database.js");
  context.after(() => db.close());

  const companyId = Number(db.prepare(`INSERT INTO companies (name, cnpj, email)
    VALUES ('Empresa logística', '11222333000181', 'empresa.logistica@ermes.local')`).run().lastInsertRowid);
  const clientId = Number(db.prepare(`INSERT INTO users
    (role, full_name, email, password_hash) VALUES ('client', 'Cliente logística',
    'cliente.logistica@ermes.local', 'hash-de-teste')`).run().lastInsertRowid);
  const validDestination = {
    postalCode: "01001000",
    state: "SP",
    city: "São Paulo",
    neighborhood: "Sé",
    street: "Praça da Sé",
    number: "1",
    complement: "",
  };

  function createOrder({ status = "confirmed", paymentStatus = "paid",
    destinationSnapshotJson = JSON.stringify(validDestination), freightTotalCents = null } = {}) {
    return Number(db.prepare(`INSERT INTO orders
      (client_id, company_id, status, destination_snapshot_json, items_total_cents,
       freight_total_cents, payment_status)
      VALUES (?, ?, ?, ?, 1000, ?, ?)`).run(clientId, companyId, status,
      destinationSnapshotJson, freightTotalCents, paymentStatus).lastInsertRowid);
  }

  function storedDelivery(orderId) {
    return db.prepare(`SELECT id, order_id AS orderId, courier_id AS courierId, status,
                              confirmation_code_hash AS confirmationCodeHash,
                              confirmation_code_ciphertext AS confirmationCodeCiphertext,
                              invalid_code_attempts AS invalidCodeAttempts,
                              accepted_at AS acceptedAt, collected_at AS collectedAt,
                              completed_at AS completedAt, last_location_json AS lastLocationJson,
                              created_at AS createdAt
                       FROM deliveries WHERE order_id = ?`).get(orderId) || null;
  }

  function storedEvents(deliveryId) {
    return db.prepare(`SELECT id, delivery_id AS deliveryId, actor_user_id AS actorUserId,
                              event_type AS eventType, details_json AS detailsJson,
                              occurred_at AS occurredAt
                       FROM delivery_events WHERE delivery_id = ? ORDER BY id`).all(deliveryId)
      .map((event) => ({ ...event }));
  }

  await context.test("cria available com um delivery_created e preserva o pedido", () => {
    const orderId = createOrder();
    const orderBefore = { ...db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) };
    const delivery = createDeliveryForEligibleOrder(orderId);

    assert.deepEqual(delivery, {
      id: delivery.id,
      orderId,
      courierId: null,
      status: "available",
      createdAt: delivery.createdAt,
    });
    assert.match(delivery.createdAt, /^\d{4}-\d{2}-\d{2} /);
    assert.deepEqual({ ...storedDelivery(orderId) }, {
      ...delivery,
      confirmationCodeHash: storedDelivery(orderId).confirmationCodeHash,
      confirmationCodeCiphertext: storedDelivery(orderId).confirmationCodeCiphertext,
      invalidCodeAttempts: 0,
      acceptedAt: null,
      collectedAt: null,
      completedAt: null,
      lastLocationJson: null,
    });
    assert.match(storedDelivery(orderId).confirmationCodeHash, /^scrypt\$/);
    assert.match(storedDelivery(orderId).confirmationCodeCiphertext, /^aes-256-gcm\$/);
    const events = storedEvents(delivery.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: events[0].id,
      deliveryId: delivery.id,
      actorUserId: null,
      eventType: "delivery_created",
      detailsJson: "{}",
      occurredAt: events[0].occurredAt,
    });
    assert.match(events[0].occurredAt, /^\d{4}-\d{2}-\d{2} /);
    assert.deepEqual({ ...db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) }, orderBefore);
    assert.equal(orderBefore.freight_total_cents, null);
    assert.equal(orderBefore.route_snapshot_json, null);
  });

  await context.test("repete sem alterar id, estado, timestamp ou evento inicial", () => {
    const orderId = createOrder();
    const first = createDeliveryForEligibleOrder(orderId);
    const before = { delivery: { ...storedDelivery(orderId) }, events: storedEvents(first.id) };
    const second = createDeliveryForEligibleOrder(orderId);

    assert.deepEqual(second, first);
    assert.equal(second.id, first.id);
    assert.deepEqual({ delivery: { ...storedDelivery(orderId) }, events: storedEvents(first.id) }, before);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries WHERE order_id = ?").get(orderId).value, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS value FROM delivery_events
                             WHERE delivery_id = ? AND event_type = 'delivery_created'`).get(first.id).value, 1);
  });

  await context.test("repetição interna recupera o mesmo código sem armazená-lo em texto puro", () => {
    const orderId = createOrder();
    const first = transaction(() => createDeliveryForEligibleOrderInTransaction(orderId));
    const before = storedDelivery(orderId);
    const second = transaction(() => createDeliveryForEligibleOrderInTransaction(orderId));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.confirmationCode, first.confirmationCode);
    assert.deepEqual(storedDelivery(orderId), before);
    assert.equal(JSON.stringify(before).includes(first.confirmationCode), false);
  });

  await context.test("rejeita pedido não pago sem efeitos persistentes", () => {
    const orderId = createOrder({ paymentStatus: "pending" });
    const eventCountBefore = db.prepare("SELECT COUNT(*) AS value FROM delivery_events").get().value;
    assert.throws(() => createDeliveryForEligibleOrder(orderId), {
      message: "O pagamento do pedido ainda não está confirmado.",
      statusCode: 409,
    });
    assert.equal(storedDelivery(orderId), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM delivery_events").get().value, eventCountBefore);
  });

  await context.test("rejeita pedido não confirmado sem efeitos persistentes", () => {
    const orderId = createOrder({ status: "draft" });
    assert.throws(() => createDeliveryForEligibleOrder(orderId), {
      message: "O pedido não está confirmado comercialmente.",
      statusCode: 409,
    });
    assert.equal(storedDelivery(orderId), null);
  });

  await context.test("rejeita pedido inexistente e identificador inválido", () => {
    assert.throws(() => createDeliveryForEligibleOrder(999999), {
      message: "Pedido não encontrado.",
      statusCode: 404,
    });
    for (const value of [undefined, null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createDeliveryForEligibleOrder(value), {
        message: "Identificador de pedido inválido.",
        statusCode: 400,
      });
    }
  });

  await context.test("rejeita destino ausente, malformado ou incompleto", () => {
    for (const destinationSnapshotJson of [
      null,
      "json inválido",
      JSON.stringify({}),
      JSON.stringify({ ...validDestination, street: " " }),
      JSON.stringify({ ...validDestination, postalCode: "01001-000" }),
      JSON.stringify({ ...validDestination, postalCode: "123" }),
      JSON.stringify({ ...validDestination, state: "sp" }),
      JSON.stringify({ ...validDestination, number: 10 }),
      JSON.stringify([]),
    ]) {
      const orderId = createOrder({ destinationSnapshotJson });
      assert.throws(() => createDeliveryForEligibleOrder(orderId), {
        message: "O pedido não possui um destino preservado válido.",
        statusCode: 409,
      });
      assert.equal(storedDelivery(orderId), null);
    }
  });

  await context.test("desfaz a entrega quando o evento inicial falha", () => {
    const orderId = createOrder();
    const eventCountBefore = db.prepare("SELECT COUNT(*) AS value FROM delivery_events").get().value;
    db.exec(`CREATE TRIGGER fail_delivery_created_event
      BEFORE INSERT ON delivery_events
      WHEN NEW.event_type = 'delivery_created'
      BEGIN
        SELECT RAISE(ABORT, 'forced delivery event failure');
      END;`);
    try {
      assert.throws(() => createDeliveryForEligibleOrder(orderId), /forced delivery event failure/);
    } finally {
      db.exec("DROP TRIGGER fail_delivery_created_event");
    }
    assert.equal(storedDelivery(orderId), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM delivery_events").get().value, eventCountBefore);
  });

  await context.test("chamadas iniciadas juntas convergem para uma entrega e um evento", async () => {
    const orderId = createOrder();
    const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve()
      .then(() => createDeliveryForEligibleOrder(orderId))));
    assert.equal(new Set(results.map(({ id }) => id)).size, 1);
    const delivery = storedDelivery(orderId);
    assert.equal(db.prepare("SELECT COUNT(*) AS value FROM deliveries WHERE order_id = ?").get(orderId).value, 1);
    assert.equal(storedEvents(delivery.id).filter(({ eventType }) => eventType === "delivery_created").length, 1);
    for (const result of results) {
      assert.deepEqual(result, {
        id: delivery.id,
        orderId,
        courierId: null,
        status: "available",
        createdAt: delivery.createdAt,
      });
    }
  });

  await context.test("UNIQUE de order_id impede duplicação fora da operação", () => {
    const orderId = createOrder();
    const delivery = createDeliveryForEligibleOrder(orderId);
    assert.throws(() => db.prepare("INSERT INTO deliveries (order_id, status) VALUES (?, 'available')")
      .run(orderId), /UNIQUE constraint failed: deliveries\.order_id/);
    assert.equal(storedDelivery(orderId).id, delivery.id);
    assert.equal(storedEvents(delivery.id).length, 1);
  });
});
