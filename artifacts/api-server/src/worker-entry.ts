import { logger } from "./lib/logger";
import {
  WorkerConfigurationError,
  processDueCampaigns,
} from "./lib/worker";
import { getRequiredSecretStatus } from "./lib/config-diagnostics";

async function main(): Promise<void> {
  logger.info(
    { requiredSecrets: getRequiredSecretStatus() },
    "AmoConecta required Secrets check",
  );
  const processed = await processDueCampaigns();
  logger.info({ processed }, "AmoConecta worker finished");
}

main().catch((error) => {
  if (error instanceof WorkerConfigurationError) {
    logger.error({ message: error.message }, "AmoConecta worker configuration error");
  } else {
    logger.error({ error }, "AmoConecta worker failed");
  }
  process.exitCode = 1;
});
