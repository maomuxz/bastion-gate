// v1.0 - global compile/test slot pool: bounded concurrency, FIFO, release on failure.
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSlotPool } from '../src/slots.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Let queued microtasks / continuations settle. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Submit n tasks; each records start order and blocks on its own deferred. */
function submit(pool: ReturnType<typeof createSlotPool>, n: number) {
  const started: number[] = [];
  const gates = Array.from({ length: n }, () => deferred<void>());
  const results = gates.map((g, i) =>
    pool.run(async () => {
      started.push(i);
      await g.promise;
      return `r${i}`;
    })
  );
  return { started, gates, results };
}

describe('v1.0 slot pool', () => {
  it('limit 2 runs at most two at once and queues the rest', async () => {
    const pool = createSlotPool(2);
    const { started, gates, results } = submit(pool, 5);
    await settle();
    assert.deepEqual(started, [0, 1]);
    assert.equal(pool.active(), 2);
    gates[0].resolve();
    await settle();
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(pool.active(), 2);
    for (const g of gates) g.resolve();
    assert.deepEqual(await Promise.all(results), ['r0', 'r1', 'r2', 'r3', 'r4']);
    assert.equal(pool.active(), 0);
  });

  it('never exceeds the limit even when tasks finish out of order', async () => {
    const pool = createSlotPool(3);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 9 }, () => deferred<void>());
    const all = gates.map((g) =>
      pool.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      })
    );
    await settle();
    assert.equal(running, 3);
    // release in reverse-ish order
    for (const i of [2, 0, 1, 8, 7, 6, 5, 4, 3]) {
      gates[i].resolve();
      await settle();
      assert.ok(running <= 3);
    }
    await Promise.all(all);
    assert.equal(peak, 3);
    assert.equal(pool.active(), 0);
  });

  it('starts waiting callers in FIFO order (limit 1)', async () => {
    const pool = createSlotPool(1);
    const { started, gates, results } = submit(pool, 4);
    await settle();
    assert.deepEqual(started, [0]);
    for (let i = 0; i < 4; i++) {
      gates[i].resolve();
      await settle();
    }
    await Promise.all(results);
    assert.deepEqual(started, [0, 1, 2, 3]);
  });

  it('does not invoke a queued fn before a slot is free', async () => {
    const pool = createSlotPool(1);
    const hold = deferred<void>();
    const first = pool.run(() => hold.promise);
    let invoked = false;
    const second = pool.run(async () => {
      invoked = true;
    });
    await settle();
    assert.equal(invoked, false);
    hold.resolve();
    await first;
    await second;
    assert.equal(invoked, true);
  });

  it('passes through resolved values and rejections unchanged', async () => {
    const pool = createSlotPool(1);
    assert.equal(await pool.run(async () => 42), 42);
    const err = new Error('boom');
    await assert.rejects(
      pool.run(async () => {
        throw err;
      }),
      (e) => e === err
    );
  });

  it('releases the slot when fn rejects, so the next waiter runs', async () => {
    const pool = createSlotPool(1);
    const gate = deferred<void>();
    const failing = pool.run(async () => {
      await gate.promise;
      throw new Error('fail');
    });
    const failed = assert.rejects(failing, /fail/);
    let ran = false;
    const next = pool.run(async () => {
      ran = true;
      return 'ok';
    });
    await settle();
    assert.equal(ran, false);
    assert.equal(pool.active(), 1);
    gate.resolve();
    await failed;
    assert.equal(await next, 'ok');
    assert.equal(ran, true);
    assert.equal(pool.active(), 0);
  });

  it('releases the slot when fn throws synchronously', async () => {
    const pool = createSlotPool(1);
    await assert.rejects(
      pool.run((() => {
        throw new Error('sync');
      }) as () => Promise<never>),
      /sync/
    );
    assert.equal(pool.active(), 0);
    assert.equal(await pool.run(async () => 'after'), 'after');
  });

  it('a failure in one task does not stall the rest of a long queue', async () => {
    const pool = createSlotPool(2);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        pool.run(async () => {
          await settle();
          if (i % 2 === 0) throw new Error(`e${i}`);
          return i;
        })
      )
    );
    assert.deepEqual(outcomes.map((o) => o.status), ['rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
    assert.equal(pool.active(), 0);
  });

  for (const [label, limit] of [['undefined', undefined], ['0', 0], ['negative', -3]] as const) {
    it(`limit ${label} is unlimited`, async () => {
      const pool = createSlotPool(limit);
      const { started, gates, results } = submit(pool, 12);
      await settle();
      assert.equal(started.length, 12);
      assert.equal(pool.active(), 12);
      for (const g of gates) g.resolve();
      await Promise.all(results);
      assert.equal(pool.active(), 0);
    });
  }

  it('pools are independent of each other', async () => {
    const a = createSlotPool(1);
    const b = createSlotPool(1);
    const hold = deferred<void>();
    const pa = a.run(() => hold.promise);
    let bRan = false;
    await b.run(async () => {
      bRan = true;
    });
    assert.equal(bRan, true);
    assert.equal(a.active(), 1);
    assert.equal(b.active(), 0);
    hold.resolve();
    await pa;
  });

  it('active() is 0 on a fresh pool and counts only running fns, not queued ones', async () => {
    const pool = createSlotPool(1);
    assert.equal(pool.active(), 0);
    const { gates, results } = submit(pool, 3);
    await settle();
    assert.equal(pool.active(), 1);
    for (const g of gates) g.resolve();
    await Promise.all(results);
    assert.equal(pool.active(), 0);
  });
});
