// v1.1 round 5 - hardened gap quotes: checkQuotes (src/gaps.ts) and findGaps / runGaps (src/commands/gaps.ts).
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { checkQuotes } from '../src/gaps.js';
import type { Gap } from '../src/gaps.js';
import { findGaps, runGaps } from '../src/commands/gaps.js';
import { runLock } from '../src/commands/lock.js';
import { captureConsole, cleanupTempRepos, git } from './v04-helpers.js';
import { createRoleRepo } from './v1-helpers.js';
import type { RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const g = (quote: string, rule = `rule for ${quote}`): Gap => ({ rule, quote });
/** Run checkQuotes on one quote; true when it is kept. */
const keeps = (requirement: string, quote: string): boolean => {
  const r = checkQuotes({ gaps: [g(quote)] }, requirement);
  assert.equal(r.kept.length + r.discarded.length, 1);
  return r.kept.length === 1;
};

describe('checkQuotes - normalisation', () => {
  it('full-width vs ASCII punctuation in a Chinese requirement, both directions', () => {
    const reqFull = '输入必须为正数，否则抛出错误（RangeError）：见下！是吗？';
    assert.equal(keeps(reqFull, '输入必须为正数,否则抛出错误(RangeError):见下!是吗?'), true);
    const reqAscii = '输入必须为正数,否则抛出错误(RangeError):见下!';
    assert.equal(keeps(reqAscii, '输入必须为正数，否则抛出错误（RangeError）：见下！'), true);
    assert.equal(keeps(reqFull, '输入必须为负数,否则抛出错误'), false);
  });

  it('full-width letters and digits fold to ASCII', () => {
    assert.equal(keeps('Add returns 42 always.', 'Ａｄｄ returns ４２ always.'), true);
  });

  it('markdown markers present on one side only', () => {
    const plain = 'Negative inputs are rejected with a RangeError.';
    const marked = '**Negative** inputs are `rejected` with a _RangeError_.';
    assert.equal(keeps(marked, plain), true, 'markers only in requirement');
    assert.equal(keeps(plain, marked), true, 'markers only in quote');
    assert.equal(keeps('| Add | returns the sum |', 'Add returns the sum'), true, 'table pipes in requirement');
    assert.equal(keeps('Add returns the sum', '| Add | returns the sum |'), true, 'table pipes in quote');
    assert.equal(keeps('# Rules\n> Add returns the sum', 'Rules Add returns the sum'), true, 'heading + quote marker');
    assert.equal(keeps('Add returns the sum', '## Add returns ~~the~~ sum'), true, 'heading + strike in quote');
    assert.equal(keeps('* Add returns the sum\n* Mul returns the product', 'Add returns the sum Mul returns the product'), true, 'star list');
    assert.equal(keeps('**Add** returns the sum', 'Mul returns the sum'), false, 'markers do not make a wrong quote match');
  });

  it('curly vs straight quotes, both directions', () => {
    const curly = 'He said “stop” and don’t go ‘now’.';
    const straight = 'He said "stop" and don\'t go \'now\'.';
    assert.equal(keeps(curly, straight), true);
    assert.equal(keeps(straight, curly), true);
    assert.equal(keeps(curly, 'He said stop and dont go now.'), true, 'quote marks dropped entirely');
  });

  it('a quote that is only markers / whitespace is discarded; an empty one too', () => {
    const req = '**Add** | returns > the `sum`';
    for (const q of ['**', '` | > #', ' \t\n ', '* _ ~ " “”‘’', '']) {
      assert.equal(keeps(req, q), false, JSON.stringify(q));
    }
  });

  it('an invented quote is discarded', () => {
    assert.equal(keeps('Add returns the sum.', 'Division by zero returns Infinity'), false);
    assert.equal(keeps('Add returns the sum.', 'Add returns the sum of three numbers'), false);
  });

  it('order is preserved across kept and discarded', () => {
    const req = 'Alpha one. Beta two. Gamma three. Delta four.';
    const gaps = [g('Delta four'), g('invented 1'), g('Alpha one'), g('invented 2'), g('Gamma three')];
    const r = checkQuotes({ gaps }, req);
    assert.deepEqual(r.kept.map((x) => x.quote), ['Delta four', 'Alpha one', 'Gamma three']);
    assert.deepEqual(r.discarded.map((x) => x.quote), ['invented 1', 'invented 2']);
    assert.deepEqual(r.kept[0], gaps[0], 'gap objects returned unchanged');
  });
});

describe('checkQuotes - ellipsis', () => {
  const REQ = 'Add returns the sum of two numbers.\nMul returns the product of two numbers.\nNegative inputs are rejected with a RangeError.\n';

  it('"..." keeps a quote whose pieces occur in order', () => {
    assert.equal(keeps(REQ, 'Add returns ... two numbers.'), true);
    assert.equal(keeps(REQ, 'Add returns the sum...Negative inputs'), true);
    assert.equal(keeps(REQ, 'Add returns ... Mul returns ... RangeError.'), true, 'several ellipses');
    assert.equal(keeps(REQ, 'Add returns ..... RangeError.'), true, 'five dots are one separator');
  });

  it('the U+2026 character works the same way', () => {
    assert.equal(keeps(REQ, 'Add returns… two numbers.'), true);
    assert.equal(keeps(REQ, 'Add returns … Mul returns … RangeError.'), true);
    assert.equal(keeps(REQ, 'Add returns ... Mul returns … RangeError.'), true, 'mixed');
  });

  it('a leading or trailing ellipsis leaves one real piece', () => {
    assert.equal(keeps(REQ, '... rejected with a RangeError.'), true);
    assert.equal(keeps(REQ, 'Negative inputs are rejected ...'), true);
    assert.equal(keeps(REQ, '… rejected with a RangeError.…'), true);
    assert.equal(keeps(REQ, '... invented tail'), false);
  });

  it('a quote that is only ellipses is discarded', () => {
    for (const q of ['...', '…', '... … ....', ' ... ']) assert.equal(keeps(REQ, q), false, JSON.stringify(q));
  });

  it('discarded when a piece is missing', () => {
    assert.equal(keeps(REQ, 'Add returns ... Division by zero'), false);
    assert.equal(keeps(REQ, 'Division by zero ... two numbers.'), false);
    assert.equal(keeps(REQ, 'Add returns … Infinity … RangeError.'), false, 'middle piece missing');
  });

  it('discarded when the pieces occur in the wrong order', () => {
    assert.equal(keeps(REQ, 'Negative inputs ... Add returns'), false);
    assert.equal(keeps(REQ, 'RangeError.…Add returns'), false);
    assert.equal(keeps(REQ, 'Mul returns ... Add returns the sum'), false);
  });

  it('pieces must not overlap', () => {
    // normalised requirement "addreturnsthesum." - "the" would be shared
    assert.equal(keeps('Add returns the sum.', 'Add returns the ... the sum.'), false);
    assert.equal(keeps('Add returns the sum.', 'Add returns the ... sum.'), true);
  });

  it('each piece matches after the end of the previous one, not at its last occurrence', () => {
    const req = 'xx yy xx zz';
    assert.equal(keeps(req, 'xx ... yy'), true);
    assert.equal(keeps(req, 'xx ... zz'), true);
    assert.equal(keeps(req, 'zz ... xx'), false);
    assert.equal(keeps('one two one', 'one ... one'), true, 'the same piece twice needs two occurrences');
    assert.equal(keeps('one two', 'one ... one'), false);
  });

  it('normalisation applies inside pieces; two dots are not an ellipsis', () => {
    assert.equal(keeps('**Add** returns the `sum`, always.', 'add RETURNS ... the sum,always'), true);
    assert.equal(keeps('Add returns the sum.', 'Add returns .. the sum.'), false, 'two dots stay literal');
    assert.equal(keeps('wait.. what', 'wait.. what'), true, 'literal two dots still match themselves');
  });
});

// ---- findGaps / runGaps -------------------------------------------------------------------------------------------

const REQ =
  'Add returns the sum of two numbers.\nMul returns the product of two numbers.\nNegative inputs are rejected with a RangeError.\n';
const ADD = 'tests/add.test.mjs';
const MUL = 'tests/mul.test.mjs';
const ADD_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { add } from '../src/add.mjs';`,
  `test('add basic', () => { assert.equal(add(2, 3), 5); });`,
  ``,
].join('\n');
const MUL_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { mul } from '../src/mul.mjs';`,
  `test('mul basic', () => { assert.equal(mul(4, 5), 20); });`,
  ``,
].join('\n');

