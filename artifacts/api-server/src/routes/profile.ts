import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, patientsTable } from "@workspace/db";
import {
  GetProfessionalProfileResponse,
  UpdateProfessionalProfileBody,
  UpdateProfessionalProfileResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Gate: authenticated user who has no linked patient record (i.e. a professional).
 * Mirrors the requireProfessional guard used in clinic.ts for treatment management.
 */
async function requireProfessional(req: Request, res: Response): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Autenticação necessária" });
    return false;
  }
  const [linked] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(eq(patientsTable.userId, req.user.id));
  if (linked) {
    res.status(403).json({ error: "Apenas profissionais podem acessar as configurações de perfil" });
    return false;
  }
  return true;
}

router.get("/profile", async (req: Request, res: Response): Promise<void> => {
  if (!(await requireProfessional(req, res))) return;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id));

  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  res.json(
    GetProfessionalProfileResponse.parse({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      notificationEmail: user.notificationEmail,
    }),
  );
});

router.patch("/profile", async (req: Request, res: Response): Promise<void> => {
  if (!(await requireProfessional(req, res))) return;

  const parsed = UpdateProfessionalProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (parsed.data.notificationEmail !== undefined) {
    // null clears the column so the clinic default (PROFESSIONAL_EMAIL env var) is used
    updates.notificationEmail = parsed.data.notificationEmail ?? null;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.user!.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  res.json(
    UpdateProfessionalProfileResponse.parse({
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      profileImageUrl: updated.profileImageUrl,
      notificationEmail: updated.notificationEmail,
    }),
  );
});

export default router;
