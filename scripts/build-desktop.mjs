// NILCODE AI desktop build pipeline.
//
// Produces a real desktop application around the EXISTING NILCODE server:
//   1. esbuild bundles server/index.js into desktop/server-bundle.cjs
//      (server deps inlined; playwright-core stays a guarded dynamic import).
//   2. electron-builder packages desktop/ into:
//        Windows: dist-desktop/NILCODE-AI-Setup-<version>.exe (NSIS installer)
//        macOS:   dist-desktop/NILCODE-AI-<version>-<arch>.dmg (+ .app inside)
//
// No API keys are embedded: the packaged server resolves providers from the
// user's per-install .env (%APPDATA%/nilcode-ai-desktop/.env on Windows,
// ~/Library/Application Support/nilcode-ai-desktop/.env on macOS) or its own
// server-side configuration.
//
// Usage:
//   node scripts/build-desktop.mjs            # build for the current platform
//   node scripts/build-desktop.mjs --mac      # (macOS host) build dmg for arm64+x64
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'desktop');
const OUT = join(DESKTOP, 'dist-desktop');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

console.log('== bundle server ==');
run(process.execPath, [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'server', 'index.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${join(DESKTOP, 'server-bundle.cjs')}`,
  '--external:playwright-core',
  '--log-level=warning',
]);

console.log('== assemble desktop resources ==');
mkdirSync(join(DESKTOP, 'app-server', 'public'), { recursive: true });
for (const entry of ['index.html', 'styles.css', 'app.js', 'auth.js']) {
  copyFileSync(join(ROOT, 'public', entry), join(DESKTOP, 'app-server', 'public', entry));
}
mkdirSync(join(DESKTOP, 'app-server', 'public', 'brand'), { recursive: true });
for (const f of ['logo-light.svg', 'logo-dark.svg', 'icon-light.svg', 'icon-dark.svg', 'favicon.svg']) {
  copyFileSync(join(ROOT, 'public', 'brand', f), join(DESKTOP, 'app-server', 'public', 'brand', f));
}

// electron-builder expects the runtime resources in build/ before packing.
// We keep sources clean and let "extraResources" copy app-server + bundle.
console.log('== electron-builder ==');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const args = ['--project', DESKTOP, '--config', 'builder.config.cjs'];
const mode = process.argv[2] || '';
if (mode === '--mac') {
  args.push('--mac', '--arm64', '--x64');
} else if (mode === '--win') {
  args.push('--win', '--x64');
} else {
  args.push(process.platform === 'darwin' ? '--mac' : '--win');
}
args.push('-c.directories.output=' + OUT.split('\\').join('/'));

// Run the CLI via node directly — spawning .cmd shims is blocked by modern Node.
run(process.execPath, [join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), ...args]);

console.log(`\nDone. Output: ${OUT}`);
