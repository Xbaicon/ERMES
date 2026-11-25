import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const boot = "import { db } from './src/database.js'; db.close();";

function run(databasePath, source, extraEnv = {}) {
  const env = { ...process.env, ERMES_DB_PATH: databasePath, NODE_ENV: "production", ...extraEnv };
  delete env.ERMES_CONFIRMATION_CODE_KEY;
  delete env.ERMES_CONFIRMATION_KEY_PATH;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root, env, encoding: "utf8",
  });
}

function successful(databasePath, source, extraEnv = {}) {
  const result = run(databasePath, source, extraEnv);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}

function rows(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return Object.fromEntries(["orders", "order_items", "deliveries", "order_adjustments",
      "order_adjustment_validations", "financial_entries", "delivery_events"]
      .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        .map((row) => ({ ...row }))]));
  } finally { db.close(); }
}

const fixture = `
  import { db, transaction } from './src/database.js';
  import { recordPaymentInTransaction } from './src/finance.js';
  import { createDeliveryForEligibleOrderInTransaction } from './src/delivery-creation.js';
  import { proposeAdjustment } from './src/order-adjustments.js';
  const id = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);
  const company = id("INSERT INTO companies (name,email,cnpj) VALUES ('company','company@local.test','company')");
  const client = id("INSERT INTO users (role,full_name,email,password_hash) VALUES ('client','client','client@local.test','unused')");
  const owner = id("INSERT INTO users (role,company_profile,full_name,email,company_id,password_hash) VALUES ('company','RESPONSAVEL','owner','owner@local.test',?,'unused')", company);
  const first = id("INSERT INTO products (company_id,name,price_cents,unit_weight_kg,is_available) VALUES (?,'first',100,1,1)", company);
  const replacement = id("INSERT INTO products (company_id,name,price_cents,unit_weight_kg,is_available) VALUES (?,'replacement',101,1,1)", company);
  const address = JSON.stringify({postalCode:'01001000',state:'SP',city:'São Paulo',neighborhood:'Centro',street:'Rua Um',number:'10'});
  const recipient = JSON.stringify({type:'other',name:'Recipient'});
  const created = transaction(() => {
    const order = id("INSERT INTO orders (client_id,company_id,status,payment_status,payment_paid_at,confirmed_at,destination_snapshot_json,recipient_snapshot_json,items_total_cents,freight_total_cents,version) VALUES (?,?,'confirmed','paid',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,100,NULL,4)", client, company, address, recipient);
    db.prepare('INSERT INTO order_items (order_id,product_id,quantity,unit_price_cents,unit_weight_kg) VALUES (?,?,1,100,1)').run(order, first);
    const { delivery, confirmationCode } = createDeliveryForEligibleOrderInTransaction(order);
    const { timestamp } = db.prepare('SELECT payment_paid_at AS timestamp FROM orders WHERE id=?').get(order);
    recordPaymentInTransaction(db, { id:order,clientId:client,itemsTotalCents:100,
      freightTotalCents:null,paymentPaidAt:timestamp }, delivery.id);
    return { order, delivery: delivery.id, confirmationCode };
  });
  const proposal = process.env.ERMES_KEY_TEST_PROPOSAL === '1'
    ? proposeAdjustment(created.delivery, company, owner,
      { version:4,items:[{productId:replacement,quantity:1}] }) : null;
  console.log(JSON.stringify({ ...created, client, proposalId:proposal?.id ?? null }));
  db.close();
`;

