import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { evolveRevalidationSchema } from '../src/revalidation-schema.js';
import { officialDeliveryStatus, officialOrderStatus, DELIVERY_OFFICIAL_STATUSES, ORDER_OFFICIAL_STATUSES } from '../src/official-statuses.js';

function legacy() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./fixtures/revalidation-legacy.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO companies(id,name,cnpj,email) VALUES (1,'Empresa','1','e'),(2,'Outra','2','f');
    INSERT INTO users(id,company_id,role,full_name,email,password_hash) VALUES
    (1,NULL,'client','Cliente','c','hash'),(2,1,'company','Empresa','e','hash'),
    (3,1,'courier','Motoboy','m','hash'),(4,2,'company','Outra','f','hash');
    INSERT INTO orders(id,client_id,company_id,status) VALUES (1,1,1,'confirmed'),(2,1,1,'confirmed');
    INSERT INTO deliveries(id,order_id,status) VALUES (1,1,'returned'),(2,2,'available');
    INSERT INTO delivery_attempts(id,delivery_id,attempt_number,courier_id,status,ended_at,end_reason,end_nature)
      VALUES (1,1,1,3,'closed_unsuccessfully','2026-11-11 10:00:00','recipient_absent','terminal');
    INSERT INTO delivery_occurrences(id,delivery_id,delivery_attempt_id,type,description,reported_by_user_id,
      responsibility,classified_by_user_id,classified_at,analysis_result,evidence_json)
      VALUES (42,1,1,'recipient_absent','Relato histórico',3,'INDEFINIDO',2,
      '2026-11-11 10:01:00','Análise histórica','{"contact":"relato preservado"}');`);
  return db;
}
const schema = db => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name = 'delivery_occurrences' ORDER BY type,name").all();
const occurrences = db => db.prepare('SELECT * FROM delivery_occurrences ORDER BY id').all();
function newCycle(db, deliveryId = 2, attemptId = 2, occurrenceId = 43) {
  db.prepare(`UPDATE deliveries SET status='awaiting_revalidation', return_reason='temporary_external_obstruction',
    return_reported_at=CURRENT_TIMESTAMP, returned_at=CURRENT_TIMESTAMP WHERE id=?`).run(deliveryId);
  db.prepare(`INSERT INTO delivery_attempts(id,delivery_id,attempt_number,courier_id,status,ended_at,end_reason,end_nature)
    VALUES (?,?,1,3,'closed_unsuccessfully',CURRENT_TIMESTAMP,'temporary_external_obstruction','recoverable')`)
    .run(attemptId, deliveryId);
  db.prepare(`INSERT INTO delivery_occurrences(id,delivery_id,delivery_attempt_id,type,reported_by_user_id)
    VALUES (?,?,?,'temporary_external_obstruction',3)`).run(occurrenceId, deliveryId, attemptId);
}
const insertCycle = db => db.prepare(`INSERT INTO delivery_revalidations
  (delivery_id,delivery_attempt_id,occurrence_id,received_by_user_id) VALUES (?,?,?,?)`);

test('projeções oficiais distinguem sucesso, cancelamento e legado sem inferir returned', () => {
  assert.equal(ORDER_OFFICIAL_STATUSES.length, 7);
  assert.equal(DELIVERY_OFFICIAL_STATUSES.length, 10);
  assert.equal(officialDeliveryStatus('completed'), 'FINALIZADA');
  assert.equal(officialDeliveryStatus('cancelled'), 'CANCELADA');
  assert.equal(officialDeliveryStatus('awaiting_revalidation'), 'AGUARDANDO_REVALIDACAO');
  assert.equal(officialOrderStatus('confirmed', 'completed'), 'CONCLUIDO');
  assert.equal(officialOrderStatus('confirmed', 'cancelled', 'client_cancelled_before_pickup'), 'CANCELADO');
  assert.equal(officialOrderStatus('confirmed', 'awaiting_revalidation'), 'CONFIRMADO');
  assert.equal(officialOrderStatus('draft'), 'EM_MONTAGEM');
  assert.equal(officialDeliveryStatus('returned'), null);
  assert.equal(officialOrderStatus('confirmed', 'returned'), null);
  assert.equal(officialOrderStatus('confirmed', 'cancelled'), null);
  assert.equal(officialOrderStatus('confirmed', 'returned', 'client_cancelled_after_pickup'), 'CANCELADO');
  assert.equal(officialDeliveryStatus('toString'), null);
  assert.equal(officialOrderStatus('unknown'), null);
});

test('reconstrói schema real legado preservando dados, IDs, índices e triggers; repete sem backfill', () => {
  const db = legacy();
  try {
    const before = occurrences(db);
    const objects = schema(db).filter(r => r.type !== 'table');
    evolveRevalidationSchema(db);
    assert.deepEqual(occurrences(db), before);
    assert.deepEqual(schema(db).filter(r => r.type !== 'table'), objects);
    assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_revalidations').get().n, 0);
    assert.throws(() => db.exec('DELETE FROM delivery_occurrences WHERE id=42'), /cannot be deleted/);
    assert.throws(() => db.exec("UPDATE delivery_occurrences SET evidence_json='{}' WHERE id=42"), /immutable|final/);
    newCycle(db);
    assert.equal(insertCycle(db).run(2,2,43,2).changes, 1);
    evolveRevalidationSchema(db);
    assert.deepEqual(db.prepare('SELECT * FROM delivery_occurrences WHERE id=42').get(), before[0]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_revalidations').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { db.close(); }
});

test('falha após cópia, DROP e RENAME reverte tudo; a mesma conexão retoma com sucesso', () => {
  const db = legacy();
  try {
    const beforeSchema = schema(db), beforeData = occurrences(db);
    const exec = db.exec.bind(db); let reachedRename = false;
    db.exec = sql => {
      const result = exec(sql);
      if (sql.includes('ALTER TABLE delivery_occurrences_next RENAME TO delivery_occurrences')) {
        reachedRename = true;
        assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='delivery_occurrences'").get().sql.includes('temporary_external_obstruction'), true);
        assert.deepEqual(occurrences(db), beforeData);
        throw new Error('forced failure after rename');
      }
      return result;
    };
    assert.throws(() => evolveRevalidationSchema(db), /forced failure after rename/);
    db.exec = exec;
    assert.equal(reachedRename, true);
    assert.deepEqual(schema(db), beforeSchema);
    assert.deepEqual(occurrences(db), beforeData);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='delivery_occurrences_next'").get().n, 0);
    assert.throws(() => db.exec('DELETE FROM delivery_occurrences WHERE id=42'), /cannot be deleted/);
    assert.throws(() => db.exec('DELETE FROM deliveries WHERE id=1'), /cannot be deleted/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM deliveries WHERE id=1').get().n, 1);
    assert.throws(() => db.exec("UPDATE delivery_occurrences SET responsibility='SISTEMA' WHERE id=42"), /final/);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    evolveRevalidationSchema(db);
    assert.deepEqual(db.prepare('SELECT * FROM delivery_occurrences WHERE id=42').get(), beforeData[0]);
    newCycle(db);
    assert.throws(() => insertCycle(db).run(2,1,43,2), /invalid revalidation cycle/);
    assert.throws(() => insertCycle(db).run(2,2,42,2), /invalid revalidation cycle/);
    assert.equal(insertCycle(db).run(2,2,43,2).changes, 1);
    assert.throws(() => db.exec('DELETE FROM delivery_revalidations'), /cannot be deleted/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('banco rejeita ciclos cruzados, natureza incompatível, recebedores e verificadores não autorizados', () => {
  const db = legacy();
  try {
    evolveRevalidationSchema(db); newCycle(db);
    const insert = insertCycle(db);
    for (const values of [[2,1,43,2], [2,2,42,2], [1,2,42,2]]) {
      assert.throws(() => insert.run(...values), /invalid revalidation cycle/);
    }
    db.exec(`INSERT INTO delivery_attempts(id,delivery_id,attempt_number,courier_id,status,ended_at,end_reason,end_nature)
      VALUES (3,2,2,3,'closed_unsuccessfully',CURRENT_TIMESTAMP,'temporary_external_obstruction','recoverable');`);
    assert.throws(() => insert.run(2,3,43,2), /invalid revalidation cycle/);
    assert.throws(() => insert.run(2,2,43,2), /invalid revalidation cycle/);
    db.exec('DELETE FROM delivery_attempts WHERE id=3');
    for (const type of ['recipient_absent','recipient_refused','confirmation_failed']) {
      const oc = db.prepare(`INSERT INTO delivery_occurrences(delivery_id,delivery_attempt_id,type,reported_by_user_id)
        VALUES (2,2,?,3)`).run(type).lastInsertRowid;
      assert.throws(() => insert.run(2,2,oc,2), /invalid revalidation cycle/);
    }
    for (const user of [1,3,4]) assert.throws(() => insert.run(2,2,43,user), /invalid revalidation cycle/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_revalidations').get().n, 0);
    const id = insert.run(2,2,43,2).lastInsertRowid;
    const verify = db.prepare(`UPDATE delivery_revalidations SET verified_by_user_id=?,
      verified_at=CURRENT_TIMESTAMP,verification_result='Verificado' WHERE id=?`);
    for (const user of [1,3,4]) assert.throws(() => verify.run(user,id), /invalid revalidation verifier/);
    assert.equal(db.prepare('SELECT verified_at FROM delivery_revalidations WHERE id=?').get(id).verified_at, null);
    assert.equal(verify.run(2,id).changes, 1);
    assert.throws(() => verify.run(2,id), /immutable/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
