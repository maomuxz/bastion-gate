// v1.1 gap check - pure helpers in src/gaps.ts (no disk, no role calls, so no temp repos are needed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCriticPrompt,
  checkQuotes,
  listTestCases,
  parseGapsReport,
  removeTestCase,
  renderGapsMarkdown,
  type Gap,
} from '../src/gaps.js';

/** The "every other character preserved" rule: input === result with `removed` put back at the cut. */
function assertPreserved(input: string, res: { source: string; removed: string }): void {
  const cut = input.indexOf(res.removed);
  assert.ok(cut >= 0, 'removed must be a substring of the input');
  // The cut is where the rest of the input stops matching the result.
  let found = false;
  for (let c = cut; c >= 0 && c <= input.length - res.removed.length; c = input.indexOf(res.removed, c + 1)) {
    if (res.source.slice(0, c) + res.removed + res.source.slice(c) === input) { found = true; break; }
    if (c === -1) break;
  }
  assert.ok(found, 'input must equal result with removed re-inserted at one position');
}

describe('listTestCases', () => {
  it('lists test/it names in source order, with .only/.skip/.todo, all quote kinds', () => {
    const src = [
      "test('one', () => {});",
      'it("two", () => {});',
      'test(`three`, () => {});',
      "test.only('four', () => {});",
      "it.skip('five', () => {});",
      "test.todo('six');",
      "it.only(\"seven\", () => {});",
    ].join('\n');
    assert.deepEqual(listTestCases(src), ['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
  });

  it('does not count describe/group blocks but does count the cases inside them (nested)', () => {
    const src = [
      "describe('outer', () => {",
      "  describe('inner', () => {",
      "    test('t1', () => {});",
      "    group('g', () => { it('t2', () => {}); });",
      '  });',
      "  describe.skip('skipped', () => { test('t3', () => {}); });",
      '});',
    ].join('\n');
    assert.deepEqual(listTestCases(src), ['t1', 't2', 't3']);
  });

  it('ignores calls inside comments and string/template literals, and look-alike identifiers', () => {
    const src = [
      "// test('line comment', () => {});",
      "/* it('block comment', () => {}); */",
      "const a = \"test('in double', () => {})\";",
      "const b = 'it(\"in single\", () => {})';",
      "const c = `it('in template', () => {}) ${ 1 + 1 }`;",
      "latest('prefixed', () => {});",
      "mytest('prefixed2', () => {});",
      "obj.test('member', () => {});",
      "test(someVariable, () => {});",
      "test('real', () => {});",
    ].join('\n');
    const names = listTestCases(src);
    assert.ok(names.includes('real'));
    assert.ok(!names.includes('line comment'));
    assert.ok(!names.includes('block comment'));
    assert.ok(!names.includes('in double'));
    assert.ok(!names.includes('in single'));
    assert.ok(!names.includes('in template'));
    assert.ok(!names.includes('prefixed'));
    assert.ok(!names.includes('prefixed2'));
    assert.deepEqual(names, ['real']);
  });

  it('keeps names exactly as written: no trimming, duplicates kept, escapes not interpreted', () => {
    const src = [
      "test('  spaced  ', () => {});",
      "test('dup', () => {});",
      "test('dup', () => {});",
      "test('it\\'s (ok', () => {});",
    ].join('\n');
    assert.deepEqual(listTestCases(src), ['  spaced  ', 'dup', 'dup', "it\\'s (ok"]);
  });

  it('finds cases that follow tricky code (an apostrophe in a comment, a template with ${})', () => {
    const src = [
      "// don't start a string here ' \"",
      "/* it's ` here */",
      "const t = `a ${ `b ${ 'c' }` } d`;",
      "test('after the traps', () => {});",
    ].join('\n');
    assert.deepEqual(listTestCases(src), ['after the traps']);
  });

  it('returns an empty list for a source without cases', () => {
    assert.deepEqual(listTestCases(''), []);
    assert.deepEqual(listTestCases("describe('x', () => {});\n"), []);
  });
});

describe('removeTestCase', () => {
  it('removes a whole line: indentation before the call stays, `;` and the line break go', () => {
    const src = "a\n  test('x', () => {});\nb\n";
    const r = removeTestCase(src, 'x')!;
    assert.ok(r);
    assert.equal(r.removed, "test('x', () => {});\n");
    assert.equal(r.source, 'a\n  b\n');
  });

  it('handles no trailing newline, no semicolon, CRLF and trailing whitespace', () => {
    assert.deepEqual(removeTestCase("test('x', () => {});", 'x'), { source: '', removed: "test('x', () => {});" });
    assert.deepEqual(removeTestCase("test('x', () => {})\nnext", 'x'), { source: 'next', removed: "test('x', () => {})\n" });
    assert.deepEqual(removeTestCase("test('x');\r\nnext", 'x'), { source: 'next', removed: "test('x');\r\n" });
    assert.deepEqual(removeTestCase("test('x');   \t\nnext", 'x'), { source: 'next', removed: "test('x');   \t\n" });
  });

  it('keeps the rest of the line when something else follows the call', () => {
    const two = "test('x', () => {}); test('y', () => {});\n";
    assert.deepEqual(removeTestCase(two, 'x'), { source: " test('y', () => {});\n", removed: "test('x', () => {});" });
    const cm = "test('x', () => {}); // keep me\nnext\n";
    assert.deepEqual(removeTestCase(cm, 'x'), { source: ' // keep me\nnext\n', removed: "test('x', () => {});" });
    // only a `;` directly after the ')' is taken
    const gap = "test('x') ;\nnext\n";
    assert.deepEqual(removeTestCase(gap, 'x'), { source: ' ;\nnext\n', removed: "test('x')" });
  });

  it('matches parentheses through strings, templates with ${...}, // and block comments', () => {
    const hard = [
      "import test from 'node:test';",
      "describe('suite (with paren', () => {",
      "  test('keep-1', () => {",
      "    const s = \"it('target', () => {});\";",
      '  });',
      "  // don't ( trap: test('target', () => {});",
      "  test('target', async () => {",
      "    const a = ')}';",
      "    const b = \"(\" + '{';",
      "    const c = `x ${ fn(`)`, { k: '}' }) } ) }`;",
      "    // ) } ( {  it's",
      "    /* ) } ( { don't ` */",
      '    assert.equal(f(")"), 1);',
      '  });',
      "  test('keep-2', () => {});",
      '});',
      '',
    ].join('\n');
    assert.deepEqual(listTestCases(hard), ['keep-1', 'target', 'keep-2']);
    const start = hard.indexOf("  test('target', async") + 2;
    const endMarker = "  });\n  test('keep-2'";
    const end = hard.indexOf(endMarker) + '  });\n'.length;
    const r = removeTestCase(hard, 'target')!;
    assert.ok(r);
    assert.ok(r.removed.startsWith("test('target', async"));
    assert.ok(r.removed.endsWith('});\n'));
    assert.equal(r.removed, hard.slice(start, end));
    assert.equal(r.source, hard.slice(0, start) + hard.slice(end));
    assert.deepEqual(listTestCases(r.source), ['keep-1', 'keep-2']);
    assertPreserved(hard, r);
  });

  it('works inside nested describe blocks and leaves siblings alone', () => {
    const src = [
      "describe('outer', () => {",
      "  describe('inner', () => {",
      "    test('t1', () => {});",
      "    it('t2', () => {});",
      '  });',
      '});',
      '',
    ].join('\n');
    const r = removeTestCase(src, 't1')!;
    assert.ok(r);
    assert.equal(r.removed, "test('t1', () => {});\n");
    assert.equal(r.source, "describe('outer', () => {\n  describe('inner', () => {\n    " + "    it('t2', () => {});\n  });\n});\n");
    assert.deepEqual(listTestCases(r.source), ['t2']);
    assert.equal(removeTestCase(src, 'inner'), null);
    assert.equal(removeTestCase(src, 'outer'), null);
  });

  it('removes test.skip / it.only calls from the modifier start', () => {
    const src = "test.skip('sk', () => { f(')'); });\nit.only('o', () => {});\n";
    const a = removeTestCase(src, 'sk')!;
    assert.deepEqual(a, { source: "it.only('o', () => {});\n", removed: "test.skip('sk', () => { f(')'); });\n" });
    const b = removeTestCase(src, 'o')!;
    assert.deepEqual(b, { source: "test.skip('sk', () => { f(')'); });\n", removed: "it.only('o', () => {});\n" });
  });

  it('includes a trailing options object (before or after the callback) in the span', () => {
    const before = "test('opt', { timeout: 100, skip: ')' }, async () => {\n  await 1;\n});\nnext();\n";
    assert.deepEqual(removeTestCase(before, 'opt'), {
      source: 'next();\n',
      removed: "test('opt', { timeout: 100, skip: ')' }, async () => {\n  await 1;\n});\n",
    });
    const after = "test('opt2', () => {}, { timeout: 5, note: '}' });\nnext();\n";
    assert.deepEqual(removeTestCase(after, 'opt2'), {
      source: 'next();\n',
      removed: "test('opt2', () => {}, { timeout: 5, note: '}' });\n",
    });
  });

  it('removes only the first of two cases with the same name', () => {
    const src = "test('dup', () => { one(); });\ntest('dup', () => { two(); });\n";
    const r = removeTestCase(src, 'dup')!;
    assert.deepEqual(r, { source: "test('dup', () => { two(); });\n", removed: "test('dup', () => { one(); });\n" });
    const r2 = removeTestCase(r.source, 'dup')!;
    assert.deepEqual(r2, { source: '', removed: "test('dup', () => { two(); });\n" });
  });

  it('matches the name exactly as written (escapes untouched, no prefix/substring match)', () => {
    const src = "test('it\\'s (ok', () => {});\ntest('ab', () => {});\n";
    assert.deepEqual(removeTestCase(src, "it\\'s (ok"), { source: "test('ab', () => {});\n", removed: "test('it\\'s (ok', () => {});\n" });
    assert.equal(removeTestCase(src, 'a'), null);
    assert.equal(removeTestCase(src, 'AB'), null);
    assert.equal(removeTestCase(src, 'ab '), null);
  });

  it('returns null for unknown names, names only in comments/strings/describe, look-alikes, and unclosed calls', () => {
    assert.equal(removeTestCase("test('x', () => {});\n", 'y'), null);
    assert.equal(removeTestCase("// test('x', () => {});\nconst s = \"it('x')\";\n", 'x'), null);
    assert.equal(removeTestCase("describe('x', () => {});\n", 'x'), null);
    assert.equal(removeTestCase("latest('x', () => {});\n", 'x'), null);
    assert.equal(removeTestCase("test('x', () => {\n  f(1);\n", 'x'), null);
    assert.equal(removeTestCase("test('x', () => { f(')'); \n", 'x'), null);
    assert.equal(removeTestCase('', 'x'), null);
  });

  it('preserves every other character, for every case in a mixed source', () => {
    const mixed = [
      "test('a', () => { f('b)'); });",
      'it.only("b", () => {});',
      'test.skip(`c`, () => {}, { timeout: 5 });',
      "describe('d', () => {",
      "  test('a', { skip: true }, () => {",
      "    /* ) */ g(`${'}'}`);",
      '  });',
      "  it.todo('e');",
      '});',
      '',
    ].join('\n');
    const all = listTestCases(mixed);
    assert.deepEqual(all, ['a', 'b', 'c', 'a', 'e']);
    for (const name of new Set(all)) {
      const r = removeTestCase(mixed, name);
      assert.ok(r, `case ${name} should be removable`);
      assertPreserved(mixed, r!);
      const expected = all.slice();
      expected.splice(expected.indexOf(name), 1);
      assert.deepEqual(listTestCases(r!.source), expected, `after removing ${name}`);
    }
    // the first 'a' is the one that goes
    const first = removeTestCase(mixed, 'a')!;
    assert.ok(first.removed.startsWith("test('a', () => { f('b)'); });"));
    assert.ok(first.source.includes("test('a', { skip: true }"));
  });
});

describe('parseGapsReport', () => {
  it('accepts a valid report, trims rule/quote, keeps file, ignores extra keys', () => {
    const raw = {
      gaps: [
        { rule: '  Rejects negatives  ', quote: '\tmust be positive\n', file: 'tests/a.test.ts', extra: 1 },
        { rule: 'Second', quote: 'q2' },
      ],
      note: 'ignored',
    };
    assert.deepEqual(parseGapsReport(raw), {
      gaps: [
        { rule: 'Rejects negatives', quote: 'must be positive', file: 'tests/a.test.ts' },
        { rule: 'Second', quote: 'q2' },
      ],
    });
  });

  it('accepts an empty gaps array', () => {
    assert.deepEqual(parseGapsReport({ gaps: [] }), { gaps: [] });
  });

  it('drops an empty or non-string file instead of failing', () => {
    const r = parseGapsReport({
      gaps: [
        { rule: 'r1', quote: 'q1', file: '' },
        { rule: 'r2', quote: 'q2', file: 42 },
        { rule: 'r3', quote: 'q3', file: null },
        { rule: 'r4', quote: 'q4', file: ['x'] },
      ],
    });
    assert.deepEqual(r, {
      gaps: [
        { rule: 'r1', quote: 'q1' },
        { rule: 'r2', quote: 'q2' },
        { rule: 'r3', quote: 'q3' },
        { rule: 'r4', quote: 'q4' },
      ],
    });
    assert.ok(!('file' in r!.gaps[0]!));
  });

  it('rejects anything that is not a well-formed report', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'gaps',
      42,
      [],
      {},
      { gaps: 'x' },
      { gaps: {} },
      { gaps: [null] },
      { gaps: ['str'] },
      { gaps: [[]] },
      { gaps: [{ rule: 'r' }] },
      { gaps: [{ quote: 'q' }] },
      { gaps: [{ rule: '   ', quote: 'q' }] },
      { gaps: [{ rule: 'r', quote: ' \n\t ' }] },
      { gaps: [{ rule: 5, quote: 'q' }] },
      { gaps: [{ rule: 'r', quote: ['q'] }] },
      { gaps: [{ rule: 'ok', quote: 'ok' }, { rule: 'r', quote: '' }] },
    ];
    for (const b of bad) assert.equal(parseGapsReport(b), null, JSON.stringify(b));
  });
});

