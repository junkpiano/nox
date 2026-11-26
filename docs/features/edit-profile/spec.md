# Edit profile (phone app)

## Purpose

The web app lets you change your name, picture and the rest of your kind 0
profile; the phone app cannot. Someone who uses nox only on a phone has no way
to fix their own profile.

## Behaviour

- On your own profile (the You tab), when signed in with a key, an
  **Edit profile** button sits where Follow sits on other people's profiles.
  A read-only (npub) session does not show it.
- It opens an Edit profile screen with these fields, prefilled from your
  newest profile on your relays: Display name, Username (`name`), About
  (multi-line), Picture URL, Banner URL, Website, NIP-05, Lightning address
  (`lud16`).
- While your profile is being read, the fields are not editable. If any of
  your relays does not answer, or your current profile cannot be read, the
  screen says so and offers Try again; it does not let you save over a profile
  it could not read. A relay that never answers has to be removed in
  Settings → Relays before you can edit.
- **Save** in the header publishes a new kind 0 to your relays and goes back to
  your profile, which shows the new values.
- If no relay accepts it, the screen stays open with your edits and says so.

## Acceptance

- PROFILE-EDIT-1: Editing starts from the newest kind 0 any of your relays
  holds, read from every relay rather than the first to answer.
- PROFILE-EDIT-2: Fields nox does not edit (`lud06`, `bot`, anything unknown)
  and the event's tags (custom emoji, NIP-39 identities, ...) are published
  unchanged.
- PROFILE-EDIT-3: An edited field is trimmed; an emptied field is removed from
  the profile rather than published as `""`.
- PROFILE-EDIT-4: Saving `website` also writes `url` with the same value, and
  emptying it removes both, as the web editor does.
- PROFILE-EDIT-5: If any relay does not answer the read, or the newest kind
  0's content is not a JSON object, saving is refused. A silent relay may hold
  the newest profile, or the only one.
- PROFILE-EDIT-6: The new kind 0's `created_at` is later than the one it
  replaces, even if this device's clock is behind.
- PROFILE-EDIT-7: The Edit profile button appears only on your own profile and
  only when the session can sign.
- PROFILE-EDIT-8: After a save that at least one relay accepted, your profile
  screen and the cache show the new values, as published rather than read
  back from relays that may still hold the old copy.
- PROFILE-EDIT-9: With the keyboard open, every field can be scrolled into
  view above it, and the field being typed in stays visible.

## Not doing

- Uploading a picture or banner from the phone: URLs only for now. The web
  editor is URL-only too.
- Guarding the profile cache against an older kind 0 read later: opening a
  profile afresh still takes the newest copy among the relays that answer
  first, as it does for everyone's profile. A relay that refused your edit
  can briefly show the old one there. Nothing is published from it.
- Moving the web editor onto the shared helper: a separate change, so this one
  touches only the phone app and a new shared module.

## Open

- Should picture and banner upload (NIP-96 / Blossom) come next?
- Requiring every relay to answer means one dead relay blocks editing until it
  is removed. Is that the right trade against overwriting a profile it could
  not see?
