import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  patientsTable,
  protocolsTable,
  protocolTasksTable,
  treatmentsTable,
  taskLogsTable,
  insightsTable,
  alertsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
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
  MarkAlertReadParams,
  PublishTreatmentParams,
  CompleteTreatmentParams,
  CancelTreatmentParams,
  LinkPatientAccountParams,
  LinkPatientAccountBody,
} from "@workspace/api-zod";
import {
  computeAdherence,
  computeProgress,
  getActiveTreatmentWithTasks,
  todayStr,
} from "../lib/adherence";
import { sendHighRiskAlertEmail } from "../lib/email";

/** Returns YYYY-MM-DD for N days ago */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared alert-creation logic
// ---------------------------------------------------------------------------

/**
 * For a single patient: if riskLevel is "high" and there is no unread alert,
 * create one. Returns true if a new alert was created.
 */
export async function ensureHighRiskAlert(
  patientId: number,
  patientName: string,
  score: number,
): Promise<boolean> {
  const [existingUnread] = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(and(eq(alertsTable.patientId, patientId), isNull(alertsTable.readAt)))
    .limit(1);

  if (existingUnread) return false;

  await db.insert(alertsTable).values({
    patientId,
    patientName,
    message: `Adesão baixou para ${score}% — paciente em risco alto.`,
    riskLevel: "high",
  });

  // Fire-and-forget: notify the professional by e-mail regardless of which
  // code path triggered the alert (task-log, inactivity scanner, etc.)
  void sendHighRiskAlertEmail({ patientId, patientName, adherenceScore: score });

  return true;
}

/**
 * Scan every patient with an active treatment and create high-risk alerts for
 * those that are at risk but have no unread alert yet. Returns how many new
 * alerts were created.
 */
export async function checkAllPatientsForHighRisk(): Promise<number> {
  const patients = await db.select().from(patientsTable);
  let created = 0;
  await Promise.all(
    patients.map(async (patient) => {
      const adherence = await computeAdherence(patient.id);
      if (adherence.riskLevel !== "high") return;
      const wasCreated = await ensureHighRiskAlert(patient.id, patient.name, adherence.score);
      if (wasCreated) created++;
    }),
  );
  return created;
}

async function patientSummary(patient: typeof patientsTable.$inferSelect) {
  const adherence = await computeAdherence(patient.id);
  const active = await getActiveTreatmentWithTasks(patient.id);
  const [lastLog] = await db
    .select({ createdAt: taskLogsTable.createdAt })
    .from(taskLogsTable)
    .where(eq(taskLogsTable.patientId, patient.id))
    .orderBy(desc(taskLogsTable.createdAt))
    .limit(1);

  // BR-081: Dashboard exibe insight resumido por paciente
  const [latestInsight] = await db
    .select({ summary: insightsTable.summary })
    .from(insightsTable)
    .where(eq(insightsTable.patientId, patient.id))
    .orderBy(desc(insightsTable.createdAt))
    .limit(1);

  return {
    id: patient.id,
    name: patient.name,
    goal: patient.goal,
    age: patient.age,
    startWeightKg: patient.startWeightKg,
    currentWeightKg: patient.currentWeightKg,
    nextAppointment: patient.nextAppointment,
    userId: patient.userId ?? null,
    adherenceScore: adherence.score,
    riskLevel: adherence.riskLevel,
    trend: adherence.trend,
    hasActiveTreatment: !!active,
    protocolName: active?.treatment.protocolName ?? null,
    lastActivityAt: lastLog?.createdAt?.toISOString() ?? null,
    insightSummary: latestInsight?.summary ?? null,
  };
}

// BR-080: Dashboard ordena por nível de risco
const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };

// Dados clínicos exigem sessão autenticada (dashboard profissional)
function requireAuth(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return false;
  }
  return true;
}

// Returns the patient record linked to the currently authenticated user (patient self-service)
router.get("/patients/me", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  const [patient] = await db
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.userId, req.user.id));
  if (!patient) {
    res.status(404).json({ error: "Nenhum paciente vinculado a este usuário" });
    return;
  }
  res.json(await patientSummary(patient));
});

