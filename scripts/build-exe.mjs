// NILCODE AI Windows executable build pipeline (Node SEA — no Electron).
// 1. Bundle server ESM into one CJS file (esbuild, server deps external to node).
// 2. Generate the SEA config + blob with `node --experimental-sea-config`.
// 3. Copy the node.exe binary and inject the blob with postject.
// 4. Assemble dist/NILCODE/ with public/, .env.example, README.
// Usage: npm run build:exe
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const DIST = join(ROOT, 'dist', 'NILCODE');
const NODE_EXE = process.execPath;

function step(name) { console.log(`\n== ${name}`); }
function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

step('clean');
rmSync(BUILD, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

step('bundle server with esbuild');
run(process.execPath, [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'server', 'index.js'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  '--outfile=' + join(BUILD, 'nilcode-ai.cjs'),
  '--external:playwright-core',
  '--log-level=warning',
]);

step('sea config + blob');
writeFileSync(
  join(BUILD, 'sea-config.json'),
  JSON.stringify({ main: join(BUILD, 'nilcode-ai.cjs'), output: join(BUILD, 'sea-prep.blob'), disableExperimentalSEAWarning: true }, null, 2)
);
run(process.execPath, ['--experimental-sea-config', join(BUILD, 'sea-config.json')]);

step('copy node binary + inject blob');
const exeName = process.platform === 'win32' ? 'NILCODE.exe' : 'nilcode-ai';
const exePath = join(BUILD, exeName);
copyFileSync(NODE_EXE, exePath);
if (process.platform !== 'win32') chmodSync(exePath, 0o755);
const blob = readFileSync(join(BUILD, 'sea-prep.blob'));
run(process.execPath, [
  join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  exePath,
  'NODE_SEA_BLOB',
  join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--mach-o-segment-name', 'NODE_SEA'] : []),
]);

step('assemble dist');
copyFileSync(exePath, join(DIST, exeName));
mkdirSync(join(DIST, 'public'), { recursive: true });
for (const entry of ['index.html', 'styles.css', 'app.js', 'auth.js']) {
  copyFileSync(join(ROOT, 'public', entry), join(DIST, 'public', entry));
}
mkdirSync(join(DIST, 'public', 'brand'), { recursive: true });
for (const f of ['logo-light.svg', 'logo-dark.svg', 'icon-light.svg', 'icon-dark.svg', 'favicon.svg']) {
  copyFileSync(join(ROOT, 'public', 'brand', f), join(DIST, 'public', 'brand', f));
}
writeFileSync(
  join(DIST, '.env.example'),
  [
    '# NILCODE AI configuration (rename to .env next to NILCODE.exe)',
    '# All values are optional — NILCODE AI runs without them.',
    '# (Environment variable names keep the historical NULLCODE_ prefix.)',
    '',
    '# Server',
    'PORT=4310',
    'HOST=127.0.0.1',
    '',
    '# Platform AI (default model for all users, no per-user setup needed)',
    '# NULLCODE_AI_TYPE=openai-compatible',
    '# NULLCODE_AI_BASE_URL=https://api.groq.com/openai/v1',
    '# NULLCODE_AI_API_KEY=your-key-here',
    '# NULLCODE_AI_MODEL=llama-3.3-70b-versatile',
    '',
    '# Built-in providers (server-side only; used when NULLCODE_AI_* is not set)',
    '# OPENROUTER_API_KEY=sk-or-...',
    '# GEMINI_API_KEY=...',
    '# GEMINI_MODEL=gemini-flash-latest',
    '# GROQ_API_KEY=gsk_...',
    '# GROQ_MODEL=openai/gpt-oss-120b',
    '',
    '# Google sign-in (from Google Cloud Console, see README-GOOGLE.md)',
    '# NULLCODE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com',
    '',
    '# Local Ollama detection (free fallback when installed)',
    '# NULLCODE_ALLOW_OLLAMA=1',
  ].join('\n')
);
writeFileSync(
  join(DIST, 'README.txt'),
  [
    'NILCODE AI — standalone Windows build',
    '=====================================',
    '',
    '1. Keep NILCODE.exe in the same folder as the public/ folder.',
    '2. (Optional) Create a .env file for AI/Google configuration (see .env.example).',
    '3. Double-click NILCODE.exe, then open http://localhost:4310',
    '',
    'All user data (accounts, projects, attachments) is stored in the',
    '.nullcode-data folder next to the executable. Delete it to reset the app.',
    '',
    'To run on a different port: set PORT in .env, e.g. PORT=8080.',
  ].join('\n')
);

console.log(`\nDone. Output: ${DIST}\\${exeName}`);
