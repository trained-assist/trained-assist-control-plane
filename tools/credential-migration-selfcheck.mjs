import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { unstable_splitSqlQuery } = require('wrangler');
const migration = readFileSync(new URL('../migrations/0013_credential_ready.sql', import.meta.url), 'utf8');
const statements = unstable_splitSqlQuery(migration);
assert.equal(statements.length, 4);
const guard = statements.find(statement => statement.startsWith('CREATE TRIGGER credential_ready_guard'));
assert.ok(guard);
assert.doesNotMatch(guard, /\bCASE\b/i);
assert.match(guard, /WHEN NOT EXISTS[\s\S]*AND NOT EXISTS[\s\S]*BEGIN\s+SELECT RAISE\(ABORT, 'credential_wait_mismatch'\);\s+END$/);

const database = new DatabaseSync(':memory:');
try {
  for (let migrationNumber = 1; migrationNumber <= 12; migrationNumber++) {
    const prefix = `${String(migrationNumber).padStart(4, '0')}_`;
    const name = readdirSync(new URL('../migrations/', import.meta.url)).find(filename => filename.startsWith(prefix));
    assert.ok(name, `missing migration ${prefix}`);
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const statement of statements) database.exec(statement);
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'credential_ready_%'").get().count, 2);
  console.log('credential migration: Wrangler statement parsing and SQLite installation passed (not remote D1 validation)');
} finally {
  database.close();
}