router.get("/patients", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
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
  if (!requireAuth(req, res)) return;
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

router.patch("/patients/:id", async (req, res): Promise<void> => {
  const params = LinkPatientAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = LinkPatientAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
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
  const [updated] = await db
    .update(patientsTable)
    .set({ userId: body.data.userId ?? null })
    .where(eq(patientsTable.id, params.data.id))
    .returning();
  res.json(await patientSummary(updated!));
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

router.get("/patients/:id/measurements", async (req, res): Promise<void> => {
  const params = GetPatientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const since = daysAgoStr(30);
  const logs = await db
    .select({
      date: taskLogsTable.logDate,
      valueNumber: taskLogsTable.valueNumber,
    })
    .from(taskLogsTable)
    .innerJoin(protocolTasksTable, eq(taskLogsTable.taskId, protocolTasksTable.id))
    // Apenas o tratamento ativo: medições de tratamentos encerrados/cancelados
    // não devem aparecer no gráfico do ciclo atual
    .innerJoin(treatmentsTable, eq(taskLogsTable.treatmentId, treatmentsTable.id))
    .where(
      and(
        eq(taskLogsTable.patientId, params.data.id),
        eq(treatmentsTable.status, "active"),
        or(
          eq(protocolTasksTable.category, "weight"),
          eq(protocolTasksTable.category, "measurement"),
        ),
        gte(taskLogsTable.logDate, since),
        isNotNull(taskLogsTable.valueNumber),
      ),
    )
    .orderBy(taskLogsTable.logDate);
  res.json(logs.map((l) => ({ date: l.date, valueNumber: l.valueNumber! })));
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
    status: active.treatment.status,
    startedAt: active.treatment.startedAt.toISOString(),
    durationWeeks: active.treatment.durationWeeks,
    tasks: active.tasks,
  });
});

router.get("/patients/:id/tasks/today", async (req, res): Promise<void> => {
  // Dados sensíveis (fotos, notas): exige sessão; paciente vinculado só acessa
  // o próprio id, profissionais (sem paciente vinculado) acessam qualquer um
  if (!requireAuth(req, res)) return;
  const params = GetTodayTasksParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [linkedPatient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.userId, req.user!.id));
  if (linkedPatient && linkedPatient.id !== params.data.id) {
    res.status(403).json({ error: "Você só pode acessar suas próprias tarefas" });
    return;
  }
  // BR-022: somente tratamentos ativos
  const active = await getActiveTreatmentWithTasks(params.data.id);
  if (!active) {
    res.json([]);
    return;
  }
  const today = todayStr();

  // BR-035: week-start (Sunday) for weekly-task completion detection
  const wd = new Date();
  wd.setUTCHours(0, 0, 0, 0);
  wd.setUTCDate(wd.getUTCDate() - wd.getUTCDay());
  const weekStart = wd.toISOString().slice(0, 10);

  // Query all logs since week-start — covers daily (today) and weekly (this week)
  const logs = await db
    .select({
      taskId: taskLogsTable.taskId,
      logDate: taskLogsTable.logDate,
      note: taskLogsTable.note,
      photoData: taskLogsTable.photoData,
    })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, params.data.id),
        eq(taskLogsTable.treatmentId, active.treatment.id),
        gte(taskLogsTable.logDate, weekStart),
      ),
    );

  // Build separate maps: daily tasks check today only, weekly tasks check whole week
  type LogInfo = { note: string | null; photoData: string | null };
  const dailyDone = new Map<number, LogInfo>();
  const weeklyDone = new Map<number, LogInfo>();
  for (const log of logs) {
    const info = { note: log.note, photoData: log.photoData };
    if (log.logDate === today) dailyDone.set(log.taskId, info);
    weeklyDone.set(log.taskId, info);
  }

  const items = active.tasks.map((t) => {
    const isWeekly = t.frequency === "weekly";
    const done = isWeekly ? weeklyDone.has(t.id) : dailyDone.has(t.id);
    const info = isWeekly ? weeklyDone.get(t.id) : dailyDone.get(t.id);
    return {
      taskId: t.id,
      title: t.title,
      description: t.description,
      category: t.category,
      frequency: t.frequency,
      mandatory: t.mandatory,
      completedToday: done,
      note: info?.note ?? null,
      photoDataUrl: info?.photoData ?? null,
    };
  });

  // STORY-011: ordenação determinística — pendentes antes de concluídas,
  // obrigatórias antes de opcionais, estável por taskId dentro de cada grupo
  items.sort(
    (a, b) =>
      Number(a.completedToday) - Number(b.completedToday) ||
      Number(b.mandatory) - Number(a.mandatory) ||
      a.taskId - b.taskId,
  );

  res.json(items);
});

// Somente usuários autenticados SEM paciente vinculado (profissionais) podem
// gerenciar tratamentos. Pacientes vinculados recebem 403.
async function requireProfessional(req: Request, res: Response): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return false;
  }
  const [linkedPatient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.userId, req.user.id));
  if (linkedPatient) {
    res.status(403).json({ error: "Apenas profissionais podem gerenciar tratamentos" });
    return false;
  }
  return true;
}

router.get("/protocols", async (_req, res): Promise<void> => {
  const protocols = await db.select().from(protocolsTable).orderBy(protocolsTable.id);
  // Biblioteca de protocolos: apenas tarefas canônicas (sem as personalizadas de tratamentos)
  const tasks = await db
    .select()
    .from(protocolTasksTable)
    .where(isNull(protocolTasksTable.treatmentId));
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
    .where(
      and(
        eq(protocolTasksTable.protocolId, protocol.id),
        isNull(protocolTasksTable.treatmentId),
      ),
    );
  res.json({ ...protocol, tasks });
});

