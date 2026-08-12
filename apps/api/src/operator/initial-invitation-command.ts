import { loadIdentityOperatorConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import { createEmailSender } from "../identity/email.js";
import { createIdentityService } from "../identity/service.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { parseProductionInitializationDocument } from "./initialization-document.js";
import { createProductionInitializationLatch } from "./initialization-latch.js";
import { invitationDeliveryFailureMetadata, sendInvitationEmail } from "./invitation.js";
import { readBoundedStdinDocument } from "./stdin-document.js";

async function run(): Promise<void> {
  const config = loadIdentityOperatorConfig();
  const document = parseProductionInitializationDocument(await readBoundedStdinDocument());
  const pool = createDatabasePool(config.databaseUrl);
  let normalizedEmail: string;
  try {
    const database = createDatabase(pool);
    await createProductionInitializationLatch(database).requireComplete(document.documentSha256);
    const target = await createIdentityService(database).initialInvitationTarget({
      adminEmail: document.administratorEmail,
      workspaceIdentity: document.workspaceIdentity,
    });
    normalizedEmail = target.normalizedEmail;
  } finally {
    await pool.end();
  }

  const emailSender = createEmailSender(config.emailDelivery, {
    emailFrom: config.emailFrom,
    resendApiKey: config.resendApiKey,
  });
  try {
    try {
      await sendInvitationEmail(emailSender, config.publicOrigin, normalizedEmail);
    } catch (error: unknown) {
      process.stderr.write(`${JSON.stringify(invitationDeliveryFailureMetadata(error))}\n`);
      process.exitCode = 1;
      return;
    }
  } finally {
    await emailSender.close();
  }

  process.stdout.write(
    `${JSON.stringify({ command: "invite-initial", outcome: "sent", retrySafe: true })}\n`,
  );
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});
