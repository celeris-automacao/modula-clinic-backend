/**
 * Seed script — inserts preset protocols using the 9 official category slugs.
 *
 * Run with:  pnpm --filter @workspace/db seed
 *
 * Safe to run repeatedly: existing presets with the same name are skipped.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { protocolsTable, protocolTasksTable } from "./schema/index.js";

// ---------------------------------------------------------------------------
// Official category slugs (BR-031)
// weight | water | nutrition | exercise | sleep | mood | medication | photo | free_text
// ---------------------------------------------------------------------------

const PRESET_PROTOCOLS = [
  {
    name: "Protocolo Bariátrico Padrão",
    description:
      "Protocolo completo para acompanhamento pós-cirurgia bariátrica: monitoramento de peso, hidratação, nutrição e adesão medicamentosa.",
    durationWeeks: 12,
    tasks: [
      {
        title: "Registrar peso",
        description: "Pese-se em jejum, sempre no mesmo horário.",
        category: "weight",
        frequency: "weekly",
        mandatory: true,
      },
      {
        title: "Hidratação diária",
        description: "Beba pelo menos 1,5 L de água ao longo do dia.",
        category: "water",
        frequency: "daily",
        mandatory: true,
      },
      {
        title: "Refeições fracionadas",
        description: "Registre que realizou as 5-6 refeições do plano alimentar.",
        category: "nutrition",
        frequency: "daily",
        mandatory: true,
      },
      {
        title: "Atividade física",
        description: "Caminhada leve ou exercício orientado pelo fisioterapeuta.",
        category: "exercise",
        frequency: "daily",
        mandatory: false,
      },
      {
        title: "Tomar suplementos",
        description: "Vitaminas e minerais conforme prescrição.",
        category: "medication",
        frequency: "daily",
        mandatory: true,
      },
      {
        title: "Qualidade do sono",
        description: "Como foi seu sono esta noite? Registre horas e qualidade.",
        category: "sleep",
        frequency: "daily",
        mandatory: false,
      },
      {
        title: "Humor e bem-estar",
        description: "Como você está se sentindo hoje? Registre seu estado emocional.",
        category: "mood",
        frequency: "daily",
        mandatory: false,
      },
      {
        title: "Foto de progresso",
        description: "Foto semanal para acompanhar a evolução corporal.",
        category: "photo",
        frequency: "weekly",
        mandatory: false,
      },
    ],
  },
  {
    name: "Protocolo de Emagrecimento",
    description:
      "Protocolo focado em perda de peso saudável: controle alimentar, exercício e monitoramento regular.",
    durationWeeks: 8,
    tasks: [
      {
        title: "Pesagem semanal",
        description: "Pese-se uma vez por semana, em jejum.",
        category: "weight",
        frequency: "weekly",
        mandatory: true,
      },
      {
        title: "Água no dia",
        description: "Registre ao atingir a meta de hidratação do dia.",
        category: "water",
        frequency: "daily",
        mandatory: true,
      },
      {
        title: "Refeição saudável",
        description: "Confirme que seguiu o plano alimentar hoje.",
        category: "nutrition",
        frequency: "daily",
        mandatory: false,
      },
      {
        title: "Exercício do dia",
        description: "Pelo menos 30 minutos de atividade moderada.",
        category: "exercise",
        frequency: "daily",
        mandatory: true,
      },
      {
        title: "Anotação livre",
        description: "Registre qualquer observação sobre seu dia ou dificuldades.",
        category: "free_text",
        frequency: "daily",
        mandatory: false,
      },
    ],
  },
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log("🌱  Starting seed…");

  for (const proto of PRESET_PROTOCOLS) {
    // Skip if a preset with the same name already exists
    const [existing] = await db
      .select({ id: protocolsTable.id })
      .from(protocolsTable)
      .where(eq(protocolsTable.name, proto.name));

    if (existing) {
      console.log(`  ⏭  Skipped (already exists): "${proto.name}"`);
      continue;
    }

    const [inserted] = await db
      .insert(protocolsTable)
      .values({
        name: proto.name,
        description: proto.description,
        durationWeeks: proto.durationWeeks,
        isPreset: true,
      })
      .returning();

    await db.insert(protocolTasksTable).values(
      proto.tasks.map((t) => ({
        protocolId: inserted!.id,
        title: t.title,
        description: t.description,
        category: t.category,
        frequency: t.frequency as "daily" | "weekly",
        mandatory: t.mandatory,
      })),
    );

    console.log(`  ✅  Seeded: "${proto.name}" (${proto.tasks.length} tasks)`);
  }

  await pool.end();
  console.log("🌱  Seed complete.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
