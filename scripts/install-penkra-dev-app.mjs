import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targetApp = '/Applications/Penkra Dev.app';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');
const nodeExecutable = process.execPath;
const npmCli = process.env.npm_execpath;

if (process.platform !== 'darwin') {
  throw new Error('The Penkra Dev Applications launcher is available only on macOS.');
}

if (!npmCli || !existsSync(npmCli)) {
  throw new Error('Run this installer with `npm run dev:install-app`.');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const backupApp = `/Applications/.Penkra Dev.console-backup-${timestamp}.app`;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'penkra-dev-app-'));
const stagedApp = join(temporaryRoot, 'Penkra Dev.app');
const contents = join(stagedApp, 'Contents');
const macOS = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
const executable = join(macOS, 'Penkra Dev');
let movedExistingApp = false;

try {
  mkdirSync(macOS, { recursive: true });
  mkdirSync(resources, { recursive: true });

  const existingIcon = join(targetApp, 'Contents', 'Resources', 'PenkraDev.icns');
  const hasIcon = existsSync(existingIcon);
  if (hasIcon) copyFileSync(existingIcon, join(resources, 'PenkraDev.icns'));

  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Penkra Dev</string>
  <key>CFBundleExecutable</key><string>Penkra Dev</string>
  <key>CFBundleIdentifier</key><string>com.penkra.app.dev.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Penkra Dev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.1</string>
  <key>CFBundleVersion</key><string>3</string>
  ${hasIcon ? '<key>CFBundleIconFile</key><string>PenkraDev.icns</string>' : ''}
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
  );

  writeFileSync(
    executable,
    `#!/bin/zsh
cd ${shellQuote(repoRoot)} || exit 1
export npm_execpath=${shellQuote(npmCli)}
${shellQuote(nodeExecutable)} ${shellQuote(join(repoRoot, 'scripts', 'dev-launcher.mjs'))} launch
exit $?
`,
  );
  chmodSync(executable, 0o755);

  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp], {
    stdio: 'pipe',
  });

  if (existsSync(targetApp)) {
    renameSync(targetApp, backupApp);
    movedExistingApp = true;
  }

  renameSync(stagedApp, targetApp);
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', targetApp],
    { stdio: 'pipe' },
  );

  process.stdout.write(
    `Installed Penkra Dev launcher at ${targetApp}\nRepository: ${repoRoot}\n` +
      (movedExistingApp ? `Previous launcher backup: ${backupApp}\n` : ''),
  );
} catch (error) {
  if (!existsSync(targetApp) && movedExistingApp && existsSync(backupApp)) {
    cpSync(backupApp, targetApp, { recursive: true });
  }
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
