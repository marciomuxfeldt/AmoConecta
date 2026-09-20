import { logger } from "./lib/logger";
import {
  WorkerConfigurationError,
  processDueCampaigns,
} from "./lib/worker";

async function main(): Promise<void> {
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