test("chave local ausente falha sem substituir dados protegidos e aceita restauração", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-key-integrity-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  await context.test("proposta pendente e chave diferente", () => {
    const databasePath = join(directory, "pending.sqlite");
    const keyPath = `${databasePath}.confirmation-key`;
    const setup = successful(databasePath, fixture, { ERMES_KEY_TEST_PROPOSAL: "1" });
    const originalKey = readFileSync(keyPath);
    const before = rows(databasePath);
    rmSync(keyPath);
    const missing = run(databasePath, boot);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Chave criptográfica local ausente.*reconciliação/);
    assert.equal(existsSync(keyPath), false);
    assert.deepEqual(rows(databasePath), before);

    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    const decision = `import { db } from './src/database.js';
      import { decideAdjustment } from './src/order-adjustments.js';
      try { decideAdjustment(${setup.delivery}, ${setup.proposalId}, ${setup.client}, 'accept');
        console.log(JSON.stringify({ accepted: true })); }
      catch (error) { console.log(JSON.stringify({ accepted: false, statusCode: error.statusCode,
        message: error.message })); } db.close();`;
    const wrong = successful(databasePath, decision);
    assert.equal(wrong.accepted, false);
    assert.equal(wrong.statusCode, 409);
    assert.match(wrong.message, /validação íntegra/);
    assert.deepEqual(rows(databasePath), before);

    writeFileSync(keyPath, originalKey, { mode: 0o600 });
    const restored = successful(databasePath, `import { db } from './src/database.js';
      import { decideAdjustment } from './src/order-adjustments.js';
      import { decryptConfirmationCode } from './src/security.js';
      decideAdjustment(${setup.delivery}, ${setup.proposalId}, ${setup.client}, 'accept');
      const applied = decideAdjustment(${setup.delivery}, ${setup.proposalId}, ${setup.client}, 'pay');
      const delivery = db.prepare('SELECT confirmation_code_ciphertext AS code FROM deliveries WHERE id = ?')
        .get(${setup.delivery});
      const item = db.prepare('SELECT unit_price_cents AS price FROM order_items WHERE order_id = ?')
        .get(${setup.order});
      const payment = db.prepare("SELECT amount_cents AS amount FROM financial_entries WHERE order_id = ? AND reason = 'order_adjustment'")
        .get(${setup.order});
      console.log(JSON.stringify({ state: applied.state, price: item.price, payment: payment.amount,
        code: decryptConfirmationCode(delivery.code), violations: db.prepare('PRAGMA foreign_key_check').all() }));
      db.close();`);
    assert.deepEqual(restored, { state: "applied", price: 101, payment: 1,
      code: setup.confirmationCode, violations: [] });
    assert.equal(rows(databasePath).order_adjustment_validations[0].seal,
      before.order_adjustment_validations[0].seal);
  });

  await context.test("código cifrado sem evidência também bloqueia geração", () => {
    const databasePath = join(directory, "ciphertext.sqlite");
    const keyPath = `${databasePath}.confirmation-key`;
    successful(databasePath, fixture);
    assert.equal(rows(databasePath).order_adjustments.length, 0);
    const before = rows(databasePath);
    rmSync(keyPath);
    const missing = run(databasePath, boot);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Chave criptográfica local ausente/);
    assert.equal(existsSync(keyPath), false);
    assert.deepEqual(rows(databasePath), before);
  });

  await context.test("evidência histórica bloqueia geração mesmo sem código cifrado", () => {
    for (const state of ["pending", "applied", "rejected"]) {
      const databasePath = join(directory, `evidence-${state}.sqlite`);
      const keyPath = `${databasePath}.confirmation-key`;
      const setup = successful(databasePath, fixture, { ERMES_KEY_TEST_PROPOSAL: "1" });
      if (state !== "pending") {
        successful(databasePath, `import { db } from './src/database.js';
          import { decideAdjustment } from './src/order-adjustments.js';
          decideAdjustment(${setup.delivery}, ${setup.proposalId}, ${setup.client},
            '${state === "rejected" ? "reject" : "accept"}');
          ${state === "applied" ? `decideAdjustment(${setup.delivery}, ${setup.proposalId}, ${setup.client}, 'pay');` : ""}
          db.close();`);
      }
      const db = new DatabaseSync(databasePath);
      db.prepare("UPDATE deliveries SET confirmation_code_ciphertext = NULL").run();
      db.close();
      assert.equal(rows(databasePath).order_adjustment_validations.length, 1);
      const before = rows(databasePath);
      rmSync(keyPath);
      const missing = run(databasePath, boot);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /Chave criptográfica local ausente/);
      assert.equal(existsSync(keyPath), false);
      assert.deepEqual(rows(databasePath), before);
    }
  });

  await context.test("banco vazio ou comum sem dependência pode criar chave", () => {
    const databasePath = join(directory, "ordinary.sqlite");
    const keyPath = `${databasePath}.confirmation-key`;
    successful(databasePath, boot);
    assert.equal(existsSync(keyPath), false);
    const makeKey = `import { db } from './src/database.js';
      import { encryptConfirmationCode } from './src/security.js';
      encryptConfirmationCode('123456'); db.close();`;
    successful(databasePath, makeKey);
    const oldKey = readFileSync(keyPath);
    successful(databasePath, `import { db } from './src/database.js';
      db.prepare("INSERT INTO companies (name, email, cnpj) VALUES ('ordinary','ordinary@local.test','ordinary')").run();
      db.close();`);
    rmSync(keyPath);
    successful(databasePath, makeKey);
    assert.equal(existsSync(keyPath), true);
    assert.notDeepEqual(readFileSync(keyPath), oldKey);
    assert.deepEqual(rows(databasePath).order_adjustments, []);
  });
});
