import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("adiciona colunas de pedido a banco existente e repete a migração sem perder dados", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-address-migration-test-"));
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
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
    id: 1, status: "draft", itemsTotalCents: 1234, version: 1, confirmedAt: null,
    paymentStatus: "pending", paymentPaidAt: null,
  });
  assert.deepEqual(JSON.parse(migratedAgain.prepare(
    "SELECT recipient_snapshot_json AS value FROM orders WHERE id = 1",
  ).get().value), { type: "self", name: "Cliente Legado" });
  assert.equal(migratedAgain.prepare("SELECT count(*) AS total FROM client_default_addresses")
    .get().total, 1);

  migratedAgain.prepare("DELETE FROM deliveries WHERE order_id = 1").run();
  migratedAgain.prepare("DELETE FROM orders WHERE id = 1").run();
  migratedAgain.prepare("DELETE FROM users WHERE id = 1").run();
  assert.equal(migratedAgain.prepare("SELECT count(*) AS total FROM client_default_addresses")
    .get().total, 0);
  migratedAgain.close();
});
