#!/usr/bin/env node
/**
 * check-migration-drift.ts
 *
 * Detects whether the Drizzle schema has changed without a corresponding
 * migration file being generated and committed.
 *
 * Strategy:
 *  1. Copy the existing migrations/meta directory into a temp folder so
 *     drizzle-kit knows which snapshots already exist.
 *  2. Run `drizzle-kit generate --out <tempDir>` against the real schema.
 *  3. If drizzle-kit writes any new .sql files the check fails — those
 *     files represent ungenerated migrations.
 *  4. Clean up the temp folder regardless of outcome.
 */

import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const CONFIG = path.join(ROOT, "drizzle.config.ts");

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function sqlFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// drizzle-kit prepends "./" to the out path when reading snapshots, which
// breaks for absolute /tmp paths. Keep the temp dir inside the workspace so
// drizzle-kit resolves snapshots correctly via a relative path.
const tmpDir = fs.mkdtempSync(path.join(ROOT, ".drizzle-drift-"));
const tmpConfig = path.join(tmpDir, "drizzle.check.config.ts");

try {
  // Copy existing meta snapshots so drizzle-kit can diff against them.
  const metaSrc = path.join(MIGRATIONS_DIR, "meta");
  if (fs.existsSync(metaSrc)) {
    copyDir(metaSrc, path.join(tmpDir, "meta"));
  }

  // Write a temporary drizzle config that outputs into our temp dir.
  // Use relative paths — drizzle-kit prepends "./" when reading snapshots,
  // which breaks absolute /tmp paths but works fine for workspace-relative ones.
  const schemaRel = path.relative(ROOT, path.join(ROOT, "src/schema/index.ts"));
  const outRel = path.relative(ROOT, tmpDir);
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://localhost/placeholder";
  fs.writeFileSync(
    tmpConfig,
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: ${JSON.stringify(schemaRel)},
  out: ${JSON.stringify(outRel)},
  dialect: "postgresql",
  dbCredentials: { url: ${JSON.stringify(dbUrl)} },
});
`
  );

  const sqlBefore = new Set(sqlFilesIn(tmpDir));

  try {
    execSync(
      `node_modules/.bin/drizzle-kit generate --config ${tmpConfig}`,
      { stdio: "pipe", cwd: ROOT }
    );
  } catch (err: any) {
    // drizzle-kit exits 0 even when generating; a real failure should surface.
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    console.error("drizzle-kit generate failed:");
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    process.exit(2);
  }

  const sqlAfter = sqlFilesIn(tmpDir);
  const newFiles = sqlAfter.filter((f) => !sqlBefore.has(f));

  if (newFiles.length > 0) {
    console.error("");
    console.error(
      "❌ Schema changed but no migration generated — run:"
    );
    console.error("");
    console.error("     pnpm --filter @workspace/db generate");
    console.error("");
    console.error(
      `   (${newFiles.length} new migration file${newFiles.length > 1 ? "s" : ""} would be created: ${newFiles.join(", ")})`
    );
    console.error("");
    process.exit(1);
  }

  console.log("✅ Schema is in sync with committed migrations.");
  process.exit(0);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
