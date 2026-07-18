/**
 * patient-read-auth.test.ts
 *
 * Verifies that GET /patients/:id enforces authentication and authorization:
 *   - 401 when the caller is not authenticated
 *   - 403 when an authenticated patient tries to read another patient's record
 *   - 200 when an authenticated patient reads their own record
 *   - 200 when a professional (no linked patient row) reads any patient
 *
 * All external dependencies (DB, auth, adherence) are mocked so this suite
 * runs without a real database or OIDC server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Control knobs set by each test ──────────────────────────────────────────

/** null → unauthenticated; object → authenticated as that user */
let currentUser: { id: string } | null = null;

/**
 * Simulates the result of the "does this user have a linked patient?" SELECT.
 * null  → caller is a professional (no linked patient)
 * number → caller is a patient linked to that patient id
 */
let callerLinkedPatientId: number | null = null;

/** The patient row returned when the target patient is fetched. */
let targetPatientRow: Record<string, unknown> | null = {
  id: 1,
  name: "Maria",
  goal: "lose weight",
  age: 30,
  startWeightKg: 80,
  currentWeightKg: 78,
  goalWeightKg: 65,
  nextAppointment: null,
  userId: null,
};

// ─── Mock: auth middleware ────────────────────────────────────────────────────

vi.mock("../middlewares/authMiddleware", () => ({
  authMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.isAuthenticated = function () {
      return currentUser != null;
    } as typeof req.isAuthenticated;
    if (currentUser) req.user = currentUser as Express.User;
    next();
  },
}));

// ─── Mock: @workspace/db ─────────────────────────────────────────────────────

function makeSelectBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chainMethods = ["from", "where", "limit", "orderBy", "innerJoin"];
  for (const m of chainMethods) {
    builder[m] = () => builder;
  }
  (builder as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => ({ set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), returning: vi.fn() })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  patientsTable: { id: "id", userId: "userId" },
  alertsTable: {},
  usersTable: {},
  protocolsTable: {},
  protocolTasksTable: {},
  treatmentsTable: {},
  taskLogsTable: {},
  insightsTable: {},
}));

// ─── Mock: drizzle-orm ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn((col: unknown) => col),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  gte: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNotNull: vi.fn((col: unknown) => col),
  isNull: vi.fn((col: unknown) => col),
  or: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

// ─── Mock: lib/adherence ─────────────────────────────────────────────────────

vi.mock("../lib/adherence", () => ({
  computeAdherence: vi.fn().mockResolvedValue({ score: 80, riskLevel: "low", trend: "stable" }),
  computeProgress: vi.fn().mockResolvedValue({}),
  getActiveTreatmentWithTasks: vi.fn().mockResolvedValue(null),
  todayStr: vi.fn(() => "2026-07-18"),
}));

// ─── Mock: lib/email ─────────────────────────────────────────────────────────

vi.mock("../lib/email", () => ({
  sendHighRiskAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock: lib/logger ────────────────────────────────────────────────────────

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Mock: lib/auth ───────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  getSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  clearSession: vi.fn(),
  updateSession: vi.fn(),
  getOidcConfig: vi.fn(),
}));

// ─── Build test app ───────────────────────────────────────────────────────────

import { authMiddleware } from "../middlewares/authMiddleware";
import { db } from "@workspace/db";
import clinicRouter from "./clinic";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api", clinicRouter);
  return app;
}

// ─── DB select sequence helpers ───────────────────────────────────────────────
//
// GET /patients/:id performs:
//   SELECT 0 – linked-patient check (returns [] for professionals, [{id}] for patients)
//   SELECT 1 – fetch the target patient row
//   SELECT 2+ – patientSummary internals (lastLog, latestInsight, etc.) → []

function setupDbSequence(linkedRows: unknown[], targetRows: unknown[]) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    const rows = idx === 0 ? linkedRows : idx === 1 ? targetRows : [];
    return makeSelectBuilder(rows) as any;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/patients/:id – authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = null;
    callerLinkedPatientId = null;
  });

  it("returns 401 when the caller is not authenticated", async () => {
    currentUser = null;

    const app = buildApp();
    const res = await request(app).get("/api/patients/1");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 403 when an authenticated patient tries to read another patient's record", async () => {
    currentUser = { id: "patient-user-id" };
    callerLinkedPatientId = 99; // caller is linked to patient 99

    // SELECT 0: linked-patient check returns patient 99
    // The route will 403 before SELECT 1 because 99 !== 1 (requested id)
    setupDbSequence([{ id: callerLinkedPatientId }], []);

    const app = buildApp();
    const res = await request(app).get("/api/patients/1"); // requesting id=1, not 99

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 200 when an authenticated patient reads their own record", async () => {
    currentUser = { id: "patient-user-id" };
    callerLinkedPatientId = 1; // caller is linked to patient 1

    setupDbSequence(
      [{ id: 1 }], // SELECT 0: linked-patient check → this is patient 1
      [targetPatientRow], // SELECT 1: fetch patient 1 row
    );

    const app = buildApp();
    const res = await request(app).get("/api/patients/1"); // requesting own record

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1 });
  });

  it("returns 200 when a professional reads any patient record", async () => {
    currentUser = { id: "prof-user-id" };
    callerLinkedPatientId = null; // no linked patient → is a professional

    setupDbSequence(
      [], // SELECT 0: linked-patient check → empty (professional)
      [targetPatientRow], // SELECT 1: fetch target patient
    );

    const app = buildApp();
    const res = await request(app).get("/api/patients/1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1 });
  });
});
