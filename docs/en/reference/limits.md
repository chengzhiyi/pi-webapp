# Limits

This page collects the size and count limits you can run into, so you can tell a limit from a bug.

| Area | Limit |
| --- | --- |
| **Attachments** | Up to 20 files per message, each non-empty and at most 20 MB. |
| **Queued messages** | Up to 50 at once, each up to 32,000 characters, and a combined 64 MB including attachments. A queued message can't start with `/`. |
| **File preview** | 1,000 entries listed per folder; text up to 512 KB and 10,000 lines; images up to 8 MB. |
| **Terminals** | 8 per chat and 32 per service; 2,000 lines of scrollback; a disconnected browser keeps its terminal for 5 minutes. |
| **Git panel** | Up to 1,000 changed files listed; a diff over 512 KB or 10,000 lines shows only a notice; history loads 50 commits at a time. Read commands time out after 10 seconds and writes after 30 seconds. |
| **Custom provider form** | Name up to 100 characters, provider ID up to 64, model ID up to 200, API URL up to 2,048. API key fields accept up to 16,384 characters. |
| **Agent diagrams** | Pi's diagram tool takes at most 30 shapes and 60 connectors per drawing, and each label up to 500 characters. |
| **Startup and shutdown** | Startup is abandoned after about 60 seconds. `pi-webapp stop` waits about 40 seconds, and `stop --force` falls back to ending processes after 5 seconds. A plugin view must confirm its save within about 15 seconds before an update proceeds. |

Pi and your model provider have their own limits, such as context window size and rate limits. They aren't listed here.
