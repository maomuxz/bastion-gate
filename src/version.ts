import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Works both from src/ (dev/ts) and dist/ (compiled)
    const candidates = [
      path.resolve(__dirname, '../package.json'),
      path.resolve(__dirname, '../../package.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // fallback
  }
  return '1.0.0';
}

export const BASTION_VERSION = readPackageVersion();
