# Slice 1 medium SPEC correction — document failure reset

Finding: `did-finish-load` cleared a genuine failure of the same document, allowing preparation to wait for a bridge whose constructor never installed listeners.

Bounded fix: distinguish current-document failure from navigation-in-progress. `gone` marks the document failed; a genuinely new main-frame, non-in-place navigation resets that failure while keeping preparation unavailable until loading completes. Load completion derives availability from retained document failure, never erases it. Same-document/subframe navigation does not reset failure. Existing failure cancellation, all-reference joins and native cleanup remain unchanged.

API regression: preload-error -> did-finish-load -> attach + LAYOUT must reject, issue neither prepare nor READY, and join playback/socket/allocation retirement. No timeout, retry, policy, new receipt or scope expansion. Run affected and named SDK regressions, then fresh read-only Astra SPEC at user-selected gpt-6-astra/medium. QUALITY only after SPEC passes.
