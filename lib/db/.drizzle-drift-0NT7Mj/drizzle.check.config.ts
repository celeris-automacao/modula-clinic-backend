import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "src/schema/index.ts",
  out: ".drizzle-drift-0NT7Mj",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://postgres:password@helium/heliumdb?sslmode=disable" },
});
