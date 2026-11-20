// v1.1: three presets over a set of scaffolding switches. The wall itself (lock, gap check, gate, live QA, audit -
// see src/wall.ts) has no switch. Everything else is scaffolding and can be turned on or off one by one; a preset is
// just a named set of switch values. Presets and switches are fixed when a flow starts and never change mid-run.
//
// Two house rules (docs: the positioning and v1.1 plan):
//  1. A switch may be ON in the default preset only with measured evidence; without evidence it is off by default.
//  2. Every switch must be re-testable: after a model upgrade, re-run the benchmark target and see which can go.

export type Tier = 'village' | 'city' | 'capital';
export const TIERS: readonly Tier[] = ['village', 'city', 'capital'];
/** The preset used when the user names none: the thinnest one (rule 1). */
export const DEFAULT_TIER: Tier = 'village';

export interface Switches {
  /** Map design: split the work into blocks with dependencies and interfaces. Off = one thin interface contract. */
  map: boolean;
  /** A second, blind map to compare with the first. */
  secondMap: boolean;
  /** Recursive split of blocks the planner marked as too big. */
  split: boolean;
  /** Crew size: how many AIs write code at once. 1 = one session (no map) or one block after another (map).
   *  0 = as configured (config.concurrency), each in its own worktree. */
  crew: number;
  /** A separate scaffold call that creates stub files with the agreed interfaces. */
  scaffold: boolean;
  /** Stop once for a human approval before building. */
  approval: boolean;
  /** Construction AIs may queue tier-3 questions for a human (off: they decide themselves and record the decision). */
  questions: boolean;
  /** Budget limits (agent calls / minutes) stop the run. */
  budget: boolean;
}
export const SWITCH_NAMES: readonly (keyof Switches)[] = ['map', 'secondMap', 'split', 'crew', 'scaffold', 'approval', 'questions', 'budget'];

/**
 * village: map false, secondMap false, split false, crew 1, scaffold false, approval false, questions false, budget false.
 * city:    map true,  secondMap false, split false, crew 1, scaffold true,  approval true,  questions false, budget false.
 * capital: map true,  secondMap false, split true,  crew 0, scaffold true,  approval true,  questions true,  budget true.
 */
export const PRESETS: Readonly<Record<Tier, Readonly<Switches>>> = {
  village: { map: false, secondMap: false, split: false, crew: 1, scaffold: false, approval: false, questions: false, budget: false },
  city: { map: true, secondMap: false, split: false, crew: 1, scaffold: true, approval: true, questions: false, budget: false },
  capital: { map: true, secondMap: false, split: true, crew: 0, scaffold: true, approval: true, questions: true, budget: true },
};

/** Rule 1 in data form: what was measured for each switch. `measured: false` means "no measurement yet". */
export interface SwitchEvidence { measured: boolean; note: string }
/**
 * One entry per switch name. Required content:
 *  - secondMap: measured true; the note must say it was tried twice without effect (0 disagreements once, 75 noisy
 *    ones once) - which is why it is off in every preset.
 *  - every other switch: measured false, with a note that says no with/without comparison has been measured yet.
 * (When a measurement exists, this table is where it is recorded.)
 */
const UNMEASURED: SwitchEvidence = { measured: false, note: 'No with/without comparison has been measured yet.' };
export const SWITCH_EVIDENCE: Readonly<Record<keyof Switches, SwitchEvidence>> = {
  map: { ...UNMEASURED },
  secondMap: {
    measured: true,
    note: 'Tried twice without effect: 0 disagreements once, 75 noisy ones once - which is why it is off in every preset.',
  },
  split: { ...UNMEASURED },
  crew: { ...UNMEASURED },
  scaffold: { ...UNMEASURED },
  approval: { ...UNMEASURED },
  questions: { ...UNMEASURED },
  budget: { ...UNMEASURED },
};

/**
 * Parse a tier name given by a human. Accepts 'village' | 'city' | 'capital' in any letter case and with
 * surrounding whitespace, and the Chinese names '村庄' | '城邦' | '王都'. Anything else (including non-strings) -> null.
 */
export function parseTier(raw: unknown): Tier | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const l = s.toLowerCase();
  if (l === 'village' || s === '村庄') return 'village';
  if (l === 'city' || s === '城邦') return 'city';
  if (l === 'capital' || s === '王都') return 'capital';
  return null;
}

/**
 * The switches of a flow: the preset of `tier` with `overrides` (the raw `switches` object of .bastion/config.json,
 * possibly undefined) applied on top. Returns a fresh object; PRESETS is never mutated.
 * Errors ({ ok: false, error }, the error names the offending key):
 *  - overrides is neither undefined nor a plain object;
 *  - a key that is not in SWITCH_NAMES;
 *  - a boolean switch whose value is not a boolean; crew not an integer >= 0;
 *  - combinations that cannot work, checked on the final values: map false with crew other than 1 (no map means one
 *    session); map false with split, secondMap or scaffold true (there is no map to split, compare or scaffold from).
 * On success `overridden` lists the keys whose final value differs from the preset, in SWITCH_NAMES order.
 */
