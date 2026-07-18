/**
 * Integration test — verifies the seed script runs cleanly against a FRESH
 * database with no prior data, and that every seeded task category passes
 * the official Zod validation from @workspace/api-zod (BR-031).
 *
 * Run with:  pnpm --filter @workspace/db run test:seed
 *
 * Steps:
 *   1. Creates a throwaway database on the same Postgres server
 *   2. Applies the schema via drizzle migrations
 *   3. Runs the seed script twice (fresh + idempotence check)
 *   4. Asserts protocols/tasks are readable and categories are valid
 *   5. Drops the throwaway database (also on failure)
 *
 * Exits non-zero (loudly) on any failure.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { CreateProtocolBody } from "@workspace/api-zod";
import { protocolsTable, protocolTasksTable } from "./schema/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");

// Official category enum straight from the generated API contract
const CategorySchema = CreateProtocolBody.shape.tasks.element.shape.category;
const OFFICIAL_CATEGORIES = CategorySchema.options as readonly string[];

function fail(message: string): never {
  console.error(`❌  ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main() {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) fail("DATABASE_URL must be set");

  assert(
    OFFICIAL_CATEGORIES.length === 9,
    `Expected 9 official categories in the contract, got ${OFFICIAL_CATEGORIES.length}: ${OFFICIAL_CATEGORIES.join(", ")}`,
  );

  const testDbName = `seed_test_${Date.now()}_${process.pid}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${testDbName}`;

  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  console.log(`🧪  Creating fresh database "${testDbName}"…`);
  await admin.query(`CREATE DATABASE "${testDbName}"`);

  let exitCode = 0;
  try {
    // 2. Apply schema to the empty database via migrations
    console.log("🧪  Applying migrations…");
    execFileSync(
      "pnpm",
      ["--filter", "@workspace/db", "migrate"],
      { env: { ...process.env, DATABASE_URL: testUrl.href }, stdio: "inherit" },
    );

    // 3. Run the seed script — twice, to also verify idempotence
    for (const run of [1, 2] as const) {
      console.log(`🧪  Running seed (pass ${run})…`);
      execFileSync("node", ["--import", "tsx/esm", "./src/seed.ts"], {
        cwd: PKG_ROOT,
        env: { ...process.env, DATABASE_URL: testUrl.href },
        stdio: "inherit",
      });
    }

    // 4. Assertions against the freshly seeded database
    const pool = new pg.Pool({ connectionString: testUrl.href, max: 1 });
    const db = drizzle(pool);

    const protocols = await db.select().from(protocolsTable);
    assert(protocols.length === 2, `Expected 2 seeded preset protocols, found ${protocols.length}`);
    assert(
      protocols.every((p) => p.isPreset),
      "All seeded protocols must have isPreset = true",
    );

    const tasks = await db.select().from(protocolTasksTable);
    assert(tasks.length === 13, `Expected 13 seeded tasks (8 + 5), found ${tasks.length}`);

    for (const task of tasks) {
      const parsed = CategorySchema.safeParse(task.category);
      assert(
        parsed.success,
        `Task "${task.title}" has category "${task.category}" which is NOT one of the 9 official slugs: ${OFFICIAL_CATEGORIES.join(", ")}`,
      );
    }

    await pool.end();
    console.log("✅  Seed integration test passed: fresh DB seeded, idempotent, all categories valid.");
  } catch (err) {
    console.error("❌  Seed integration test failed:", err);
    exitCode = 1;
  } finally {
    // 5. Always drop the throwaway database
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`).catch((e) => {
      console.error(`⚠️  Could not drop test database "${testDbName}":`, e);
    });
    await admin.end();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Seed integration test crashed:", err);
  process.exit(1);
});
