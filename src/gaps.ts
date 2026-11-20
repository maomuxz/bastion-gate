// v1.1 gap check ("挑漏"): pure helpers. A critic role gets ONLY the original requirement and the full text of
// the test suite, and lists requirement rules that no test checks. Nothing here touches the disk or calls a role.

export const GAPS_REPORT_REL_PATH = '.bastion/gaps.json';
export const GAPS_MD_REL_PATH = '.bastion/gaps.md';

/** One requirement rule that no test checks. */
export interface Gap {
  /** The missing rule in one plain sentence. */
  rule: string;
  /** Text copied verbatim from the requirement that states the rule. */
  quote: string;
  /** Test file (as given to the critic) where a test for it belongs best; optional. */
  file?: string;
}
export interface GapsReport { gaps: Gap[] }
export interface TestSource { file: string; content: string }

interface CaseHit { name: string; start: number; open: number }

const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Index just after the string literal opening at `i` (quote char at src[i]). */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === q) return j + 1;
    else j++;
  }
  return src.length;
}

/** Index just after the template literal opening at `i` (backtick), handling `${...}` nesting. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') j = skipBraces(src, j + 1);
    else j++;
  }
  return src.length;
}

/** `i` is at a `{`; returns the index just after its matching `}`. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const n = skipNonCode(src, j);
    if (n !== j) { j = n; continue; }
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return src.length;
}

/** If a comment or string starts at `i`, the index after it; otherwise `i`. */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const e = src.indexOf('\n', i);
    return e < 0 ? src.length : e;
  }
  if (c === '/' && src[i + 1] === '*') {
    const e = src.indexOf('*/', i + 2);
    return e < 0 ? src.length : e + 2;
  }
  if (c === "'" || c === '"') return skipQuoted(src, i);
  if (c === '`') return skipTemplate(src, i);
  return i;
}

function scanCases(src: string): CaseHit[] {
  const hits: CaseHit[] = [];
  let i = 0;
  while (i < src.length) {
    const n = skipNonCode(src, i);
    if (n !== i) { i = n; continue; }
    const c = src[i];
    if ((c === 't' || c === 'i') && !isIdent(src[i - 1]) && src[i - 1] !== '.') {
      const m = /^(?:test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])/.exec(src.slice(i, i + 64));
      if (m) {
        const nameStart = i + m[0].length;
        const q = m[1]!;
        let j = nameStart;
        while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
        if (j >= src.length) break;
        hits.push({ name: src.slice(nameStart, j), start: i, open: i + m[0].indexOf('(') });
        i = j + 1;
        continue;
      }
    }
    if (isIdent(c)) {
      while (isIdent(src[i])) i++;
      continue;
    }
    i++;
  }
  return hits;
}

/** `open` is at a `(`; returns the index of its matching `)` or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const n = skipNonCode(src, j);
    if (n !== j) { j = n; continue; }
    const c = src[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return c === ')' ? j : -1; }
    j++;
  }
  return -1;
}

/**
 * Names of the test cases in a JS/TS test source, in source order: every `test(` / `it(` call (also with a
 * `.only` / `.skip` / `.todo` suffix) whose first argument is a string literal ('...', "..." or `...`).
 * `describe(` / `group(` blocks are NOT cases (the cases inside them are). Calls that appear inside a
 * comment or inside a string literal are ignored. Names are returned exactly as written between the quotes
 * (no trimming, duplicates kept).
 */
export function listTestCases(source: string): string[] {
  return scanCases(source).map((h) => h.name);
}

/**
 * Remove one test case from a JS/TS test source: the first `test(` / `it(` call (same forms as listTestCases)
 * whose name === `name`. The removed span runs from the first character of `test` / `it` to the matching
 * closing parenthesis of that call, plus one directly following `;` if present, plus the rest of that line
 * when only whitespace remains on it (including its line break). Parentheses, brackets and braces inside
 * string literals, template literals (including `${...}` nesting), regex-free comments (`//` and block
 * comments) must not confuse the matching.
 * Returns { source: the text without the span, removed: the span } - so `removed` is a substring of the input and
 * every other character of the input is preserved in order. Returns null when no such case exists or the
 * call never closes.
 */
export function removeTestCase(source: string, name: string): { source: string; removed: string } | null {
  const hit = scanCases(source).find((h) => h.name === name);
  if (!hit) return null;
  const close = matchParen(source, hit.open);
  if (close < 0) return null;
  let end = close + 1;
  if (source[end] === ';') end++;
  let j = end;
  while (source[j] === ' ' || source[j] === '\t') j++;
  if (j >= source.length) end = j;
  else if (source[j] === '\n') end = j + 1;
  else if (source[j] === '\r' && source[j + 1] === '\n') end = j + 2;
  return { source: source.slice(0, hit.start) + source.slice(end), removed: source.slice(hit.start, end) };
}

/**
 * Validate an untrusted critic report. Valid: an object with `gaps`, an array of objects each having non-empty
 * (after trim) string `rule` and `quote`, and an optional string `file` (an empty or non-string `file` is dropped,
 * not an error). Unknown extra keys are ignored. Returns the cleaned report (rule/quote trimmed) or null.
 */
export function parseGapsReport(raw: unknown): GapsReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const list = (raw as Record<string, unknown>).gaps;
  if (!Array.isArray(list)) return null;
  const gaps: Gap[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.rule !== 'string' || typeof o.quote !== 'string') return null;
    const rule = o.rule.trim();
    const quote = o.quote.trim();
    if (!rule || !quote) return null;
    const gap: Gap = { rule, quote };
    if (typeof o.file === 'string' && o.file !== '') gap.file = o.file;
    gaps.push(gap);
  }
  return { gaps };
}

