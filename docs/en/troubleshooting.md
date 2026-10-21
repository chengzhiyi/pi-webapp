# Troubleshooting

Identify your [entry point](./index) and [versions](./reference) first. Do not diagnose by repeatedly launching, resubmitting tasks, or deleting Pi data. None of the checks below requires sharing secrets.

| Symptom | Check | Safe action / report |
| --- | --- | --- |
| Page unavailable or no automatic browser | For background launchers run `npx pi-webapp status`. Is this headless/remote, or is `PI_WEBAPP_AUTO_OPEN=0` set? | Reopen the actual local address from the original terminal. Use private forwarding remotely, never publish the token. Report OS, entry point, sanitized error. |
| Pi too old | Is `pi --version` ≥ 0.87.1 and `node --version` ≥ 22.19? | Update the corresponding runtime through a trusted installation path. The launcher does not replace old Pi. Report actual versions, not “latest.” |
| Source changed but old UI/bridge remains | Did you only refresh, or rebuild and reload the backend? | Finish work, rebuild, and restart the source launcher; with `pi -e .`, use `/reload` then `/web`. Report entry point, source commit, running version. |
| Provider login succeeds but chat is unauthenticated | Can the callback reach the Pi machine? Does the model accept the input type? | Follow manual-code prompts or sign in again. Never paste credentials/codes in chat or reports. Provide provider name and sanitized error. |
| Plugin switch disabled / Git busy or locked | Are all chats idle? Is a real Git operation, conflict, or occupied worktree involved? | Wait for operations and refresh state. Never blindly delete locks, force-switch, or discard changes. Manage external plugins through Packages & extensions. |
| Update page does not return | Check `status`, running version, and `launcher.log` exit reasons. | Follow [recovery](./updates); restart only after confirming work is finished. Report old/new versions and sanitized lifecycle excerpts. |
| Terminal tab gone / stale file preview | Was the page reloaded, service stopped, or browser disconnected for over five minutes? | Terminals do not survive service restarts. Check side effects before rerunning; never blindly replay input. Refresh file previews manually. Report action sequence. |
| macOS blocks desktop test build | Did DMG checksum and installed `codesign` verification pass? Which build? | Follow the [desktop guide](./desktop) with explicit acceptance of testing limits. Stop on verification failure; never re-sign or globally disable protections. |

## Minimal report

Use [project Issues](https://github.com/chengzhiyi/pi-webapp/issues) with OS/architecture, Node/Pi/pi-webapp versions or desktop build number, entry point, minimal reproduction steps, expected/actual behavior, and sanitized errors or necessary screenshots. Include the commit for source issues.

The default log is `~/.pi/agent/pi-web/launcher.log`, or `%USERPROFILE%\.pi\agent\pi-web\launcher.log` on Windows. See [configuration](./reference) for custom data roots. **Review excerpts before sharing.** Exclude full access URLs, tokens, absolute workspace paths, private conversations, attachments, `auth.json`, and private keys. Never upload the entire data directory.
