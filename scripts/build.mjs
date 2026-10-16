// Package the app for the current OS: `pnpm package [--debug]`. Output goes to src-tauri/target/release/bundle/.
// macOS -> .app + .dmg, Windows -> .msi + .exe (NSIS), Linux -> .deb + .AppImage.
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const bundles = { darwin: 'app,dmg', win32: 'msi,nsis', linux: 'deb,appimage' }[os.platform()];
if (!bundles) { console.error(`Unsupported platform: ${os.platform()}`); process.exit(1); }

const env = { ...process.env, PATH: `${os.homedir()}/.cargo/bin${os.platform() === 'win32' ? ';' : ':'}${process.env.PATH}` };
const args = ['tauri', 'build', '--bundles', bundles, ...process.argv.slice(2)];
console.log(`> pnpm ${args.join(' ')}`);
const r = spawnSync('pnpm', args, { stdio: 'inherit', env, shell: os.platform() === 'win32' });
if (r.status === 0) console.log('\nDone. Installers are in src-tauri/target/release/bundle/');
process.exit(r.status ?? 1);
