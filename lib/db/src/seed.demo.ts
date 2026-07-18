/**
 * Demo seed — DOC-010 / STORY-003 official Hackathon scenario.
 *
 * Creates exactly:
 *   • 3 DOC-010 protocols with their task lists
 *   • 3 demo patients (Ana, João, Carlos) — tagged by name for idempotency
 *   • 1 active treatment per patient
 *   • Task-log history calibrated so the Adherence Engine later produces:
 *       Ana   → ~95  crescente   🟢
 *       João  → ~64  estável     🟡
 *       Carlos→ ~27  decrescente 🔴 (triggers high-risk alert flow)
 *
 * Note: DOC-010 also specifies a Clinic ("Modula Clinic - Unidade Florianópolis")
 * and a Professional ("Dra. Mariana Costa, Nutricionista"). Those entities have
 * no backing DB tables in the current schema and are represented implicitly by
 * the application itself. They are documented here for completeness.
 *
 * Run with:  pnpm --filter @workspace/db seed
 *
 * Safe to run repeatedly: demo records are keyed by name and skipped if they
 * already exist. Non-demo patient data is never touched.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and } from "drizzle-orm";
import {
  protocolsTable,
  protocolTasksTable,
  patientsTable,
  treatmentsTable,
  taskLogsTable,
} from "./schema/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns YYYY-MM-DD for N days ago (UTC). */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0); // noon UTC — avoids timezone edge cases
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Returns a Date N days ago at noon UTC — for startedAt timestamps. */
function daysAgoDate(n: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// DOC-010 Protocols
// ---------------------------------------------------------------------------

const DEMO_PROTOCOLS = [
  {
    name: "Emagrecimento Inicial",
    description: "Protocolo de acompanhamento para emagrecimento inicial: controle de peso, hidratação, exercício, alimentação e bem-estar.",
    durationWeeks: 8,
    tasks: [
      { title: "Registrar Peso",  category: "weight",    frequency: "weekly" as const, mandatory: true,  description: "Pese-se em jejum e registre o valor." },
      { title: "Beber Água",      category: "water",     frequency: "daily"  as const, mandatory: true,  description: "Registre ao atingir a meta de hidratação do dia." },
      { title: "Caminhada",       category: "exercise",  frequency: "daily"  as const, mandatory: false, description: "Pelo menos 30 minutos de caminhada." },
      { title: "Alimentação",     category: "nutrition", frequency: "daily"  as const, mandatory: false, description: "Confirme que seguiu o plano alimentar hoje." },
      { title: "Sono",            category: "sleep",     frequency: "daily"  as const, mandatory: false, description: "Como foi seu sono? Registre horas e qualidade." },
      { title: "Humor",           category: "mood",      frequency: "daily"  as const, mandatory: false, description: "Como você está se sentindo hoje?" },
    ],
  },
  {
    name: "Reeducação Alimentar",
    description: "Protocolo de reeducação alimentar: registro fotográfico, alimentação saudável e hidratação diária.",
    durationWeeks: 8,
    tasks: [
      { title: "Foto do almoço",  category: "photo",     frequency: "daily"  as const, mandatory: false, description: "Tire uma foto do seu almoço." },
      { title: "Alimentação",     category: "nutrition", frequency: "daily"  as const, mandatory: false, description: "Registre que seguiu o plano alimentar." },
      { title: "Água",            category: "water",     frequency: "daily"  as const, mandatory: false, description: "Confirme a meta de hidratação do dia." },
    ],
  },
  {
    name: "Personalizado",
    description: "Protocolo reservado para criação manual de tarefas personalizadas pelo profissional.",
    durationWeeks: 4,
    tasks: [], // DOC-010: sem tarefas — reservado para a Story de criação manual
  },
] as const;

// ---------------------------------------------------------------------------
// DOC-010 Patient profiles
// ---------------------------------------------------------------------------

interface DemoPatient {
  name: string;
  goal: string;
  age: number;
  startWeightKg: number;
  currentWeightKg: number;
  goalWeightKg: number;
  protocolName: string;
}

const DEMO_PATIENTS: DemoPatient[] = [
  {
    name: "Ana Oliveira",
    goal: "Perda de peso",
    age: 34,
    startWeightKg: 78,
    currentWeightKg: 73,
    goalWeightKg: 62,
    protocolName: "Emagrecimento Inicial",
  },
  {
    name: "João Pereira",
    goal: "Reeducação alimentar",
    age: 45,
    startWeightKg: 95,
    currentWeightKg: 92,
    goalWeightKg: 80,
    protocolName: "Reeducação Alimentar",
  },
  {
    name: "Carlos Souza",
    goal: "Emagrecimento",
    age: 52,
    startWeightKg: 110,
    currentWeightKg: 108,
    goalWeightKg: 90,
    protocolName: "Emagrecimento Inicial",
  },
];

// ---------------------------------------------------------------------------
// Log patterns — calibrated for the Adherence Engine (ADR-003)
//
// Engine window: last 7 days (days 0–6 ago)
// score = 70% * recentPct (days 0–2) + 30% * olderPct (days 3–6)
// Weekly task: blended in → score_final = 0.85 * score_daily + 0.15 * weeklyPct
// Trend: improving if recent−older > 10, declining if < −10, else stable
//
// Ana  (target ~95, improving):
//   Older 4 days: 4/5 daily tasks → 80%
//   Recent 3 days: 5/5 daily tasks → 100%
//   Weekly (Registrar Peso): done
//   → score_daily = 0.7×100 + 0.3×80 = 94
//   → score_final = 0.85×94 + 0.15×100 ≈ 95  trend: 100−80=20 → improving ✓
//
// João (target ~64, stable):
//   Older 4 days: 7/12 daily task-slots (mix of 2/3 and 1/3) → 58%
//   Recent 3 days: 6/9 daily task-slots (2/3 each) → 67%
//   No weekly task.
//   → score = 0.7×67 + 0.3×58 ≈ 64  trend: 67−58=9 → stable ✓
//
// Carlos (target ~27, declining):
//   Older 4 days: 3/5 daily tasks per day → 60%
//   Recent 3 days: 1/5 daily tasks per day → 20%
//   Weekly (Registrar Peso): NOT done
//   → score_daily = 0.7×20 + 0.3×60 = 32
//   → score_final = 0.85×32 + 0.15×0 ≈ 27  trend: 20−60=−40 → declining ✓
// ---------------------------------------------------------------------------

type LogPattern = {
  /** which task indices (0-based into the protocol's daily task array) to log for each day */
  dailyTaskIndices: Record<number, number[]>; // day-ago → task index list
  /** whether to log the weekly task (if any) */
  logWeeklyTask: boolean;
  /** which day ago to log the weekly task on (if logWeeklyTask) */
  weeklyTaskDayAgo?: number;
};

const ANA_PATTERN: LogPattern = {
  dailyTaskIndices: {
    6: [0, 1, 2, 3],    // Beber Água, Caminhada, Alimentação, Sono  (skip Humor → 4/5)
    5: [0, 1, 2, 3],    // same
    4: [0, 1, 2, 3],    // same
    3: [0, 1, 2, 3],    // same → olderPct = 16/20 = 80%
    2: [0, 1, 2, 3, 4], // all 5
    1: [0, 1, 2, 3, 4], // all 5
    0: [0, 1, 2, 3, 4], // all 5 → recentPct = 15/15 = 100%
  },
  logWeeklyTask: true,
  weeklyTaskDayAgo: 4,
};

const JOAO_PATTERN: LogPattern = {
  dailyTaskIndices: {
    6: [0, 1],    // Foto do almoço, Alimentação  (2/3)
    5: [0, 1],    // same
    4: [0],       // only Foto (1/3)
    3: [0, 1],    // 2/3 → olderPct = 7/12 ≈ 58%
    2: [0, 1],    // 2/3
    1: [0, 1],    // 2/3
    0: [0, 1],    // 2/3 → recentPct = 6/9 ≈ 67%
  },
  logWeeklyTask: false,
};

const CARLOS_PATTERN: LogPattern = {
  dailyTaskIndices: {
    6: [0, 1, 2], // Beber Água, Caminhada, Alimentação  (3/5)
    5: [0, 1, 2], // same
    4: [0, 1, 2], // same
    3: [0, 1, 2], // same → olderPct = 12/20 = 60%
    2: [0],       // only Beber Água (1/5)
    1: [0],       // same
    0: [0],       // same → recentPct = 3/15 = 20%
  },
  logWeeklyTask: false, // weekly NOT done → score_final = 0.85×32 ≈ 27
};

const PATIENT_PATTERNS: Record<string, LogPattern> = {
  "Ana Oliveira":   ANA_PATTERN,
  "João Pereira":   JOAO_PATTERN,
  "Carlos Souza":   CARLOS_PATTERN,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function seedDemo(db: ReturnType<typeof drizzle>) {
  console.log("\n🎭  Starting demo seed (DOC-010)…");

  // ----- 1. Seed DOC-010 protocols ----------------------------------------

  const protocolIds: Record<string, number> = {};

  for (const proto of DEMO_PROTOCOLS) {
    const [existing] = await db
      .select({ id: protocolsTable.id })
      .from(protocolsTable)
      .where(eq(protocolsTable.name, proto.name));

    if (existing) {
      console.log(`  ⏭  Protocol already exists: "${proto.name}"`);
      protocolIds[proto.name] = existing.id;
      continue;
    }

    const [inserted] = await db
      .insert(protocolsTable)
      .values({
        name: proto.name,
        description: proto.description,
        durationWeeks: proto.durationWeeks,
        isPreset: false, // demo protocols are not library presets
      })
      .returning();

    protocolIds[proto.name] = inserted!.id;

    if (proto.tasks.length > 0) {
      await db.insert(protocolTasksTable).values(
        proto.tasks.map((t) => ({
          protocolId: inserted!.id,
          title: t.title,
          description: t.description,
          category: t.category,
          frequency: t.frequency,
          mandatory: t.mandatory,
        })),
      );
    }

    console.log(`  ✅  Protocol seeded: "${proto.name}" (${proto.tasks.length} tasks)`);
  }

  // ----- 2. Seed patients, treatments, task logs --------------------------

  for (const demo of DEMO_PATIENTS) {
    // Idempotency: skip if a patient with this exact name already exists
    const [existingPatient] = await db
      .select({ id: patientsTable.id })
      .from(patientsTable)
      .where(eq(patientsTable.name, demo.name));

    let patientId: number;

    if (existingPatient) {
      console.log(`  ⏭  Patient already exists: "${demo.name}"`);
      patientId = existingPatient.id;
    } else {
      const [patient] = await db
        .insert(patientsTable)
        .values({
          name: demo.name,
          goal: demo.goal,
          age: demo.age,
          startWeightKg: demo.startWeightKg,
          currentWeightKg: demo.currentWeightKg,
          goalWeightKg: demo.goalWeightKg,
          nextAppointment: daysAgoStr(-14), // appointment 2 weeks in the future
        })
        .returning();

      patientId = patient!.id;
      console.log(`  ✅  Patient seeded: "${demo.name}"`);
    }

    // Treatment: skip if an active treatment already exists for this patient
    const [existingTreatment] = await db
      .select({ id: treatmentsTable.id, protocolId: treatmentsTable.protocolId })
      .from(treatmentsTable)
      .where(
        and(
          eq(treatmentsTable.patientId, patientId),
          eq(treatmentsTable.status, "active"),
        ),
      );

    let treatmentId: number;
    let protocolId: number;

    if (existingTreatment) {
      console.log(`  ⏭  Active treatment already exists for "${demo.name}"`);
      treatmentId = existingTreatment.id;
      protocolId = existingTreatment.protocolId;
    } else {
      protocolId = protocolIds[demo.protocolName]!;
      const [treatment] = await db
        .insert(treatmentsTable)
        .values({
          patientId,
          protocolId,
          status: "active",
          startedAt: daysAgoDate(30), // started 30 days ago → full 7-day window always applies
        })
        .returning();

      treatmentId = treatment!.id;
      console.log(`  ✅  Treatment seeded for "${demo.name}" → "${demo.protocolName}"`);
    }

    // Task logs: skip entirely if any logs already exist for this treatment
    const [firstLog] = await db
      .select({ id: taskLogsTable.id })
      .from(taskLogsTable)
      .where(eq(taskLogsTable.treatmentId, treatmentId));

    if (firstLog) {
      console.log(`  ⏭  Task logs already exist for "${demo.name}" — skipping`);
      continue;
    }

    // Fetch the tasks for this protocol
    const allTasks = await db
      .select({ id: protocolTasksTable.id, frequency: protocolTasksTable.frequency })
      .from(protocolTasksTable)
      .where(eq(protocolTasksTable.protocolId, protocolId));

    const dailyTasks = allTasks.filter((t) => t.frequency === "daily");
    const weeklyTasks = allTasks.filter((t) => t.frequency === "weekly");

    const pattern = PATIENT_PATTERNS[demo.name];
    if (!pattern) {
      console.warn(`  ⚠️  No log pattern defined for "${demo.name}" — skipping logs`);
      continue;
    }

    const logsToInsert: {
      patientId: number;
      treatmentId: number;
      taskId: number;
      logDate: string;
    }[] = [];

    // Daily task logs
    for (const [dayAgoStr, taskIndices] of Object.entries(pattern.dailyTaskIndices)) {
      const dayAgo = parseInt(dayAgoStr, 10);
      const logDate = daysAgoStr(dayAgo);
      for (const idx of taskIndices) {
        const task = dailyTasks[idx];
        if (!task) continue;
        logsToInsert.push({ patientId, treatmentId, taskId: task.id, logDate });
      }
    }

    // Weekly task log
    if (pattern.logWeeklyTask && weeklyTasks.length > 0 && pattern.weeklyTaskDayAgo !== undefined) {
      const weeklyLogDate = daysAgoStr(pattern.weeklyTaskDayAgo);
      logsToInsert.push({
        patientId,
        treatmentId,
        taskId: weeklyTasks[0]!.id,
        logDate: weeklyLogDate,
      });
    }

    if (logsToInsert.length > 0) {
      await db.insert(taskLogsTable).values(logsToInsert);
    }

    console.log(`  ✅  ${logsToInsert.length} task logs seeded for "${demo.name}"`);
  }

  console.log("🎭  Demo seed complete.\n");
}

// ---------------------------------------------------------------------------
// Standalone entrypoint (when run directly)
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  try {
    await seedDemo(db);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Demo seed failed:", err);
  process.exit(1);
});
