import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { isCanonicalTimestamp } from "../src/finance.js";
import { canonicalSystemAddress, isSystemAddressBlocked } from "../src/system-address-evidence.js";

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
  db.function("canonical_system_address_json", { deterministic: true }, canonicalSystemAddress);
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
    "delivery_events", "delivery_occurrences", "delivery_revalidations", "system_address_resolutions",
    "system_address_blocks", "financial_entries", "sessions"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  for (const table of ["system_address_resolutions", "system_address_blocks"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, 0);
  }
  const triggers = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").all(triggerName);
  assert.equal(triggers.length, 1);
  assert.equal(normalizeSql(triggers[0].sql), normalizeSql(expectedTrigger));
  for (const name of ["financial_entry_valid_kind_insert", "financial_entry_distribution_owner_insert"]) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name)?.sql;
    assert.match(sql, /recipient_absent/);
    assert.match(sql, /recipient_refused/);
  }
  for (const name of ["system_address_block_insert", "system_address_block_order_confirmation",
    "system_address_block_order_payment", "system_address_block_delivery_insert"]) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name)?.sql;
    assert.match(sql, /json_extract/);
    assert.doesNotMatch(sql, /canonical_address_json\s*=\s*\w+\.destination_snapshot_json/);
  }
  assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
    AND name = 'system_address_block_insert'`).get().sql, /canonical_system_address_json/);
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
      for (const name of ["financial_entry_valid_kind_insert", "financial_entry_distribution_owner_insert"]) {
        db.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} BEFORE INSERT ON financial_entries
          BEGIN SELECT RAISE(ABORT, 'legacy financial rule'); END;`);
      }
      for (const [name, table, operation] of [
        ["system_address_block_insert", "system_address_blocks", "INSERT"],
        ["system_address_block_order_confirmation", "orders", "UPDATE OF status"],
        ["system_address_block_order_payment", "orders", "UPDATE OF payment_status"],
        ["system_address_block_delivery_insert", "deliveries", "INSERT"],
      ]) {
        db.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
          WHEN EXISTS (SELECT 1 FROM system_address_blocks block WHERE
            block.canonical_address_json = NEW.destination_snapshot_json)
          BEGIN SELECT RAISE(ABORT, 'legacy raw address comparison'); END;`);
      }
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

test("blocos persistem apenas JSON canônico e bootstrap exige reconciliação de legado inválido", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-system-address-block-"));
  const path = join(directory, "blocks.sqlite");
  const address = {
    postalCode: "01001000", state: "SP", city: "São Paulo", neighborhood: "Sé",
    street: "Praça da Sé", number: "1", complement: "",
  };
  const canonical = JSON.stringify(address);
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(address).reverse()));
  const unicodeWhitespace = JSON.stringify({ ...address, city: "São Paulo\u00a0" });
  try {
    await initialize(path, 1);
    const db = inspect(path);
    try {
      db.exec(`INSERT INTO companies(id,name,cnpj,email)
        VALUES (1,'Empresa','11222333000181','empresa@teste.local');
        INSERT INTO users(id,role,full_name,email,password_hash)
        VALUES (1,'client','Cliente','cliente@teste.local','hash');
        INSERT INTO users(id,company_id,role,company_profile,full_name,email,password_hash)
        VALUES (2,1,'company','RESPONSAVEL','Empresa','usuario@teste.local','hash'),
          (3,1,'courier',NULL,'Motoboy','motoboy@teste.local','hash');`);
      for (const [id, snapshot] of [[1, canonical], [2, reordered], [3, unicodeWhitespace]]) {
        db.prepare(`INSERT INTO orders(id,client_id,company_id,status,destination_snapshot_json)
          VALUES (?,1,1,'confirmed',?)`).run(id, snapshot);
        db.prepare(`INSERT INTO deliveries(id,order_id,status,return_reason,
          return_reported_at,returned_at)
          VALUES (?,?,'awaiting_revalidation','address_problem',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
          .run(id, id);
        db.prepare(`INSERT INTO delivery_attempts(id,delivery_id,attempt_number,courier_id,
          status,ended_at,end_reason,end_nature)
          VALUES (?,?,1,3,'closed_unsuccessfully',CURRENT_TIMESTAMP,'address_problem','recoverable')`)
          .run(id, id);
        db.prepare(`INSERT INTO delivery_occurrences(id,delivery_id,delivery_attempt_id,type,
          reported_by_user_id,responsibility,classified_by_user_id,classified_at)
          VALUES (?,?,?,'address_problem',3,'SISTEMA',2,CURRENT_TIMESTAMP)`).run(id, id, id);
        db.prepare(`INSERT INTO system_address_resolutions(id,delivery_id,
          delivery_attempt_id,occurrence_id,received_by_user_id)
          VALUES (?,?,?,?,2)`).run(id, id, id, id);
        db.prepare(`UPDATE system_address_resolutions SET resolution='persistent',
          resolved_by_user_id=2,resolved_at=CURRENT_TIMESTAMP,verification_result='Persistente'
          WHERE id=?`).run(id);
        db.prepare("UPDATE deliveries SET status='returned' WHERE id=?").run(id);
      }
      const insert = db.prepare(`INSERT INTO system_address_blocks
        (source_resolution_id,canonical_address_json) VALUES (?,?)`);
      assert.equal(canonicalSystemAddress(reordered), canonical);
      assert.equal(canonicalSystemAddress(unicodeWhitespace), null);
      for (const [id, value] of [[1, reordered], [1, "{invalid"], [3, unicodeWhitespace]]) {
        assert.throws(() => insert.run(id, value), /invalid persistent system address block/);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_address_blocks").get().n, 0);
      insert.run(1, canonical);
      insert.run(2, canonical);
      assert.deepEqual(db.prepare(`SELECT canonical_address_json AS value
        FROM system_address_blocks ORDER BY source_resolution_id`).all().map(({ value }) => value),
      [canonical, canonical]);
      assert.equal(isSystemAddressBlocked(db, reordered), true);
      assert.equal(isSystemAddressBlocked(db, JSON.stringify({ ...address, number: "2" })), false);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    await initialize(path, 1);
    const existing = inspect(path);
    try {
      assert.equal(existing.prepare("SELECT COUNT(*) AS n FROM system_address_blocks").get().n, 2);
      assert.deepEqual(existing.prepare("PRAGMA foreign_key_check").all(), []);
      existing.exec("DROP TRIGGER system_address_block_insert");
      existing.prepare(`INSERT INTO system_address_blocks
        (source_resolution_id,canonical_address_json) VALUES (3,?)`).run(unicodeWhitespace);
    } finally { existing.close(); }
    await assert.rejects(initialize(path, 1), /requires reconciliation/);
    const unreconciled = inspect(path);
    try {
      assert.equal(unreconciled.prepare("SELECT COUNT(*) AS n FROM system_address_blocks").get().n, 3);
      assert.deepEqual(unreconciled.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { unreconciled.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("bootstrap completo migra ocorrências legadas, reverte falha e repete sem perder dados", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-occurrence-bootstrap-"));
  try {
    const freshPath = join(directory, "fresh.sqlite");
    await initialize(freshPath, 1);
    const fresh = inspect(freshPath);
    const financialTable = fresh.prepare("SELECT sql FROM sqlite_master WHERE name='financial_entries'").get().sql;
    fresh.close();
    const path = join(directory, "legacy.sqlite");
    const legacy = inspect(path);
    let beforeData, beforeSchema;
    try {
      legacy.exec(readFileSync(new URL("./fixtures/revalidation-legacy.sql", import.meta.url), "utf8"));
      seed(legacy);
      legacy.exec(`INSERT INTO users(id, company_id, role, full_name, email, password_hash)
        VALUES (2,1,'company','Empresa','e','hash'),(3,1,'courier','Motoboy','m','hash');
        INSERT INTO deliveries(id,order_id,status) VALUES (1,1,'returned');
        INSERT INTO delivery_attempts(id,delivery_id,attempt_number,courier_id,status,ended_at,end_reason,end_nature)
        VALUES (1,1,1,3,'closed_unsuccessfully',CURRENT_TIMESTAMP,'recipient_absent','terminal');
        INSERT INTO delivery_occurrences(id,delivery_id,delivery_attempt_id,type,reported_by_user_id,
          responsibility,classified_by_user_id,classified_at)
        VALUES (42,1,1,'recipient_absent',3,'CLIENTE',2,CURRENT_TIMESTAMP);`);
      legacy.exec(financialTable);
      legacy.exec(`CREATE TRIGGER financial_entry_valid_kind_insert BEFORE INSERT ON financial_entries
        BEGIN SELECT RAISE(ABORT, 'legacy protection'); END;`);
      beforeData = data(legacy); beforeSchema = schema(legacy);
    } finally { legacy.close(); }
    // Falha após DROP/RENAME real, sem desligar constraints ou foreign keys.
    const failed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        const result = original.call(this, sql);
        if (sql.includes('ALTER TABLE delivery_occurrences_next RENAME')) throw new Error('forced migration failure');
        return result;
      };
      await import('./src/database.js');
    `], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", ERMES_DB_PATH: path }, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /forced migration failure/);
    const restored = inspect(path);
    try { assert.deepEqual(schema(restored), beforeSchema); assert.deepEqual(data(restored), beforeData); }
    finally { restored.close(); }
    let finalSchema;
    for (let pass = 0; pass < 2; pass++) {
      await initialize(path, 1);
      const db = inspect(path);
      try {
        assertInitialized(db);
        for (const [table, rows] of Object.entries(beforeData)) {
          const expected = table === "users" ? rows.map((row) => Object.assign(Object.create(null),
            row, { company_profile: row.role === "company" ? "RESPONSAVEL" : null })) : rows;
          assert.deepEqual(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(), expected);
        }
        assert.equal(db.prepare('SELECT COUNT(*) n FROM financial_entries').get().n, 0);
        const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='financial_entry_valid_kind_insert'").get().sql;
        assert.match(trigger, /classifier.role = 'company'/);
        assert.match(trigger, /COUNT\(\*\)/);
        assertFinancialRule(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec("UPDATE orders SET payment_status='paid', payment_paid_at=CURRENT_TIMESTAMP WHERE id=1");
          db.exec(`INSERT INTO financial_entries(order_id,delivery_id,entry_type,component,party_type,party_user_id,amount_cents,reason,idempotency_key)
            VALUES (1,1,'payment','products','client',1,1000,'simulated_payment','probe-payment')`);
          assert.throws(() => db.exec(`INSERT INTO financial_entries(order_id,delivery_id,entry_type,component,party_type,party_user_id,amount_cents,reason,idempotency_key)
            VALUES (1,1,'refund','products','client',1,1000,'confirmation_failed','probe-refund')`), /invalid financial entry kind/);
        } finally { db.exec('ROLLBACK'); }
        if (pass === 0) finalSchema = schema(db); else assert.deepEqual(schema(db), finalSchema);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
