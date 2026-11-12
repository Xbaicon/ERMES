import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { isCanonicalTimestamp } from "../src/finance.js";

const triggerName = "financial_entry_payment_state_insert";
const expectedTrigger = `CREATE TRIGGER financial_entry_payment_state_insert
  BEFORE INSERT ON financial_entries
  WHEN NEW.entry_type = 'payment' AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = NEW.order_id AND o.payment_status = 'paid'
      AND is_canonical_timestamp(o.payment_paid_at) = 1
  )
  BEGIN SELECT RAISE(ABORT, 'payment requires paid order with valid timestamp'); END`;
const normalizeSql = (sql) => sql.replace(/\s+/g, " ").trim();

// Todos os workers atingem a barreira ANTES de importar o inicializador real.
// Não há serialização entre os imports, sleeps ou simulação do schema.
async function initialize(databasePath, count) {
  const runs = Array.from({ length: count }, () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.once('message', async () => {
        let db;
        try {
          process.env.ERMES_DB_PATH = workerData.databasePath;
          process.env.NODE_ENV = 'production';
          ({ db } = await import(workerData.databaseUrl));
          const result = { ok: true,
            foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
            violations: db.prepare('PRAGMA foreign_key_check').all() };
          db.close(); db = undefined;
          parentPort.postMessage(result);
        } catch (error) {
          parentPort.postMessage({ ok: false, message: error.message, stack: error.stack });
        } finally { db?.close(); parentPort.close(); }
      });
      parentPort.postMessage({ ready: true });
    `, { eval: true, workerData: {
      databasePath, databaseUrl: new URL("../src/database.js", import.meta.url).href,
    } });
    let readyResolve, readyReject, doneResolve, doneReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    worker.on("message", (message) => {
      if (message.ready) readyResolve();
      else doneResolve(message);
    });
    worker.on("error", (error) => { readyReject(error); doneReject(error); });
    return { worker, ready, done };
  });
  try {
    await Promise.all(runs.map((run) => run.ready));
    const completion = Promise.all(runs.map((run) => run.done));
    for (const { worker } of runs) worker.postMessage("initialize");
    const results = await completion;
    for (const result of results) {
      assert.equal(result.ok, true, result.stack || result.message);
      assert.equal(result.foreignKeys, 1);
      assert.deepEqual(result.violations, []);
    }
  } finally { await Promise.all(runs.map(({ worker }) => worker.terminate())); }
}

function inspect(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.function("is_canonical_timestamp", { deterministic: true }, (value) => isCanonicalTimestamp(value) ? 1 : 0);
  return db;
}

function schema(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

function data(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  ]));
}

function assertInitialized(db) {
  for (const table of ["companies", "users", "orders", "order_items", "deliveries", "delivery_attempts",
    "delivery_events", "delivery_occurrences", "delivery_revalidations", "financial_entries", "sessions"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").all(triggerName);
  assert.equal(triggers.length, 1);
  assert.equal(normalizeSql(triggers[0].sql), normalizeSql(expectedTrigger));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

function seed(db) {
  db.exec(`INSERT INTO companies(id, name, cnpj, email) VALUES (1, 'Empresa teste', '11222333000181', 'empresa@teste.local');
    INSERT INTO users(id, role, full_name, email, password_hash) VALUES (1, 'client', 'Cliente teste', 'cliente@teste.local', 'hash-teste');
    INSERT INTO products(id, company_id, name, price_cents, unit_weight_kg) VALUES (1, 1, 'Produto teste', 1000, 1);
    INSERT INTO orders(id, client_id, company_id, status, items_total_cents, recipient_snapshot_json)
      VALUES (1, 1, 1, 'confirmed', 1000, '{"type":"self","name":"Cliente teste"}');
    INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents, unit_weight_kg) VALUES (1, 1, 1, 1000, 1);`);
}

function assertFinancialRule(db) {
  const insert = db.prepare(`INSERT INTO financial_entries
    (order_id, entry_type, component, party_type, party_user_id, amount_cents, reason, idempotency_key)
    VALUES (1, 'payment', 'products', 'client', 1, 1000, 'simulated_payment', ?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => insert.run("pending"), /payment requires paid order with valid timestamp/);
    db.exec("UPDATE orders SET payment_status = 'paid', payment_paid_at = '2026-02-30 10:00:00' WHERE id = 1");
    assert.throws(() => insert.run("invalid-date"), /payment requires paid order with valid timestamp/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM financial_entries").get().n, 0);
    db.exec("UPDATE orders SET payment_paid_at = '2026-02-28 10:00:00' WHERE id = 1");
    assert.equal(insert.run("valid-date").changes, 1);
  } finally { db.exec("ROLLBACK"); }
}

test("quatro conexões inicializam simultaneamente um banco novo", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-startup-new-"));
  try {
    const path = join(directory, "new.sqlite");
    await initialize(path, 4);
    const db = inspect(path);
    try { assertInitialized(db); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM financial_entries").get().n, 0); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("inicialização concorrente substitui trigger legado sem perder schema ou dados", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-startup-legacy-"));
  try {
    const path = join(directory, "existing.sqlite");
    await initialize(path, 1);
    const db = inspect(path);
    let beforeSchema, beforeData;
    try {
      seed(db); beforeSchema = schema(db); beforeData = data(db);
      db.exec(`DROP TRIGGER financial_entry_payment_state_insert;
        CREATE TRIGGER financial_entry_payment_state_insert BEFORE INSERT ON financial_entries
        WHEN NEW.entry_type = 'payment' AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.payment_status = 'paid'
            AND datetime(o.payment_paid_at) IS NOT NULL
        ) BEGIN SELECT RAISE(ABORT, 'legacy timestamp check'); END;`);
    } finally { db.close(); }
    await initialize(path, 4);
    const after = inspect(path);
    try {
      assertInitialized(after);
      assert.deepEqual(schema(after), beforeSchema);
      assert.deepEqual(data(after), beforeData);
      assertFinancialRule(after);
      assert.deepEqual(data(after), beforeData);
    } finally { after.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("três inicializações sequenciais no mesmo banco preservam schema, trigger e dados", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-startup-sequential-"));
  try {
    const path = join(directory, "sequential.sqlite");
    await initialize(path, 1);
    const db = inspect(path);
    let beforeSchema, beforeData;
    try { seed(db); assertInitialized(db); beforeSchema = schema(db); beforeData = data(db); }
    finally { db.close(); }
    for (let initialization = 2; initialization <= 3; initialization += 1) {
      await initialize(path, 1);
      const reopened = inspect(path);
      try {
        assertInitialized(reopened);
        assert.deepEqual(schema(reopened), beforeSchema);
        assert.deepEqual(data(reopened), beforeData);
        assertFinancialRule(reopened);
        assert.deepEqual(data(reopened), beforeData);
      } finally { reopened.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
