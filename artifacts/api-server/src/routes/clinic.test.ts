/**
 * clinic.test.ts
 *
 * Tests for ensureHighRiskAlert — specifically the e-mail notification path.
 * All DB calls and sendHighRiskAlertEmail are mocked so the test suite runs
 * without a real database or SMTP server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────
//
// We intercept every drizzle query chain.  Each call to db.select() returns a
// builder whose methods (from, where, limit) are all chainable and ultimately
// resolve to a configurable array so tests can control the returned rows.

const mockSelectResult: { result: unknown[] } = { result: [] };

function makeSelectBuilder() {
  const builder: Record<string, () => typeof builder> = {};
  const methods = ["from", "where", "limit"];
  for (const m of methods) {
    builder[m] = () => builder;
  }
  // Make the builder itself thenable so `await db.select()...` works
  (builder as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(mockSelectResult.result).then(resolve);
  return builder;
}

const mockInsertBuilder = {
  values: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeSelectBuilder()),
    insert: vi.fn(() => mockInsertBuilder),
  },
  patientsTable: {},
  alertsTable: {},
  usersTable: {},
  // Unused but imported by clinic.ts
  protocolsTable: {},
  protocolTasksTable: {},
  treatmentsTable: {},
  taskLogsTable: {},
  insightsTable: {},
}));

// ─── Mock drizzle-orm helpers ─────────────────────────────────────────────
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

// ─── Mock email sender ────────────────────────────────────────────────────
vi.mock("../lib/email", () => ({
  sendHighRiskAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock adherence / other deps ──────────────────────────────────────────
vi.mock("../lib/adherence", () => ({
  computeAdherence: vi.fn(),
  computeProgress: vi.fn(),
  getActiveTreatmentWithTasks: vi.fn(),
  todayStr: vi.fn(() => "2026-07-18"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Import SUT after mocks are in place ──────────────────────────────────
import { ensureHighRiskAlert } from "./clinic";
import { sendHighRiskAlertEmail } from "../lib/email";
import { db } from "@workspace/db";

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Wire up the sequence of DB calls made by ensureHighRiskAlert:
 *   1st select  → alertsTable check (existingUnread)
 *   insert      → new alert row
 *   2nd select  → usersTable rows (professionals with notificationEmail)
 *   3rd select  → patientsTable rows (to determine patient user-ids)
 */
function setupDbSequence({
  existingAlert,
  usersWithEmail,
  patientUserIds,
}: {
  existingAlert: boolean;
  usersWithEmail: { id: string; notificationEmail: string | null }[];
  patientUserIds: (string | null)[];
}) {
  let callCount = 0;
  const sequences = [
    existingAlert ? [{ id: 1 }] : [],   // 1st select: existing unread alert
    usersWithEmail,                       // 2nd select: users with notificationEmail
    patientUserIds.map((userId) => ({ userId })), // 3rd select: patient user ids
  ];

  vi.mocked(db.select).mockImplementation(() => {
    const result = sequences[callCount] ?? [];
    callCount++;
    mockSelectResult.result = result;
    return makeSelectBuilder() as any;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ensureHighRiskAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertBuilder.values.mockResolvedValue(undefined);
  });

  it("returns false and sends no e-mail when an unread alert already exists", async () => {
    setupDbSequence({
      existingAlert: true,
      usersWithEmail: [],
      patientUserIds: [],
    });

    const result = await ensureHighRiskAlert(1, "Maria", 30);

    expect(result).toBe(false);
    expect(sendHighRiskAlertEmail).not.toHaveBeenCalled();
  });

  it("sends to a single professional's configured e-mail", async () => {
    setupDbSequence({
      existingAlert: false,
      usersWithEmail: [{ id: "prof-1", notificationEmail: "prof@clinic.com" }],
      patientUserIds: ["patient-user-1"],
    });

    const result = await ensureHighRiskAlert(1, "Maria", 28);

    expect(result).toBe(true);
    expect(sendHighRiskAlertEmail).toHaveBeenCalledOnce();
    expect(sendHighRiskAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "prof@clinic.com" }),
    );
  });

  it("joins multiple professional e-mails with a comma", async () => {
    setupDbSequence({
      existingAlert: false,
      usersWithEmail: [
        { id: "prof-1", notificationEmail: "alice@clinic.com" },
        { id: "prof-2", notificationEmail: "bob@clinic.com" },
      ],
      patientUserIds: ["patient-user-1"],
    });

    const result = await ensureHighRiskAlert(2, "João", 20);

    expect(result).toBe(true);
    expect(sendHighRiskAlertEmail).toHaveBeenCalledOnce();
    const { to } = vi.mocked(sendHighRiskAlertEmail).mock.calls[0]![0];
    const addresses = to!.split(",");
    expect(addresses).toContain("alice@clinic.com");
    expect(addresses).toContain("bob@clinic.com");
    expect(addresses).toHaveLength(2);
  });

  it("excludes a user whose id appears in patientsTable (i.e. a patient)", async () => {
    // "prof-2" is a professional; "patient-user-1" is linked to a patient row
    setupDbSequence({
      existingAlert: false,
      usersWithEmail: [
        { id: "patient-user-1", notificationEmail: "patient@example.com" },
        { id: "prof-2", notificationEmail: "prof@clinic.com" },
      ],
      patientUserIds: ["patient-user-1"],
    });

    await ensureHighRiskAlert(3, "Carlos", 22);

    expect(sendHighRiskAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "prof@clinic.com" }),
    );
  });

  it("passes to=undefined (env-var fallback) when no professional has configured an e-mail", async () => {
    setupDbSequence({
      existingAlert: false,
      usersWithEmail: [],      // no user has notificationEmail set
      patientUserIds: [],
    });

    const result = await ensureHighRiskAlert(4, "Ana", 25);

    expect(result).toBe(true);
    expect(sendHighRiskAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: undefined }),
    );
  });

  it("still passes to=undefined when the only user with an e-mail is a patient", async () => {
    setupDbSequence({
      existingAlert: false,
      usersWithEmail: [{ id: "patient-user-1", notificationEmail: "linked@example.com" }],
      patientUserIds: ["patient-user-1"],
    });

    const result = await ensureHighRiskAlert(5, "Lucas", 18);

    expect(result).toBe(true);
    expect(sendHighRiskAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: undefined }),
    );
  });
});