describe('checkQuotes', () => {
  const req = 'The total MUST be positive.\n  Reject zero\tamounts, and   log them.';

  it('keeps quotes that differ from the requirement only in whitespace or case', () => {
    const gaps: Gap[] = [
      { rule: 'r1', quote: 'the total must be positive.' },
      { rule: 'r2', quote: 'Reject zero amounts, and log them.' },
      { rule: 'r3', quote: 'THE  TOTAL\nMUST\tBE POSITIVE.' },
      { rule: 'r4', quote: 'positive.Reject' }, // whitespace is dropped on both sides
      { rule: 'r5', quote: 'a', file: 'x.test.ts' },
    ];
    const { kept, discarded } = checkQuotes({ gaps }, req);
    assert.deepEqual(kept, gaps);
    assert.deepEqual(discarded, []);
  });

  it('discards quotes that are not contiguous text of the requirement, preserving order', () => {
    const gaps: Gap[] = [
      { rule: 'keep-a', quote: 'must be positive' },
      { rule: 'drop-a', quote: 'must be negative' },
      { rule: 'drop-b', quote: 'The total, positive' }, // not contiguous
      { rule: 'keep-b', quote: 'LOG THEM' },
      { rule: 'drop-c', quote: 'The total MUST be positive. And more text that is not there' },
      { rule: 'drop-d', quote: 'positive!' }, // punctuation differs
    ];
    const { kept, discarded } = checkQuotes({ gaps }, req);
    assert.deepEqual(kept.map((g) => g.rule), ['keep-a', 'keep-b']);
    assert.deepEqual(discarded.map((g) => g.rule), ['drop-a', 'drop-b', 'drop-c', 'drop-d']);
  });

  it('handles an empty report and returns the gap objects unchanged', () => {
    assert.deepEqual(checkQuotes({ gaps: [] }, req), { kept: [], discarded: [] });
    const g: Gap = { rule: 'r', quote: 'LOG THEM', file: 'tests/z.test.ts' };
    const res = checkQuotes({ gaps: [g] }, req);
    assert.deepEqual(res.kept, [g]);
    assert.equal(res.kept[0]!.quote, 'LOG THEM'); // not normalised in the output
  });
});

