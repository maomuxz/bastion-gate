import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASTION_DIR, CONFIG_REL_PATH } from './config.js';
import { getRepoRoot, toPosixPath } from './git.js';
import { contentHash } from './runner.js';

export const SHEET_CONFIG_REL_PATH = '.bastion/sheet.json';
export const DEFAULT_SHEET_OUTPUT = '.bastion/sheet.md';

export interface SheetEntryObject {
  /** File or directory path relative to the project root (e.g. "lib/ui/ui.dart" or "lib/src"). */
  path: string;
  /** Optional section heading in the generated markdown. */
  title?: string;
  /** Explicit Dart import URI (e.g. "package:acme_ui/ui/ui.dart"); auto-derived from pubspec.yaml when omitted. */
  importUri?: string;
  /** Show the `[package:...]` import tag inline on each symbol line instead of only in the section heading. */
  inlineImport?: boolean;
  /** When `path` is a barrel file (`export '...'`), keep only exports starting with one of these prefixes. */
  exportPrefixes?: string[];
  /** Subdirectories (relative to barrel file dir) to scan for public `.dart` files not re-exported by the barrel. */
  discoverUnexportedDirs?: string[];
}

export type SheetEntry = string | SheetEntryObject;

export interface SheetConfig {
  /** Source language adapter. Currently only "dart" is supported. */
  language: 'dart';
  /** Output markdown path relative to the project root (default: ".bastion/sheet.md"). */
  output?: string;
  /** Optional top-level markdown H1 title. */
  title?: string;
  /** Optional Dart `lib` directory relative to project root (e.g. "lib" or "code/lib") for `package:` URI derivation. */
  packageRoot?: string;
  /** Optional Dart package name (auto-detected from `pubspec.yaml` when omitted). */
  packageName?: string;
  /** Optional rule-script files whose top numbered `// 1. ...` header comments are extracted into a rules section. */
  ruleFiles?: string[];
  /** Optional one-line architecture/layering notes appended to the rules section. */
  notes?: string[];
  /** Public entrypoints (barrel files, source files, or directories) to scan in order. */
  entries: SheetEntry[];
}

export interface ParsedDartSymbol {
  kind: 'enum' | 'typedef' | 'class' | 'mixin' | 'function';
  name: string;
  line: string;
  namedParams: string[];
}

export interface ParsedDartFile {
  symbols: ParsedDartSymbol[];
  exports: Array<{
    relUri: string;
    show?: Set<string>;
    hide?: Set<string>;
  }>;
}

export interface SheetBuildResult {
  markdown: string;
  outputPath: string;
  symbolCount: number;
  lineCount: number;
  charCount: number;
}

function stripBom(raw: string): string {
  return raw.replace(/^\uFEFF/, '');
}

/**
 * Strip Dart `//` comments (preserving `///` doc comments when `keepDoc` is true) and `/* ... *\/` block comments
 * (including nested block comments) without corrupting normal, triple-quoted, or raw (`r'...'`) string literals.
 */
