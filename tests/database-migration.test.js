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
      role TEXT NOT NULL
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
    INSERT INTO users (id, role) VALUES (1, 'client');
    INSERT INTO companies (id) VALUES (1);
    INSERT INTO orders (id, client_id, company_id, status, items_total_cents)
      VALUES (1, 1, 1, 'draft', 1234);
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
  assert.deepEqual({ ...db.prepare(`SELECT id, status, items_total_cents AS itemsTotalCents,
                                           version, confirmed_at AS confirmedAt,
                                           payment_status AS paymentStatus,
                                           payment_paid_at AS paymentPaidAt
                                    FROM orders WHERE id = 1`).get() }, {
    id: 1, status: "draft", itemsTotalCents: 1234, version: 1, confirmedAt: null,
    paymentStatus: "pending", paymentPaidAt: null,
  });

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
  assert.deepEqual({ ...migratedAgain.prepare(`SELECT id, status, items_total_cents AS itemsTotalCents,
                                                       version, confirmed_at AS confirmedAt,
                                                       payment_status AS paymentStatus,
                                                       payment_paid_at AS paymentPaidAt
                                                FROM orders WHERE id = 1`).get() }, {
    id: 1, status: "draft", itemsTotalCents: 1234, version: 1, confirmedAt: null,
    paymentStatus: "pending", paymentPaidAt: null,
  });
  assert.equal(migratedAgain.prepare("SELECT count(*) AS total FROM client_default_addresses")
    .get().total, 1);

  migratedAgain.prepare("DELETE FROM orders WHERE id = 1").run();
  migratedAgain.prepare("DELETE FROM users WHERE id = 1").run();
  assert.equal(migratedAgain.prepare("SELECT count(*) AS total FROM client_default_addresses")
    .get().total, 0);
  migratedAgain.close();
});
