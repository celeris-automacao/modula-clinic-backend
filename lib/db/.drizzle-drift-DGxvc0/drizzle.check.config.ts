import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "src/schema/index.ts",
  out: ".drizzle-drift-DGxvc0",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://postgres:password@helium/heliumdb?sslmode=disable" },
});
