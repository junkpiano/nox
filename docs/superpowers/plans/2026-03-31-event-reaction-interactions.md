# Event Reaction Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reaction badges show reactor details and make the heart action toggle the viewer's own heart reaction.

**Architecture:** Keep the UI change local to the event rendering flow in `src/common/event-render.ts`. Extract small pure helpers for click-state and own-heart lookup so the risky decision logic is covered by tests even though the project does not currently include a DOM test harness.

**Tech Stack:** TypeScript, Node test runner, existing Nostr relay publishing helpers

---

### Task 1: Add test coverage for reaction interaction decisions

**Files:**
- Modify: `tsconfig.test.json`
- Create: `tests/event-reaction-interactions.test.ts`
- Modify: `src/common/event-render.ts`

- [ ] **Step 1: Write the failing tests**

Add tests covering:
- opening details for a clicked reaction badge
- closing details when the same badge is clicked again
- switching details when a different badge is clicked
- finding the viewer's existing `❤` reaction event for a target event
- ignoring reactions from other users or other reaction content

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because the new helper exports do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add small exported helpers in `src/common/event-render.ts` for:
- deciding the next details panel state after a badge click
- finding the viewer's existing matching reaction event

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS for the new test file.

### Task 2: Wire event-card behavior to the tested helpers

**Files:**
- Modify: `src/common/event-render.ts`

- [ ] **Step 1: Update reaction badge click handling**

Replace badge click publishing with inline details toggle behavior using the existing `.reactions-details` container and `loadReactionDetails(...)`.

- [ ] **Step 2: Update heart button behavior**

When the viewer clicks the heart button:
- load reaction events for the note
- find the viewer's existing matching heart reaction
- delete it if present
- otherwise publish a new heart reaction

- [ ] **Step 3: Keep surrounding behaviors intact**

Preserve hover tooltip behavior, sign-in checks, and all other event action buttons.

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS

Run: `npm run build`
Expected: PASS