export function stripDartComments(src: string, keepDoc = false): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];

    // Line or doc comment
    if (ch === '/' && next === '/') {
      const isDoc = src[i + 2] === '/' && src[i + 3] !== '/';
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      if (keepDoc && isDoc) {
        out += src.slice(i, end);
      }
      i = end;
      continue;
    }

    // Nested block comment /* ... */
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (src[i] === '\n') out += '\n';
          i++;
        }
      }
      continue;
    }

    // Raw string literal: r'''...''', r"""...""", r'...', r"..."
    if (ch === 'r' && (next === '\'' || next === '"')) {
      const q = next;
      if (src[i + 2] === q && src[i + 3] === q) {
        out += src.slice(i, i + 4);
        i += 4;
        while (i < n) {
          if (src[i] === q && src[i + 1] === q && src[i + 2] === q) {
            out += src.slice(i, i + 3);
            i += 3;
            break;
          }
          out += src[i]!;
          i++;
        }
        continue;
      }
      out += src.slice(i, i + 2);
      i += 2;
      while (i < n && src[i] !== '\n') {
        if (src[i] === q) {
          out += q;
          i++;
          break;
        }
        out += src[i]!;
        i++;
      }
      continue;
    }

    // Normal string literal: '''...''', """...""", '...', "..."
    if (ch === '\'' || ch === '"') {
      const q = ch;
      if (next === q && src[i + 2] === q) {
        out += src.slice(i, i + 3);
        i += 3;
        while (i < n) {
          if (src[i] === '\\') {
            out += src.slice(i, Math.min(n, i + 2));
            i += 2;
            continue;
          }
          if (src[i] === q && src[i + 1] === q && src[i + 2] === q) {
            out += src.slice(i, i + 3);
            i += 3;
            break;
          }
          out += src[i]!;
          i++;
        }
        continue;
      }
      out += q;
      i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') {
          out += src.slice(i, Math.min(n, i + 2));
          i += 2;
          continue;
        }
        if (src[i] === q) {
          out += q;
          i++;
          break;
        }
        out += src[i]!;
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Advance past a Dart string literal starting at `pos` (raw or normal, single or triple quoted). */
function skipDartString(text: string, pos: number): number {
  const n = text.length;
  let i = pos;
  let raw = false;
  if (text[i] === 'r' && (text[i + 1] === '\'' || text[i + 1] === '"')) {
    raw = true;
    i++;
  }
  const q = text[i];
  if (q !== '\'' && q !== '"') return pos + 1;
  if (text[i + 1] === q && text[i + 2] === q) {
    i += 3;
    while (i < n) {
      if (!raw && text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === q && text[i + 1] === q && text[i + 2] === q) return i + 3;
      i++;
    }
    return n;
  }
  i++;
  while (i < n && text[i] !== '\n') {
    if (!raw && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** Find matching closing delimiter (`)` for `(`, `}` for `{`, etc.) on comment-stripped Dart text. Returns -1 if unbalanced. */
export function findMatchingDelimiter(text: string, openPos: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = openPos;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if ((c === 'r' && (text[i + 1] === '\'' || text[i + 1] === '"')) || c === '\'' || c === '"') {
      i = skipDartString(text, i);
      continue;
    }
    if (c === openCh) {
      depth++;
    } else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split top-level statements/declarations inside a class/file body at brace/paren depth 0 (ending with `;` or `}`). */
function topLevelMembers(body: string): string[] {
  const items: string[] = [];
  let start = 0;
  let dParen = 0;
  let dBrace = 0;
  let dBrack = 0;
  let i = 0;
  const n = body.length;

  while (i < n) {
    const c = body[i]!;
    if ((c === 'r' && (body[i + 1] === '\'' || body[i + 1] === '"')) || c === '\'' || c === '"') {
      i = skipDartString(body, i);
      continue;
    }
    if (c === '(') dParen++;
    else if (c === ')') dParen = Math.max(0, dParen - 1);
    else if (c === '[') dBrack++;
    else if (c === ']') dBrack = Math.max(0, dBrack - 1);
    else if (c === '{') dBrace++;
    else if (c === '}') {
      dBrace = Math.max(0, dBrace - 1);
      if (dBrace === 0 && dParen === 0 && dBrack === 0) {
        const seg = body.slice(start, i + 1).trim();
        if (seg) items.push(seg);
        start = i + 1;
      }
    } else if (c === ';' && dBrace === 0 && dParen === 0 && dBrack === 0) {
      const seg = body.slice(start, i + 1).trim();
      if (seg) items.push(seg);
      start = i + 1;
    }
    i++;
  }
  return items;
}

function stripLeadingAnnotations(stmt: string): string {
  let s = stmt.trim();
  while (s.startsWith('@')) {
    const m = /^@[a-zA-Z_][\w.]*/.exec(s);
    if (!m) break;
    let idx = m[0].length;
    if (s[idx] === '<') {
      const endA = findMatchingDelimiter(s, idx, '<', '>');
      if (endA < 0) break;
      idx = endA + 1;
    }
    if (s[idx] === '(') {
      const endP = findMatchingDelimiter(s, idx, '(', ')');
      if (endP < 0) break;
      idx = endP + 1;
    }
    s = s.slice(idx).trim();
  }
  return s;
}

/** Extract `final <Type> <field>;` map from class top-level members so `this.<field>` gets its true static type. */
function resolveClassFieldTypes(members: string[]): Map<string, string> {
  const fmap = new Map<string, string>();
  for (const raw of members) {
    const s = stripLeadingAnnotations(raw);
    if (s.startsWith('static ')) continue;
    const m = /^(?:late\s+)?final\s+([\s\S]+?)\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*(?:=[\s\S]*)?;$/.exec(s);
    if (!m) continue;
    const rawType = m[1]!.replace(/\s+/g, ' ').trim();
    // Guard against untyped `final x = ...` where regex might misparse keywords
    if (!rawType || /^(?:const|var|final)$/.test(rawType)) continue;
    for (const part of m[2]!.split(',')) {
      const nm = part.trim();
      if (nm) fmap.set(nm, rawType);
    }
  }
  return fmap;
}

/** Compact a Dart parameter list, resolving `this.x` via `fieldTypes` and collecting named parameter identifiers. */
export function compactDartParams(rawParams: string, fieldTypes: Map<string, string>): { sig: string; namedParams: string[] } {
  const cleaned = rawParams.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { sig: '', namedParams: [] };

  const parts: Array<{ kind: 'pos' | 'opt' | 'named'; text: string }> = [];
  let cur = '';
  let dAngle = 0;
  let dParen = 0;
  let dBrace = 0;
  let dBrack = 0;
  let groupMode: 'pos' | 'opt' | 'named' = 'pos';
  let i = 0;
  const n = cleaned.length;

  while (i < n) {
    const ch = cleaned[i]!;
    if ((ch === 'r' && (cleaned[i + 1] === '\'' || cleaned[i + 1] === '"')) || ch === '\'' || ch === '"') {
      const nextIdx = skipDartString(cleaned, i);
      cur += cleaned.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }
    if (ch === '<') {
      dAngle++;
      cur += ch;
    } else if (ch === '>' && dAngle > 0 && cleaned[i - 1] !== '=') {
      dAngle--;
      cur += ch;
    } else if (ch === '(') {
      dParen++;
      cur += ch;
    } else if (ch === ')') {
      dParen = Math.max(0, dParen - 1);
      cur += ch;
    } else if (ch === '{') {
      if (dParen === 0 && dAngle === 0 && dBrack === 0 && groupMode === 'pos') {
        const prev = cur.trim().replace(/,$/, '').trim();
        if (prev) parts.push({ kind: 'pos', text: prev });
        cur = '';
        groupMode = 'named';
      } else {
        dBrace++;
        cur += ch;
      }
    } else if (ch === '}') {
      if (dBrace > 0) {
        dBrace--;
        cur += ch;
      } else if (groupMode === 'named') {
        const prev = cur.trim().replace(/,$/, '').trim();
        if (prev) parts.push({ kind: 'named', text: prev });
        cur = '';
        groupMode = 'pos';
      }
    } else if (ch === '[') {
      if (dParen === 0 && dAngle === 0 && dBrace === 0 && groupMode === 'pos') {
        const prev = cur.trim().replace(/,$/, '').trim();
        if (prev) parts.push({ kind: 'pos', text: prev });
        cur = '';
        groupMode = 'opt';
      } else {
        dBrack++;
        cur += ch;
      }
    } else if (ch === ']') {
      if (dBrack > 0) {
        dBrack--;
        cur += ch;
      } else if (groupMode === 'opt') {
        const prev = cur.trim().replace(/,$/, '').trim();
        if (prev) parts.push({ kind: 'opt', text: prev });
        cur = '';
        groupMode = 'pos';
      }
    } else if (ch === ',' && dAngle === 0 && dParen === 0 && dBrace === 0 && dBrack === 0) {
      const tok = cur.trim();
      if (tok) parts.push({ kind: groupMode, text: tok });
      cur = '';
    } else {
      cur += ch;
    }
    i++;
  }
  const tail = cur.trim().replace(/,$/, '').trim();
  if (tail) parts.push({ kind: groupMode, text: tail });

  const posOut: string[] = [];
  const optOut: string[] = [];
  const namedOut: string[] = [];
  const namedParams: string[] = [];

  for (const part of parts) {
    let tok = stripLeadingAnnotations(part.text);
    if (tok === 'super.key' || tok === 'Key? key') continue;

    const mThis = /^(required\s+)?(?:covariant\s+)?this\.([a-zA-Z_]\w*)(\s*=\s*[\s\S]+)?$/.exec(tok);
    if (mThis) {
      const req = mThis[1] ?? '';
      const pname = mThis[2]!;
      const dflt = mThis[3] ?? '';
      const ptyp = fieldTypes.get(pname) ?? '';
      tok = `${req}${ptyp ? ptyp + ' ' : ''}${pname}${dflt}`.trim();
      if (part.kind === 'named') namedParams.push(pname);
    } else if (/^(?:required\s+)?super\./.test(tok)) {
      const mSup = /^(required\s+)?super\.([a-zA-Z_]\w*)(\s*=\s*[\s\S]+)?$/.exec(tok);
      if (mSup) {
        const pname = mSup[2]!;
        const supType = pname === 'child' ? 'Widget ' : '';
        tok = `${mSup[1] ?? ''}${supType}${pname}${mSup[3] ?? ''}`.trim();
        if (part.kind === 'named') namedParams.push(pname);
      }
    } else if (part.kind === 'named') {
      const lhs = splitTopLevelEquals(tok);
      const mName = /([a-zA-Z_]\w*)\s*(?:\([^)]*\))?\s*$/.exec(lhs);
      if (mName) namedParams.push(mName[1]!);
    }

    if (part.kind === 'named') namedOut.push(tok);
    else if (part.kind === 'opt') optOut.push(tok);
    else posOut.push(tok);
  }

  const segs: string[] = [];
  if (posOut.length > 0) segs.push(posOut.join(', '));
  if (optOut.length > 0) segs.push(`[${optOut.join(', ')}]`);
  if (namedOut.length > 0) segs.push(`{${namedOut.join(', ')}}`);
  return { sig: segs.join(', '), namedParams };
}

function splitTopLevelEquals(paramToken: string): string {
  let dAngle = 0;
  let dParen = 0;
  let dBrace = 0;
  let i = 0;
  while (i < paramToken.length) {
    const c = paramToken[i]!;
    if ((c === 'r' && (paramToken[i + 1] === '\'' || paramToken[i + 1] === '"')) || c === '\'' || c === '"') {
      i = skipDartString(paramToken, i);
      continue;
    }
    if (c === '<') dAngle++;
    else if (c === '>' && dAngle > 0) dAngle--;
    else if (c === '(') dParen++;
    else if (c === ')') dParen = Math.max(0, dParen - 1);
    else if (c === '{') dBrace++;
    else if (c === '}') dBrace = Math.max(0, dBrace - 1);
    else if (c === '=' && dAngle === 0 && dParen === 0 && dBrace === 0) {
      return paramToken.slice(0, i).trim();
    }
    i++;
  }
  return paramToken.trim();
}

/** Parse a Dart source file's barrel `export` directives and public symbols (enums, typedefs, classes/mixins, functions). */
export function parseDartSource(rawSource: string): ParsedDartFile {
  const src = stripDartComments(stripBom(rawSource), false);
  const exports: ParsedDartFile['exports'] = [];
  const symbols: ParsedDartSymbol[] = [];

  // 1. Parse barrel export directives (supporting optional `show` and `hide` combinators)
  const exportRe = /^\s*export\s+['"]([^'"]+)['"]([^;]*);/gm;
  for (const m of src.matchAll(exportRe)) {
    const relUri = m[1]!.trim();
    const rest = (m[2] ?? '').trim();
    let show: Set<string> | undefined;
    let hide: Set<string> | undefined;
    const mShow = /\bshow\s+([a-zA-Z0-9_,\s]+)/.exec(rest);
    if (mShow) {
      show = new Set(mShow[1]!.split(',').map((x) => x.trim()).filter(Boolean));
    }
    const mHide = /\bhide\s+([a-zA-Z0-9_,\s]+)/.exec(rest);
    if (mHide) {
      hide = new Set(mHide[1]!.split(',').map((x) => x.trim()).filter(Boolean));
    }
    exports.push({ relUri, ...(show ? { show } : {}), ...(hide ? { hide } : {}) });
  }

  // Track spans of enum / class / mixin / extension bodies so top-level function scan skips them
  const blockSpans: Array<[number, number]> = [];
  const inBlock = (pos: number): boolean => blockSpans.some(([s, e]) => pos >= s && pos < e);

  // Record extension spans (excluded from top-level functions)
  const extRe = /^\s*extension(?:\s+type)?(?:\s+[A-Za-z_]\w*)?(?:<[^{]+?>)?\s+on\s+[^{]+\{/gm;
  for (const m of src.matchAll(extRe)) {
    const bOpen = src.indexOf('{', m.index! + m[0].length - 1);
    const bEnd = findMatchingDelimiter(src, bOpen, '{', '}');
    if (bEnd > bOpen) blockSpans.push([m.index!, bEnd + 1]);
  }

  // Collect ordered declarations with source offset so output preserves file declaration order
  const ordered: Array<{ offset: number; sym: ParsedDartSymbol }> = [];

  // 2. Public enums
  const enumRe = /^\s*enum\s+([A-Z]\w*)(?:<[^{]+?>)?(?:\s+(?:with|implements)\s+[^{]+?)?\s*\{/gm;
  for (const m of src.matchAll(enumRe)) {
    const ename = m[1]!;
    const bOpen = src.indexOf('{', m.index! + m[0].length - 1);
    const bEnd = findMatchingDelimiter(src, bOpen, '{', '}');
    if (bEnd < 0) continue;
    blockSpans.push([m.index!, bEnd + 1]);

    const body = src.slice(bOpen + 1, bEnd);
    const semiIdx = findTopLevelChar(body, ';');
    let headPart = semiIdx >= 0 ? body.slice(0, semiIdx) : body;
    // Strip enhanced-enum constructor args e.g. dev(requireLogin: false)
    while (headPart.includes('(')) {
      const p0 = headPart.indexOf('(');
      const p1 = findMatchingDelimiter(headPart, p0, '(', ')');
      if (p1 < 0) break;
      headPart = headPart.slice(0, p0) + headPart.slice(p1 + 1);
    }
    const vals = headPart
      .split(',')
      .map((t) => stripLeadingAnnotations(t).trim())
      .filter((t) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(t));

    const extras: string[] = [];
    if (semiIdx >= 0) {
      const restMembers = topLevelMembers(body.slice(semiIdx + 1));
      for (const rawM of restMembers) {
        const ms = stripLeadingAnnotations(rawM);
        const stField = /^static\s+(?:const|final|var)\s+(?:([\w<>?,\s]+?)\s+)?([a-zA-Z]\w*)\b/.exec(ms);
        if (stField && !stField[2]!.startsWith('_')) {
          extras.push(`static ${stField[2]!}`);
          continue;
        }
        const stGet = /^static\s+([\w<>?,\s]+?)\s+get\s+([a-zA-Z]\w*)\b/.exec(ms);
        if (stGet && !stGet[2]!.startsWith('_')) {
          extras.push(`static ${stGet[1]!.replace(/\s+/g, ' ').trim()} get ${stGet[2]!}`);
          continue;
        }
        const instGet = /^(?!static\b)([\w<>?,\s]+?)\s+get\s+([a-zA-Z]\w*)\b/.exec(ms);
        if (instGet && !instGet[2]!.startsWith('_')) {
          extras.push(`.${instGet[2]!}`);
        }
      }
    }
    const extraStr = extras.length > 0 ? ` (${extras.join(', ')})` : '';
    ordered.push({
      offset: m.index!,
      sym: { kind: 'enum', name: ename, line: `enum ${ename} {${vals.join(', ')}}${extraStr}`, namedParams: [] },
    });
  }

  // 3. Public typedefs
  const typedefRe = /^\s*typedef\s+([A-Z]\w*)(<[^=]+?>)?\s*=\s*([^;]+);/gm;
  for (const m of src.matchAll(typedefRe)) {
    const tname = m[1]!;
    const tparams = (m[2] ?? '').trim();
    const rhs = m[3]!.replace(/\s+/g, ' ').trim();
    ordered.push({
      offset: m.index!,
      sym: { kind: 'typedef', name: tname, line: `typedef ${tname}${tparams} = ${rhs}`, namedParams: [] },
    });
  }

  // 4. Public classes and mixins
  const clsRe =
    /^\s*((?:(?:abstract|sealed|base|interface|final|mixin)\s+)*)(class|mixin)\s+([A-Z]\w*)(<[^{]+?>)?(\s+(?:extends|on|with|implements)\s+[^{]+?)?\s*\{/gm;
  for (const m of src.matchAll(clsRe)) {
    if (inBlock(m.index!)) continue;
    const mods = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    const kw = m[2]! as 'class' | 'mixin';
    const cname = m[3]!;
    const tparams = (m[4] ?? '').replace(/\s+/g, ' ').trim();
    const heritage = (m[5] ?? '').replace(/\s+/g, ' ').trim();

    const bOpen = src.indexOf('{', m.index! + m[0].length - 1);
    const bEnd = findMatchingDelimiter(src, bOpen, '{', '}');
    if (bEnd < 0) continue;
    blockSpans.push([m.index!, bEnd + 1]);

    const cbody = src.slice(bOpen + 1, bEnd);
    const members = topLevelMembers(cbody);
    const ftypes = resolveClassFieldTypes(members);

    if (kw === 'mixin') {
      ordered.push({
        offset: m.index!,
        sym: { kind: 'mixin', name: cname, line: `mixin ${cname}${tparams}`, namedParams: [] },
      });
      continue;
    }

    let primaryCtor: string | null = null;
    const namedCtors: string[] = [];
    const allNamedParams: string[] = [];
    const statics: string[] = [];
    const publicInstanceMethods: string[] = [];

    for (const rawMem of members) {
      const hasOverride = /@override\b/.test(rawMem);
      const ms = stripLeadingAnnotations(rawMem);

      // Primary generative or factory constructor: [const|factory] ClassName(...)
      const mPrimary = new RegExp(`^(?:const\\s+|factory\\s+)?${cname}\\s*\\(`).exec(ms);
      if (mPrimary) {
        const pOpen = ms.indexOf('(');
        const pEnd = findMatchingDelimiter(ms, pOpen, '(', ')');
        if (pEnd > pOpen && /^\s*(?:[;:{]|=>)/.test(ms.slice(pEnd + 1))) {
          const { sig, namedParams } = compactDartParams(ms.slice(pOpen + 1, pEnd), ftypes);
          if (!primaryCtor) {
            primaryCtor = `${cname}${tparams}(${sig})`;
            allNamedParams.push(...namedParams);
          }
          continue;
        }
      }

      // Public named / factory constructor: [const|factory] ClassName.foo(...)
      const mNamed = new RegExp(`^(?:const\\s+|factory\\s+)?${cname}\\.([a-zA-Z]\\w*)\\s*\\(`).exec(ms);
      if (mNamed) {
        const subName = mNamed[1]!;
        const pOpen = ms.indexOf('(');
        const pEnd = findMatchingDelimiter(ms, pOpen, '(', ')');
        if (pEnd > pOpen && /^\s*(?:[;:{]|=>)/.test(ms.slice(pEnd + 1))) {
          const { sig, namedParams } = compactDartParams(ms.slice(pOpen + 1, pEnd), ftypes);
          namedCtors.push(`${cname}.${subName}(${sig})`);
          allNamedParams.push(...namedParams);
          continue;
        }
      }

      // Public static members — always prefixed with `static` so callers never instantiate static utility classes
      if (ms.startsWith('static ')) {
        const afterStatic = ms.slice('static '.length).trim();

        // static method: [RetType] foo[<T>](...)
        const mStMethod = /^(?:([\w<>?,\s()]+?)\s+)?([a-zA-Z]\w*)(<[^(]+?>)?\s*\(/.exec(afterStatic);
        if (mStMethod && !/^(?:const|final|var|late|get|set)$/.test(mStMethod[2]!)) {
          const retT = (mStMethod[1] ?? 'void').replace(/\s+/g, ' ').trim();
          const fnName = mStMethod[2]!;
          const fnTp = (mStMethod[3] ?? '').trim();
          const pOpen = afterStatic.indexOf('(', mStMethod[0].length - 1);
          const pEnd = findMatchingDelimiter(afterStatic, pOpen, '(', ')');
          if (pEnd > pOpen) {
            const { sig } = compactDartParams(afterStatic.slice(pOpen + 1, pEnd), new Map());
            statics.push(`static ${retT} ${fnName}${fnTp}(${sig})`);
            continue;
          }
        }

        // static getter: [Type] get foo
        const mStGetter = /^(?:([\w<>?,\s]+?)\s+)?get\s+([a-zA-Z]\w*)\b/.exec(afterStatic);
        if (mStGetter) {
          const gType = (mStGetter[1] ?? '').replace(/\s+/g, ' ').trim();
          statics.push(`static ${gType ? gType + ' ' : ''}get ${mStGetter[2]!}`);
          continue;
        }

        // static const / final / var field
        const mStField = /^(?:late\s+)?(?:const|final|var)\s+(?:[\w<>?,\s()]+?\s+)?([a-zA-Z]\w*)\s*(?:=|;)/.exec(afterStatic);
        if (mStField) {
          statics.push(`static ${mStField[1]!}`);
          continue;
        }
      }

      // Public non-override instance methods (useful for ThemeExtension helper methods)
      if (!hasOverride && !ms.startsWith('static ') && !ms.startsWith('final ') && !ms.startsWith('var ') && !ms.startsWith('late ')) {
        const mInstMethod = /^([\w<>?,\s]+?)\s+([a-z][a-zA-Z0-9_]*)(<[^(]+?>)?\s*\(/.exec(ms);
        if (mInstMethod && !['copyWith', 'lerp', 'build', 'createState', 'debugFillProperties'].includes(mInstMethod[2]!)) {
          const pOpen = ms.indexOf('(', mInstMethod[0].length - 1);
          const pEnd = findMatchingDelimiter(ms, pOpen, '(', ')');
          if (pEnd > pOpen) {
            const { sig } = compactDartParams(ms.slice(pOpen + 1, pEnd), new Map());
            publicInstanceMethods.push(`${mInstMethod[1]!.replace(/\s+/g, ' ').trim()} ${mInstMethod[2]!}(${sig})`);
          }
        }
      }
    }

    // Standard Flutter ThemeExtension<T> compact representation: `Tokens.of(context) -> field1, field2; helper(...)`
    const isThemeExtension = /\bextends\s+ThemeExtension\s*</.test(heritage);
    const hasStaticOf = statics.some((s) => /\bof\s*\(/.test(s));
    let lineTxt: string;

    if (isThemeExtension && hasStaticOf && ftypes.size > 0) {
      const publicFields = [...ftypes.keys()].filter((k) => !k.startsWith('_'));
      const methodSuffix = publicInstanceMethods.length > 0 ? `; ${publicInstanceMethods.join('; ')}` : '';
      lineTxt = `${cname}.of(context) -> ${publicFields.join(', ')}${methodSuffix}`;
    } else if (primaryCtor || namedCtors.length > 0) {
      const ctors = [primaryCtor, ...namedCtors].filter((x): x is string => Boolean(x));
      const stSuffix = statics.length > 0 ? `; ${statics.slice(0, 8).join(', ')}` : '';
      lineTxt = `${ctors.join('; ')}${stSuffix}`;
    } else if (statics.length > 0) {
      const clsPrefix = mods ? `${mods} class` : 'class';
      lineTxt = `${clsPrefix} ${cname}${tparams} { ${statics.slice(0, 20).join(', ')} }`;
    } else {
      const clsPrefix = mods ? `${mods} class` : 'class';
      lineTxt = `${clsPrefix} ${cname}${tparams}`;
    }

    ordered.push({
      offset: m.index!,
      sym: { kind: 'class', name: cname, line: lineTxt, namedParams: allNamedParams },
    });
  }

  // 5. Public top-level functions (outside any class/enum/mixin/extension span)
  const fnRe = /^([A-Za-z_][\w<>?,\s()]*?)\s+([a-z][a-zA-Z0-9_]*)(<[^(]+?>)?\s*\(/gm;
  for (const m of src.matchAll(fnRe)) {
    if (inBlock(m.index!)) continue;
    const retType = m[1]!.replace(/\s+/g, ' ').trim();
    const fname = m[2]!;
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'import', 'export', 'part'].includes(fname)) continue;
    if (/^(?:import|export|part|typedef|class|enum|mixin|extension)\b/.test(retType)) continue;
    const tparams = (m[3] ?? '').trim();
    const pOpen = src.indexOf('(', m.index! + m[0].length - 1);
    const pEnd = findMatchingDelimiter(src, pOpen, '(', ')');
    if (pEnd < 0) continue;
    if (!/^\s*(?:async\s*\*?\s*|sync\s*\*\s*)?(?:\{|=>|;)/.test(src.slice(pEnd + 1))) continue;
    const { sig, namedParams } = compactDartParams(src.slice(pOpen + 1, pEnd), new Map());
    ordered.push({
      offset: m.index!,
      sym: { kind: 'function', name: fname, line: `${retType} ${fname}${tparams}(${sig})`, namedParams },
    });
  }

  ordered.sort((a, b) => a.offset - b.offset);
  for (const item of ordered) symbols.push(item.sym);
  return { symbols, exports };
}

function findTopLevelChar(text: string, target: string): number {
  let dParen = 0;
  let dBrace = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((c === 'r' && (text[i + 1] === '\'' || text[i + 1] === '"')) || c === '\'' || c === '"') {
      i = skipDartString(text, i);
      continue;
    }
    if (c === '(') dParen++;
    else if (c === ')') dParen = Math.max(0, dParen - 1);
    else if (c === '{') dBrace++;
    else if (c === '}') dBrace = Math.max(0, dBrace - 1);
    else if (c === target && dParen === 0 && dBrace === 0) return i;
    i++;
  }
  return -1;
}

/** Extract top numbered `// 1. ...` header rule comments from a rule check file. */
export function extractRuleFileHeader(filePath: string): string[] {
  const lines = stripBom(fs.readFileSync(filePath, 'utf8')).split(/\r?\n/);
  const rules: string[] = [];
  for (const line of lines.slice(0, 25)) {
    const s = line.trim();
    if (/^\/\/\s*\d+[.、)]/.test(s)) {
      rules.push('- ' + s.replace(/^\/\/\s*/, '').trim());
    }
  }
  return rules;
}

/** Try to infer `package:<name>/<rel>` for a Dart file by locating `pubspec.yaml` above a `lib/` directory. */
function inferDartPackageUri(
  absFile: string,
  projectRoot: string,
  cfg: SheetConfig
): string | undefined {
  if (cfg.packageName && cfg.packageRoot) {
    const libAbs = path.resolve(projectRoot, cfg.packageRoot);
    const rel = toPosixPath(path.relative(libAbs, absFile));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `package:${cfg.packageName}/${rel}`;
    }
  }
  let dir = path.dirname(absFile);
  for (let depth = 0; depth < 10; depth++) {
    if (path.basename(dir) === 'lib') {
      const pkgDir = path.dirname(dir);
      const pubspec = path.join(pkgDir, 'pubspec.yaml');
      if (fs.existsSync(pubspec)) {
        const m = /^\s*name\s*:\s*([a-zA-Z0-9_]+)\s*$/m.exec(fs.readFileSync(pubspec, 'utf8'));
        const pkgName = cfg.packageName ?? m?.[1];
        if (pkgName) {
          const rel = toPosixPath(path.relative(dir, absFile));
          return `package:${pkgName}/${rel}`;
        }
      }
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Validate and normalize a raw JSON object into a `SheetConfig`. Throws descriptive errors on bad input. */
export function parseSheetConfig(raw: string, label: string): SheetConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: config root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.language !== 'dart') {
    throw new Error(`Invalid ${label}: unsupported language "${String(obj.language ?? '')}" (currently only "dart" is supported).`);
  }
  if (!Array.isArray(obj.entries) || obj.entries.length === 0) {
    throw new Error(`Invalid ${label}: "entries" must be a non-empty array of Dart file or directory paths.`);
  }

  const entries: SheetEntry[] = obj.entries.map((item, idx) => {
    if (typeof item === 'string') {
      if (!item.trim()) throw new Error(`Invalid ${label}: entries[${idx}] must be a non-empty path.`);
      return toPosixPath(item.trim());
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid ${label}: entries[${idx}] must be a path string or entry object.`);
    }
    const eo = item as Record<string, unknown>;
    if (typeof eo.path !== 'string' || !eo.path.trim()) {
      throw new Error(`Invalid ${label}: entries[${idx}].path must be a non-empty string.`);
    }
    return {
      path: toPosixPath(eo.path.trim()),
      ...(typeof eo.title === 'string' && eo.title.trim() ? { title: eo.title.trim() } : {}),
      ...(typeof eo.importUri === 'string' && eo.importUri.trim() ? { importUri: eo.importUri.trim() } : {}),
      ...(typeof eo.inlineImport === 'boolean' ? { inlineImport: eo.inlineImport } : {}),
      ...(Array.isArray(eo.exportPrefixes)
        ? { exportPrefixes: eo.exportPrefixes.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map(toPosixPath) }
        : {}),
      ...(Array.isArray(eo.discoverUnexportedDirs)
        ? { discoverUnexportedDirs: eo.discoverUnexportedDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(toPosixPath) }
        : {}),
    };
  });

  return {
    language: 'dart',
    ...(typeof obj.output === 'string' && obj.output.trim() ? { output: toPosixPath(obj.output.trim()) } : {}),
    ...(typeof obj.title === 'string' && obj.title.trim() ? { title: obj.title.trim() } : {}),
    ...(typeof obj.packageRoot === 'string' && obj.packageRoot.trim() ? { packageRoot: toPosixPath(obj.packageRoot.trim()) } : {}),
    ...(typeof obj.packageName === 'string' && obj.packageName.trim() ? { packageName: obj.packageName.trim() } : {}),
    ...(Array.isArray(obj.ruleFiles)
      ? { ruleFiles: obj.ruleFiles.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map(toPosixPath) }
      : {}),
    ...(Array.isArray(obj.notes)
      ? { notes: obj.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()) }
      : {}),
    entries,
  };
}

/** Locate and read `SheetConfig` from explicit `--config`, `.bastion/sheet.json`, or `sheet` inside `.bastion/config.json`. */
export function loadSheetConfig(cwd: string, explicitConfigPath?: string): { projectRoot: string; config: SheetConfig } {
  if (explicitConfigPath) {
    const absCfg = path.resolve(cwd, explicitConfigPath);
    if (!fs.existsSync(absCfg)) {
      throw new Error(`Sheet config file not found: ${explicitConfigPath}`);
    }
    const cfg = parseSheetConfig(fs.readFileSync(absCfg, 'utf8'), explicitConfigPath);
    // Project root is repoRoot when inside git, or parent of `.bastion` if config is inside `.bastion/`, else cwd.
    const cfgDir = path.dirname(absCfg);
    const projectRoot =
      path.basename(cfgDir) === BASTION_DIR
        ? path.dirname(cfgDir)
        : (getRepoRoot(cwd) ?? cwd);
    return { projectRoot, config: cfg };
  }

  const projectRoot = getRepoRoot(cwd) ?? cwd;
  const sheetPath = path.join(projectRoot, SHEET_CONFIG_REL_PATH);
  if (fs.existsSync(sheetPath)) {
    return {
      projectRoot,
      config: parseSheetConfig(fs.readFileSync(sheetPath, 'utf8'), SHEET_CONFIG_REL_PATH),
    };
  }

  const mainCfgPath = path.join(projectRoot, CONFIG_REL_PATH);
  if (fs.existsSync(mainCfgPath)) {
    let mainParsed: Record<string, unknown>;
    try {
      mainParsed = JSON.parse(stripBom(fs.readFileSync(mainCfgPath, 'utf8'))) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Invalid JSON in ${CONFIG_REL_PATH}: ${(err as Error).message}`);
    }
    if (mainParsed && typeof mainParsed === 'object' && mainParsed.sheet !== undefined) {
      return {
        projectRoot,
        config: parseSheetConfig(JSON.stringify(mainParsed.sheet), `${CONFIG_REL_PATH}#sheet`),
      };
    }
  }

  throw new Error(`Missing ${SHEET_CONFIG_REL_PATH}. Create ${SHEET_CONFIG_REL_PATH} (or pass --config <path>) to configure "bastion sheet".`);
}

function collectDartFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_') || ent.name === 'build') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectDartFilesRecursive(full));
    else if (ent.isFile() && ent.name.endsWith('.dart')) out.push(full);
  }
  return out.sort();
}

function collectExportedSymbolsFromBarrel(
  barrelAbs: string,
  prefixes: string[] | undefined,
  visited: Set<string>,
  exportedFileSet: Set<string>
): ParsedDartSymbol[] {
  const real = fs.realpathSync(barrelAbs);
  if (visited.has(real)) return [];
  visited.add(real);

  const parsed = parseDartSource(fs.readFileSync(barrelAbs, 'utf8'));
  const result: ParsedDartSymbol[] = [...parsed.symbols];
  const baseDir = path.dirname(barrelAbs);

  for (const exp of parsed.exports) {
    if (exp.relUri.startsWith('dart:') || exp.relUri.startsWith('package:')) continue;
    if (prefixes && prefixes.length > 0 && !prefixes.some((p) => exp.relUri.startsWith(p))) continue;

    const targetAbs = path.resolve(baseDir, exp.relUri);
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
      throw new Error(`Exported file "${exp.relUri}" referenced in ${toPosixPath(barrelAbs)} does not exist.`);
    }
    exportedFileSet.add(path.normalize(targetAbs));

    let childSymbols = collectExportedSymbolsFromBarrel(targetAbs, undefined, visited, exportedFileSet);
    if (exp.show) childSymbols = childSymbols.filter((s) => exp.show!.has(s.name));
    if (exp.hide) childSymbols = childSymbols.filter((s) => !exp.hide!.has(s.name));
    result.push(...childSymbols);
  }
  return result;
}

/** Build the complete cheatsheet markdown from `config` rooted at `projectRoot` (pure, deterministic, no disk writes). */
export function buildCheatsheet(projectRoot: string, config: SheetConfig, outputOverride?: string): SheetBuildResult {
  const outRel = outputOverride ?? config.output ?? DEFAULT_SHEET_OUTPUT;
  const outputPath = path.resolve(projectRoot, outRel);

  const lines: string[] = [];
  lines.push(`# ${config.title ?? 'Public API & Rules Cheatsheet (generated by bastion sheet)'}`);

  // Optional Section: Rule headers + layering notes
  const ruleLines: string[] = [];
  for (const rf of config.ruleFiles ?? []) {
    const absRf = path.resolve(projectRoot, rf);
    if (!fs.existsSync(absRf)) {
      throw new Error(`Configured ruleFile does not exist: ${rf}`);
    }
    ruleLines.push(...extractRuleFileHeader(absRf));
  }
  for (const note of config.notes ?? []) {
    ruleLines.push(note.startsWith('- ') ? note : `- ${note}`);
  }
  if (ruleLines.length > 0) {
    lines.push('');
    lines.push('## Project Hard Rules');
    lines.push(...ruleLines);
  }

  let symbolCount = 0;

  // Group standalone inline-import entries together cleanly when consecutive, or render each entry section
  const pendingInlineLines: Array<{ sectionTitle?: string; line: string }> = [];
  const flushInline = (heading?: string): void => {
    if (pendingInlineLines.length === 0) return;
    lines.push('');
    lines.push(`## ${heading ?? pendingInlineLines[0]!.sectionTitle ?? 'Standalone Entrypoints'}`);
    for (const item of pendingInlineLines) lines.push(item.line);
    pendingInlineLines.length = 0;
  };

  for (const rawEntry of config.entries) {
    const entry: SheetEntryObject = typeof rawEntry === 'string' ? { path: rawEntry } : rawEntry;
    const absTarget = path.resolve(projectRoot, entry.path);
    if (!fs.existsSync(absTarget)) {
      throw new Error(`Configured entry path does not exist: ${entry.path}`);
    }

    const stat = fs.statSync(absTarget);
    if (stat.isDirectory()) {
      flushInline();
      const dartFiles = collectDartFilesRecursive(absTarget);
      lines.push('');
      lines.push(`## ${entry.title ?? `Directory \`${entry.path}\``}`);
      for (const df of dartFiles) {
        const pkgUri = inferDartPackageUri(df, projectRoot, config) ?? toPosixPath(path.relative(projectRoot, df));
        const parsed = parseDartSource(fs.readFileSync(df, 'utf8'));
        for (const sym of parsed.symbols) {
          symbolCount++;
          lines.push(`- [\`${pkgUri}\`] \`${sym.line}\``);
        }
      }
      continue;
    }

    // Single `.dart` file: determine if it acts as a barrel (`export '...'` present) or standalone file
    const parsedTop = parseDartSource(fs.readFileSync(absTarget, 'utf8'));
    const isBarrel = parsedTop.exports.length > 0;
    const pkgUri = entry.importUri ?? inferDartPackageUri(absTarget, projectRoot, config) ?? entry.path;

    if (!isBarrel && (entry.inlineImport ?? true) && !entry.title) {
      for (const sym of parsedTop.symbols) {
        symbolCount++;
        pendingInlineLines.push({ line: `- [\`${pkgUri}\`] \`${sym.line}\`` });
      }
      continue;
    }

    if (!isBarrel && entry.inlineImport) {
      for (const sym of parsedTop.symbols) {
        symbolCount++;
        pendingInlineLines.push({ sectionTitle: entry.title, line: `- [\`${pkgUri}\`] \`${sym.line}\`` });
      }
      continue;
    }

    const exportedFileSet = new Set<string>([path.normalize(absTarget)]);
    const barrelSymbols = isBarrel
      ? collectExportedSymbolsFromBarrel(absTarget, entry.exportPrefixes, new Set<string>(), exportedFileSet)
      : parsedTop.symbols;

    // Discover unexported sibling files BEFORE flushing inline entries if desired, or right alongside
    if (isBarrel && entry.discoverUnexportedDirs && entry.discoverUnexportedDirs.length > 0) {
      const barrelDir = path.dirname(absTarget);
      const barrelName = path.basename(absTarget);
      for (const subRel of entry.discoverUnexportedDirs) {
        const subDir = path.resolve(barrelDir, subRel);
        if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) continue;
        const candidates = fs
          .readdirSync(subDir)
          .filter((f) => f.endsWith('.dart') && !f.startsWith('_'))
          .sort();
        for (const fname of candidates) {
          const fullCand = path.normalize(path.join(subDir, fname));
          if (exportedFileSet.has(fullCand)) continue;
          const candUri = inferDartPackageUri(fullCand, projectRoot, config) ?? toPosixPath(path.relative(projectRoot, fullCand));
          const candParsed = parseDartSource(fs.readFileSync(fullCand, 'utf8'));
          for (const sym of candParsed.symbols) {
            symbolCount++;
            pendingInlineLines.push({
              line: `- [\`${candUri}\` (not re-exported by ${barrelName}; import directly)] \`${sym.line}\``,
            });
          }
        }
      }
    }

    flushInline();
    lines.push('');
    const heading = entry.title ?? `Public API (\`import '${pkgUri}';\`)`;
    lines.push(`## ${heading}`);
    for (const sym of barrelSymbols) {
      symbolCount++;
      lines.push(`- \`${sym.line}\``);
    }
  }

  flushInline();
  const markdown = lines.join('\n') + '\n';
  return {
    markdown,
    outputPath,
    symbolCount,
    lineCount: lines.length,
    charCount: markdown.length,
  };
}

/** Check whether an existing cheatsheet file on disk matches `markdown` (CRLF-independent). */
export function isSheetUpToDate(outputPath: string, markdown: string): boolean {
  if (!fs.existsSync(outputPath)) return false;
  const diskHash = contentHash(fs.readFileSync(outputPath));
  const memHash = contentHash(Buffer.from(markdown, 'utf8'));
  return diskHash === memHash;
}
