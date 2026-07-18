import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Use paths relative to this config file so drizzle-kit resolves snapshot
// paths correctly regardless of cwd. Absolute paths trigger a drizzle-kit
// bug where it prepends "./" and produces ".//absolute/path" URLs.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
