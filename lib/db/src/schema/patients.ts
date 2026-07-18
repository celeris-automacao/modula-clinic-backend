import { pgTable, text, serial, integer, real, date, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const patientsTable = pgTable("patients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  goal: text("goal").notNull(),
  age: integer("age"),
  startWeightKg: real("start_weight_kg"),
  currentWeightKg: real("current_weight_kg"),
  goalWeightKg: real("goal_weight_kg"),
  nextAppointment: date("next_appointment", { mode: "string" }),
  // Links this patient record to a Replit Auth user (nullable — not all patients have accounts yet)
  userId: varchar("user_id").unique(),
  pushToken: text("push_token"),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPatientSchema = createInsertSchema(patientsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPatient = z.infer<typeof insertPatientSchema>;
export type PatientRow = typeof patientsTable.$inferSelect;
