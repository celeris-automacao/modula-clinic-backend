/**
 * clinic.complete-cancel.test.ts
 *
 * Integration-style tests for:
 *   POST /treatments/:id/complete  (BR-021: Active → Completed)
 *   POST /treatments/:id/cancel    (BR-021: Active → Cancelled)
 *
 * The DB is fully mocked — no real database connection is needed.
 * Supertest drives HTTP requests through the real Express router so that
 * param parsing, status codes, and response shapes are all exercised.
 *
 * Covered cases per endpoint:
 *   - 404: treatment does not exist
 *   - 409: treatment is not active (e.g. still a draft)
 *   - 409: treatment is active but has zero logged tasks (BR-050)
 *   - 200: active treatment with activity → success
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoist mock state so vi.mock factories can reference it
// ---------------------------------------------------------------------------

const {
  mockSelectWhere,
  mockUpdateReturning,
  mockDb,
} = vi.hoisted(() => {
  const mockSelectWhere = vi.fn();
  const mockUpdateReturning = vi.fn();

  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: mockUpdateReturning,
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  return { mockSelectWhere, mockUpdateReturning, mockDb };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: mockDb,
  treatmentsTable: { id: "id", status: "status", patientId: "patientId", protocolId: "protocolId" },
  patientsTable: { id: "id", userId: "userId", name: "name" },
  protocolsTable: {},
  protocolTasksTable: { id: "id", protocolId: "protocolId", treatmentId: "treatmentId", category: "category", mandatory: "mandatory" },
  taskLogsTable: { treatmentId: "treatmentId", patientId: "patientId", logDate: "logDate", taskId: "taskId" },
  insightsTable: {},
  alertsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: "eq", col, val })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  desc: vi.fn((col: unknown) => ({ op: "desc", col })),
  gte: vi.fn((col: unknown, val: unknown) => ({ op: "gte", col, val })),
  isNull: vi.fn((col: unknown) => ({ op: "isNull", col })),
  sql: vi.fn((_strings: unknown) => "sql-fragment"),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock("../lib/adherence", () => ({
  computeAdherence: vi.fn().mockResolvedValue({ score: 0, riskLevel: "none", trend: "stable" }),
  computeProgress: vi.fn().mockResolvedValue([]),
  getActiveTreatmentWithTasks: vi.fn().mockResolvedValue(null),
  todayStr: vi.fn().mockReturnValue("2026-07-18"),
}));

vi.mock("../lib/email", () => ({
  sendHighRiskAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Build the test Express app using the real clinic router
// ---------------------------------------------------------------------------

import clinicRouter from "./clinic";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulate a logged-in professional (authenticated, not linked to any patient)
  app.use((_req, _res, next) => {
    (_req as any).isAuthenticated = () => true;
    (_req as any).user = { id: "prof-user-test" };
    next();
  });
  app.use("/", clinicRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeTreatment = { id: 42, status: "active", patientId: 1, protocolId: 1 };
const draftTreatment  = { id: 42, status: "draft",  patientId: 1, protocolId: 1 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /treatments/:id/complete", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when the treatment does not exist", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])  // requireProfessional: no linked patient → is professional
      .mockResolvedValueOnce([]); // treatment lookup → not found

    const res = await request(app).post("/treatments/999/complete");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("não encontrado") });
  });

  it("returns 409 when the treatment is not active", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([draftTreatment]); // treatment lookup → draft

    const res = await request(app).post("/treatments/42/complete");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("ativos") });
  });

  it("returns 409 when the treatment has no logged activity (BR-050)", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 0 }]);   // log count → zero

    const res = await request(app).post("/treatments/42/complete");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("atividades registradas") });
  });

  it("returns 200 with status=completed when treatment has activity", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 3 }])    // log count → has logs
      .mockResolvedValueOnce([]);               // mandatory tasks → none
    mockUpdateReturning.mockResolvedValue([{ id: 42, status: "completed" }]);

    const res = await request(app).post("/treatments/42/complete");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 42, status: "completed", missingMandatoryTasks: 0, missingMandatoryCategories: [] });
  });

  it("returns 409 when mandatory tasks were never logged (BR-089)", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 3 }])    // log count → has logs
      .mockResolvedValueOnce([               // mandatory tasks → weight + medication
        { id: 10, category: "weight" },
        { id: 11, category: "medication" },
      ])
      .mockResolvedValueOnce([{ taskId: 99 }]); // logged IDs → neither mandatory task logged

    const res = await request(app).post("/treatments/42/complete");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("obrigatórias"),
      missingMandatoryTasks: 2,
      missingMandatoryCategories: expect.arrayContaining(["weight", "medication"]),
    });
  });

  it("counts each missing task ID separately even when two share the same category", async () => {
    // Two mandatory "weight" tasks (e.g. morning + evening) — count=2 but only 1 unique category.
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 5 }])    // log count → has logs
      .mockResolvedValueOnce([               // mandatory tasks → two weight tasks + one medication
        { id: 10, category: "weight" },
        { id: 11, category: "weight" },
        { id: 12, category: "medication" },
      ])
      .mockResolvedValueOnce([{ taskId: 12 }]); // task 12 (medication) was logged; 10+11 were not

    const res = await request(app).post("/treatments/42/complete");

    expect(res.status).toBe(409);
    // missingMandatoryTasks must be 2 (two task IDs), not 1 (one deduplicated category)
    expect(res.body.missingMandatoryTasks).toBe(2);
    // missingMandatoryCategories is deduplicated for display
    expect(res.body.missingMandatoryCategories).toEqual(["weight"]);
  });
});

describe("POST /treatments/:id/cancel", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when the treatment does not exist", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])  // requireProfessional: no linked patient → is professional
      .mockResolvedValueOnce([]); // treatment lookup → not found

    const res = await request(app).post("/treatments/999/cancel");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("não encontrado") });
  });

  it("returns 409 when the treatment is not active", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([draftTreatment]); // treatment lookup → draft

    const res = await request(app).post("/treatments/42/cancel");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("ativos") });
  });

  it("returns 409 when the treatment has no logged activity (BR-050)", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 0 }]);   // log count → zero

    const res = await request(app).post("/treatments/42/cancel");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("atividades registradas") });
  });

  it("returns 200 with status=cancelled when treatment has activity", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 3 }])    // log count → has logs
      .mockResolvedValueOnce([]);               // mandatory tasks → none
    mockUpdateReturning.mockResolvedValue([{ id: 42, status: "cancelled" }]);

    const res = await request(app).post("/treatments/42/cancel");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 42, status: "cancelled", missingMandatoryTasks: 0, missingMandatoryCategories: [] });
  });

  it("returns 409 when mandatory tasks were never logged (BR-089)", async () => {
    mockSelectWhere
      .mockResolvedValueOnce([])              // requireProfessional: no linked patient
      .mockResolvedValueOnce([activeTreatment]) // treatment lookup → active
      .mockResolvedValueOnce([{ count: 3 }])    // log count → has logs
      .mockResolvedValueOnce([               // mandatory tasks → weight
        { id: 10, category: "weight" },
      ])
      .mockResolvedValueOnce([]);               // logged IDs → mandatory task never logged

    const res = await request(app).post("/treatments/42/cancel");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("obrigatórias"),
      missingMandatoryTasks: 1,
      missingMandatoryCategories: ["weight"],
    });
  });
});
