# Slice 2 consolidated SPEC fix plan

Six necessary reachable integration corrections only, mapped to original preservation requirements:
1. Cross-avatar reveal: fence presentation generation at replacement mount, not eventual attach; retain healthy same-avatar image. Installed bridge old event between mount/attach regression.
2. Recover failed graphics: preserve a healthy cover but, after joined receiver retirement, dispose/recreate unhealthy cover for explicit next attach. No auto retry/recovery timer. Installed context-failure/retire/retry regression.
3. Destroyed window: fence outbound renderer notifications on closed and ensure dispose in finally. Actual native/reference joins remain; test send throws after destruction and subsequent registration.
4. QR session ownership: lift existing binding workflow/UI lifetime to public session, pass same binding capability to each conversation attempt, dispose once on session close. Existing attempt60000 cancellation/2000retry unchanged. Test initial attach failure then timeout/retry preserving same QR root/workflow.
5. Restore accessible SDK media error overlay in optional Avatar; keep retained image and QR; clear after ready. Tests failed before/after content and recovery.
6. App async connected callback: revalidate selected-avatar/status operation after getStore await and on unmount. Existing switch30000/failure unchanged. Mounted deferred-store replacement regression.

One coherent correction batch; no framework/client/input/timeouts/limits changes. Re-run named API batches, source diagnostics comparison as needed; repeat integrated SPEC then independent QUALITY. Prior NOTPASS retained.
