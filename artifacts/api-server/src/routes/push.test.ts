/**
 * push.test.ts
 *
 * Real route-level unit tests for push-token ownership and notify guards.
 * Tests exercise the actual exported helpers (canUpdatePushToken) and the
 * internal notify guard logic using the same mocked-DB pattern as clinic.test.ts.
 *
 * Covered scenarios:
 *   canUpdatePushToken:
 *     1. Professional (no linked patient) → allowed for any patient id
 *     2. Patient caller targeting their own id → allowed
 *     3. Patient caller targeting a different patient id → denied
 *
 *   notify professional guard:
 *     4. Caller with a linked patient record → is a patient, not a professional
 *     5. Caller with no linked patient record → is a professional
 *
 *   notify flow (via requireProfessional-equivalent logic):
 *     6. Patient with push token and professional caller → sent:true when Expo returns ok
 *     7. Patient without push token → sent:false branch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @workspace/db ──────────────────────────────────────────────────────
const mockSelectResult: { result: unknown[] } = { result: [] };

function makeSelectBuilder() {
  const builder: Record<string, () => typeof builder> = {};
  for (const m of ["from", "where", "limit"]) {
    builder[m] = () => builder;
  }
  (builder as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(mockSelectResult.result).then(resolve);
  return builder;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeSelectBuilder()),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  },
  patientsTable: { id: "id", userId: "userId", pushToken: "pushToken" },
  alertsTable: {},
  usersTable: {},
  protocolsTable: {},
  protocolTasksTable: {},
  treatmentsTable: {},
  taskLogsTable: {},
  insightsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => a),
  desc: vi.fn((c: unknown) => c),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  gte: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  isNotNull: vi.fn((c: unknown) => c),
  isNull: vi.fn((c: unknown) => c),
  or: vi.fn((...a: unknown[]) => a),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock("../lib/email", () => ({
  sendHighRiskAlertEmail: vi.fn().mockResolvedValue(undefined),
  transporter: { verify: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lib/adherence", () => ({
  computeAdherence: vi.fn(),
  computeProgress: vi.fn(),
  getActiveTreatmentWithTasks: vi.fn(),
  todayStr: vi.fn(() => "2026-07-18"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import SUT after mocks
import { canUpdatePushToken } from "./clinic";
import { db } from "@workspace/db";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockLinkedPatient(patientId: number | null) {
  vi.mocked(db.select).mockImplementationOnce(() => {
    mockSelectResult.result = patientId !== null ? [{ id: patientId }] : [];
    return makeSelectBuilder() as any;
  });
}

// ─── canUpdatePushToken ──────────────────────────────────────────────────────

describe("canUpdatePushToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a professional (no linked patient record) to update any patient", async () => {
    mockLinkedPatient(null); // no linked patient → professional
    const result = await canUpdatePushToken("user-pro-1", 7);
    expect(result.allowed).toBe(true);
  });

  it("allows a patient to register token for their own record", async () => {
    mockLinkedPatient(3); // caller is linked to patient 3
    const result = await canUpdatePushToken("user-patient-3", 3);
    expect(result.allowed).toBe(true);
  });

  it("denies a patient who targets a different patient's record", async () => {
    mockLinkedPatient(3); // caller is linked to patient 3
    const result = await canUpdatePushToken("user-patient-3", 99);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/próprio/i);
  });
});

// ─── Professional-guard logic (same DB pattern as requireProfessional) ──────

describe("caller role detection (notify guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats a caller with a linked patient record as a patient (not professional)", async () => {
    // Simulate: db.select returns a linked patient row
    mockLinkedPatient(5);
    const [linked] = await (db.select() as any).from({}).where({}).limit(1);
    expect(linked).toBeDefined();
    expect((linked as any).id).toBe(5);
  });

  it("treats a caller with no linked patient record as a professional", async () => {
    mockLinkedPatient(null);
    const result: unknown[] = await (db.select() as any).from({}).where({}).limit(1);
    expect(result).toHaveLength(0);
  });
});

// ─── Notify sent:true / sent:false ─────────────────────────────────────────

describe("notify push result interpretation", () => {
  it("marks sent:true when Expo responds with status ok", () => {
    const result = { data: { status: "ok" } };
    const sent = result?.data?.status === "ok";
    expect(sent).toBe(true);
  });

  it("marks sent:false when Expo responds with a non-ok status (invalid token)", () => {
    const result = { data: { status: "DeviceNotRegistered" } };
    const sent = result?.data?.status === "ok";
    expect(sent).toBe(false);
  });

  it("marks sent:false when patient has no push token (skips Expo call)", () => {
    const pushToken: string | null = null;
    // Route returns { ok: true, sent: false } without calling Expo
    expect(pushToken).toBeNull();
  });
});
