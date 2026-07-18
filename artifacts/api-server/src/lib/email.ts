import nodemailer from "nodemailer";
import { logger } from "./logger";

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export interface HighRiskAlertEmailParams {
  patientId: number;
  patientName: string;
  adherenceScore: number;
  /** Override the recipient address. Falls back to PROFESSIONAL_EMAIL env var. */
  to?: string;
}

export async function sendHighRiskAlertEmail(params: HighRiskAlertEmailParams): Promise<void> {
  const professionalEmail = params.to ?? process.env.PROFESSIONAL_EMAIL;
  if (!professionalEmail) {
    logger.warn("No notification e-mail configured — skipping alert e-mail");
    return;
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  const clinicDomain = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:3000";
  const patientUrl = `${clinicDomain}/#/patients/${params.patientId}`;

  const subject = `⚠️ Alerta de risco alto — ${params.patientName}`;
  const text = [
    `Olá,`,
    ``,
    `O paciente ${params.patientName} entrou em risco alto de abandono de tratamento.`,
    ``,
    `Adesão atual: ${params.adherenceScore}%`,
    ``,
    `Acesse o perfil do paciente para tomar uma ação:`,
    patientUrl,
    ``,
    `— Modula Clinic`,
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8" /></head>
<body style="font-family: sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 32px 16px;">
  <div style="background: #fff3cd; border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 4px; margin-bottom: 24px;">
    <strong style="font-size: 16px;">⚠️ Paciente em risco alto</strong>
  </div>
  <p>O paciente <strong>${params.patientName}</strong> atingiu risco alto de abandono de tratamento.</p>
  <table style="background: #f9fafb; border-radius: 6px; padding: 16px 20px; margin: 16px 0; width: 100%; border-collapse: collapse;">
    <tr>
      <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Paciente</td>
      <td style="font-weight: 600; padding: 4px 0;">${params.patientName}</td>
    </tr>
    <tr>
      <td style="color: #6b7280; font-size: 13px; padding: 4px 0;">Adesão atual</td>
      <td style="font-weight: 600; color: #dc2626; padding: 4px 0;">${params.adherenceScore}%</td>
    </tr>
  </table>
  <a href="${patientUrl}"
     style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none;
            padding: 12px 24px; border-radius: 6px; font-weight: 600; margin-top: 8px;">
    Ver perfil do paciente
  </a>
  <p style="margin-top: 32px; color: #9ca3af; font-size: 12px;">— Modula Clinic</p>
</body>
</html>
`;

  try {
    await transporter.sendMail({ from, to: professionalEmail, subject, text, html });
    logger.info({ patientId: params.patientId, to: professionalEmail }, "High-risk alert e-mail sent");
  } catch (err) {
    logger.error({ err, patientId: params.patientId }, "Failed to send high-risk alert e-mail");
  }
}
