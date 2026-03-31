# Event Reaction Interactions Design

**Goal:** Change event reaction interactions so existing reaction badges show who reacted, while the heart action remains the user's personal reaction toggle.

## Behavior

- Clicking a reaction badge inside an event card must open the inline reaction details area for that specific reaction.
- Clicking the same reaction badge again must close the inline reaction details area.
- Hovering a reaction badge may continue to show the existing tooltip behavior.
- Clicking the heart action button must keep using the `❤` reaction only.
- Clicking the heart action button when the viewer has not yet reacted with `❤` must publish a new heart reaction.
- Clicking the heart action button when the viewer already has a `❤` reaction on that event must publish a kind `5` deletion for that existing reaction event instead of publishing another reaction.

## Constraints

- Keep the existing event card structure and reuse the existing `.reactions-details` container.
- Reuse the current reaction event fetch path rather than introducing a new cache or store.
- Reuse the existing deletion publishing pattern already used for user-owned reactions.
- Do not change repost, reply, zap, or delete-post behaviors.

## Testing Strategy

- Add focused unit tests for the pure decision logic that determines:
  - whether the inline details panel opens or closes for a clicked badge
  - whether the current viewer already has a matching heart reaction event
- Verify the runtime integration with targeted tests and a production build.
