/**
 * notify-rate-limit.test.ts
 *
 * Tests for the exported `isReminderRateLimited` predicate that the
 * POST /patients/:id/notify route uses to enforce its per-day rate-limit.
 *
 * The predicate is extracted from the route so assertions run against the
 * real production logic — any regression in clinic.ts will be caught here.
 *
 * Covered scenarios:
 *   1. lastReminderAt is yesterday (YYYY-MM-DD < today) → not limited → allows 200
 *   2. lastReminderAt is today (YYYY-MM-DD === today)   → limited     → causes 429
 *   3. lastReminderAt is null/undefined                 → not limited → allows 200
 *   4. Edge: 23:59:59 UTC the previous day              → not limited (day rolled over)
 *   5. Edge: 00:00:00 UTC today                         → limited (first second of today)
 */

import { describe, it, expect, vi } from "vitest";

// ─── Mocks must be declared before the SUT is imported ────────────────────

// todayStr() is pinned to 2026-07-18 so all date comparisons are deterministic.
vi.mock("../lib/adherence", () => ({
  computeAdherence: vi.fn(),
  computeProgress: vi.fn(),
  getActiveTreatmentWithTasks: vi.fn(),
  todayStr: vi.fn(() => "2026-07-18"),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => {
      const b: any = {};
      for (const m of ["from", "where", "limit", "orderBy"]) b[m] = () => b;
      b.then = (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve);
      return b;
    }),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
  patientsTable: {},
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

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Import the real production predicate after mocks are in place ─────────
import { isReminderRateLimited } from "./clinic";

// ─── Tests ────────────────────────────────────────────────────────────────
// todayStr() returns "2026-07-18" for all assertions below.

describe("isReminderRateLimited (notify route rate-limit predicate)", () => {
  it("allows a reminder when lastReminderAt is yesterday — rate-limit resets at midnight", () => {
    const yesterday = new Date("2026-07-17T15:30:00.000Z");
    expect(isReminderRateLimited(yesterday)).toBe(false);
  });

  it("blocks a reminder when lastReminderAt is today — returns 429 in the route", () => {
    const todayMidday = new Date("2026-07-18T12:00:00.000Z");
    expect(isReminderRateLimited(todayMidday)).toBe(true);
  });

  it("allows a reminder when lastReminderAt is null — patient never received one", () => {
    expect(isReminderRateLimited(null)).toBe(false);
  });

  it("allows a reminder sent at 23:59:59 UTC on the previous day — the UTC day has rolled over", () => {
    const justBeforeMidnight = new Date("2026-07-17T23:59:59.999Z");
    expect(isReminderRateLimited(justBeforeMidnight)).toBe(false);
  });

  it("blocks a reminder sent at 00:00:00 UTC today — still within the same UTC day", () => {
    const midnight = new Date("2026-07-18T00:00:00.000Z");
    expect(isReminderRateLimited(midnight)).toBe(true);
  });
});
