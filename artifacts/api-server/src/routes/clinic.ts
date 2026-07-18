import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  patientsTable,
  protocolsTable,
  protocolTasksTable,
  treatmentsTable,
  taskLogsTable,
  insightsTable,
} from "@workspace/db";
import {
  CreatePatientBody,
  CreateProtocolBody,
  CreateTreatmentBody,
  CreateTaskLogBody,
  GetPatientParams,
  GetPatientAdherenceParams,
  GetPatientProgressParams,
  GetActiveTreatmentParams,
  GetTodayTasksParams,
  GetProtocolParams,
} from "@workspace/api-zod";
import {
  computeAdherence,
  computeProgress,
  getActiveTreatmentWithTasks,
  todayStr,
} from "../lib/adherence";

const router: IRouter = Router();

async function patientSummary(patient: typeof patientsTable.$inferSelect) {
  const adherence = await computeAdherence(patient.id);
  const active = await getActiveTreatmentWithTasks(patient.id);
  const [lastLog] = await db
    .select({ createdAt: taskLogsTable.createdAt })
    .from(taskLogsTable)
    .where(eq(taskLogsTable.patientId, patient.id))
    .orderBy(desc(taskLogsTable.createdAt))
    .limit(1);

  return {
    id: patient.id,
    name: patient.name,
    goal: patient.goal,
    age: patient.age,
    startWeightKg: patient.startWeightKg,
    currentWeightKg: patient.currentWeightKg,
    nextAppointment: patient.nextAppointment,
    adherenceScore: adherence.score,
    riskLevel: adherence.riskLevel,
    trend: adherence.trend,
    hasActiveTreatment: !!active,
    protocolName: active?.treatment.protocolName ?? null,
    lastActivityAt: lastLog?.createdAt?.toISOString() ?? null,
  };
}

const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };

router.get("/patients", async (_req, res): Promise<void> => {
  const patients = await db.select().from(patientsTable).orderBy(patientsTable.id);
  const summaries = await Promise.all(patients.map(patientSummary));
  summaries.sort(
    (a, b) =>
      (riskOrder[a.riskLevel] ?? 9) - (riskOrder[b.riskLevel] ?? 9) ||
      a.adherenceScore - b.adherenceScore,
  );
  res.json(summaries);
});

router.post("/patients", async (req, res): Promise<void> => {
  const parsed = CreatePatientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [patient] = await db.insert(patientsTable).values(parsed.data).returning();
  res.status(201).json(await patientSummary(patient!));
});

router.get("/patients/:id", async (req, res): Promise<void> => {
  const params = GetPatientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.id, params.data.id));
  if (!patient) {
    res.status(404).json({ error: "Paciente não encontrado" });
    return;
  }
  res.json(await patientSummary(patient));
});

router.get("/patients/:id/adherence", async (req, res): Promise<void> => {
  const params = GetPatientAdherenceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.id, params.data.id));
  if (!patient) {
    res.status(404).json({ error: "Paciente não encontrado" });
    return;
  }
  res.json(await computeAdherence(params.data.id));
});

router.get("/patients/:id/progress", async (req, res): Promise<void> => {
  const params = GetPatientProgressParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  res.json(await computeProgress(params.data.id));
});

router.get("/patients/:id/treatment", async (req, res): Promise<void> => {
  const params = GetActiveTreatmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const active = await getActiveTreatmentWithTasks(params.data.id);
  if (!active) {
    res.status(404).json({ error: "Nenhum tratamento ativo" });
    return;
  }
  res.json({
    id: active.treatment.id,
    patientId: active.treatment.patientId,
    protocolId: active.treatment.protocolId,
    protocolName: active.treatment.protocolName,
    startedAt: active.treatment.startedAt.toISOString(),
    durationWeeks: active.treatment.durationWeeks,
    tasks: active.tasks,
  });
});

router.get("/patients/:id/tasks/today", async (req, res): Promise<void> => {
  const params = GetTodayTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const active = await getActiveTreatmentWithTasks(params.data.id);
  if (!active) {
    res.json([]);
    return;
  }
  const logs = await db
    .select({ taskId: taskLogsTable.taskId, note: taskLogsTable.note })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, params.data.id),
        eq(taskLogsTable.treatmentId, active.treatment.id),
        eq(taskLogsTable.logDate, todayStr()),
      ),
    );
  const doneMap = new Map(logs.map((l) => [l.taskId, l.note]));
  res.json(
    active.tasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      description: t.description,
      category: t.category,
      frequency: t.frequency,
      completedToday: doneMap.has(t.id),
      note: doneMap.get(t.id) ?? null,
    })),
  );
});

router.get("/protocols", async (_req, res): Promise<void> => {
  const protocols = await db.select().from(protocolsTable).orderBy(protocolsTable.id);
  const tasks = await db.select().from(protocolTasksTable);
  res.json(
    protocols.map((p) => ({
      ...p,
      tasks: tasks.filter((t) => t.protocolId === p.id),
    })),
  );
});

