import { spawnSync } from 'node:child_process';
import acpxPackage from 'acpx/package.json' with { type: 'json' };

/** Version-only subprocess; injected in unit tests so no Copilot installation is needed. */
export function detectRuntimeVersions({ run = spawnSync } = {}) {
  const result = run('copilot', ['--version'], {
    encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 4096,
    env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' }
  });
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const known = !result.error && result.status === 0 && output.length > 0;
  return {
    copilot: {
      source: 'copilot --version', version: known ? output : null,
      ...(!known ? { error: result.error?.code || (result.status === 0 ? 'Empty version output' : `Version probe exited ${result.status}`) } : {})
    },
    acpx: acpxPackage.version
  };
}
