# ADR-003: Reader-controlled conversation scrolling

Status: Accepted

Date: 2026-10-17

Streaming previously assigned the conversation's `scrollTop` on every text chunk
and message-count change. This repeatedly pulled readers away from earlier text.

The chat now follows new output while the reader stays at the bottom. Scrolling
up pauses following immediately. New chunks and the final response preserve the
reader's position. A floating “Back to latest” button above the composer returns
to the bottom and resumes following; manually scrolling down to within 24px of
the bottom also resumes it. An upward scroll pauses even within that threshold.

Opening another chat, returning from Trajectory, or submitting a message restores
following. Confirmation of an optimistic message does not reset it. Trajectory
does not follow incoming chat text.

`use-conversation-scroll.ts` owns the follow state separately from message data.
Layout effects follow React content updates before paint. A `ResizeObserver`
also follows delayed content/layout changes and measures composer clearance for
the existing floating-button styles. The button uses a native, labeled control
and an immediate scroll, with no animated motion.

Validation: `PI_WEB_TEST_CHROME=true npx playwright test
test/browser/conversation-scroll.spec.ts` covers following, paused streaming,
completion, keyboard activation, manually returning to the bottom, switching
chats with equal message counts, and optimistic-send confirmation at 1440px,
768px, and 320px. Screenshots verify the floating control above the composer.
