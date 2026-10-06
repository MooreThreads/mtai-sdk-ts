# Voice Pending-Message Sequencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SDK sequencing for text-bearing wakeup and sleep messages, with one session-scoped pending-message task that is interrupted by every new wakeup, input, or sleep action and never fabricates avatar playback transitions.

**Architecture:** Keep sequencing in the voice-client SDK adapter/connection layer. `wakeup(text)` sends `conversation.start` followed by `text.input`; `sleep(text)` sends `text.input`, records the exact accepted turn ID, waits until avatar playback observes that ID and then a different valid turn ID, and sends `conversation.stop`. A new action invalidates the previous pending sequence. The sequence is session-scoped and fenced by connection generation; no timeout, polling limit, fabricated idle event, or Pi/backend behavior is added.

**Tech Stack:** TypeScript, Jest, existing `VoiceMessageAdapter`, `VoiceClientConnection`, DH2D turn-stripe tracker, React SDK tests.

---

### Task 1: Define pending-message state and cancellation contract

**Files:**
- Modify: `core/src/voice/adapter.ts`
- Test: `core/src/voice/adapter.test.ts`

- [ ] **Step 1: Write failing tests for interruption semantics**

Add tests that prove:

```ts
const first = adapter.wakeup('hello')
const second = adapter.textInput('new input')
expect(first).toBe(...)
expect(second).toBe(...)
// any deferred action created by first is no longer allowed to send
```

Cover all nine replacements: wakeup interrupts wakeup, input, and sleep; input interrupts wakeup, input, and sleep; sleep interrupts wakeup, input, and sleep. Also assert `reset()` invalidates the pending sequence.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd /home/jj/Work/mtai-sdk-ts/core
npx jest src/voice/adapter.test.ts --runInBand
```

Expected: FAIL because the adapter has no pending-message generation/state.

- [ ] **Step 3: Implement the minimal session-scoped invalidation primitive**

Add an adapter-local monotonically increasing `pendingMessageGeneration` and a helper that increments it whenever a new `wakeup`, `textInput`, `sleep`, or `reset` action begins. Every deferred callback must capture its generation and check it before sending.

Do not use a process-global variable. The state belongs to one adapter/session.

- [ ] **Step 4: Run the focused tests**

Expected: PASS for interruption and reset fencing tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/voice/adapter.ts core/src/voice/adapter.test.ts
git commit -m "feat(voice): add pending message generation fencing"
```

---

### Task 2: Support wakeup with text

**Files:**
- Modify: `core/src/voice/adapter.ts`
- Modify: `core/src/dh2d/voiceConnections.ts`
- Test: `core/src/voice/adapter.test.ts`
- Test: `core/src/dh2d/voiceConnections.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that:

```ts
await sendVoiceClientMessage(ws, adapter, { type: 'wakeup', text: '你好' })
```

writes exactly, in order:

```json
{"type":"conversation.start","session_id":"..."}
{"type":"text.input","session_id":"...","request_id":"...","text":"你好"}
```

There must be no `conversation.stop` in this text-bearing wakeup path, even if the adapter currently considers the conversation active. Keep the existing no-text wakeup behavior unchanged.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /home/jj/Work/mtai-sdk-ts/core
npx jest src/voice/adapter.test.ts src/dh2d/voiceConnections.test.ts --runInBand
```

Expected: FAIL because `wakeup` currently ignores its text field and emits only adapter wakeup frames.

- [ ] **Step 3: Implement wakeup sequencing**

Add a text-bearing wakeup operation that invalidates the previous pending operation and returns `[conversation.start, text.input]` in that order. Preserve `wakeup()` with no text as the existing conversation-start operation.

Ensure both frames use the same adapter session ID and the text frame receives a fresh request ID.

- [ ] **Step 4: Run the focused tests**

Expected: PASS, including the existing active-wakeup/no-text interruption tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/voice/adapter.ts core/src/dh2d/voiceConnections.ts core/src/voice/adapter.test.ts core/src/dh2d/voiceConnections.test.ts
git commit -m "feat(voice): support wakeup with text"
```

---

### Task 3: Correlate `text.accepted` with the submitted turn

**Files:**
- Modify: `core/src/voice/adapter.ts`
- Test: `core/src/voice/adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Feed the adapter:

```ts
{
  type: 'text.accepted',
  session_id: sessionId,
  request_id: requestId,
  turn_id: 'A1'
}
```

Assert that the adapter stores the request-to-turn association for the pending sleep-with-text operation and emits no app-facing message for `text.accepted`.

Test mismatched session IDs, unknown request IDs, duplicate acknowledgements, and reset-generation acknowledgements; none may arm the old operation.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
cd /home/jj/Work/mtai-sdk-ts/core
npx jest src/voice/adapter.test.ts --runInBand
```

Expected: FAIL because `text.accepted` is currently ignored without internal correlation.

- [ ] **Step 3: Implement internal accepted-turn correlation**

Track pending text request IDs and their accepted turn IDs inside the adapter. Keep `text.accepted` internal; do not expose a new app-facing event. Remove associations when reset or when the pending operation is replaced.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/voice/adapter.ts core/src/voice/adapter.test.ts
git commit -m "feat(voice): correlate accepted text turns"
```

---

### Task 4: Support sleep with text using avatar turn transitions

**Files:**
- Modify: `core/src/voice/adapter.ts`
- Modify: `core/src/dh2d/voiceConnections.ts`
- Modify: `core/src/dh2d/avatarMedia.ts`
- Modify: `core/src/dh2d/turnStripe.ts`
- Test: `core/src/voice/adapter.test.ts`
- Test: `core/src/dh2d/voiceConnections.test.ts`
- Test: `core/src/dh2d/avatarMedia.test.ts`

