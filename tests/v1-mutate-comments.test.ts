// v1.0 F11 - mutate must not mutate comments: codeLineMask + its use when collecting mutants.
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { codeLineMask, runMutate } from '../src/commands/mutate.js';
import { captureConsole, cleanupTempRepos } from './v04-helpers.js';
import { createRoleRepo } from './v1-helpers.js';

afterEach(cleanupTempRepos);

describe('v1.0 F11 codeLineMask', () => {
  it('returns one boolean per line (empty input gives empty output)', () => {
    assert.deepEqual(codeLineMask([]), []);
    assert.equal(codeLineMask(['a', '', '// c']).length, 3);
  });

  it('masks every line of a multi-line JSDoc block, including `*` lines, and resumes code after it', () => {
    const lines = ['const a = 1;', '/**', ' * Returns true when a === b.', ' * @returns {boolean}', ' */', 'const b = a === 1;'];
    assert.deepEqual(codeLineMask(lines), [true, false, false, false, false, true]);
  });

  it('masks a plain `/*` block whose inner lines do not start with `*`', () => {
    const lines = ['/*', 'x === y', 'true false', '*/', 'run();'];
    assert.deepEqual(codeLineMask(lines), [false, false, false, false, true]);
  });

  it('masks single-line block comments (`/* ... */` and `/** ... */`) and does not leak into the next line', () => {
    const lines = ['/* a === b */', '/** x !== y */', 'const ok = true;'];
    assert.deepEqual(codeLineMask(lines), [false, false, true]);
  });

  it('treats a line with code before an opening block comment as code, and the following comment lines as not', () => {
    const lines = ['x = 1; /* note', 'still a comment === here', 'end of it */', 'y = 2;'];
    assert.deepEqual(codeLineMask(lines), [true, false, false, true]);
  });

  it('a `//` inside a block comment does not end it', () => {
    const lines = ['/* see http://example.com', 'a === b', '*/', 'z = 3;'];
    assert.deepEqual(codeLineMask(lines), [false, false, false, true]);
  });

  it('a `/*` inside a `//` comment does not open a block comment', () => {
    const lines = ['// start /* not a block', 'x = a === b;'];
    assert.deepEqual(codeLineMask(lines), [false, true]);
  });

  it('masks lines that are entirely a `//` or `#` comment (indented too) but keeps trailing-comment code lines', () => {
    const lines = ['// c', '    // indented c', '# python c', '  #!/usr/bin/env x', 'x = 1; // trailing', 'y = 2  # trailing'];
    assert.deepEqual(codeLineMask(lines), [false, false, false, false, true, true]);
  });

  it('masks import lines and blank / whitespace-only lines, but not identifiers that merely start with "import"', () => {
    const lines = ["import fs from 'node:fs';", "  import { a } from './a.js';", '', '   \t', 'important = true;'];
    assert.deepEqual(codeLineMask(lines), [false, false, false, false, true]);
  });

  it('a leading `*` outside a block comment is code (multiplication continuation)', () => {
    const lines = ['const x = a', '  * b === c;'];
    assert.deepEqual(codeLineMask(lines), [true, true]);
  });

  it('handles several block comments in one file', () => {
    const lines = ['/** a */', 'f();', '/*', ' * b', ' */', 'g();', '/* c */'];
    assert.deepEqual(codeLineMask(lines), [false, true, false, false, false, true, false]);
  });
});

describe('v1.0 F11 runMutate skips comments', () => {
  it('mutates only the real `===` line, not the one inside a JSDoc block', async () => {
    const source = [
      '/**',                                  // 1
      ' * Returns whether a === b.',           // 2
      ' * @param {number} a',                  // 3
      ' */',                                  // 4
      'export function same(a, b) {',         // 5
      '  return a === b;',                    // 6
      '}',                                    // 7
      '',
    ].join('\n');
    const repo = createRoleRepo({
      fixtures: {},
      testCommand: 'node -e "process.exit(0)"',
      files: { 'src/same.js': source },
    });
    const { out, err } = await captureConsole(() => runMutate({ cwd: repo, files: ['src/same.js'] }));
    const printed = `${out}\n${err}`;
    const mutantLines = printed.split('\n').filter((l) => /src\/same\.js:\d+/.test(l));
    assert.ok(mutantLines.length >= 1, `expected a mutant line, got:\n${printed}`);
    assert.ok(mutantLines.some((l) => l.includes('src/same.js:6')), `line 6 must be mutated:\n${printed}`);
    for (const l of mutantLines) {
      assert.doesNotMatch(l, /src\/same\.js:2\b/, `JSDoc line 2 must not be mutated:\n${printed}`);
    }
    assert.equal(mutantLines.length, 1, `only one mutant expected:\n${printed}`);
  });

  it('reports no mutation points when `===` / true / false appear only in comments', async () => {
    const source = [
      '/*',
      ' * a === b, x !== y, true, false, a >= b',
      ' */',
      '// c <= d and true',
      'export const v = 1;',
      '',
    ].join('\n');
    const repo = createRoleRepo({
      fixtures: {},
      testCommand: 'node -e "process.exit(0)"',
      files: { 'src/only-comments.js': source },
    });
    const { out, err, result } = await captureConsole(() => runMutate({ cwd: repo, files: ['src/only-comments.js'] }));
    assert.equal(result, 0);
    assert.match(out, /No mutation points found/);
    assert.doesNotMatch(`${out}\n${err}`, /only-comments\.js:\d+/);
  });
});
