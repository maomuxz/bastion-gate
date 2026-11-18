export interface SlotPool {
  /** Run fn when a slot is free; resolves/rejects with fn's result. Slots are released even if fn throws. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Number of fns currently running. */
  active(): number;
}

/**
 * A global compile/test slot pool (config.compileSlots): at most `limit` gate runs at once across all
 * nodes, waiting callers start in FIFO order. limit undefined, 0 or negative = unlimited.
 */
export function createSlotPool(limit: number | undefined): SlotPool {
  const max = limit !== undefined && limit > 0 ? Math.floor(limit) || 1 : Infinity;
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < max) {
        active++;
      } else {
        // The releasing task hands its slot straight to us (active stays unchanged), preserving FIFO.
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      try {
        return await fn();
      } finally {
        const next = waiters.shift();
        if (next) next();
        else active--;
      }
    },
    active: () => active,
  };
}
