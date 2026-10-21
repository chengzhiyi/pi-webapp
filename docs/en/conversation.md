# Controls & attachments

Conversations show Markdown, streaming output, expandable reasoning and tools, token usage, and a turn-by-turn trace. You can change the current model and thinking level; model availability depends on [configuration and authentication](./configuration).

## Pause and continue

The bottom-right control pauses an active request. After pausing, an empty composer offers **Continue**, including after reloading or reopening an eligible paused session.

Continue is an internal host action without a new user message. The model starts a **new request** using the original task, existing tool results, and partial reply; it does not resume the same interrupted network token stream. Running or completed tasks, or tasks with pending interactions, cannot use generic Continue.

Plan mode is provided by a plugin, not an inherent mode of every chat. It handles questions, approvals, revisions, and previews. A plan requiring renewed approval must be approved again: **historical approval does not authorize new execution**. Resolve pending interactions rather than bypassing them through Continue.

## Attachments

- Select, drop, or paste up to **20 files**, each no larger than **20 MB**.
- Images have previews and are sent as Pi image content. Image handling also depends on the model's accepted input types.
- Never upload API keys, authentication files, private keys, or data you are not authorized to provide. Sending data to a model is not necessarily local processing; follow your provider's data policy.

Pause affects only the selected chat. See [sessions](./sessions) for the difference between closing a page, switching chats, and stopping the service.
