import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  treatmentsTable,
  protocolTasksTable,
  taskLogsTable,
  protocolsTable,
} from "@workspace/db";

export type RiskLevel = "high" | "medium" | "low" | "none";
export type Trend = "improving" | "stable" | "declining" | "unknown";

export interface AdherenceResult {
  patientId: number;
  score: number;
  riskLevel: RiskLevel;
  trend: Trend;
  currentStreakDays: number;
  missedLast3Days: number;
  weeklyCompletionPct: number;
  categoryBreakdown: { category: string; completionPct: number }[];
  computedAt: string;
}

export interface ProgressPoint {
  date: string;
  completed: number;
  expected: number;
  completionPct: number;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export async function getActiveTreatmentWithTasks(patientId: number) {
  // BR-022: somente tratamentos ativos aparecem para o paciente
  const [treatment] = await db
    .select({
      id: treatmentsTable.id,
      patientId: treatmentsTable.patientId,
      protocolId: treatmentsTable.protocolId,
      startedAt: treatmentsTable.startedAt,
      status: treatmentsTable.status,
      protocolName: protocolsTable.name,
      durationWeeks: protocolsTable.durationWeeks,
    })
    .from(treatmentsTable)
    .innerJoin(protocolsTable, eq(treatmentsTable.protocolId, protocolsTable.id))
    .where(and(eq(treatmentsTable.patientId, patientId), eq(treatmentsTable.status, "active")))
    .limit(1);

  if (!treatment) return null;

  // Tarefas do protocolo (compartilhadas) + tarefas personalizadas deste tratamento
  const tasks = await db
    .select()
    .from(protocolTasksTable)
    .where(
      and(
        eq(protocolTasksTable.protocolId, treatment.protocolId),
        or(
          isNull(protocolTasksTable.treatmentId),
          eq(protocolTasksTable.treatmentId, treatment.id),
        ),
      ),
    );

  return { treatment, tasks };
}

/**
 * Adherence Engine (deterministic, rule-based — ADR-003).
 * Window: last 7 days, clipped to treatment start.
 * score = 70% completion of last 3 days + 30% completion of the 4 days before.
 * BR-061 risk bands: ≥70 low (Boa adesão), 40–69 medium (Atenção), <40 high (Alto risco).
 */
export async function computeAdherence(patientId: number): Promise<AdherenceResult> {
  const computedAt = new Date().toISOString();
  const active = await getActiveTreatmentWithTasks(patientId);

  if (!active || active.tasks.length === 0) {
    return {
      patientId,
      score: 0,
      riskLevel: "none",
      trend: "unknown",
      currentStreakDays: 0,
      missedLast3Days: 0,
      weeklyCompletionPct: 0,
      categoryBreakdown: [],
      computedAt,
    };
  }

  const { treatment, tasks } = active;
  const dailyTasks = tasks.filter((t) => t.frequency === "daily");
  const weeklyTasks = tasks.filter((t) => t.frequency === "weekly");
  const taskIds = tasks.map((t) => t.id);

  const windowStart = daysAgo(6);
  const treatmentStart = new Date(treatment.startedAt);
  treatmentStart.setUTCHours(0, 0, 0, 0);
  const effectiveStart = treatmentStart > windowStart ? treatmentStart : windowStart;

  const logs = await db
    .select({
      taskId: taskLogsTable.taskId,
      logDate: taskLogsTable.logDate,
    })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, patientId),
        eq(taskLogsTable.treatmentId, treatment.id),
        inArray(taskLogsTable.taskId, taskIds),
        gte(taskLogsTable.logDate, toDateStr(effectiveStart)),
      ),
    );

  const logsByDate = new Map<string, Set<number>>();
  for (const log of logs) {
    if (!logsByDate.has(log.logDate)) logsByDate.set(log.logDate, new Set());
    logsByDate.get(log.logDate)!.add(log.taskId);
  }

  // Per-day daily-task completion across the window
  const dayStats: { date: string; completed: number; expected: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = daysAgo(i);
    if (day < effectiveStart) continue;
    const dateStr = toDateStr(day);
    const done = logsByDate.get(dateStr) ?? new Set<number>();
    const completed = dailyTasks.filter((t) => done.has(t.id)).length;
    dayStats.push({ date: dateStr, completed, expected: dailyTasks.length });
  }

  const pct = (stats: { completed: number; expected: number }[]): number => {
    const expected = stats.reduce((s, d) => s + d.expected, 0);
    if (expected === 0) return 100;
    const completed = stats.reduce((s, d) => s + d.completed, 0);
    return Math.round((completed / expected) * 100);
  };

  const recent = dayStats.slice(-3);
  const older = dayStats.slice(0, -3);

  const recentPct = pct(recent);
  const olderPct = older.length > 0 ? pct(older) : recentPct;

  // Weekly tasks: done if logged at least once inside the window
  const weeklyDone = weeklyTasks.filter((t) => logs.some((l) => l.taskId === t.id)).length;
  const totalExpected =
    dayStats.reduce((s, d) => s + d.expected, 0) + weeklyTasks.length;
  const totalCompleted =
    dayStats.reduce((s, d) => s + d.completed, 0) + weeklyDone;
  const weeklyCompletionPct =
    totalExpected === 0 ? 100 : Math.round((totalCompleted / totalExpected) * 100);

  let score = Math.round(0.7 * recentPct + 0.3 * olderPct);
  // Blend in weekly tasks lightly so they matter but don't dominate
  if (weeklyTasks.length > 0) {
    const weeklyPct = Math.round((weeklyDone / weeklyTasks.length) * 100);
    score = Math.round(0.85 * score + 0.15 * weeklyPct);
  }
  score = Math.max(0, Math.min(100, score));

  // BR-061: faixas oficiais — 70–100 Boa adesão, 40–69 Atenção, 0–39 Alto risco
  const riskLevel: RiskLevel = score < 40 ? "high" : score < 70 ? "medium" : "low";

  let trend: Trend = "stable";
  if (older.length === 0) trend = "unknown";
  else if (recentPct - olderPct > 10) trend = "improving";
  else if (recentPct - olderPct < -10) trend = "declining";

  // Streak: consecutive fully-completed days counting backwards; an
  // incomplete today doesn't break the streak (the day isn't over yet).
  let currentStreakDays = 0;
  for (let i = dayStats.length - 1; i >= 0; i--) {
    const d = dayStats[i]!;
    const full = d.expected > 0 && d.completed >= d.expected;
    if (i === dayStats.length - 1 && !full) continue;
    if (full) currentStreakDays++;
    else break;
  }

  const last3 = dayStats.slice(-3);
  const missedLast3Days = last3.reduce((s, d) => s + Math.max(0, d.expected - d.completed), 0);

  // Category breakdown over the window (daily + weekly tasks)
  const categories = [...new Set(tasks.map((t) => t.category))];
  const categoryBreakdown = categories.map((category) => {
    const catDaily = dailyTasks.filter((t) => t.category === category);
    const catWeekly = weeklyTasks.filter((t) => t.category === category);
    let expected = 0;
    let completed = 0;
    for (const d of dayStats) {
      expected += catDaily.length;
      const done = logsByDate.get(d.date) ?? new Set<number>();
      completed += catDaily.filter((t) => done.has(t.id)).length;
    }
    expected += catWeekly.length;
    completed += catWeekly.filter((t) => logs.some((l) => l.taskId === t.id)).length;
    return {
      category,
      completionPct: expected === 0 ? 100 : Math.round((completed / expected) * 100),
    };
  });

  return {
    patientId,
    score,
    riskLevel,
    trend,
    currentStreakDays,
    missedLast3Days,
    weeklyCompletionPct,
    categoryBreakdown,
    computedAt,
  };
}

