# Slice3 second bounded QUALITY correction

Required exact-artifact law: verifier must derive expected runtime bytes from receipted vendor tar, not packaged self-report. Previous QUALITY NOTPASS retained; no observed artifact mismatch asserted.

1. Read original artifact.json from SHA256-receipt-verified tar; compare packaged artifact.json bytes exactly before using original manifest hashes for runtime/addon checks. No new identity scheme or production runtime behavior.
2. Add packaging CLI regression building a minimal ASAR with an altered payload/hash manifest but unchanged sourceCommit/inputIdentity; require explicit manifest-mismatch rejection before any binary/module execution. Covers concrete gap, no fake GPU/RT contract.
3. Re-run verifier against actual unpacked/extracted package and focused app/CLI checks. Coherent SPEC then fresh QUALITY at Astra/medium. No install/restart or qualification claim.
