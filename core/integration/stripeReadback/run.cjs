// Node launcher owns the temporary profile until the entire Electron process exits.
// Usage: STRIPE_TEST_OUTPUT=/private/result.json node run.cjs /absolute/path/to/electron
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) throw Error('Supply an absolute Electron executable path');
if (!process.env.STRIPE_TEST_OUTPUT || !path.isAbsolute(process.env.STRIPE_TEST_OUTPUT)) throw Error('Supply an absolute private STRIPE_TEST_OUTPUT path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-readback-parity-'));
try {
  const env = { ...process.env, STRIPE_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [path.join(__dirname, 'main.cjs')], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
