/**
 * auth-upsert.test.ts
 *
 * Unit tests for the upsertUser helper inside auth.ts.
 *
 * Scenarios covered:
 *   1. New user (email not in DB, id not in DB) → inserts a fresh row.
 *   2. Repeat login with the same Replit id → updates profile via onConflictDoUpdate.
 *   3. E-mail already exists under a DIFFERENT id → updates the existing row in-place
 *      so that foreign keys (patients.user_id) continue to resolve correctly.
 *   4. E-mail matches AND id matches → normal upsert path (no double-write).
 *   5. Patient referenced by old row is still reachable after e-mail-conflict resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared state ─────────────────────────────────────────────────────────────

/** Rows currently "in" the users table, keyed by id */
let usersById: Record<string, { id: string; email: string | null; firstName: string | null; lastName: string | null; profileImageUrl: string | null; updatedAt: Date }> = {};

// ─── Mock: @workspace/db ─────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockInsertOnConflict = vi.fn(() => ({ returning: mockInsertReturning }));
const mockInsertValues = vi.fn(() => ({ onConflictDoUpdate: mockInsertOnConflict }));

const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));

function makeSelectBuilder(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  const chain = ['from', 'where', 'limit', 'orderBy'];
  for (const m of chain) {
    b[m] = () => b;
  }
  (b as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return b;
}

const mockSelect = vi.fn();

vi.mock('@workspace/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
  usersTable: {
    id: 'id',
    email: 'email',
    firstName: 'first_name',
    lastName: 'last_name',
    profileImageUrl: 'profile_image_url',
    updatedAt: 'updated_at',
  },
}));

// ─── Mock: drizzle-orm ────────────────────────────────────────────────────────

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ─── Import subject under test ────────────────────────────────────────────────
// Must be imported AFTER mocks are registered.

import { upsertUser } from './auth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<typeof usersById[string]> = {}): typeof usersById[string] {
  return {
    id: 'default-id',
    email: 'user@example.com',
    firstName: 'Alice',
    lastName: 'Smith',
    profileImageUrl: null,
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'replit-sub-abc',
    email: 'user@example.com',
    first_name: 'Alice',
    last_name: 'Smith',
    profile_image_url: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('upsertUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usersById = {};
  });

  // ─── 1. New user ────────────────────────────────────────────────────────────
  it('inserts a fresh row when neither e-mail nor id exists', async () => {
    // email lookup → no existing row
    mockSelect.mockReturnValueOnce(makeSelectBuilder([]));

    const newRow = makeRow({ id: 'replit-sub-abc' });
    mockInsertReturning.mockResolvedValueOnce([newRow]);

    const result = await upsertUser(makeClaims());

    expect(result).toEqual(newRow);
    // select was called to check by email
    expect(mockSelect).toHaveBeenCalledTimes(1);
    // insert path was taken
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertOnConflict).toHaveBeenCalledTimes(1);
    // update path was NOT taken
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // ─── 2. Repeat login – same Replit id ───────────────────────────────────────
  it('updates the existing row via onConflictDoUpdate when the same id logs in again', async () => {
    // email lookup → the same id already exists (no conflict path needed)
    mockSelect.mockReturnValueOnce(
      makeSelectBuilder([makeRow({ id: 'replit-sub-abc' })]),
    );

    const updatedRow = makeRow({ id: 'replit-sub-abc', firstName: 'Alice Updated' });
    mockInsertReturning.mockResolvedValueOnce([updatedRow]);

    const result = await upsertUser(makeClaims());

    expect(result).toEqual(updatedRow);
    // id matched → fall through to standard upsert
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  // ─── 3. E-mail conflict – different id ──────────────────────────────────────
  it('updates the existing row in-place when e-mail already belongs to a different id', async () => {
    const existingRow = makeRow({ id: 'old-uuid-from-seeding', email: 'user@example.com' });

    // email lookup → existing row with a DIFFERENT id
    mockSelect.mockReturnValueOnce(makeSelectBuilder([existingRow]));

    const updatedRow = { ...existingRow, firstName: 'Alice', updatedAt: new Date() };
    mockUpdateReturning.mockResolvedValueOnce([updatedRow]);

    const claims = makeClaims({ sub: 'replit-sub-new' }); // different id
    const result = await upsertUser(claims);

    // The OLD row is returned (preserving its id for FK consistency)
    expect(result.id).toBe('old-uuid-from-seeding');
    // update path was taken, NOT insert
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  // ─── 4. E-mail matches AND id matches ───────────────────────────────────────
  it('takes the standard upsert path when e-mail row id matches the claims sub', async () => {
    const existingRow = makeRow({ id: 'replit-sub-abc', email: 'user@example.com' });

    // email lookup → same id as claims.sub
    mockSelect.mockReturnValueOnce(makeSelectBuilder([existingRow]));

    mockInsertReturning.mockResolvedValueOnce([existingRow]);

    const result = await upsertUser(makeClaims({ sub: 'replit-sub-abc' }));

    expect(result.id).toBe('replit-sub-abc');
    // no separate update needed
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  // ─── 5. No e-mail in claims ──────────────────────────────────────────────────
  it('skips the email lookup and goes straight to upsert when claims carry no e-mail', async () => {
    const newRow = makeRow({ id: 'replit-sub-noemail', email: null });
    mockInsertReturning.mockResolvedValueOnce([newRow]);

    const result = await upsertUser(makeClaims({ email: undefined, sub: 'replit-sub-noemail' }));

    expect(result).toEqual(newRow);
    // no email → no select
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  // ─── 6. E-mail conflict – patient FK stays valid ────────────────────────────
  it('preserves the existing row id (so patients.user_id FK remains valid) on e-mail conflict', async () => {
    const patientLinkedRow = makeRow({
      id: 'patient-owner-uuid',
      email: 'patient@example.com',
    });

    // DB has a row for patient-owner-uuid linked from patients.user_id
    mockSelect.mockReturnValueOnce(makeSelectBuilder([patientLinkedRow]));

    const afterUpdate = { ...patientLinkedRow, firstName: 'Updated' };
    mockUpdateReturning.mockResolvedValueOnce([afterUpdate]);

    // Patient logs in with a Replit sub that is different from the seeded uuid
    const result = await upsertUser(
      makeClaims({ sub: 'replit-brand-new-sub', email: 'patient@example.com' }),
    );

    // The returned id must be the OLD one that patients.user_id points to
    expect(result.id).toBe('patient-owner-uuid');
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
  });
});
