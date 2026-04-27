import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const gitSha = process.env.GIT_SHA || run('git rev-parse HEAD') || 'unknown';
const gitShortSha = process.env.GIT_SHORT_SHA || run('git rev-parse --short HEAD') || gitSha.slice(0, 7);
const gitBranch = process.env.GIT_BRANCH || run('git rev-parse --abbrev-ref HEAD') || 'unknown';
const builtAt = process.env.BUILD_TIME || new Date().toISOString();

const outDir = path.join(root, 'src', 'generated');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'build-info.ts'),
  `export const buildInfo = ${JSON.stringify({
    service: 'receipt-assistant',
    version: pkg.version,
    gitSha,
    gitShortSha,
    gitBranch,
    builtAt,
  }, null, 2)} as const;\n`,
);
