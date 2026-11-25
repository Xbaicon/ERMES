import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("migração empresarial preserva usuários e sessões e aplica integridade em banco novo e legado", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-company-profile-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      cnpj TEXT NOT NULL UNIQUE, email TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
      role TEXT NOT NULL, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO companies VALUES (1, 'Empresa', '11222333000181', 'e@local.test');
    INSERT INTO users (id, company_id, role, full_name, email, password_hash) VALUES
      (1, 1, 'company', 'Responsável', 'owner@local.test', 'hash'),
      (2, NULL, 'client', 'Cliente', 'client@local.test', 'hash'),
      (3, 1, 'courier', 'Motoboy', 'courier@local.test', 'hash');
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('token', 1, '2099-01-01');
  `);
  legacy.close();
  process.env.ERMES_DB_PATH = path;
  process.env.NODE_ENV = "production";
  let db;
  try {
    ({ db } = await import(`../src/database.js?company-profile-legacy=${Date.now()}`));
    const users = () => db.prepare("SELECT id, company_id, role, email, password_hash, company_profile FROM users ORDER BY id").all();
    const migrated = users();
    assert.deepEqual(migrated.map(({ company_profile }) => company_profile), ["RESPONSAVEL", null, null]);
    assert.equal(db.prepare("SELECT user_id FROM sessions WHERE token_hash = 'token'").get().user_id, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.prepare("INSERT INTO users (company_id, role, full_name, email, password_hash) VALUES (1, 'company', 'No profile', 'x@local.test', 'hash')").run());
    assert.throws(() => db.prepare("UPDATE users SET company_profile = 'ATENDENTE' WHERE id = 2").run());
    assert.throws(() => db.prepare("UPDATE users SET company_profile = NULL WHERE id = 1").run());
    assert.throws(() => db.prepare("UPDATE users SET company_profile = 'INVALIDO' WHERE id = 1").run());
    db.close();
    ({ db } = await import(`../src/database.js?company-profile-repeat=${Date.now()}`));
    assert.deepEqual(users(), migrated);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("banco novo exige perfil válido somente de company", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ermes-company-profile-new-"));
  process.env.ERMES_DB_PATH = join(directory, "new.sqlite");
  process.env.NODE_ENV = "production";
  const { db } = await import(`../src/database.js?company-profile-new=${Date.now()}`);
  try {
    db.prepare("INSERT INTO companies (name, cnpj, email) VALUES ('Nova', '22333444000181', 'nova@local.test')").run();
    for (const [role, profile] of [["company", null], ["company", "INVALIDO"],
      ["client", "RESPONSAVEL"], ["courier", "ATENDENTE"]]) {
      assert.throws(() => db.prepare(`INSERT INTO users
        (company_id, role, company_profile, full_name, email, password_hash)
        VALUES (?, ?, ?, 'Teste', ?, 'hash')`).run(role === "client" ? null : 1,
        role, profile, `${role}-${profile}@local.test`));
    }
    db.prepare(`INSERT INTO users (company_id, role, company_profile, full_name, email, password_hash)
      VALUES (1, 'company', 'ATENDENTE', 'Atendente', 'atendente@local.test', 'hash')`).run();
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
