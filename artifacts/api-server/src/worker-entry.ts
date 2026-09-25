import { logger } from "./lib/logger";
import {
  WorkerConfigurationError,
  processDueCampaigns,
} from "./lib/worker";
import {
  getRequiredSecretStatus,
  WORKER_REQUIRED_SECRET_NAMES,
} from "./lib/config-diagnostics";
import { getTechnicalError } from "./lib/technical-error";

async function main(): Promise<void> {
  logger.info(
    {
      process: "worker",
      requiredSecrets: getRequiredSecretStatus(WORKER_REQUIRED_SECRET_NAMES),
    },
    "AmoConecta worker required Secrets check",
  );
  const processed = await processDueCampaigns();
  logger.info({ processed }, "AmoConecta worker finished");
}

main().catch((error) => {
  if (error instanceof WorkerConfigurationError) {
    logger.error({ message: error.message }, "AmoConecta worker configuration error");
  } else {
    logger.error(
      { technicalError: getTechnicalError(error) },
      "AmoConecta worker failed",
    );
  }
  process.exitCode = 1;
});
