export function progressTimestampForIncrease(
  previousProcessed: number,
  nextProcessed: number,
  timestamp = new Date().toISOString(),
): { progresso_atualizado_em?: string } {
  return nextProcessed > previousProcessed
    ? { progresso_atualizado_em: timestamp }
    : {};
}

export function createSerializedProgressCounter(
  initial: number,
  total: number,
  persist: (previous: number, next: number) => Promise<void>,
): { advance: (completedItems: number) => Promise<number> } {
  let current = initial;
  let queue: Promise<void> = Promise.resolve();
  let updateFailure: unknown = null;

  return {
    advance(completedItems) {
      const update = queue.then(async () => {
        if (updateFailure) throw updateFailure;
        if (!Number.isSafeInteger(completedItems) || completedItems < 0) {
          throw new RangeError("completedItems must be a non-negative integer.");
        }
        const next = Math.min(total, current + completedItems);
        if (next > current) {
          await persist(current, next);
          current = next;
        }
        return current;
      });
      queue = update.then(
        () => undefined,
        (error: unknown) => {
          updateFailure = error;
        },
      );
      return update;
    },
  };
}
