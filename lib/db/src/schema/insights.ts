import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { patientsTable } from "./patients";

export const insightsTable = pgTable("insights", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id")
    .notNull()
    .references(() => patientsTable.id),
  // BR-072: resumo, fatores observados e sugestão de acompanhamento
  summary: text("summary").notNull(),
  observedFactors: text("observed_factors").notNull().default(""),
  suggestedAction: text("suggested_action").notNull(),
  riskLevel: text("risk_level").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InsightRow = typeof insightsTable.$inferSelect;
