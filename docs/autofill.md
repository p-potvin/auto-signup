# Autofill and form detection

How the extension finds credential fields, what it offers, and what it does with
what you submit. Written 2026-08-05.

## Detection

`src/content/detect.ts` runs per form, not per document, and is re-runnable.

- **Re-scans on DOM mutation** (debounced 300ms). Most SPA login pages render
  their form after load; a single pass at `document_idle` misses them entirely.
- **Traverses open shadow roots.** Design-system inputs live inside them.
  Closed roots are unreachable by design and are not supported.
- **Prefers the `autocomplete` attribute** over guessing from `name`/`id`, since
  it is the one signal the HTML spec defines for this. Sectioned tokens
  (`section-checkout billing cc-number`) resolve to their last component.
- **Groups by form.** A real `<form>` wins; otherwise it walks up until a
  container holds more than one fillable input, which is what a div-based login
  box looks like. This is what stops a search box on a checkout page from being
  treated as part of the payment form.
- **Classifies** login / signup / changePassword / payment. A change-password
  form is deliberately *not* a login form, so a saved password is never filled
  into a new-password box.

Filling goes through the native `value` setter and dispatches `input` and
`change`. Assigning `.value` directly leaves React's internal value tracker
stale, React concludes nothing changed, and the field silently reverts on the
next render.

## What gets offered

- **Logins, cards, addresses** matching the domain.
- **Identities**, when the form actually has fields a persona can fill (name,
  phone, address). A persona that already owns an item on this domain sorts
  first; the rest follow by favourite, then recency. Identities are not
  domain-scoped — a persona is meant to be reusable — so they are offered
  broadly rather than only where they were first used.
- **Passkeys** appear as a notice only. A ceremony can only be started by the
  site calling `navigator.credentials.get()`, so a clickable entry would promise
  a sign-in the menu cannot perform. Conditional mediation would fix this.

The menu renders in a closed shadow root so page CSS cannot break it and page
scripts cannot read the labels. Arrow keys move, Enter picks, Escape dismisses.

## Save prompt, and what happens if the page reloads

The hard part is that a submit which navigates tears down the content script
before the user can answer. Three things make the prompt survive it:

1. **The fields are read synchronously in the event handler**, and the message
   to the background is dispatched in the same task. Nothing waits on a timer or
   an `await` before the values are captured — by the time either resolves, the
   document may be gone.
2. **The background holds the pending save**, keyed by tab, in
   `chrome.storage.session`. The next page load in that tab asks for it and
   shows the prompt there. Session storage rather than a module-level `Map`
   because an MV3 service worker is evicted when idle, which would drop the
   pending save during exactly the gap it exists to cover. It is memory-backed
   and cleared when the browser closes, so the plaintext password never reaches
   disk.
3. **`pagehide` is a catch-all** for flows that produce neither a `submit` nor a
   recognisable button press — a script calling `location.assign`, or a custom
   control that was not classified.

Pending saves expire after 2 minutes and are dropped when the tab closes.

Known remaining hole: if the tab is closed outright before answering, the prompt
is gone — the pending save is deliberately discarded with the tab rather than
resurfacing somewhere the user has no context for it.

## Settings

- `autoDetectEnabled` — turn detection off entirely.
- `autoFillEnabled` — keep detection but stop offering the menu on focus.
- `savePromptEnabled` — stop offering to save submitted logins.

## Verification

Fixtures covering shadow DOM, late-mounted SPA forms, div-based login boxes,
change-password forms, hidden inputs, sectioned autocomplete tokens, and scope
isolation ran 19/19 in a real browser. The fixture page is not committed; it is
rebuilt from `src/content/detect.ts` when needed.
