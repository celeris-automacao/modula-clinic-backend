/**
 * Integration test — verifies that every migration file applies cleanly to a
 * completely empty PostgreSQL database, and that the resulting schema contains
 * all expected tables with the correct columns and constraints.
 *
 * Run with:  pnpm --filter @workspace/db run test:migrate
 *
 * Steps:
 *   1. Creates a throwaway database on the same Postgres server
 *   2. Runs the full migration stack against the empty database
 *   3. Asserts all 9 tables exist
 *   4. Spot-checks representative columns and constraints
 *   5. Drops the throwaway database (also on failure)
 *
 * Exits non-zero (loudly) on any failure.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

function fail(message: string): never {
  console.error(`❌  ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

// ---------------------------------------------------------------------------
// Expected schema: all 9 tables and a representative column subset each must
// satisfy so we catch both missing tables AND missing columns.
// ---------------------------------------------------------------------------
const EXPECTED_TABLES: Record<string, string[]> = {
  patients: ["id", "name", "goal", "user_id", "created_at"],
  protocols: ["id", "name", "description", "duration_weeks", "is_preset"],
  protocol_tasks: ["id", "protocol_id", "title", "category", "frequency", "mandatory"],
  treatments: ["id", "patient_id", "protocol_id", "status", "started_at"],
  task_logs: ["id", "patient_id", "treatment_id", "task_id", "log_date", "created_at"],
  insights: ["id", "patient_id", "summary", "risk_level", "created_at"],
  alerts: ["id", "patient_id", "patient_name", "message", "risk_level", "created_at"],
  sessions: ["sid", "sess", "expire"],
  users: ["id", "email", "first_name", "last_name", "created_at", "updated_at", "notification_email"],
};

const EXPECTED_TABLE_COUNT = Object.keys(EXPECTED_TABLES).length; // 9

// Unique constraints that must exist after migrations
const EXPECTED_UNIQUE_CONSTRAINTS = [
  { table: "patients", column: "user_id" },
  { table: "users", column: "email" },
];

// Foreign-key constraints (table → referenced table)
const EXPECTED_FK_CONSTRAINTS: Array<{ table: string; references: string }> = [
  { table: "protocol_tasks", references: "protocols" },
  { table: "treatments", references: "patients" },
  { table: "treatments", references: "protocols" },
  { table: "task_logs", references: "patients" },
  { table: "task_logs", references: "treatments" },
  { table: "task_logs", references: "protocol_tasks" },
  { table: "insights", references: "patients" },
  { table: "alerts", references: "patients" },
];

async function main() {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) fail("DATABASE_URL must be set");

  const testDbName = `migrate_test_${Date.now()}_${process.pid}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${testDbName}`;

  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  console.log(`🧪  Creating fresh database "${testDbName}"…`);
  await admin.query(`CREATE DATABASE "${testDbName}"`);

  let exitCode = 0;
  const pool = new pg.Pool({ connectionString: testUrl.href, max: 1 });

  try {
    // -----------------------------------------------------------------------
    // 1. Run all migrations against the empty database
    // -----------------------------------------------------------------------
    console.log("🧪  Running migrations against the empty database…");
    execFileSync(
      "pnpm",
      ["--filter", "@workspace/db", "migrate"],
      { env: { ...process.env, DATABASE_URL: testUrl.href }, stdio: "inherit" },
    );
    console.log("✅  migrate script exited 0");

    // -----------------------------------------------------------------------
    // 2. Verify all 9 tables exist
    // -----------------------------------------------------------------------
    const tablesResult = await pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM   pg_tables
      WHERE  schemaname = 'public'
      ORDER  BY tablename
    `);
    const actualTables = new Set(tablesResult.rows.map((r) => r.tablename));

    // Drizzle migrations create this bookkeeping table; exclude it
    actualTables.delete("__drizzle_migrations");

    console.log(`\n🧪  Tables found: ${[...actualTables].join(", ")}`);

    assert(
      actualTables.size === EXPECTED_TABLE_COUNT,
      `Expected ${EXPECTED_TABLE_COUNT} tables, found ${actualTables.size}: ${[...actualTables].join(", ")}`,
    );

    for (const tableName of Object.keys(EXPECTED_TABLES)) {
      assert(
        actualTables.has(tableName),
        `Table "${tableName}" is missing from the migrated schema`,
      );
    }
    console.log(`✅  All ${EXPECTED_TABLE_COUNT} expected tables are present`);

    // -----------------------------------------------------------------------
    // 3. Verify representative columns for each table
    // -----------------------------------------------------------------------
    const columnsResult = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM   information_schema.columns
      WHERE  table_schema = 'public'
    `);
    const columnsByTable: Record<string, Set<string>> = {};
    for (const row of columnsResult.rows) {
      (columnsByTable[row.table_name] ??= new Set()).add(row.column_name);
    }

    for (const [table, requiredCols] of Object.entries(EXPECTED_TABLES)) {
      const actual = columnsByTable[table] ?? new Set();
      for (const col of requiredCols) {
        assert(
          actual.has(col),
          `Column "${col}" is missing from table "${table}" (found: ${[...actual].join(", ")})`,
        );
      }
    }
    console.log("✅  All expected columns are present");

    // -----------------------------------------------------------------------
    // 4. Verify unique constraints
    // -----------------------------------------------------------------------
    const uniqueResult = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT kcu.table_name, kcu.column_name
      FROM   information_schema.table_constraints tc
      JOIN   information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema    = kcu.table_schema
      WHERE  tc.constraint_type = 'UNIQUE'
      AND    tc.table_schema    = 'public'
    `);
    const uniqueSet = new Set(
      uniqueResult.rows.map((r) => `${r.table_name}.${r.column_name}`),
    );

    for (const { table, column } of EXPECTED_UNIQUE_CONSTRAINTS) {
      assert(
        uniqueSet.has(`${table}.${column}`),
        `Expected UNIQUE constraint on ${table}.${column} — not found`,
      );
    }
    console.log("✅  Unique constraints are in place");

    // -----------------------------------------------------------------------
    // 5. Verify foreign-key constraints
    // -----------------------------------------------------------------------
    const fkResult = await pool.query<{ from_table: string; to_table: string }>(`
      SELECT kcu.table_name         AS from_table,
             ccu.table_name         AS to_table
      FROM   information_schema.table_constraints tc
      JOIN   information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema   = kcu.table_schema
      JOIN   information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name
             AND tc.table_schema   = rc.constraint_schema
      JOIN   information_schema.constraint_column_usage ccu
             ON rc.unique_constraint_name = ccu.constraint_name
             AND rc.unique_constraint_schema = ccu.table_schema
      WHERE  tc.constraint_type = 'FOREIGN KEY'
      AND    tc.table_schema    = 'public'
    `);
    // A pair may appear multiple times (multi-column FK); deduplicate
    const fkSet = new Set(
      fkResult.rows.map((r) => `${r.from_table}→${r.to_table}`),
    );

    for (const { table, references } of EXPECTED_FK_CONSTRAINTS) {
      assert(
        fkSet.has(`${table}→${references}`),
        `Expected FK from "${table}" → "${references}" — not found (found: ${[...fkSet].join(", ")})`,
      );
    }
    console.log("✅  Foreign-key constraints are in place");

    // -----------------------------------------------------------------------
    // 6. Verify the sessions index exists
    // -----------------------------------------------------------------------
    const idxResult = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM   pg_indexes
      WHERE  schemaname = 'public'
      AND    tablename  = 'sessions'
      AND    indexname  = 'IDX_session_expire'
    `);
    assert(
      idxResult.rowCount !== null && idxResult.rowCount > 0,
      'Expected index "IDX_session_expire" on sessions table — not found',
    );
    console.log("✅  sessions.expire index is present");

    console.log(
      "\n✅  Migration integration test passed: all migrations applied cleanly to a fresh database.\n",
    );
  } catch (err) {
    console.error("\n❌  Migration integration test failed:", err);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    // Always drop the throwaway database
    await admin
      .query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`)
      .catch((e) => {
        console.error(`⚠️  Could not drop test database "${testDbName}":`, e);
      });
    await admin.end();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Migration integration test crashed:", err);
  process.exit(1);
});