const GOOD = { rule: 'Negative inputs must throw RangeError', quote: 'Negative inputs are rejected with a RangeError.', file: MUL };
const BAD1 = { rule: 'Division by zero returns Infinity', quote: 'Division by zero returns Infinity', file: ADD };
const BAD2 = { rule: 'Modulo is supported', quote: 'Mod returns the remainder', file: MUL };

function makeRepo(gaps: unknown[]): string {
  const fixtures: RoleFixtures = { critic: { byLabel: { gaps: { output: { gaps } } } } };
  const repo = createRoleRepo({
    fixtures,
    files: {
      'src/add.mjs': 'export function add(a, b) { return 0; }\n',
      'src/mul.mjs': 'export function mul(a, b) { return 0; }\n',
      [ADD]: ADD_TEST,
      [MUL]: MUL_TEST,
      '.bastion/requirement.md': REQ,
    },
  });
  assert.equal(runLock({ cwd: repo }), 0, 'fixture lock must succeed');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  return repo;
}

const ALL_DISCARDED = (n: number) => `critic reported ${n} gap(s) but none of them quotes the requirement; the gap check does not count.`;
const DROPPED = (n: number) => `[bastion] gaps: ${n} reported gap(s) dropped because their quote is not in the requirement.`;

describe('findGaps / runGaps - round 5 contract', () => {
  it('every reported gap discarded -> not ok with the exact error; runGaps returns 1 and prints it', async () => {
    const repo = makeRepo([BAD1, BAD2]);
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.equal(r.error, ALL_DISCARDED(2));
    const cmd = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(cmd.result, 1);
    assert.ok(cmd.err.includes(ALL_DISCARDED(2)), cmd.err);
    assert.ok(!cmd.out.includes('none found'), 'must not claim "none found"');
  });

  it('a single reported gap that is discarded uses n = 1', async () => {
    const repo = makeRepo([BAD1]);
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.equal(r.error, ALL_DISCARDED(1));
  });

  it('one good and one invented gap -> ok, kept 1, discarded 1, stderr line with n = 1', async () => {
    const repo = makeRepo([BAD1, GOOD]);
    const cap = await captureConsole(() => findGaps(repo));
    const r = cap.result;
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.kept, [GOOD]);
    assert.deepEqual(r.discarded, [BAD1]);
    assert.ok(cap.err.includes(DROPPED(1)), cap.err);
    const cmd = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(cmd.result, 1, 'a kept gap still fails the command');
    assert.ok(cmd.err.includes(DROPPED(1)), cmd.err);
  });

  it('the stderr line counts every dropped gap', async () => {
    const repo = makeRepo([BAD1, GOOD, BAD2]);
    const cap = await captureConsole(() => findGaps(repo));
    assert.equal(cap.result.ok, true, cap.result.error);
    assert.equal(cap.result.discarded.length, 2);
    assert.ok(cap.err.includes(DROPPED(2)), cap.err);
  });

  it('zero reported gaps -> ok, nothing kept or discarded, no stderr line', async () => {
    const repo = makeRepo([]);
    const cap = await captureConsole(() => findGaps(repo));
    assert.equal(cap.result.ok, true, cap.result.error);
    assert.deepEqual(cap.result.kept, []);
    assert.deepEqual(cap.result.discarded, []);
    assert.ok(!cap.err.includes('dropped'), cap.err);
    const cmd = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(cmd.result, 0);
    assert.ok(!cmd.err.includes('dropped'), cmd.err);
  });

  it('only good gaps -> ok and no stderr line', async () => {
    const repo = makeRepo([GOOD]);
    const cap = await captureConsole(() => findGaps(repo));
    assert.equal(cap.result.ok, true, cap.result.error);
    assert.deepEqual(cap.result.discarded, []);
    assert.ok(!cap.err.includes('dropped'), cap.err);
  });

  it('a sloppy quote (markers, ellipsis) is kept through findGaps instead of dropped', async () => {
    const sloppy = { rule: 'Reject negatives', quote: '> **Negative inputs** ... rejected with a `RangeError`.' };
    const repo = makeRepo([sloppy]);
    const cap = await captureConsole(() => findGaps(repo));
    assert.equal(cap.result.ok, true, cap.result.error);
    assert.equal(cap.result.kept.length, 1);
    assert.equal(cap.result.discarded.length, 0);
  });
});
