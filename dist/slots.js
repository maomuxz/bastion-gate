/**
 * A global compile/test slot pool (config.compileSlots): at most `limit` gate runs at once across all
 * nodes, waiting callers start in FIFO order. limit undefined, 0 or negative = unlimited.
 */
export function createSlotPool(limit) {
    const max = limit !== undefined && limit > 0 ? Math.floor(limit) || 1 : Infinity;
    let active = 0;
    const waiters = [];
    return {
        async run(fn) {
            if (active < max) {
                active++;
            }
            else {
                // The releasing task hands its slot straight to us (active stays unchanged), preserving FIFO.
                await new Promise((resolve) => waiters.push(resolve));
            }
            try {
                return await fn();
            }
            finally {
                const next = waiters.shift();
                if (next)
                    next();
                else
                    active--;
            }
        },
        active: () => active,
    };
}
