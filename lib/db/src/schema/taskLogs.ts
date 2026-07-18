import { pgTable, serial, integer, text, real, date, timestamp } from "drizzle-orm/pg-core";
import { patientsTable } from "./patients";
import { protocolTasksTable } from "./protocols";
import { treatmentsTable } from "./treatments";

export const taskLogsTable = pgTable("task_logs", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id")
    .notNull()
    .references(() => patientsTable.id),
  treatmentId: integer("treatment_id")
    .notNull()
    .references(() => treatmentsTable.id),
  taskId: integer("task_id")
    .notNull()
    .references(() => protocolTasksTable.id),
  logDate: date("log_date", { mode: "string" }).notNull(),
  note: text("note"),
  valueNumber: real("value_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TaskLogRow = typeof taskLogsTable.$inferSelect;
