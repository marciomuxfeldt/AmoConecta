export function progressTimestampForIncrease(
  previousProcessed: number,
  nextProcessed: number,
  timestamp = new Date().toISOString(),
): { progresso_atualizado_em?: string } {
  return nextProcessed > previousProcessed
    ? { progresso_atualizado_em: timestamp }
    : {};
}