export function resolveSwitches(
  tier: Tier,
  overrides: unknown
): { ok: true; switches: Switches; overridden: (keyof Switches)[] } | { ok: false; error: string } {
  const sw: Switches = { ...PRESETS[tier] };
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return { ok: false, error: 'switches must be an object of switch names to values' };
    }
    const o = overrides as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (!(SWITCH_NAMES as readonly string[]).includes(key)) return { ok: false, error: 'unknown switch "' + key + '"' };
      const v = o[key];
      if (key === 'crew') {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { ok: false, error: 'switch "crew" must be an integer >= 0' };
        sw.crew = v;
      } else {
        if (typeof v !== 'boolean') return { ok: false, error: 'switch "' + key + '" must be true or false' };
        (sw as unknown as Record<string, unknown>)[key] = v;
      }
    }
  }
  if (!sw.map) {
    if (sw.crew !== 1) return { ok: false, error: 'switch "crew" must be 1 when map is off (no map means one session)' };
    for (const k of ['split', 'secondMap', 'scaffold'] as const) {
      if (sw[k]) return { ok: false, error: 'switch "' + k + '" cannot be on when map is off (there is no map to split, compare or scaffold from)' };
    }
  }
  const overridden = SWITCH_NAMES.filter((n) => sw[n] !== PRESETS[tier][n]);
  return { ok: true, switches: sw, overridden };
}

/**
 * Decide the tier of a flow. `recorded` is the tier stored when the flow started (undefined on the first call),
 * `requested` is what the user passed now (undefined when no --tier was given).
 *  - nothing recorded, nothing requested -> { ok: true, tier: DEFAULT_TIER, defaulted: true }
 *  - nothing recorded, requested         -> { ok: true, tier: requested, defaulted: false }
 *  - recorded, nothing requested or the same tier requested -> { ok: true, tier: recorded, defaulted: false }
 *  - recorded and a different tier requested -> { ok: false, error } where error names both tiers, says the tier is
 *    fixed once work has started, and tells the user to stop and start over with `bastion clean --runs` if this tier
 *    no longer fits (no automatic up- or downgrade).
 */
export function chooseTier(
  recorded: Tier | undefined,
  requested: Tier | undefined
): { ok: true; tier: Tier; defaulted: boolean } | { ok: false; error: string } {
  if (recorded === undefined) {
    if (requested === undefined) return { ok: true, tier: DEFAULT_TIER, defaulted: true };
    return { ok: true, tier: requested, defaulted: false };
  }
  if (requested === undefined || requested === recorded) return { ok: true, tier: recorded, defaulted: false };
  return {
    ok: false,
    error:
      'this flow runs as ' + recorded + ' but you asked for ' + requested + '. The tier is fixed once work has started. ' +
      'If ' + recorded + ' no longer fits, stop and start over with `bastion clean --runs`.',
  };
}

/**
 * Lines printed when the tier was defaulted, each starting with `[bastion] flow: `. Exactly 4 lines: one per tier, then
 * a usage line. The village line must contain 'village', 'one session' and 'no approval stop'; the city line 'city',
 * 'map' and 'one block after another'; the capital line 'capital', 'map' and 'parallel'. The last line must contain
 * `bastion flow --tier <village|city|capital> "<requirement>"`.
 */
export function tierHint(): string[] {
  return [
    '[bastion] flow: village - one session builds it all, no map, no approval stop (default)',
    '[bastion] flow: city - a map of blocks with interfaces, scaffold, one approval stop, one block after another',
    '[bastion] flow: capital - map with recursive split, approval, questions and budget, blocks built in parallel',
    '[bastion] flow: choose with `bastion flow --tier <village|city|capital> "<requirement>"`',
  ];
}

/** One line for logs: `map=off secondMap=off split=off crew=1 scaffold=off approval=off questions=off budget=off` (crew 0 prints `crew=config`). */
export function describeSwitches(s: Switches): string {
  const on = (b: boolean): string => (b ? 'on' : 'off');
  return (
    'map=' + on(s.map) + ' secondMap=' + on(s.secondMap) + ' split=' + on(s.split) +
    ' crew=' + (s.crew === 0 ? 'config' : String(s.crew)) +
    ' scaffold=' + on(s.scaffold) + ' approval=' + on(s.approval) + ' questions=' + on(s.questions) + ' budget=' + on(s.budget)
  );
}
