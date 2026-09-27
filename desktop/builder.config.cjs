// electron-builder configuration for the NILCODE AI desktop apps.
// Loaded via scripts/build-desktop.mjs. Produces:
//   Windows: NSIS installer (NILCODE-AI-Setup-<version>.exe)
//   macOS:   dmg per architecture (NILCODE-AI-<version>-<arch>.dmg)
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// electron-builder needs the exact installed Electron version, not a range.
let electronVersion = '44.4.5';
try {
  electronVersion = JSON.parse(
    readFileSync(join(__dirname, '..', 'node_modules', 'electron', 'package.json'), 'utf8')
  ).version;
} catch { /* fall back to the pinned default */ }

module.exports = {
  electronVersion,
  appId: 'online.xeer0.nilcode-ai',
  productName: 'NILCODE AI',
  directories: { output: 'dist-desktop', buildResources: 'build' },
  files: ['main.cjs', 'package.json'],
  extraResources: [
    { from: 'server-bundle.cjs', to: 'app-server/server-bundle.cjs' },
  ],
  // The server resolves public/ next to the executable (same rule as the
  // standalone SEA build), so public goes exe-adjacent on both platforms.
  extraFiles: [
    { from: 'app-server/public', to: 'public' },
  ],
  win: {
    icon: 'build/appicon.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
    signExecutable: false, // unsigned local/CI builds; no fake certs. Icon + metadata still applied.
  },
  nsis: {
    // Version-less artifact name so the GitHub release "latest" download URL
    // (…/releases/latest/download/<name>) stays stable across releases.
    artifactName: 'NILCODE-AI-Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'NILCODE AI',
    uninstallDisplayName: 'NILCODE AI',
  },
  mac: {
    icon: 'build/appicon.png',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    // Per-arch, version-less DMG names (same stable-latest-URL rationale).
    artifactName: 'NILCODE-AI-${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    identity: null, // no Apple credentials exist; unsigned builds on purpose
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    darkModeSupport: true,
  },
  dmg: { writeUpdateInfo: false },
};