router.post("/protocols", async (req, res): Promise<void> => {
  const parsed = CreateProtocolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { tasks, ...protocolData } = parsed.data;
  const [protocol] = await db
    .insert(protocolsTable)
    .values({ ...protocolData, isPreset: false })
    .returning();
  const insertedTasks = await db
    .insert(protocolTasksTable)
    .values(tasks.map((t) => ({ ...t, protocolId: protocol!.id })))
    .returning();
  res.status(201).json({ ...protocol!, tasks: insertedTasks });
});

router.get("/protocols/:id", async (req, res): Promise<void> => {
  const params = GetProtocolParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [protocol] = await db
    .select()
    .from(protocolsTable)
    .where(eq(protocolsTable.id, params.data.id));
  if (!protocol) {
    res.status(404).json({ error: "Protocolo não encontrado" });
    return;
  }
  const tasks = await db
    .select()
    .from(protocolTasksTable)
    .where(eq(protocolTasksTable.protocolId, protocol.id));
  res.json({ ...protocol, tasks });
});

router.post("/treatments", async (req, res): Promise<void> => {
  const parsed = CreateTreatmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { patientId, protocolId, extraTasks } = parsed.data;
  const [patient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.id, patientId));
  const [protocol] = await db
    .select()
    .from(protocolsTable)
    .where(eq(protocolsTable.id, protocolId));
  if (!patient || !protocol) {
    res.status(400).json({ error: "Paciente ou protocolo inválido" });
    return;
  }
  // Deactivate any current treatment, then start the new one
  await db
    .update(treatmentsTable)
    .set({ active: false })
    .where(and(eq(treatmentsTable.patientId, patientId), eq(treatmentsTable.active, true)));
  const [treatment] = await db
    .insert(treatmentsTable)
    .values({ patientId, protocolId })
    .returning();
  // Tarefas personalizadas além do protocolo (DOC-002, Fluxo 01)
  if (extraTasks && extraTasks.length > 0) {
    await db.insert(protocolTasksTable).values(
      extraTasks.map((t) => ({
        protocolId,
        treatmentId: treatment!.id,
        title: t.title,
        description: t.description ?? null,
        category: t.category,
        frequency: t.frequency,
      })),
    );
  }
  const active = await getActiveTreatmentWithTasks(patientId);
  res.status(201).json({
    id: active!.treatment.id,
    patientId: active!.treatment.patientId,
    protocolId: active!.treatment.protocolId,
    protocolName: active!.treatment.protocolName,
    startedAt: active!.treatment.startedAt.toISOString(),
    durationWeeks: active!.treatment.durationWeeks,
    tasks: active!.tasks,
  });
});

router.post("/task-logs", async (req, res): Promise<void> => {
  const parsed = CreateTaskLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { taskId, patientId, note, valueNumber } = parsed.data;
  const active = await getActiveTreatmentWithTasks(patientId);
  if (!active || !active.tasks.some((t) => t.id === taskId)) {
    res.status(400).json({ error: "Tarefa não pertence ao tratamento ativo" });
    return;
  }
  const today = todayStr();
  const existing = await db
    .select({ id: taskLogsTable.id })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, patientId),
        eq(taskLogsTable.treatmentId, active.treatment.id),
        eq(taskLogsTable.taskId, taskId),
        eq(taskLogsTable.logDate, today),
      ),
    );
  let logId: number;
  if (existing.length > 0) {
    // Same-day re-log: update note/value instead of silently ignoring
    logId = existing[0]!.id;
    await db
      .update(taskLogsTable)
      .set({
        ...(note !== undefined ? { note } : {}),
        ...(valueNumber !== undefined ? { valueNumber } : {}),
      })
      .where(eq(taskLogsTable.id, logId));
  } else {
    const [log] = await db
      .insert(taskLogsTable)
      .values({
        patientId,
        treatmentId: active.treatment.id,
        taskId,
        logDate: today,
        note: note ?? null,
        valueNumber: valueNumber ?? null,
      })
      .returning();
    logId = log!.id;
  }
  // If it's a measurement log with a numeric value, update current weight
  const task = active.tasks.find((t) => t.id === taskId);
  if (task?.category === "measurement" && typeof valueNumber === "number") {
    await db
      .update(patientsTable)
      .set({ currentWeightKg: valueNumber })
      .where(eq(patientsTable.id, patientId));
  }
  const adherence = await computeAdherence(patientId);
  res.status(201).json({ logId, adherence });
});

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const patients = await db.select().from(patientsTable);
  const summaries = await Promise.all(patients.map((p) => computeAdherence(p.id)));
  const withTreatment = summaries.filter((s) => s.riskLevel !== "none");
  const [logsTodayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskLogsTable)
    .where(eq(taskLogsTable.logDate, todayStr()));
  res.json({
    totalPatients: patients.length,
    highRisk: summaries.filter((s) => s.riskLevel === "high").length,
    mediumRisk: summaries.filter((s) => s.riskLevel === "medium").length,
    lowRisk: summaries.filter((s) => s.riskLevel === "low").length,
    avgAdherence:
      withTreatment.length === 0
        ? 0
        : Math.round(
            withTreatment.reduce((s, a) => s + a.score, 0) / withTreatment.length,
          ),
    logsToday: logsTodayRow?.count ?? 0,
  });
});

export default router;