// BR-021: ciclo Draft → Active → Completed | Cancelled
router.post("/treatments", async (req, res): Promise<void> => {
  // Somente profissionais podem criar tratamentos
  if (!(await requireProfessional(req, res))) return;
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
  // Cancel any existing draft (only one draft per patient at a time)
  await db
    .update(treatmentsTable)
    .set({ status: "cancelled" })
    .where(and(eq(treatmentsTable.patientId, patientId), eq(treatmentsTable.status, "draft")));

  // Create treatment in Draft state (BR-021)
  const [treatment] = await db
    .insert(treatmentsTable)
    .values({ patientId, protocolId, status: "draft" })
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
        mandatory: t.mandatory ?? false,
      })),
    );
  }
  res.status(201).json({
    id: treatment!.id,
    patientId: treatment!.patientId,
    protocolId: treatment!.protocolId,
    status: treatment!.status,
    protocolName: protocol.name,
    startedAt: treatment!.startedAt.toISOString(),
    durationWeeks: protocol.durationWeeks,
  });
});

// BR-003, BR-090: Publicar tratamento — valida que tem tarefas e muda Draft → Active
router.post("/treatments/:id/publish", async (req, res): Promise<void> => {
  // Somente profissionais podem publicar tratamentos
  if (!(await requireProfessional(req, res))) return;
  const params = PublishTreatmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = params.data.id;
  const [treatment] = await db
    .select()
    .from(treatmentsTable)
    .where(eq(treatmentsTable.id, id));
  if (!treatment) {
    res.status(404).json({ error: "Tratamento não encontrado" });
    return;
  }
  if (treatment.status !== "draft") {
    res.status(409).json({ error: "Somente tratamentos em rascunho podem ser publicados" });
    return;
  }
  // BR-003, BR-090: deve ter ao menos uma tarefa
  const tasks = await db
    .select({ id: protocolTasksTable.id })
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
  if (tasks.length === 0) {
    res.status(422).json({
      error: "Não é possível publicar um tratamento sem pelo menos uma tarefa (BR-003)",
    });
    return;
  }
  // Move any current active treatment to Completed
  await db
    .update(treatmentsTable)
    .set({ status: "completed" })
    .where(
      and(
        eq(treatmentsTable.patientId, treatment.patientId),
        eq(treatmentsTable.status, "active"),
      ),
    );
  // Activate this treatment (Draft → Active)
  const [updated] = await db
    .update(treatmentsTable)
    .set({ status: "active" })
    .where(eq(treatmentsTable.id, treatment.id))
    .returning();
  res.json({ id: updated!.id, status: updated!.status });
});

// BR-021: Active → Completed
router.post("/treatments/:id/complete", async (req, res): Promise<void> => {
  const params = CompleteTreatmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [treatment] = await db
    .select()
    .from(treatmentsTable)
    .where(eq(treatmentsTable.id, params.data.id));
  if (!treatment) {
    res.status(404).json({ error: "Tratamento não encontrado" });
    return;
  }
  if (treatment.status !== "active") {
    res.status(409).json({ error: "Somente tratamentos ativos podem ser encerrados" });
    return;
  }
  const [updated] = await db
    .update(treatmentsTable)
    .set({ status: "completed" })
    .where(eq(treatmentsTable.id, treatment.id))
    .returning();
  res.json({ id: updated!.id, status: updated!.status });
});

// BR-021: Active → Cancelled
router.post("/treatments/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelTreatmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [treatment] = await db
    .select()
    .from(treatmentsTable)
    .where(eq(treatmentsTable.id, params.data.id));
  if (!treatment) {
    res.status(404).json({ error: "Tratamento não encontrado" });
    return;
  }
  if (treatment.status !== "active") {
    res.status(409).json({ error: "Somente tratamentos ativos podem ser cancelados" });
    return;
  }
  const [updated] = await db
    .update(treatmentsTable)
    .set({ status: "cancelled" })
    .where(eq(treatmentsTable.id, treatment.id))
    .returning();
  res.json({ id: updated!.id, status: updated!.status });
});

