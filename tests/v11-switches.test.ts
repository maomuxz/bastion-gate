// v1.1 switches + presets (src/tier.ts). Pure functions; no repos needed.
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseTier,
  DEFAULT_TIER,
  describeSwitches,
  parseTier,
  PRESETS,
  resolveSwitches,
  SWITCH_EVIDENCE,
  SWITCH_NAMES,
  TIERS,
  tierHint,
  type Switches,
  type Tier,
} from '../src/tier.js';

const EXPECTED: Record<Tier, Switches> = {
  village: { map: false, secondMap: false, split: false, crew: 1, scaffold: false, approval: false, questions: false, budget: false },
  city: { map: true, secondMap: false, split: false, crew: 1, scaffold: true, approval: true, questions: false, budget: false },
  capital: { map: true, secondMap: false, split: true, crew: 0, scaffold: true, approval: true, questions: true, budget: true },
};

function err(r: { ok: boolean; error?: string }): string {
  assert.equal(r.ok, false, 'expected an error result');
  return r.error ?? '';
}

describe('v1.1 presets', () => {
  it('has exactly the three tiers and names all switches', () => {
    assert.deepEqual([...TIERS], ['village', 'city', 'capital']);
    assert.deepEqual([...SWITCH_NAMES], ['map', 'secondMap', 'split', 'crew', 'scaffold', 'approval', 'questions', 'budget']);
  });

  for (const tier of ['village', 'city', 'capital'] as const) {
    it(`preset ${tier} matches the spec value by value`, () => {
      assert.deepEqual({ ...PRESETS[tier] }, EXPECTED[tier]);
    });
  }

  it('secondMap is off in every preset', () => {
    for (const t of TIERS) assert.equal(PRESETS[t].secondMap, false, t);
  });

  it('default tier is village and every boolean switch of it is off (house rule 1)', () => {
    assert.equal(DEFAULT_TIER, 'village');
    const p = PRESETS[DEFAULT_TIER];
    for (const n of SWITCH_NAMES) {
      if (n === 'crew') assert.equal(p.crew, 1);
      else assert.equal(p[n], false, n);
    }
  });
});

describe('v1.1 SWITCH_EVIDENCE', () => {
  it('has a non-empty note for every switch name', () => {
    for (const n of SWITCH_NAMES) {
      const e = SWITCH_EVIDENCE[n];
      assert.ok(e, `entry for ${n}`);
      assert.equal(typeof e.measured, 'boolean');
      assert.ok(e.note.trim().length > 0, `note for ${n}`);
    }
    assert.deepEqual(Object.keys(SWITCH_EVIDENCE).sort(), [...SWITCH_NAMES].sort());
  });

  it('secondMap is the measured one and mentions both trials', () => {
    const e = SWITCH_EVIDENCE.secondMap;
    assert.equal(e.measured, true);
    assert.match(e.note, /0 disagreements/);
    assert.match(e.note, /75/);
  });

  it('every other switch is unmeasured and says no with/without comparison yet', () => {
    for (const n of SWITCH_NAMES) {
      if (n === 'secondMap') continue;
      const e = SWITCH_EVIDENCE[n];
      assert.equal(e.measured, false, n);
      assert.ok(e.note.trim().length > 0, n);
      assert.match(e.note, /no\b[^.]*\b(with\/without|comparison)/i, n);
    }
  });

  it('house rule 1: a switch on in the default preset must be measured', () => {
    const p = PRESETS[DEFAULT_TIER];
    for (const n of SWITCH_NAMES) {
      const on = n === 'crew' ? p.crew !== 1 : p[n];
      if (on) assert.equal(SWITCH_EVIDENCE[n].measured, true, n);
    }
  });
});

describe('v1.1 parseTier', () => {
  it('accepts names in any case with whitespace', () => {
    assert.equal(parseTier('village'), 'village');
    assert.equal(parseTier('  CiTy \n'), 'city');
    assert.equal(parseTier('CAPITAL'), 'capital');
  });
  it('accepts the Chinese names', () => {
    assert.equal(parseTier('村庄'), 'village');
    assert.equal(parseTier('城邦'), 'city');
    assert.equal(parseTier(' 王都 '), 'capital');
  });
  it('rejects everything else', () => {
    for (const bad of ['', 'town', 'villages', 'city capital', undefined, null, 3, {}, ['city'], true]) {
      assert.equal(parseTier(bad), null, String(bad));
    }
  });
});

