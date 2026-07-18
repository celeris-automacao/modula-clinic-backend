import { spawnSync } from "child_process";
import app from "./app";
import { logger } from "./lib/logger";
import { transporter } from "./lib/email";
import { checkAllPatientsForHighRisk } from "./routes/clinic";

// Apply pending migrations before accepting requests so every environment
// gets the same ordered schema history without silently dropping columns.
logger.info("Applying database migrations…");
const migrateResult = spawnSync(
  "pnpm",
  ["--filter", "@workspace/db", "migrate"],
  { stdio: "inherit", encoding: "utf8" },
);
if (migrateResult.status !== 0) {
  logger.error(
    { exitCode: migrateResult.status },
    "Database migration failed — aborting startup",
  );
  process.exit(1);
}
logger.info("Database migrations applied successfully");


const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Verify SMTP connectivity at startup so misconfiguration surfaces immediately.
  transporter.verify().then(() => {
    logger.info("SMTP connection verified successfully");
  }).catch((err: unknown) => {
    logger.warn({ err }, "SMTP connection check failed — alert e-mails may not be delivered");
  });

  // Run an initial silence check shortly after startup, then every hour.
  const runCheck = () => {
    checkAllPatientsForHighRisk()
      .then((n) => {
        if (n > 0) logger.info({ alertsCreated: n }, "Silence check: new high-risk alerts created");
      })
      .catch((err) => logger.error({ err }, "Silence check failed"));
  };

  setTimeout(runCheck, 5_000); // first run 5 s after boot
  setInterval(runCheck, 60 * 60 * 1_000); // then every hour
});