router.post("/task-logs", async (req, res): Promise<void> => {
  // Authentication required for all task logging
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return;
  }

  const parsed = CreateTaskLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { taskId, patientId, note, valueNumber, photoDataUrl } = parsed.data;

  // STORY-012: validação de foto — apenas data URLs de imagem, tamanho limitado
  if (photoDataUrl !== undefined) {
    if (!/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,/.test(photoDataUrl)) {
      res.status(400).json({ error: "Foto inválida: esperado data URL base64 de imagem" });
      return;
    }
    if (photoDataUrl.length > 6 * 1024 * 1024) {
      res.status(400).json({ error: "Foto muito grande (máx. ~4MB)" });
      return;
    }
  }

  // Authentication required; patients can only log their own tasks, professionals any patient.
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return;
  }
  const [linkedPatient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.userId, req.user.id));
  if (linkedPatient && linkedPatient.id !== patientId) {
    res.status(403).json({ error: "Você só pode registrar suas próprias tarefas" });
    return;
  }

  // BR-092: tarefa deve pertencer ao tratamento ativo do paciente
  const active = await getActiveTreatmentWithTasks(patientId);
  if (!active) {
    res.status(400).json({ error: "Paciente não possui tratamento ativo (BR-092)" });
    return;
  }
  // BR-091: tarefa deve existir no tratamento
  if (!active.tasks.some((t) => t.id === taskId)) {
    res.status(400).json({ error: "Tarefa não pertence ao tratamento ativo (BR-091)" });
    return;
  }

  const task = active.tasks.find((t) => t.id === taskId)!;

  // STORY-012: tarefas de foto exigem a foto anexada
  if (task.category === "photo" && !photoDataUrl) {
    res.status(400).json({ error: "Tarefas de foto exigem uma foto anexada" });
    return;
  }

  const today = todayStr();

  // BR-035: uma tarefa só pode ser concluída uma vez por período de frequência
  // Para tarefas diárias: uma vez por dia. Para semanais: uma vez por semana.
  let periodStart = today;
  if (task.frequency === "weekly") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // início da semana (domingo)
    periodStart = d.toISOString().slice(0, 10);
  }

  const existing = await db
    .select({ id: taskLogsTable.id, logDate: taskLogsTable.logDate })
    .from(taskLogsTable)
    .where(
      and(
        eq(taskLogsTable.patientId, patientId),
        eq(taskLogsTable.treatmentId, active.treatment.id),
        eq(taskLogsTable.taskId, taskId),
        sql`${taskLogsTable.logDate} >= ${periodStart}`,
      ),
    );

  if (existing.length > 0) {
    // BR-035: rejeitar duplicata no período — servidor não permite registrar duas vezes
    res.status(409).json({
      error: "Tarefa já registrada neste período de frequência (BR-035)",
      logId: existing[0]!.id,
    });
    return;
  }

  const [log] = await db
    .insert(taskLogsTable)
    .values({
      patientId,
      treatmentId: active.treatment.id,
      taskId,
      logDate: today,
      note: note ?? null,
      valueNumber: valueNumber ?? null,
      photoData: photoDataUrl ?? null,
    })
    .returning();

  // Se for registro de peso, atualizar peso atual do paciente
  if (task.category === "weight" && typeof valueNumber === "number") {
    await db
      .update(patientsTable)
      .set({ currentWeightKg: valueNumber })
      .where(eq(patientsTable.id, patientId));
  }

  const adherence = await computeAdherence(patientId);

  if (adherence.riskLevel === "high") {
    const [patientRow] = await db
      .select({ name: patientsTable.name })
      .from(patientsTable)
      .where(eq(patientsTable.id, patientId));
    if (patientRow) {
      // ensureHighRiskAlert fires the e-mail internally when a new alert is created
      await ensureHighRiskAlert(patientId, patientRow.name, adherence.score);
    }
  } else {
    // Patient is no longer high-risk — auto-resolve any open alerts
    await db
      .update(alertsTable)
      .set({ readAt: new Date() })
      .where(and(eq(alertsTable.patientId, patientId), isNull(alertsTable.readAt)));
  }

  res.status(201).json({ logId: log!.id, adherence });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * POST /alerts/check
 * Recomputes adherence for every patient and creates high-risk alerts for any
 * patient that is at risk but has no unread alert. Safe to call repeatedly —
 * duplicate alerts are suppressed. Also triggered automatically every hour
 * by the scheduler in index.ts.
 */
router.post("/alerts/check", async (req, res): Promise<void> => {
  if (!(await requireProfessional(req, res))) return;
  const created = await checkAllPatientsForHighRisk();
  res.json({ ok: true, alertsCreated: created });
});

router.get("/alerts", async (req, res): Promise<void> => {
  if (!(await requireProfessional(req, res))) return;
  const alerts = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.createdAt));
  res.json(
    alerts.map((a) => ({
      id: a.id,
      patientId: a.patientId,
      patientName: a.patientName,
      message: a.message,
      riskLevel: a.riskLevel,
      readAt: a.readAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  );
});

router.patch("/alerts/:id/read", async (req, res): Promise<void> => {
  if (!(await requireProfessional(req, res))) return;
  const params = MarkAlertReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [updated] = await db
    .update(alertsTable)
    .set({ readAt: new Date() })
    .where(eq(alertsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Alerta não encontrado" });
    return;
  }
  res.json({ ok: true });
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
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
