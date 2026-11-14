# Slice 1 QUALITY correction — synchronous playback factory failure

Completed independent QUALITY medium found one reachable P1: audioAcceptance deferred is stored before createPlayback, but its rejection is observed only after the synchronous factory returns. A native initialization throw bypasses Promise.all; fail rejects an unobserved deferred.

Bounded correction: install rejection observation on audio.promise before native factory invocation. This does not swallow the preparation/attachment error: the original factory throw still rejects preparation and the attach promise, and later async audio failure is still joined by Promise.all. No new lifecycle abstraction, receipt, timeout/retry or policy.

Installed-host regression injects synchronous createPlayback throw after LAYOUT; assert original attach error, no READY, actual socket/allocation retirement, and drain one event-loop turn so unhandled rejection fails the test. Existing audio cleanup remains for successfully created owners only. Repeat named regressions then coherent SPEC/independent QUALITY using user-selected Astra medium.
