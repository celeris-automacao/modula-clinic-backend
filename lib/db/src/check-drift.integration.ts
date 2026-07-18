/**
 * Integration test — verifies that the migration drift check
 * (check-migration-drift.ts, wired into scripts/post-merge.sh via
 * `check:migration`) actually blocks a push when the Drizzle schema has
 * changed without a corresponding migration file.
 *
 * Run with:  pnpm --filter @workspace/db run test:drift
 *
 * Steps:
 *   1. Runs the check on the pristine schema — must exit 0.
 *   2. Temporarily injects a new table into the schema (no migration
 *      generated) — the check must exit non-zero and print guidance.
 *   3. Restores the schema and re-runs the check — must exit 0 again,
 *      proving the test left no residue.
 *
 * Exits non-zero (loudly) on any failure. Schema restoration happens in a
 * finally block so an aborted run cannot leave the workspace drifted.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCHEMA_DIR = path.join(ROOT, "src/schema");
const SCHEMA_INDEX = path.join(SCHEMA_DIR, "index.ts");
const DRIFT_FILE = path.join(SCHEMA_DIR, "_driftTestTable.ts");

function fail(message: string): never {
  console.error(`❌  ${message}`);
  process.exit(1);
}

/** Run the drift check; returns { code, output }. */
function runCheck(): { code: number; output: string } {
  try {
    const out = execFileSync(
      "node",
      ["--import", "tsx/esm", "./src/check-migration-drift.ts"],
      { cwd: ROOT, stdio: "pipe" }
    );
    return { code: 0, output: out.toString() };
  } catch (err: any) {
    const output =
      (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { code: typeof err.status === "number" ? err.status : -1, output };
  }
}

const originalIndex = fs.readFileSync(SCHEMA_INDEX, "utf8");

// Guard: a previous aborted run must not pollute this one.
if (fs.existsSync(DRIFT_FILE) || originalIndex.includes("_driftTestTable")) {
  fail(
    "Workspace already contains drift-test residue (_driftTestTable). " +
      "Remove lib/db/src/schema/_driftTestTable.ts and its index export, then re-run."
  );
}

try {
  // 1. No-drift case: check must pass on the pristine schema.
  console.log("— Step 1: drift check on pristine schema (expect pass)…");
  const clean = runCheck();
  if (clean.code !== 0) {
    console.error(clean.output);
    fail(
      "Drift check failed on the pristine schema. The workspace itself is " +
        "drifted — run `pnpm --filter @workspace/db generate` first."
    );
  }
  console.log("   ✅ passes with no drift");

  // 2. Introduce a schema change WITHOUT generating a migration.
  console.log("— Step 2: inject schema change without migration (expect block)…");
  fs.writeFileSync(
    DRIFT_FILE,
    `import { pgTable, serial, text } from "drizzle-orm/pg-core";

// Temporary table injected by check-drift.integration.ts — never committed.
export const driftTestTable = pgTable("_drift_test_table", {
  id: serial("id").primaryKey(),
  note: text("note"),
});
`
  );
  fs.writeFileSync(
    SCHEMA_INDEX,
    originalIndex + `export * from "./_driftTestTable";\n`
  );

  const drifted = runCheck();
  if (drifted.code === 0) {
    fail(
      "Drift check exited 0 despite a schema change with no migration file — " +
        "a drifted schema would slip through the push."
    );
  }
  if (!drifted.output.includes("no migration generated")) {
    console.error(drifted.output);
    fail(
      `Drift check exited non-zero (${drifted.code}) but not with the expected ` +
        "drift message — it may have failed for an unrelated reason."
    );
  }
  console.log(`   ✅ blocked with exit code ${drifted.code}`);
} finally {
  // 3. Always restore the schema, even on failure/abort.
  fs.writeFileSync(SCHEMA_INDEX, originalIndex);
  fs.rmSync(DRIFT_FILE, { force: true });
}

console.log("— Step 3: drift check after restore (expect pass)…");
const restored = runCheck();
if (restored.code !== 0) {
  console.error(restored.output);
  fail("Drift check fails after restoring the schema — cleanup is incomplete.");
}
console.log("   ✅ passes again after restore");

console.log("");
console.log("✅ All drift-check assertions passed.");