/** Daily completion series over the last 14 days (clipped to treatment start). */
export async function computeProgress(patientId: number): Promise<ProgressPoint[]> {
  const active = await getActiveTreatmentWithTasks(patientId);
  if (!active) return [];

  const { treatment, tasks } = active;
  const dailyTasks = tasks.filter((t) => t.frequency === "daily");
  if (dailyTasks.length === 0) return [];

  const windowStart = daysAgo(13);
  const treatmentStart = new Date(treatment.startedAt);
  treatmentStart.setUTCHours(0, 0, 0, 0);
  const effectiveStart = treatmentStart > windowStart ? treatmentStart : windowStart;

  const logs = await db
    .select({ taskId: taskLogsTable.taskId, logDate: taskLogsTable.logDate })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, patientId),
        eq(taskLogsTable.treatmentId, treatment.id),
        gte(taskLogsTable.logDate, toDateStr(effectiveStart)),
      ),
    );

  const logsByDate = new Map<string, Set<number>>();
  for (const log of logs) {
    if (!logsByDate.has(log.logDate)) logsByDate.set(log.logDate, new Set());
    logsByDate.get(log.logDate)!.add(log.taskId);
  }

  const points: ProgressPoint[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = daysAgo(i);
    if (day < effectiveStart) continue;
    const dateStr = toDateStr(day);
    const done = logsByDate.get(dateStr) ?? new Set<number>();
    const completed = dailyTasks.filter((t) => done.has(t.id)).length;
    const expected = dailyTasks.length;
    points.push({
      date: dateStr,
      completed,
      expected,
      completionPct: expected === 0 ? 100 : Math.round((completed / expected) * 100),
    });
  }
  return points;
}

export function todayStr(): string {
  return toDateStr(new Date());
}
