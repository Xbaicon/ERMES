import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("migra contador legado somente com evidência inequívoca e não o sincroniza novamente", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-attempt-counter-migration-"));
  const databasePath = join(directory, "legacy-attempts.sqlite");
  process.env.ERMES_DB_PATH = databasePath;
  process.env.NODE_ENV = "production";

  const { db: initialized } = await import(`../src/database.js?attempt-counter-initial=${Date.now()}`);
  initialized.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = ON; ALTER TABLE delivery_attempts DROP COLUMN invalid_code_attempts;");
  legacy.exec(`
    INSERT INTO companies (id, name, cnpj, email)
      VALUES (1, 'Empresa', '11222333000181', 'empresa@ermes.local');
    INSERT INTO users (id, company_id, role, full_name, email, password_hash)
      VALUES
        (1, NULL, 'client', 'Cliente', 'cliente@ermes.local', 'hash'),
        (2, 1, 'courier', 'Motoboy 1', 'motoboy1@ermes.local', 'hash'),
        (3, 1, 'courier', 'Motoboy 2', 'motoboy2@ermes.local', 'hash');
    INSERT INTO couriers (user_id, vehicle_type) VALUES (2, 'motorcycle'), (3, 'motorcycle');
    INSERT INTO orders (id, client_id, company_id, status, items_total_cents)
      VALUES (1, 1, 1, 'confirmed', 1000), (2, 1, 1, 'confirmed', 1000);
    INSERT INTO deliveries
      (id, order_id, courier_id, status, invalid_code_attempts, collected_at)
      VALUES
        (1, 1, 2, 'awaiting_confirmation', 2, '2026-11-01 10:00:00'),
        (2, 2, 3, 'awaiting_confirmation', 2, '2026-11-02 10:00:00');
    INSERT INTO delivery_attempts
      (id, delivery_id, attempt_number, courier_id, status, started_at)
      VALUES (1, 1, 1, 2, 'active', '2026-11-01 10:00:00');
    INSERT INTO delivery_attempts
      (id, delivery_id, attempt_number, courier_id, status, started_at,
       ended_at, end_reason, end_nature)
      VALUES (2, 2, 1, 3, 'closed_unsuccessfully', '2026-11-02 08:00:00',
        '2026-11-02 09:00:00', 'courier_failure_after_pickup', 'recoverable');
    INSERT INTO delivery_attempts
      (id, delivery_id, attempt_number, courier_id, status, started_at)
      VALUES (3, 2, 2, 3, 'active', '2026-11-02 10:00:00');
    INSERT INTO delivery_events
      (delivery_id, actor_user_id, event_type, details_json, occurred_at)
      VALUES
        (1, 2, 'confirmation_code_invalid', '{"attempt":1,"remainingAttempts":2}',
          '2026-11-01 10:10:00'),
        (1, 2, 'confirmation_code_invalid', '{"attempt":2,"remainingAttempts":1}',
          '2026-11-01 10:20:00'),
        (2, 3, 'confirmation_code_invalid', '{"attempt":1,"remainingAttempts":2}',
          '2026-11-02 10:10:00'),
        (2, 3, 'confirmation_code_invalid', '{"attempt":2,"remainingAttempts":1}',
          '2026-11-02 10:20:00');
  `);
  const insertCase = (id, counter, status, events,
    deliveryStatus = 'awaiting_confirmation', returnReason = null) => {
    const courierId = id + 10;
    legacy.prepare(`INSERT INTO users (id, company_id, role, full_name, email, password_hash)
      VALUES (?, 1, 'courier', ?, ?, 'hash')`)
      .run(courierId, `Motoboy ${id}`, `motoboy${id}@ermes.local`);
    legacy.prepare("INSERT INTO couriers (user_id, vehicle_type) VALUES (?, 'motorcycle')")
      .run(courierId);
    legacy.prepare(`INSERT INTO orders (id, client_id, company_id, status, items_total_cents)
      VALUES (?, 1, 1, 'confirmed', 1000)`).run(id);
    legacy.prepare(`INSERT INTO deliveries
      (id, order_id, courier_id, status, return_reason, invalid_code_attempts, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, '2026-11-03 10:00:00')`)
      .run(id, id, courierId, deliveryStatus, returnReason, counter);
    legacy.prepare(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, courier_id, status, started_at, ended_at,
       end_reason, end_nature)
      VALUES (?, 1, ?, ?, '2026-11-03 10:00:00', ?, ?, ?)`)
      .run(id, courierId, status,
        ['completed', 'closed_unsuccessfully'].includes(status) ? '2026-11-03 10:30:00' : null,
        status === 'closed_unsuccessfully' ? 'confirmation_failed' : null,
        status === 'closed_unsuccessfully' ? 'terminal' : null);
    for (const [type, attempt, remaining, timestamp] of events) {
      legacy.prepare(`INSERT INTO delivery_events
        (delivery_id, actor_user_id, event_type, details_json, occurred_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, courierId, type,
        JSON.stringify({ attempt, remainingAttempts: remaining }), timestamp);
    }
  };
  const invalid = 'confirmation_code_invalid';
  const failed = 'confirmation_failed';
  const at = (minute) => `2026-11-03 10:${String(minute).padStart(2, '0')}:00`;
  insertCase(3, 1, 'active', [[invalid, 1, 2, at(5)]]);
  insertCase(4, 3, 'returning', [[invalid, 1, 2, at(5)],
    [invalid, 2, 1, at(10)], [failed, 3, 0, at(15)]], 'returning', 'confirmation_failed');
  insertCase(5, 2, 'active', [[invalid, 1, 2, at(10)], [invalid, 2, 1, at(5)]]);
  insertCase(6, 3, 'completed', [[invalid, 1, 2, at(5)],
    [invalid, 2, 1, at(10)], [failed, 3, 0, at(15)]]);
  insertCase(7, 2, 'active', [[invalid, 1, 2, at(5)], [failed, 2, 1, at(10)]]);
  insertCase(8, 3, 'returning', [[invalid, 1, 2, at(5)],
    [invalid, 3, 0, at(10)], [failed, 3, 0, at(15)]]);
  insertCase(9, 3, 'returning', [[invalid, 1, 2, at(5)],
    [invalid, 2, 0, at(10)], [failed, 3, 0, at(15)]]);
  const threeErrors = [[invalid, 1, 2, at(5)], [invalid, 2, 1, at(10)],
    [failed, 3, 0, at(15)]];
  insertCase(10, 3, 'returning', threeErrors, 'awaiting_confirmation', 'confirmation_failed');
  insertCase(11, 3, 'returning', threeErrors, 'returning', 'recipient_absent');
  insertCase(12, 3, 'closed_unsuccessfully', threeErrors, 'returned', 'confirmation_failed');
  legacy.close();

  const { db: migrated } = await import(`../src/database.js?attempt-counter-migrated=${Date.now()}`);
  const columns = migrated.prepare("PRAGMA table_info(delivery_attempts)").all()
    .map(({ name }) => name);
  assert.ok(columns.includes("invalid_code_attempts"));
  assert.equal(migrated.prepare(`SELECT invalid_code_attempts AS value
    FROM delivery_attempts WHERE id = 1`).get().value, 2);
  assert.deepEqual(migrated.prepare(`SELECT invalid_code_attempts AS value
    FROM delivery_attempts WHERE delivery_id = 2 ORDER BY attempt_number`).all()
    .map(({ value }) => value), [0, 0]);
  assert.deepEqual(migrated.prepare(`SELECT invalid_code_attempts AS value
    FROM deliveries WHERE id IN (1, 2) ORDER BY id`).all().map(({ value }) => value), [2, 2]);
  assert.deepEqual(migrated.prepare(`SELECT delivery_id AS deliveryId,
    invalid_code_attempts AS value FROM delivery_attempts
    WHERE delivery_id BETWEEN 3 AND 12 ORDER BY delivery_id`).all().map(
    ({ deliveryId, value }) => [deliveryId, value],
  ), [[3, 1], [4, 3], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0],
    [10, 0], [11, 0], [12, 3]]);
  for (const value of [-1, 1.5, 4]) {
    assert.throws(() => migrated.prepare(`UPDATE delivery_attempts
      SET invalid_code_attempts = ? WHERE id = 1`).run(value), /CHECK constraint failed/);
  }
  for (const value of [0, 1, 2, 3]) {
    migrated.prepare(`UPDATE delivery_attempts SET invalid_code_attempts = ? WHERE id = 1`).run(value);
    assert.equal(migrated.prepare(`SELECT invalid_code_attempts AS value
      FROM delivery_attempts WHERE id = 1`).get().value, value);
  }
  migrated.prepare("UPDATE delivery_attempts SET invalid_code_attempts = 2 WHERE id = 1").run();
  migrated.prepare("UPDATE deliveries SET invalid_code_attempts = 3 WHERE id = 1").run();
  migrated.close();

  const { db: reopened } = await import(`../src/database.js?attempt-counter-reopened=${Date.now()}`);
  assert.equal(reopened.prepare(`SELECT invalid_code_attempts AS value
    FROM delivery_attempts WHERE id = 1`).get().value, 2);
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test("falha durante transferência reverte a coluna e permite nova tentativa", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-attempt-counter-retry-"));
  const databasePath = join(directory, "legacy-attempts.sqlite");
  process.env.ERMES_DB_PATH = databasePath;
  process.env.NODE_ENV = "production";
  const { db: initialized } = await import(`../src/database.js?attempt-retry-initial=${Date.now()}`);
  initialized.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`PRAGMA foreign_keys = ON;
    ALTER TABLE delivery_attempts DROP COLUMN invalid_code_attempts;
    INSERT INTO companies (id, name, cnpj, email)
      VALUES (1, 'Empresa', '11222333000181', 'empresa@ermes.local');
    INSERT INTO users (id, company_id, role, full_name, email, password_hash)
      VALUES (1, NULL, 'client', 'Cliente', 'cliente@ermes.local', 'hash'),
        (2, 1, 'courier', 'Motoboy', 'motoboy@ermes.local', 'hash');
    INSERT INTO couriers (user_id, vehicle_type) VALUES (2, 'motorcycle');
    INSERT INTO orders (id, client_id, company_id, status, items_total_cents)
      VALUES (1, 1, 1, 'confirmed', 1000);
    INSERT INTO deliveries (id, order_id, courier_id, status, invalid_code_attempts, collected_at)
      VALUES (1, 1, 2, 'awaiting_confirmation', 1, '2026-11-01 10:00:00');
    INSERT INTO delivery_attempts (id, delivery_id, attempt_number, courier_id, status, started_at)
      VALUES (1, 1, 1, 2, 'active', '2026-11-01 10:00:00');
    INSERT INTO delivery_events (delivery_id, actor_user_id, event_type, details_json, occurred_at)
      VALUES (1, 2, 'confirmation_code_invalid', '{"attempt":1,"remainingAttempts":2}',
        '2026-11-01 10:05:00');
    CREATE TRIGGER fail_counter_transfer BEFORE UPDATE ON delivery_attempts
      BEGIN SELECT RAISE(ABORT, 'forced counter transfer failure'); END;`);
  legacy.close();

  await assert.rejects(import(`../src/database.js?attempt-retry-failed=${Date.now()}`),
    /forced counter transfer failure/);
  const afterFailure = new DatabaseSync(databasePath);
  assert.equal(afterFailure.prepare("PRAGMA table_info(delivery_attempts)").all()
    .some(({ name }) => name === "invalid_code_attempts"), false);
  assert.equal(afterFailure.prepare(`SELECT invalid_code_attempts AS value
    FROM deliveries WHERE id = 1`).get().value, 1);
  afterFailure.exec("DROP TRIGGER fail_counter_transfer");
  afterFailure.close();

  const { db: retried } = await import(`../src/database.js?attempt-retry-success=${Date.now()}`);
  assert.equal(retried.prepare("PRAGMA table_info(delivery_attempts)").all()
    .some(({ name }) => name === "invalid_code_attempts"), true);
  assert.equal(retried.prepare(`SELECT invalid_code_attempts AS value
    FROM delivery_attempts WHERE id = 1`).get().value, 1);
  retried.close();
  rmSync(directory, { recursive: true, force: true });
});
