import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("TentativaEntrega persiste após fechar e reabrir o banco", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-delivery-attempt-persistence-"));
  const databasePath = join(directory, "attempts.sqlite");
  process.env.ERMES_DB_PATH = databasePath;
  process.env.NODE_ENV = "production";

  const { db } = await import(`../src/database.js?attempt-persistence-create=${Date.now()}`);
  db.prepare("INSERT INTO companies (id, name, cnpj, email) VALUES (1, 'Empresa', '11222333000181', 'empresa@ermes.local')").run();
  db.prepare(`INSERT INTO users (id, role, full_name, email, password_hash)
    VALUES (1, 'client', 'Cliente', 'cliente@ermes.local', 'hash')`).run();
  db.prepare(`INSERT INTO users (id, company_id, role, full_name, email, password_hash)
    VALUES (2, 1, 'courier', 'Motoboy', 'motoboy@ermes.local', 'hash')`).run();
  db.prepare(`INSERT INTO orders
    (id, client_id, company_id, status, items_total_cents, payment_status)
    VALUES (1, 1, 1, 'confirmed', 1000, 'paid')`).run();
  db.prepare(`INSERT INTO deliveries (id, order_id, courier_id, status, collected_at)
    VALUES (1, 1, 2, 'in_transit', CURRENT_TIMESTAMP)`).run();
  db.prepare(`INSERT INTO delivery_attempts
    (id, delivery_id, attempt_number, courier_id, status, started_at)
    VALUES (1, 1, 1, 2, 'active', '2026-11-04 10:00:00')`).run();
  assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status)
    VALUES (1, 0, 2, 'active')`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status)
    VALUES (1, 2, 2, 'unknown')`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status, ended_at, end_nature)
    VALUES (1, 2, 2, 'closed_unsuccessfully', CURRENT_TIMESTAMP, 'terminal')`).run(),
  /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status, ended_at)
    VALUES (1, 1, 2, 'completed', CURRENT_TIMESTAMP)`).run(), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO delivery_attempts
    (delivery_id, attempt_number, courier_id, status)
    VALUES (999, 1, 2, 'active')`).run(), /FOREIGN KEY constraint failed/);
  db.close();

  const { db: reopened } = await import(`../src/database.js?attempt-persistence-reopen=${Date.now()}`);
  assert.deepEqual({ ...reopened.prepare(`SELECT delivery_id AS deliveryId,
    attempt_number AS attemptNumber, courier_id AS courierId, status,
    started_at AS startedAt, ended_at AS endedAt
    FROM delivery_attempts WHERE id = 1`).get() }, {
    deliveryId: 1,
    attemptNumber: 1,
    courierId: 2,
    status: "active",
    startedAt: "2026-11-04 10:00:00",
    endedAt: null,
  });
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});
