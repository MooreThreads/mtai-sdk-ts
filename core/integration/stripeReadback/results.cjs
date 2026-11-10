// Public result contract for the isolated performance harness.
function performanceRunPassed(run) {
  if (run.observed !== run.records.length || run.diagnostics.includes('observation_failed')) return false;
  if (run.backend === 'canvas') return true;
  return run.diagnostics.includes('avatar_readback backend=webgl2')
    && !run.diagnostics.some(line => line.startsWith('avatar_readback backend=canvas2d'));
}
module.exports = { performanceRunPassed };
