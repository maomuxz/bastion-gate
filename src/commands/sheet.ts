import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosixPath } from '../git.js';
import { buildCheatsheet, isSheetUpToDate, loadSheetConfig } from '../sheet.js';

export interface SheetCommandOptions {
  cwd: string;
  configPath?: string;
  outputPath?: string;
  checkOnly?: boolean;
}

export function runSheet(opts: SheetCommandOptions): number {
  const { projectRoot, config } = loadSheetConfig(opts.cwd, opts.configPath);
  const built = buildCheatsheet(projectRoot, config, opts.outputPath);
  const relOut = toPosixPath(path.relative(projectRoot, built.outputPath)) || path.basename(built.outputPath);

  if (opts.checkOnly) {
    if (!isSheetUpToDate(built.outputPath, built.markdown)) {
      console.error(`[bastion] sheet: ${relOut} is missing or out of date with source files. Run "bastion sheet" to regenerate.`);
      return 1;
    }
    console.log(`[bastion] sheet: ${relOut} is up to date (${built.symbolCount} symbol(s), ${built.lineCount} lines).`);
    return 0;
  }

  fs.mkdirSync(path.dirname(built.outputPath), { recursive: true });
  fs.writeFileSync(built.outputPath, built.markdown, 'utf8');
  console.log(`[bastion] sheet: wrote ${relOut} (${built.symbolCount} symbol(s), ${built.lineCount} lines, ${built.charCount} chars).`);
  return 0;
}
