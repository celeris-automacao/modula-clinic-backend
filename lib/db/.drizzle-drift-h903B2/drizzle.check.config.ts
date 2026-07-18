import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "src/schema/index.ts",
  out: ".drizzle-drift-h903B2",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://postgres:password@helium/heliumdb?sslmode=disable" },
});
