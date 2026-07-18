import { pgTable, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { protocolsTable } from "./protocols";
import { patientsTable } from "./patients";

export const treatmentsTable = pgTable("treatments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id")
    .notNull()
    .references(() => patientsTable.id),
  protocolId: integer("protocol_id")
    .notNull()
    .references(() => protocolsTable.id),
  active: boolean("active").notNull().default(true),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TreatmentRow = typeof treatmentsTable.$inferSelect;