describe('buildCriticPrompt', () => {
  const requirement = 'Orders ship in 3 days. Price is $& per ${unit}.\nRefunds within 30 days.';
  const tests = [
    { file: 'tests/ship.test.ts', content: "test('ships', () => { assert.equal(f('$&'), `${x}`); });\n" },
    { file: 'tests/refund.test.ts', content: "test('refund', () => {});\n// ## Requirement lookalike\n" },
  ];

  it('has instruction block, then ## Requirement (verbatim), then ## Tests with ### <file> and verbatim content, in order', () => {
    const p = buildCriticPrompt(requirement, tests);
    const iReq = p.indexOf('## Requirement');
    const iTests = p.indexOf('## Tests');
    assert.ok(iReq > 0, 'instruction block comes before ## Requirement');
    assert.ok(iTests > iReq);
    const reqSection = p.slice(iReq, iTests);
    assert.ok(reqSection.includes(requirement), 'requirement verbatim, even with $& and ${}');
    const testsSection = p.slice(iTests);
    const h1 = testsSection.indexOf('### tests/ship.test.ts');
    const c1 = testsSection.indexOf(tests[0]!.content);
    const h2 = testsSection.indexOf('### tests/refund.test.ts');
    const c2 = testsSection.indexOf(tests[1]!.content);
    assert.ok(h1 >= 0 && c1 > h1 && h2 > c1 && c2 > h2, 'headings and verbatim contents appear in order');
  });

  it('instructions tell the critic the rules of the job and where to write JSON', () => {
    const p = buildCriticPrompt(requirement, tests);
    const instr = p.slice(0, p.indexOf('## Requirement'));
    assert.match(instr, /BASTION_OUTPUT/);
    assert.ok(instr.includes('{"gaps":[]}'), 'empty-result example');
    assert.match(instr, /"gaps"/);
    assert.match(instr, /"rule"/);
    assert.match(instr, /"quote"/);
    assert.match(instr, /"file"/);
    assert.match(instr, /verbatim/i);
    assert.match(instr, /not read any file|do not read/i);
    assert.match(instr, /rule by rule/i);
    assert.match(instr, /fail/i); // a rule is covered only when an assertion would fail on a wrong implementation
  });

  it('does not mention interfaces.md, the map or any design document', () => {
    const p = buildCriticPrompt('Plain requirement text.', [{ file: 'tests/a.test.ts', content: 'test("a", () => {});\n' }]);
    assert.doesNotMatch(p, /interfaces\.md/i);
    assert.doesNotMatch(p, /interfaces/i);
    assert.doesNotMatch(p, /\bmap\b/i);
    assert.doesNotMatch(p, /design/i);
  });

  it('still has both sections when there are no test files', () => {
    const p = buildCriticPrompt('Only a requirement.', []);
    assert.ok(p.indexOf('## Requirement') > 0);
    assert.ok(p.indexOf('## Tests') > p.indexOf('## Requirement'));
    assert.ok(p.includes('Only a requirement.'));
  });
});

