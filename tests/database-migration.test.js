import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("adiciona endereços padrão a banco SQLite existente e preserva a chave estrangeira", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ermes-address-migration-test-"));
  const databasePath = join(temporaryDirectory, "legacy.sqlite");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL
    );
    INSERT INTO users (id, role) VALUES (1, 'client');
  `);
  legacyDatabase.close();

  process.env.ERMES_DB_PATH = databasePath;
  process.env.NODE_ENV = "production";
  const { db } = await import(`../src/database.js?address-migration=${Date.now()}`);

  const table = db.prepare(`SELECT name FROM sqlite_master
                            WHERE type = 'table' AND name = 'client_default_addresses'`).get();
  assert.equal(table.name, "client_default_addresses");

  db.prepare(`INSERT INTO client_default_addresses
                (client_id, postal_code, state, city, neighborhood, street, number)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(1, "01001000", "SP", "São Paulo", "Sé", "Praça da Sé", "1");
  assert.throws(() => db.prepare(`INSERT INTO client_default_addresses
                                    (client_id, postal_code, state, city, neighborhood, street, number)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(999, "01001000", "SP", "São Paulo", "Sé", "Praça da Sé", "1"), /FOREIGN KEY/);

  db.prepare("DELETE FROM users WHERE id = 1").run();
  assert.equal(db.prepare("SELECT count(*) AS total FROM client_default_addresses").get().total, 0);
  db.close();
});
