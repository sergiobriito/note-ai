// Builds NoteAI.exe and installs it for the current user:
//   %LOCALAPPDATA%\Programs\NoteAI\NoteAI.exe  + Start menu and Desktop shortcuts.
// Run with:  npm run install-app
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(process.env.LOCALAPPDATA, 'Programs', 'NoteAI');

function noteAiRunning() {
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq NoteAI.exe', '/NH'], { encoding: 'utf8' }).stdout || '';
  return /NoteAI\.exe/i.test(out);
}

async function main() {
  const mod = await import('@electron/packager');
  const packager = mod.packager || mod.default;
  const [built] = await packager({
    dir: ROOT,
    name: 'NoteAI',
    executableName: 'NoteAI',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    ignore: [/^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/\.claude($|\/)/, /^\/README\.md$/, /^\/assets\/icon-preview\.png$/],
    win32metadata: {
      CompanyName: 'NoteAI',
      FileDescription: 'NoteAI',
      ProductName: 'NoteAI',
      InternalName: 'NoteAI',
      OriginalFilename: 'NoteAI.exe',
    },
  });
  console.log(`Built ${built}`);

  if (noteAiRunning()) {
    // A normal close lets NoteAI save its open tabs first.
    spawnSync('taskkill', ['/IM', 'NoteAI.exe'], { stdio: 'ignore' });
    for (let i = 0; i < 20 && noteAiRunning(); i++) execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250']);
    if (noteAiRunning()) throw new Error('NoteAI is still open. Close it and run the install again.');
  }

  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.cpSync(built, TARGET, { recursive: true });
  const exe = path.join(TARGET, 'NoteAI.exe');
  spawnSync(exe, ['--install-shortcuts'], { stdio: 'ignore' });
  console.log(`Installed ${exe}`);
  console.log('Shortcuts: Start menu and Desktop ("NoteAI").');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
