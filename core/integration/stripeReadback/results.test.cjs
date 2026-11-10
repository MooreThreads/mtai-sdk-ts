const test = require('node:test');
const assert = require('node:assert/strict');
const { performanceRunPassed } = require('./results.cjs');
function run(diagnostics) { return { backend: 'webgl', records: [{}], observed: 1, diagnostics }; }
test('accepts a completed WebGL-only run', () => {
  assert.equal(performanceRunPassed(run(['avatar_readback backend=webgl2'])), true);
});
test('rejects runtime fallback even when every sample was observed', () => {
  assert.equal(performanceRunPassed(run(['avatar_readback backend=webgl2',
    'avatar_readback backend=canvas2d reason=readback_unavailable'])), false);
});
test('rejects startup fallback for a WebGL-designated run', () => {
  assert.equal(performanceRunPassed(run(['avatar_readback backend=canvas2d'])), false);
});
test('retains Canvas reference success but rejects incomplete/failed observations', () => {
  const reference = { backend: 'canvas', records: [{}], observed: 1, diagnostics: [] };
  assert.equal(performanceRunPassed(reference), true);
  assert.equal(performanceRunPassed({ ...reference, observed: 0 }), false);
  assert.equal(performanceRunPassed({ ...reference, diagnostics: ['observation_failed'] }), false);
});