describe('v1.1 resolveSwitches', () => {
  it('no overrides returns the preset, a fresh object, nothing overridden', () => {
    for (const t of TIERS) {
      const r = resolveSwitches(t, undefined);
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.deepEqual(r.switches, EXPECTED[t]);
      assert.deepEqual(r.overridden, []);
      assert.notEqual(r.switches, PRESETS[t]);
    }
  });

  it('applies overrides, lists overridden keys in SWITCH_NAMES order, and does not mutate PRESETS', () => {
    const before = JSON.stringify(PRESETS);
    const r = resolveSwitches('city', { budget: true, approval: false, crew: 3 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.switches, { ...EXPECTED.city, budget: true, approval: false, crew: 3 });
    assert.deepEqual(r.overridden, ['crew', 'approval', 'budget']);
    r.switches.map = false;
    assert.equal(JSON.stringify(PRESETS), before);
    assert.equal(PRESETS.city.map, true);
  });

  it('an override equal to the preset value is not listed as overridden', () => {
    const r = resolveSwitches('city', { map: true, budget: true });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.overridden, ['budget']);
  });

  it('accepts the empty object and crew 0', () => {
    const e = resolveSwitches('village', {});
    assert.ok(e.ok);
    const r = resolveSwitches('city', { crew: 0 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.switches.crew, 0);
      assert.deepEqual(r.overridden, ['crew']);
    }
  });

  it('a map-less village can turn map on together with split', () => {
    const r = resolveSwitches('village', { map: true, split: true, crew: 2 });
    assert.ok(r.ok);
  });

  it('rejects non-object overrides', () => {
    for (const bad of [null, 'x', 5, true, [], [1]]) {
      assert.equal(resolveSwitches('city', bad).ok, false, JSON.stringify(bad));
    }
  });

  it('rejects an unknown key and names it', () => {
    assert.match(err(resolveSwitches('city', { mapp: true })), /mapp/);
    assert.match(err(resolveSwitches('city', { map: true, turbo: true })), /turbo/);
  });

  it('rejects non-boolean boolean switches and names the key', () => {
    for (const k of ['map', 'secondMap', 'split', 'scaffold', 'approval', 'questions', 'budget']) {
      for (const bad of ['true', 1, 0, null]) {
        assert.match(err(resolveSwitches('capital', { [k]: bad })), new RegExp(k), `${k}=${String(bad)}`);
      }
    }
  });

  it('rejects crew that is not an integer >= 0 and names crew', () => {
    for (const bad of [-1, 1.5, '2', NaN, Infinity, true, null]) {
      assert.match(err(resolveSwitches('capital', { crew: bad })), /crew/, String(bad));
    }
  });

  it('rejects map=false with crew other than 1 (checked on final values)', () => {
    assert.match(err(resolveSwitches('village', { crew: 2 })), /crew/);
    assert.match(err(resolveSwitches('village', { crew: 0 })), /crew/);
    assert.match(err(resolveSwitches('capital', { map: false, split: false, scaffold: false, secondMap: false })), /crew/);
    // fixing crew in the same override makes it valid
    const ok = resolveSwitches('capital', { map: false, split: false, scaffold: false, crew: 1 });
    assert.ok(ok.ok);
  });

  it('rejects map=false with split, secondMap or scaffold true and names the key', () => {
    assert.match(err(resolveSwitches('village', { split: true })), /split/);
    assert.match(err(resolveSwitches('village', { secondMap: true })), /secondMap/);
    assert.match(err(resolveSwitches('village', { scaffold: true })), /scaffold/);
    assert.match(err(resolveSwitches('city', { map: false })), /scaffold/);
  });

  it('allows secondMap on when there is a map (an explicit override)', () => {
    const r = resolveSwitches('city', { secondMap: true });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.overridden, ['secondMap']);
  });
});

describe('v1.1 chooseTier', () => {
  it('nothing recorded, nothing requested -> default, defaulted', () => {
    assert.deepEqual(chooseTier(undefined, undefined), { ok: true, tier: 'village', defaulted: true });
  });
  it('nothing recorded, requested -> requested, not defaulted', () => {
    for (const t of TIERS) assert.deepEqual(chooseTier(undefined, t), { ok: true, tier: t, defaulted: false });
  });
  it('recorded wins when nothing or the same is requested', () => {
    for (const t of TIERS) {
      assert.deepEqual(chooseTier(t, undefined), { ok: true, tier: t, defaulted: false });
      assert.deepEqual(chooseTier(t, t), { ok: true, tier: t, defaulted: false });
    }
  });
  it('recorded village + nothing requested is not "defaulted"', () => {
    const r = chooseTier('village', undefined);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.defaulted, false);
  });
  it('a different tier is refused, naming both tiers, fixed-once-started and the clean command', () => {
    for (const a of TIERS) {
      for (const b of TIERS) {
        if (a === b) continue;
        const e = err(chooseTier(a, b));
        assert.ok(e.includes(a) && e.includes(b), `${a}->${b}: ${e}`);
        assert.match(e, /fixed/i);
        assert.match(e, /started|start/i);
        assert.ok(e.includes('bastion clean --runs'), e);
      }
    }
  });
});

describe('v1.1 tierHint', () => {
  it('has exactly 4 lines, all prefixed', () => {
    const h = tierHint();
    assert.equal(h.length, 4);
    for (const l of h) assert.ok(l.startsWith('[bastion] flow: '), l);
  });
  it('one line per tier, in order, then the usage line', () => {
    const h = tierHint();
    for (const s of ['village', 'one session', 'no approval stop']) assert.ok(h[0]!.includes(s), `${s} in ${h[0]}`);
    for (const s of ['city', 'map', 'one block after another']) assert.ok(h[1]!.includes(s), `${s} in ${h[1]}`);
    for (const s of ['capital', 'map', 'parallel']) assert.ok(h[2]!.includes(s), `${s} in ${h[2]}`);
    assert.ok(h[3]!.includes('bastion flow --tier <village|city|capital> "<requirement>"'), h[3]);
  });
});

describe('v1.1 describeSwitches', () => {
  it('prints the village preset exactly', () => {
    assert.equal(
      describeSwitches(PRESETS.village),
      'map=off secondMap=off split=off crew=1 scaffold=off approval=off questions=off budget=off'
    );
  });
  it('prints crew=config for 0 and on for true', () => {
    assert.equal(
      describeSwitches(PRESETS.capital),
      'map=on secondMap=off split=on crew=config scaffold=on approval=on questions=on budget=on'
    );
  });
  it('prints a numeric crew above 1', () => {
    assert.equal(
      describeSwitches({ ...PRESETS.city, crew: 4 }),
      'map=on secondMap=off split=off crew=4 scaffold=on approval=on questions=off budget=off'
    );
  });
});