- [ ] **Step 1: Write failing tests**

Test this exact sequence:

```ts
send({ type: 'sleep', text: '再见' })
receive text.accepted(turn_id='A1')
observe avatar current turn A1
observe avatar valid transition A1 -> B2
expect conversation.stop
```

Also test that no stop is sent when:

- the accepted turn has not appeared in avatar playback;
- the current frame is missing, invalid, or CRC-failing;
- the current frame remains A1 indefinitely;
- a stale/retired turn transition arrives;
- the pending action was interrupted by a new input/wakeup/sleep;
- the connection was reset.

A valid different turn ID may be any alphanumeric two-character ID; it does not need to be predicted.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /home/jj/Work/mtai-sdk-ts/core
npx jest src/voice/adapter.test.ts src/dh2d/voiceConnections.test.ts src/dh2d/avatarMedia.test.ts --runInBand
```

Expected: FAIL because sleep currently sends `conversation.stop` immediately and the adapter/connection does not coordinate pending sleep with avatar transitions.

- [ ] **Step 3: Implement sleep-with-text sequencing**

For `sleep(text)`, invalidate the old pending action, send only `text.input`, and retain the request ID. When `text.accepted` supplies turn A1, arm the pending sleep operation. The avatar playback bridge must report validated current-turn updates to the connection without treating invalid frames as idle. Once A1 has been observed and a later valid different turn is observed, send exactly one `conversation.stop` if the pending generation is still current.

Do not send a stop from `turn.end`; `turn.end` is a generation boundary, not the requested avatar playback boundary. Do not add a timeout or synthetic transition.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/voice/adapter.ts core/src/dh2d/voiceConnections.ts core/src/dh2d/avatarMedia.ts core/src/dh2d/turnStripe.ts core/src/voice/adapter.test.ts core/src/dh2d/voiceConnections.test.ts core/src/dh2d/avatarMedia.test.ts
git commit -m "feat(voice): stop after avatar transition for sleep text"
```

---

### Task 5: Fence all actions and preserve existing no-text behavior

**Files:**
- Modify: `core/src/voice/adapter.ts`
- Modify: `core/src/dh2d/voiceConnections.ts`
- Test: `core/src/voice/adapter.test.ts`
- Test: `core/src/dh2d/voiceConnections.test.ts`

- [ ] **Step 1: Add regression tests**

Verify:

```ts
sleep without text -> immediate conversation.stop
wakeup without text -> existing conversation.start/active behavior
input text -> pending sleep is cancelled and no later stop is emitted
sleep text -> pending wakeup/input is cancelled
reset/disconnect -> no deferred frame is sent
```

- [ ] **Step 2: Run focused tests**

Expected: PASS after confirming the pending generation is checked at every asynchronous boundary.

- [ ] **Step 3: Review cancellation boundaries**

Confirm cancellation only invalidates SDK sequencing. It must not close the local voice client, Pi backend, DH2D WebRTC connection, or alter any timeout.

- [ ] **Step 4: Commit**

```bash
git add core/src/voice/adapter.ts core/src/dh2d/voiceConnections.ts core/src/voice/adapter.test.ts core/src/dh2d/voiceConnections.test.ts
git commit -m "test(voice): preserve pending message interruption semantics"
```

---

### Task 6: Update documentation and run complete verification

**Files:**
- Modify: `core/README.md`
- Modify: `examples/react-app/src/dh2d.tsx` only if public behavior comments/examples need correction
- Test: all existing SDK tests

- [ ] **Step 1: Document message sequencing**

Document these public semantics:

```text
wakeup(text): conversation.start -> text.input
sleep(text): text.input -> wait for accepted turn playback -> next valid avatar turn -> conversation.stop
new wakeup/input/sleep: cancels the previous pending sequence
invalid/missing stripe: never counts as a transition
```

- [ ] **Step 2: Run the full test suite**

```bash
cd /home/jj/Work/mtai-sdk-ts
npm --prefix core test -- --runInBand
npm --prefix core run build
npm --prefix examples/react-app run build
npm --prefix core test -- --runInBand --detectOpenHandles
```

Expected: all tests pass; TypeScript and React builds pass; no new open-handle failures are introduced.

- [ ] **Step 3: Perform a manual browser smoke test**

With the existing local services running:

1. Open `http://127.0.0.1:5173`.
2. Send wakeup with text and verify the interaction WebSocket receives `conversation.start` then `text.input`.
3. Send sleep with text and verify `text.input` is sent first.
4. Verify the SDK does not send `conversation.stop` on invalid/missing/same stripes.
5. Verify a valid accepted-turn-to-different-turn transition sends exactly one `conversation.stop`.
6. Start another message before the transition and verify the previous pending sleep is cancelled.

- [ ] **Step 4: Commit documentation and final verification**

```bash
git add core/README.md examples/react-app/src/dh2d.tsx
git commit -m "docs(voice): document pending message sequencing"
```

## Scope and safety constraints

- Do not modify the voice MVP server protocol unless implementation proves `text.accepted` or the avatar transition signal is unavailable; if a protocol change becomes necessary, stop and update the plan first.
- Do not use `speech.request`; these are normal user-text turns, not TTS-only announcements.
- Do not fabricate idle transitions, infer playback from `turn.end`, add polling, add timeouts, or alter existing runtime limits.
- Do not change the legacy DH2D path or top-level legacy endpoint behavior.
