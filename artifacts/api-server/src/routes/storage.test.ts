/**
 * storage.test.ts
 *
 * Verifies that GET /storage/objects/:path enforces authentication and
 * patient-level ownership:
 *   - 401 when caller is not authenticated
 *   - 403 when an authenticated patient requests a photo that is not theirs
 *   - 200 when an authenticated patient requests their own photo
 *   - 200 when a professional (no linked patient row) requests any photo
 *
 * Also verifies POST /storage/uploads/request-url requires authentication.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Hoisted mocks (must be available before any module is imported) ──────────

const mocks = vi.hoisted(() => {
  const getObjectEntityFile = vi.fn();
  const downloadObject = vi.fn();
  const getObjectEntityUploadURL = vi.fn();
  const normalizeObjectEntityPath = vi.fn();

  class ObjectStorageService {
    getObjectEntityFile = getObjectEntityFile;
    downloadObject = downloadObject;
    getObjectEntityUploadURL = getObjectEntityUploadURL;
    normalizeObjectEntityPath = normalizeObjectEntityPath;
  }

  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
    }
  }

  return {
    ObjectStorageService,
    ObjectNotFoundError,
    getObjectEntityFile,
    downloadObject,
    getObjectEntityUploadURL,
    normalizeObjectEntityPath,
  };
});

// ─── Control knob: authenticated user ────────────────────────────────────────

let currentUser: { id: string } | null = null;

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../middlewares/authMiddleware", () => ({
  authMiddleware: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.isAuthenticated = function () {
      return currentUser != null;
    } as typeof req.isAuthenticated;
    if (currentUser) (req as any).user = currentUser;
    next();
  },
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: mocks.ObjectStorageService,
  ObjectNotFoundError: mocks.ObjectNotFoundError,
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read", WRITE: "write" },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@workspace/api-zod", () => ({
  RequestUploadUrlBody: {
    safeParse: vi.fn((data: unknown) => ({
      success: true,
      data: { name: "photo.jpg", size: 1024, contentType: "image/jpeg", ...((data as any) ?? {}) },
    })),
  },
  RequestUploadUrlResponse: {
    parse: vi.fn((data: unknown) => data),
  },
}));

// ─── DB mock ─────────────────────────────────────────────────────────────────

function makeSelectBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chainMethods = ["from", "where", "limit", "orderBy"];
  for (const m of chainMethods) {
    builder[m] = () => builder;
  }
  (builder as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn() },
  patientsTable: { id: "id", userId: "userId" },
  taskLogsTable: { id: "id", patientId: "patient_id", photoUrl: "photo_url" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ─── App builder ─────────────────────────────────────────────────────────────

import { authMiddleware } from "../middlewares/authMiddleware";
import { db } from "@workspace/db";
import storageRouter from "./storage";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: express.Response, next: express.NextFunction) => {
    req.log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    next();
  });
  app.use(authMiddleware);
  app.use("/api", storageRouter);
  return app;
}

function setupDbSequence(sequences: unknown[][]) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = sequences[call++] ?? [];
    return makeSelectBuilder(rows) as any;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/storage/objects/:path – authentication and ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = null;
    mocks.downloadObject.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    mocks.getObjectEntityFile.mockResolvedValue({ name: "mock-file" });
  });

  it("returns 401 when the caller is not authenticated", async () => {
    currentUser = null;

    const res = await request(buildApp()).get(
      "/api/storage/objects/uploads/some-uuid",
    );

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 403 when an authenticated patient requests another patient's photo", async () => {
    currentUser = { id: "patient-user-id" };
    // SELECT 0: linked-patient → patient id=1
    // SELECT 1: task-log ownership → empty (photo not in patient's logs)
    setupDbSequence([[{ id: 1 }], []]);

    const res = await request(buildApp()).get(
      "/api/storage/objects/uploads/other-uuid",
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 200 when an authenticated patient requests their own photo", async () => {
    currentUser = { id: "patient-user-id" };
    // SELECT 0: linked-patient → patient id=1
    // SELECT 1: task-log ownership → matching log found
    setupDbSequence([[{ id: 1 }], [{ id: 42 }]]);

    const res = await request(buildApp()).get(
      "/api/storage/objects/uploads/own-uuid",
    );

    expect(res.status).toBe(200);
  });

  it("returns 200 when a professional (no linked patient) requests any photo", async () => {
    currentUser = { id: "prof-user-id" };
    // SELECT 0: linked-patient → empty (professional)
    setupDbSequence([[]]);

    const res = await request(buildApp()).get(
      "/api/storage/objects/uploads/any-uuid",
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /api/storage/uploads/request-url – authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = null;
    mocks.getObjectEntityUploadURL.mockResolvedValue(
      "https://storage.googleapis.com/bucket/objects/uploads/uuid?sig=1",
    );
    mocks.normalizeObjectEntityPath.mockReturnValue("/objects/uploads/uuid");
  });

  it("returns 401 when the caller is not authenticated", async () => {
    currentUser = null;

    const res = await request(buildApp())
      .post("/api/storage/uploads/request-url")
      .send({ name: "photo.jpg", size: 1024, contentType: "image/jpeg" });

    expect(res.status).toBe(401);
  });
});
