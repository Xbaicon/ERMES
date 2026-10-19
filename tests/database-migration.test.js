import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("migra banco existente, cria financeiro e repete sem perder ou duplicar dados", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-address-migration-test-"));
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      company_id INTEGER,
      role TEXT NOT NULL,
      full_name TEXT NOT NULL
    );
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id),
      company_id INTEGER NOT NULL REFERENCES companies(id),
      status TEXT NOT NULL DEFAULT 'draft',
      destination_snapshot_json TEXT,
      route_snapshot_json TEXT,
      items_total_cents INTEGER NOT NULL DEFAULT 0,
      freight_total_cents INTEGER,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE deliveries (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      courier_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'available',
      confirmation_code_hash TEXT,
      invalid_code_attempts INTEGER NOT NULL DEFAULT 0,
      accepted_at TEXT,
      collected_at TEXT,
      completed_at TEXT,
      last_location_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE delivery_events (
      id INTEGER PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT
    );
    INSERT INTO users (id, role, full_name) VALUES (1, 'client', 'Cliente Legado');
    INSERT INTO companies (id) VALUES (1);
    INSERT INTO orders (id, client_id, company_id, status, items_total_cents)
      VALUES (1, 1, 1, 'draft', 1234);
    INSERT INTO deliveries (id, order_id, status) VALUES (1, 1, 'available');
  `);
  legacyDatabase.close();

  process.env.ERMES_DB_PATH = databasePath;
  process.env.NODE_ENV = "production";
  const { db } = await import(`../src/database.js?address-migration=${Date.now()}`);

  const table = db.prepare(`SELECT name FROM sqlite_master
                            WHERE type = 'table' AND name = 'client_default_addresses'`).get();
  assert.equal(table.name, "client_default_addresses");
  assert.equal(db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'financial_entries'`).get().name, "financial_entries");
  const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(({ name }) => name);
  assert.ok(orderColumns.includes("version"));
  assert.ok(orderColumns.includes("confirmed_at"));
  assert.ok(orderColumns.includes("payment_paid_at"));
  assert.ok(orderColumns.includes("recipient_snapshot_json"));
  const userColumns = db.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
  assert.ok(userColumns.includes("order_blocked_until"));
  const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all().map(({ name }) => name);
  for (const name of ["cancelled_at", "return_reason", "return_reported_at", "returned_at",
    "confirmation_code_ciphertext"]) {
    assert.ok(deliveryColumns.includes(name));
  }
  const migratedDelivery = db.prepare(`SELECT confirmation_code_hash AS hash,
    confirmation_code_ciphertext AS ciphertext FROM deliveries WHERE id = 1`).get();
  assert.match(migratedDelivery.hash, /^scrypt\$/);
  assert.match(migratedDelivery.ciphertext, /^aes-256-gcm\$/);
  assert.deepEqual({ ...db.prepare(`SELECT id, status, items_total_cents AS itemsTotalCents,
                                           version, confirmed_at AS confirmedAt,
                                           payment_status AS paymentStatus,
                                           payment_paid_at AS paymentPaidAt
                                    FROM orders WHERE id = 1`).get() }, {
    id: 1, status: "draft", itemsTotalCents: 1234, version: 1, confirmedAt: null,
    paymentStatus: "pending", paymentPaidAt: null,
  });
  assert.deepEqual(JSON.parse(db.prepare("SELECT recipient_snapshot_json AS value FROM orders WHERE id = 1")
    .get().value), { type: "self", name: "Cliente Legado" });

  db.prepare(`INSERT INTO client_default_addresses
                (client_id, postal_code, state, city, neighborhood, street, number)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(1, "01001000", "SP", "São Paulo", "Sé", "Praça da Sé", "1");
  assert.throws(() => db.prepare(`INSERT INTO client_default_addresses
                                    (client_id, postal_code, state, city, neighborhood, street, number)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(999, "01001000", "SP", "São Paulo", "Sé", "Praça da Sé", "1"), /FOREIGN KEY/);

  db.prepare("INSERT INTO users (id, company_id, role, full_name) VALUES (2, 1, 'courier', 'Motoboy Legado')").run();
  const productId = Number(db.prepare(`INSERT INTO products
    (company_id, name, price_cents, unit_weight_kg) VALUES (1, 'Produto legado', 1234, 1)`)
    .run().lastInsertRowid);
  const insertOrder = db.prepare(`INSERT INTO orders
    (id, client_id, company_id, status, destination_snapshot_json, recipient_snapshot_json,
     items_total_cents, freight_total_cents, payment_status, payment_paid_at, confirmed_at)
    VALUES (?, 1, 1, ?, '{}', '{"type":"self","name":"Cliente Legado"}', ?, ?, ?, ?, ?)`);
  const insertItem = db.prepare(`INSERT INTO order_items
    (order_id, product_id, quantity, unit_price_cents, unit_weight_kg) VALUES (?, ?, 1, ?, 1)`);
  const insertCompletedDelivery = db.prepare(`INSERT INTO deliveries
    (id, order_id, courier_id, status, accepted_at, collected_at, completed_at, created_at)
    VALUES (?, ?, 2, 'completed', ?, ?, ?, ?)`);
  const insertEvent = db.prepare(`INSERT INTO delivery_events
    (delivery_id, actor_user_id, event_type, occurred_at) VALUES (?, ?, ?, ?)`);
  function insertCompletedHistory(deliveryId, paymentAt, acceptedAt, collectedAt, completedAt) {
    insertEvent.run(deliveryId, null, "delivery_created", paymentAt);
    insertEvent.run(deliveryId, 2, "delivery_accepted", acceptedAt);
    insertEvent.run(deliveryId, 2, "courier_arrived_at_pickup", acceptedAt);
    insertEvent.run(deliveryId, 2, "order_collected", collectedAt);
    insertEvent.run(deliveryId, 2, "courier_arrived_at_destination", completedAt);
    insertEvent.run(deliveryId, 2, "delivery_completed", completedAt);
  }

  // Evidência completa: deve recompor o pagamento e a distribuição. Um componente
  // correto já existe para provar que banco parcialmente preenchido também é idempotente.
  insertOrder.run(2, "confirmed", 1234, 1001, "paid", "2026-09-01 10:00:00", "2026-09-01 09:00:00");
  insertItem.run(2, productId, 1234);
  insertCompletedDelivery.run(2, 2, "2026-09-01 10:10:00", "2026-09-01 10:30:00",
    "2026-09-01 11:00:00", "2026-09-01 10:00:00");
  insertCompletedHistory(2, "2026-09-01 10:00:00", "2026-09-01 10:10:00",
    "2026-09-01 10:30:00", "2026-09-01 11:00:00");
  db.prepare(`INSERT INTO financial_entries
    (order_id, delivery_id, entry_type, component, party_type, party_user_id,
     amount_cents, reason, idempotency_key, occurred_at)
    VALUES (2, 2, 'payment', 'products', 'client', 1, 1234,
      'simulated_payment', 'payment:2:products', '2026-09-01 10:00:00')`).run();

  // Casos sem prova bastante: não pago, timestamp sem estado coerente, timestamp
  // ausente e snapshots incoerentes devem permanecer sem recomposição.
  insertOrder.run(3, "confirmed", 1234, 1001, "pending", null, "2026-09-02 09:00:00");
  insertItem.run(3, productId, 1234);
  insertCompletedDelivery.run(3, 3, "2026-09-02 10:10:00", "2026-09-02 10:30:00",
    "2026-09-02 11:00:00", "2026-09-02 10:00:00");
  insertCompletedHistory(3, "2026-09-02 10:00:00", "2026-09-02 10:10:00",
    "2026-09-02 10:30:00", "2026-09-02 11:00:00");
  insertOrder.run(4, "confirmed", 1234, 1001, "pending", "2026-09-03 10:00:00", "2026-09-03 09:00:00");
  insertItem.run(4, productId, 1234);
  insertOrder.run(5, "confirmed", 1234, 1001, "paid", null, "2026-09-04 09:00:00");
  insertItem.run(5, productId, 1234);
  insertOrder.run(6, "confirmed", 999, 1001, "paid", "2026-09-05 10:00:00", "2026-09-05 09:00:00");
  insertItem.run(6, productId, 1234);

  // Frete desconhecido continua NULL: recompõe somente o produto efetivamente pago.
  insertOrder.run(7, "confirmed", 1234, null, "paid", "2026-09-06 10:00:00", "2026-09-06 09:00:00");
  insertItem.run(7, productId, 1234);
  insertCompletedDelivery.run(7, 7, "2026-09-06 10:10:00", "2026-09-06 10:30:00",
    "2026-09-06 11:00:00", "2026-09-06 10:00:00");
  insertCompletedHistory(7, "2026-09-06 10:00:00", "2026-09-06 10:10:00",
    "2026-09-06 10:30:00", "2026-09-06 11:00:00");

  // Pagamento sem Entrega é inconsistente na arquitetura atômica e não deve receber ledger.
  insertOrder.run(8, "confirmed", 1234, 1001, "paid", "2026-09-07 10:00:00", "2026-09-07 09:00:00");
  insertItem.run(8, productId, 1234);

  // Banco legado pode admitir timestamp terminal nulo; pagamento é recomposto,
  // mas a consequência terminal permanece pendente para reconciliação manual.
  insertOrder.run(9, "confirmed", 1234, 1001, "paid", "2026-09-08 10:00:00", "2026-09-08 09:00:00");
  insertItem.run(9, productId, 1234);
  insertCompletedDelivery.run(9, 9, "2026-09-08 10:10:00", "2026-09-08 10:30:00",
    "2026-09-08 11:00:00", "2026-09-08 10:00:00");
  insertEvent.run(9, null, "delivery_created", "2026-09-08 10:00:00");
  insertEvent.run(9, 2, "delivery_accepted", "2026-09-08 10:10:00");
  insertEvent.run(9, 2, "courier_arrived_at_pickup", "2026-09-08 10:20:00");
  insertEvent.run(9, 2, "order_collected", "2026-09-08 10:30:00");
  insertEvent.run(9, 2, "courier_arrived_at_destination", "2026-09-08 10:50:00");
  insertEvent.run(9, 2, "delivery_completed", null);

  // Simula uma versão anterior do trigger, que aceitava datas normalizadas pelo SQLite.
  // A reabertura deve substituí-lo pela validação canônica estrita.
  insertOrder.run(10, "confirmed", 1234, 1001, "paid", "2026-02-30 10:00:00",
    "2026-02-28 09:00:00");
  insertItem.run(10, productId, 1234);
  db.exec(`DROP TRIGGER financial_entry_payment_state_insert;
    CREATE TRIGGER financial_entry_payment_state_insert
      BEFORE INSERT ON financial_entries
      WHEN NEW.entry_type = 'payment' AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.id = NEW.order_id
          AND o.payment_status = 'paid' AND datetime(o.payment_paid_at) IS NOT NULL
      )
      BEGIN SELECT RAISE(ABORT, 'legacy timestamp check'); END;`);

  db.close();

  const { db: migratedAgain } = await import(`../src/database.js?migration-rerun=${Date.now()}`);
  const columnsAfterRerun = migratedAgain.prepare("PRAGMA table_info(orders)").all()
    .map(({ name }) => name);
  assert.equal(columnsAfterRerun.filter((name) => name === "payment_paid_at").length, 1);
  assert.equal(columnsAfterRerun.filter((name) => name === "recipient_snapshot_json").length, 1);
  assert.deepEqual({ ...migratedAgain.prepare(`SELECT id, status, items_total_cents AS itemsTotalCents,
                                                       version, confirmed_at AS confirmedAt,
                                                       payment_status AS paymentStatus,
                                                       payment_paid_at AS paymentPaidAt
                                                FROM orders WHERE id = 1`).get() }, {
    id: 1, status: "draft", itemsTotalCents: 1234, version: 1,
    confirmedAt: null, paymentStatus: "pending", paymentPaidAt: null,
  });
  assert.deepEqual(JSON.parse(migratedAgain.prepare(
    "SELECT recipient_snapshot_json AS value FROM orders WHERE id = 1",
  ).get().value), { type: "self", name: "Cliente Legado" });
  assert.equal(migratedAgain.prepare("SELECT count(*) AS total FROM client_default_addresses")
    .get().total, 1);
  assert.deepEqual(migratedAgain.prepare(`SELECT entry_type AS entryType, component,
    party_type AS partyType, amount_cents AS amountCents, occurred_at AS occurredAt
    FROM financial_entries WHERE order_id = 2 ORDER BY id`).all().map((row) => ({ ...row })), [
    { entryType: "payment", component: "products", partyType: "client", amountCents: 1234,
      occurredAt: "2026-09-01 10:00:00" },
    { entryType: "payment", component: "freight", partyType: "client", amountCents: 1001,
      occurredAt: "2026-09-01 10:00:00" },
    { entryType: "distribution", component: "freight", partyType: "courier", amountCents: 701,
      occurredAt: "2026-09-01 11:00:00" },
    { entryType: "distribution", component: "freight", partyType: "company", amountCents: 250,
      occurredAt: "2026-09-01 11:00:00" },
    { entryType: "distribution", component: "freight", partyType: "ermes", amountCents: 50,
      occurredAt: "2026-09-01 11:00:00" },
  ]);
  assert.deepEqual(migratedAgain.prepare(`SELECT order_id AS orderId, component, amount_cents AS amountCents
    FROM financial_entries WHERE order_id = 7 ORDER BY id`).all().map((row) => ({ ...row })), [
    { orderId: 7, component: "products", amountCents: 1234 },
  ]);
  assert.equal(migratedAgain.prepare(`SELECT COUNT(*) AS total FROM financial_entries
    WHERE order_id IN (1, 3, 4, 5, 6, 8)`).get().total, 0);
  assert.equal(migratedAgain.prepare(`SELECT COUNT(*) AS total FROM financial_entries
    WHERE order_id = 9 AND entry_type = 'payment'`).get().total, 2);
  assert.equal(migratedAgain.prepare(`SELECT COUNT(*) AS total FROM financial_entries
    WHERE order_id = 9 AND entry_type = 'distribution'`).get().total, 0);
  assert.throws(() => migratedAgain.prepare(`INSERT INTO financial_entries
    (order_id, entry_type, component, party_type, party_user_id,
     amount_cents, reason, idempotency_key, occurred_at)
    VALUES (10, 'payment', 'products', 'client', 1, 1234,
      'simulated_payment', 'payment:10:products', '2026-02-30 10:00:00')`).run(),
  /valid timestamp/);
  assert.equal(migratedAgain.prepare(`SELECT COUNT(*) AS total FROM financial_entries
    WHERE order_id = 10`).get().total, 0);
  assert.equal(migratedAgain.prepare("SELECT freight_total_cents AS value FROM orders WHERE id = 7")
    .get().value, null);
  assert.equal(migratedAgain.prepare("SELECT payment_status AS value FROM orders WHERE id = 4")
    .get().value, "pending");
  const financialCount = migratedAgain.prepare("SELECT count(*) AS total FROM financial_entries").get().total;
  const { db: migratedThirdTime } = await import(`../src/database.js?migration-third=${Date.now()}`);
  assert.equal(migratedThirdTime.prepare("SELECT count(*) AS total FROM financial_entries").get().total,
    financialCount);
  assert.equal(migratedThirdTime.prepare(`SELECT count(*) AS total FROM financial_entries
    WHERE order_id = 8`).get().total, 0);
  migratedThirdTime.close();

  migratedAgain.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});
