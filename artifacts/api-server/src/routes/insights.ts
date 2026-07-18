import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, patientsTable, insightsTable } from "@workspace/db";
import { GetLatestInsightParams, GenerateInsightParams } from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { computeAdherence, getActiveTreatmentWithTasks } from "../lib/adherence";

const router: IRouter = Router();

function serializeInsight(row: typeof insightsTable.$inferSelect) {
  return {
    id: row.id,
    patientId: row.patientId,
    summary: row.summary,
    observedFactors: row.observedFactors,
    suggestedAction: row.suggestedAction,
    riskLevel: row.riskLevel,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/patients/:id/insight", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return;
  }
  const params = GetLatestInsightParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [insight] = await db
    .select()
    .from(insightsTable)
    .where(eq(insightsTable.patientId, params.data.id))
    .orderBy(desc(insightsTable.createdAt))
    .limit(1);
  if (!insight) {
    res.status(404).json({ error: "Nenhum insight gerado ainda" });
    return;
  }
  res.json(serializeInsight(insight));
});

router.post("/patients/:id/insight/generate", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return;
  }
  const params = GenerateInsightParams.safeParse(req.params);
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
  const active = await getActiveTreatmentWithTasks(patient.id);
  if (!active) {
    res.status(404).json({ error: "Paciente sem tratamento ativo" });
    return;
  }

  // BR-004: O Adherence Engine é a única fonte do Score — a IA apenas interpreta
  const adherence = await computeAdherence(patient.id);

  // BR-093: Não gerar Insight sem Score
  if (adherence.score === 0 && adherence.riskLevel === "none") {
    res.status(422).json({ error: "Não é possível gerar insight sem score calculado (BR-093)" });
    return;
  }

  const context = {
    paciente: {
      nome: patient.name,
      objetivo: patient.goal,
      pesoInicialKg: patient.startWeightKg,
      pesoAtualKg: patient.currentWeightKg,
      proximaConsulta: patient.nextAppointment,
    },
    protocolo: active.treatment.protocolName,
    adesao: {
      score: adherence.score,
      nivelRisco: adherence.riskLevel,
      tendencia: adherence.trend,
      sequenciaDiasCompletos: adherence.currentStreakDays,
      tarefasPerdidasUltimos3Dias: adherence.missedLast3Days,
      conclusaoSemanalPct: adherence.weeklyCompletionPct,
      porCategoria: adherence.categoryBreakdown,
    },
  };

  // BR-072: todo insight deve conter resumo, fatores observados e sugestão de acompanhamento
  // BR-071/BR-073: a IA interpreta — nunca calcula scores nem altera Radar
  const completion = await openai.chat.completions.create({
    model: "gpt-5.6-terra",
    max_completion_tokens: 8192,
    messages: [
      {
        role: "system",
        content:
          "Você é um assistente clínico do Modula Clinic. Você recebe indicadores objetivos calculados pelo Adherence Engine (você NÃO calcula scores, apenas interpreta os dados). " +
          "Responda SOMENTE com JSON válido no formato {\"summary\": string, \"observedFactors\": string, \"suggestedAction\": string}. " +
          "Escreva TODO o texto exclusivamente em português do Brasil. " +
          "'summary': 2-3 frases explicando o comportamento de adesão do paciente de forma clara e objetiva, citando os dados relevantes. " +
          "'observedFactors': 1-2 frases destacando os principais fatores observados nos dados (tarefas com baixa conclusão, padrão de falhas, sequência interrompida, etc.). " +
          "'suggestedAction': 1-2 frases com uma sugestão de ação concreta para o profissional de saúde antes da próxima consulta. " +
          "Tom profissional e direto. A decisão final é sempre do profissional. Nunca diagnostique, prescreva ou altere indicadores.",
      },
      {
        role: "user",
        content: JSON.stringify(context),
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsedAi: { summary?: string; observedFactors?: string; suggestedAction?: string };
  try {
    parsedAi = JSON.parse(raw);
  } catch {
    parsedAi = {};
  }

  const summary =
    typeof parsedAi.summary === "string" && parsedAi.summary.trim().length > 0
      ? parsedAi.summary.trim()
      : `Adesão atual de ${adherence.score}% (risco ${adherence.riskLevel}), tendência ${adherence.trend}.`;

  const observedFactors =
    typeof parsedAi.observedFactors === "string" && parsedAi.observedFactors.trim().length > 0
      ? parsedAi.observedFactors.trim()
      : `Score de ${adherence.score}% com ${adherence.missedLast3Days} tarefas perdidas nos últimos 3 dias.`;

  const suggestedAction =
    typeof parsedAi.suggestedAction === "string" && parsedAi.suggestedAction.trim().length > 0
      ? parsedAi.suggestedAction.trim()
      : "Entre em contato com o paciente para entender as dificuldades e reforçar o plano.";

  const [insight] = await db
    .insert(insightsTable)
    .values({
      patientId: patient.id,
      summary,
      observedFactors,
      suggestedAction,
      riskLevel: adherence.riskLevel,
    })
    .returning();

  res.status(201).json(serializeInsight(insight!));
});

export default router;
