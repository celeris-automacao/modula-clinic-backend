/**
 * account-linking.test.ts
 *
 * Verifies that PATCH /patients/:id enforces authentication and authorization:
 *   - 401 when the caller is not authenticated
 *   - 403 when the caller is authenticated but linked to a patient (i.e. is a patient, not a professional)
 *   - 200 when the caller is a professional (authenticated, no linked patient record)
 *
 * All external dependencies (DB, auth, adherence) are mocked so this suite
 * runs without a real database or OIDC server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Control knobs set by each test ──────────────────────────────────────────

/** null  → unauthenticated; object → authenticated as that user */
let currentUser: { id: string } | null = null;

/**
 * When currentUser is set, this controls the patientId returned by the
 * "does this user have a linked patient?" query inside requireProfessional.
 * null  → user is a professional
 * number → user is a patient (linked to that patient id)
 */
let linkedPatientId: number | null = null;

/** Controls whether the target patient row exists for the PATCH query. */
let targetPatientExists = true;

// ─── Mock: auth middleware ────────────────────────────────────────────────────
// Replace the real OIDC-backed middleware with a simple stub that injects
// req.user from `currentUser` and wires up req.isAuthenticated().

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

const mockUpdateBuilder = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => mockUpdateBuilder),
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

// ─── Mock: lib/auth (session helpers used by real authMiddleware) ─────────────

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

// ─── Wire up DB select sequence ───────────────────────────────────────────────
//
// requireProfessional performs one SELECT to find a patient linked to the user.
// A successful PATCH then needs:
//   - one SELECT to fetch the patient row
//   - one UPDATE + returning to update it
//   - patientSummary selects (adherence/tasks/logs/insights are all mocked via lib/adherence)
//     but the summary function itself does 3 more selects (lastLog, latestInsight, ...patient).
//     We return minimal rows for those.

function setupProfessionalDbSequence() {
  let call = 0;
  const patientRow = {
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

  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    const rows: unknown[] =
      idx === 0
        ? [] // requireProfessional → no linked patient (caller is a professional)
        : idx === 1
          ? [patientRow] // fetch target patient
          : idx === 2
            ? [{ id: "new-user-id" }] // user existence check → user found
            : []; // lastLog, latestInsight selects
    return makeSelectBuilder(rows) as any;
  });

  // update().set().where().returning() → return updated patient row
  mockUpdateBuilder.returning.mockResolvedValue([{ ...patientRow, userId: "new-user-id" }]);
}

function setupNonExistentUserDbSequence() {
  let call = 0;
  const patientRow = {
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

  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    const rows: unknown[] =
      idx === 0
        ? [] // requireProfessional → no linked patient (caller is a professional)
        : idx === 1
          ? [patientRow] // fetch target patient
          : []; // user existence check → user NOT found
    return makeSelectBuilder(rows) as any;
  });
}

function setupPatientDbSequence() {
  // requireProfessional → finds a linked patient row for the caller
  vi.mocked(db.select).mockImplementation(() =>
    makeSelectBuilder([{ id: linkedPatientId }]) as any,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /api/patients/:id – account linking authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = null;
    linkedPatientId = null;
    targetPatientExists = true;
    mockUpdateBuilder.set.mockReturnThis();
    mockUpdateBuilder.where.mockReturnThis();
  });

  it("returns 401 when the caller is not authenticated", async () => {
    currentUser = null; // unauthenticated

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/1")
      .send({ userId: "some-user" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 403 when the caller is a patient (has a linked patient record)", async () => {
    currentUser = { id: "patient-user-id" };
    linkedPatientId = 99; // this user IS linked to a patient row
    setupPatientDbSequence();

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/1")
      .send({ userId: "some-user" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 200 when the caller is a professional (authenticated, no linked patient)", async () => {
    currentUser = { id: "prof-user-id" };
    linkedPatientId = null; // this user has no linked patient → is a professional
    setupProfessionalDbSequence();

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/1")
      .send({ userId: "new-patient-user-id" });

    expect(res.status).toBe(200);
  });

  it("returns 404 when the userId does not exist in the users table", async () => {
    currentUser = { id: "prof-user-id" };
    linkedPatientId = null; // caller is a professional
    setupNonExistentUserDbSequence();

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/1")
      .send({ userId: "ghost-user-id" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    // The patient record must NOT have been updated
    expect(mockUpdateBuilder.set).not.toHaveBeenCalled();
  });

  it("returns 409 when the userId is already linked to another patient (unique constraint)", async () => {
    currentUser = { id: "prof-user-id" };
    linkedPatientId = null;

    // DB sequence: professional check → no linked patient; fetch target patient → exists;
    // user existence check → user found; update → throws unique_violation
    let call = 0;
    const patientRow = {
      id: 2,
      name: "João",
      goal: "lose weight",
      age: 40,
      startWeightKg: 90,
      currentWeightKg: 89,
      goalWeightKg: 75,
      nextAppointment: null,
      userId: null,
    };
    vi.mocked(db.select).mockImplementation(() => {
      const idx = call++;
      const rows: unknown[] =
        idx === 0
          ? [] // requireProfessional → professional
          : idx === 1
            ? [patientRow] // fetch target patient
            : [{ id: "taken-user-id" }]; // user existence check → user found
      return makeSelectBuilder(rows) as any;
    });

    const pgUniqueError = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockUpdateBuilder.returning.mockRejectedValueOnce(pgUniqueError);

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/2")
      .send({ userId: "taken-user-id" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 200 when unlinking a patient account (userId set to null)", async () => {
    currentUser = { id: "prof-user-id" };
    linkedPatientId = null;

    const patientRow = {
      id: 3,
      name: "Ana",
      goal: "lose weight",
      age: 28,
      startWeightKg: 70,
      currentWeightKg: 68,
      goalWeightKg: 58,
      nextAppointment: null,
      userId: "existing-user-id",
    };

    // Unlink path: no user-existence check is performed when userId is null
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const idx = call++;
      const rows: unknown[] =
        idx === 0
          ? [] // requireProfessional → professional
          : idx === 1
            ? [patientRow] // fetch target patient
            : []; // patientSummary extra selects
      return makeSelectBuilder(rows) as any;
    });

    mockUpdateBuilder.returning.mockResolvedValueOnce([{ ...patientRow, userId: null }]);

    const app = buildApp();
    const res = await request(app)
      .patch("/api/patients/3")
      .send({ userId: null });

    expect(res.status).toBe(200);
    // The update must have been called (unlink actually executed)
    expect(mockUpdateBuilder.set).toHaveBeenCalled();
  });
});