describe('renderGapsMarkdown', () => {
  const nonBlank = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '');

  it('renders the no-gaps record', () => {
    const md = renderGapsMarkdown([], []);
    assert.deepEqual(nonBlank(md), ['# Gap check', 'Kept: 0  Discarded (quote not in requirement): 0', 'No gaps found.']);
    assert.ok(md.startsWith('# Gap check'));
    assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), 'single trailing newline');
    assert.ok(!md.includes('## Gaps') && !md.includes('## Discarded'));
  });

  it('renders kept gaps with file or "-" and the indented quote line', () => {
    const md = renderGapsMarkdown(
      [
        { rule: 'Rejects zero', quote: 'Reject zero amounts', file: 'tests/a.test.ts' },
        { rule: 'Logs refusals', quote: 'log them' },
      ],
      []
    );
    assert.deepEqual(nonBlank(md), [
      '# Gap check',
      'Kept: 2  Discarded (quote not in requirement): 0',
      '## Gaps',
      '- Rejects zero (file: tests/a.test.ts)',
      '  > Reject zero amounts',
      '- Logs refusals (file: -)',
      '  > log them',
    ]);
    assert.ok(!md.includes('No gaps found.'));
    assert.ok(!md.includes('## Discarded'));
    assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
  });

  it('adds a ## Discarded list after ## Gaps in the same item form', () => {
    const md = renderGapsMarkdown(
      [{ rule: 'K', quote: 'kq', file: 'f.test.ts' }],
      [{ rule: 'D1', quote: 'dq1' }, { rule: 'D2', quote: 'dq2', file: 'g.test.ts' }]
    );
    assert.deepEqual(nonBlank(md), [
      '# Gap check',
      'Kept: 1  Discarded (quote not in requirement): 2',
      '## Gaps',
      '- K (file: f.test.ts)',
      '  > kq',
      '## Discarded',
      '- D1 (file: -)',
      '  > dq1',
      '- D2 (file: g.test.ts)',
      '  > dq2',
    ]);
  });

  it('with only discarded gaps it does not claim "No gaps found."', () => {
    const md = renderGapsMarkdown([], [{ rule: 'D', quote: 'dq' }]);
    assert.ok(md.startsWith('# Gap check'));
    assert.ok(md.includes('Kept: 0  Discarded (quote not in requirement): 1'));
    assert.ok(!md.includes('No gaps found.'));
    assert.ok(md.includes('## Discarded'));
    assert.ok(md.includes('- D (file: -)\n  > dq'));
  });

  it('appends the note as a final paragraph, in both the empty and the non-empty case', () => {
    const empty = renderGapsMarkdown([], [], 'Critic skipped: no tests.');
    assert.ok(empty.includes('No gaps found.'));
    assert.ok(empty.endsWith('\n\nCritic skipped: no tests.\n'));
    const full = renderGapsMarkdown([{ rule: 'R', quote: 'Q' }], [{ rule: 'D', quote: 'X' }], 'Sent back to tester.');
    assert.ok(full.endsWith('\n\nSent back to tester.\n'));
    assert.ok(full.indexOf('## Discarded') < full.indexOf('Sent back to tester.'));
    assert.ok(!full.endsWith('\n\n'));
    const without = renderGapsMarkdown([{ rule: 'R', quote: 'Q' }], []);
    assert.ok(!without.includes('Sent back'));
  });
});
