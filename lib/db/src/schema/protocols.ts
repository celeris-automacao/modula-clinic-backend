import { pgTable, text, serial, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const protocolsTable = pgTable("protocols", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  durationWeeks: integer("duration_weeks").notNull().default(4),
  isPreset: boolean("is_preset").notNull().default(false),
});

export const protocolTasksTable = pgTable("protocol_tasks", {
  id: serial("id").primaryKey(),
  protocolId: integer("protocol_id")
    .notNull()
    .references(() => protocolsTable.id),
  // Quando preenchido, a tarefa é personalizada de um tratamento específico
  // (não faz parte do protocolo reutilizável da biblioteca).
  treatmentId: integer("treatment_id"),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  frequency: text("frequency").notNull().default("daily"),
});

export const insertProtocolSchema = createInsertSchema(protocolsTable).omit({ id: true });
export type InsertProtocol = z.infer<typeof insertProtocolSchema>;
export type ProtocolRow = typeof protocolsTable.$inferSelect;
export type ProtocolTaskRow = typeof protocolTasksTable.$inferSelect;