/*
 * v1.1 hardening (round 5) of checkQuotes - a real gap must not be thrown away because the critic quoted sloppily:
 * - both sides are normalised with String.prototype.normalize('NFKC') (full-width punctuation and letters become
 *   ASCII), lower-cased, and then every whitespace character and every one of these characters is removed:
 *   * _ ` ~ # > | " ' and the curly quotes (U+201C U+201D U+2018 U+2019);
 * - a quote may shorten the requirement with an ellipsis: it is split at every `...` (three or more dots) and every
 *   U+2026; it is kept when it has at least one non-empty piece and every non-empty piece occurs in the requirement,
 *   each one after the end of the previous piece (in order, not overlapping);
 * - a quote that is empty after normalisation is discarded.
 * Everything else (order preserved, kept / discarded) is unchanged.
 */
/**
 * Split gaps by whether their quote really occurs in the requirement. Comparison is case-insensitive and
 * ignores all whitespace differences (collapse every whitespace run to nothing on both sides). A critic that
 * invents a rule cannot quote it, so `discarded` gaps are not sent back to the tester. Order is preserved.
 */
export function checkQuotes(report: GapsReport, requirement: string): { kept: Gap[]; discarded: Gap[] } {
  const strip = (t: string): string => t.toLowerCase().replace(/[\s*_`~#>|"'“”‘’]+/g, '');
  const req = strip(requirement.normalize('NFKC'));
  const matches = (quote: string): boolean => {
    const pieces = quote.normalize('NFKC').split(/\.{3,}/).map(strip).filter((p) => p !== '');
    if (pieces.length === 0) return false;
    let pos = 0;
    for (const p of pieces) {
      const at = req.indexOf(p, pos);
      if (at < 0) return false;
      pos = at + p.length;
    }
    return true;
  };
  const kept: Gap[] = [];
  const discarded: Gap[] = [];
  for (const g of report.gaps) (matches(g.quote) ? kept : discarded).push(g);
  return { kept, discarded };
}

/**
 * Prompt for the critic. It must contain, in this order: the instruction block, a `## Requirement` section with
 * the requirement text verbatim, and a `## Tests` section with every test file as `### <file>` followed by its
 * content verbatim. The instruction block must say: judge only from the text in this prompt and do not read any
 * file; go through the requirement rule by rule (one sentence may hold several rules) and list every rule that no
 * test would catch if an implementation got it wrong; quote the requirement verbatim for each gap; a rule is covered
 * only when some assertion would fail on a wrong implementation; write JSON of the form
 * {"gaps":[{"rule":"...","quote":"...","file":"<one of the test files>"}]} to the BASTION_OUTPUT path, with
 * {"gaps":[]} when nothing is missing. It must not mention interfaces.md, the map, or any design document.
 */
export function buildCriticPrompt(requirement: string, tests: TestSource[]): string {
  const head = [
    'You are a test critic. Below are a requirement and the full text of a test suite.',
    'Judge only from the text in this prompt and do not read any file.',
    'Go through the requirement rule by rule (one sentence may hold several rules). List every rule that no test would catch if an implementation got it wrong.',
    'A rule is covered only when some assertion would fail on a wrong implementation; a test that merely runs the code, or only checks something nearby, does not cover it.',
    'Work in two passes. Pass 1: split the requirement into atomic rules. Every literal example (an input and its stated result), every item of a list, every table row and column, every "and" / "or" branch, every default and every stated exception is its own rule.',
    'Pass 2: for each atomic rule, look for one assertion that would fail if exactly that rule were implemented wrongly while its neighbours stay right. A test of a neighbouring case does not count: asserting the result of an expression that uses a value does not cover the rule about that value on its own, and testing one branch of a rule does not cover the other branches.',
    'When the requirement states a literal example, it is covered only if a test asserts that same situation.',
    'When you are unsure whether a rule is covered, report it: a false alarm costs one extra test, a miss ships a bug.',
    'For each gap quote the requirement verbatim (the exact words that state the rule) and name the test file where a test for it belongs best.',
    'Write JSON of the form {"gaps":[{"rule":"<the missing rule in one plain sentence>","quote":"<verbatim text from the requirement>","file":"<one of the test files>"}]} to the BASTION_OUTPUT path.',
    'Write {"gaps":[]} when nothing is missing.',
    '',
    '## Requirement',
    requirement,
    '',
    '## Tests',
  ];
  const parts = [head.join('\n')];
  for (const t of tests) parts.push(`\n### ${t.file}\n${t.content}`);
  return parts.join('\n') + '\n';
}

/**
 * Human-readable record written to .bastion/gaps.md. Starts with `# Gap check`. Then a line
 * `Kept: <n>  Discarded (quote not in requirement): <m>`. With no kept and no discarded gaps the next line is
 * `No gaps found.`. Otherwise a `## Gaps` list, one item per kept gap: `- <rule> (file: <file or "-">)` followed by an
 * indented line `  > <quote>`; then, when there are discarded gaps, a `## Discarded` list in the same item form.
 * When `note` is given it is appended as a final paragraph. Ends with a single newline.
 */
export function renderGapsMarkdown(kept: Gap[], discarded: Gap[], note?: string): string {
  const item = (g: Gap): string[] => [`- ${g.rule} (file: ${g.file ?? '-'})`, `  > ${g.quote}`];
  const lines = ['# Gap check', '', `Kept: ${kept.length}  Discarded (quote not in requirement): ${discarded.length}`, ''];
  if (kept.length === 0 && discarded.length === 0) lines.push('No gaps found.', '');
  if (kept.length > 0) lines.push('## Gaps', ...kept.flatMap(item), '');
  if (discarded.length > 0) lines.push('## Discarded', ...discarded.flatMap(item), '');
  if (note) lines.push(note, '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}
