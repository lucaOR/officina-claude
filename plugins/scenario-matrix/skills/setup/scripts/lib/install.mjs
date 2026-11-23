import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { LIB_DIR } from './plan.mjs';

// The default command runner: the child shares this process's terminal. Tests pass a fake with the
// same signature, (command, args, { cwd }) -> { status }.
export const defaultRun = (command, args, { cwd }) => spawnSync(command, args, { cwd, stdio: 'inherit' });

// Runs `npm install` in the lib, then each post-install command, and prints the system packages for
// the user to install. It never installs a system package and never runs sudo.
export function install(repo, { postInstall = [], systemPackages = {} }, { run = defaultRun, out = console.log } = {}) {
  const libDir = join(repo, LIB_DIR);
  const step = (command, args, label) => {
    if ([command, ...args].includes('sudo')) throw new Error(`refusing to run sudo: ${label}`);
    const r = run(command, args, { cwd: libDir });
    if (r.status !== 0) throw new Error(`${label} failed with exit ${r.status}`);
  };
  step('npm', ['install'], 'npm install');
  for (const cmd of postInstall) {
    const [command, ...args] = cmd.trim().split(/\s+/);
    step(command, args, cmd);
  }
  for (const [distro, pkgs] of Object.entries(systemPackages)) {
    if (pkgs.length) out(`system packages for ${distro}, install them yourself: ${pkgs.join(' ')}`);
  }
}
