# Glossary

This page defines the terms used across the guide, in alphabetical order.

**Access token.** The random secret in the part of the address after `#`. Anyone who has the full address can use your service. See [Security and privacy](../security).

**Address.** The URL the launcher prints, such as `http://127.0.0.1:52395/#<token>`: your machine, a random port, and the access token.

**Agent.** The program that works toward your request by calling a model and using tools to read files, edit them and run commands. In pi-webapp that is Pi.

**Background launcher.** The `pi-webapp` command and the service it keeps running after you close the terminal. Also called the web launcher.

**Business package.** In the desktop app, the pi-webapp version that runs inside the app shell. It updates separately from the shell. See [Desktop app](../desktop).

**Compact.** A command that shortens a session's history to free up context. Run it from the **+** menu or `/compact`.

**Data folder.** Pi's folder (`~/.pi/agent` by default) with your sessions, credentials, settings and pi-webapp's own `pi-web/` state. See [Files and directories](./files).

**Extension.** Code that adds capabilities to Pi, such as commands and tools. See [Packages, skills and plugins](../extensions).

**Handoff.** Moving a running shared service to the current desktop app's launcher, without changing its address. It waits for idle chats and never force-stops.

**Model provider.** The company or server that hosts a model: Anthropic, OpenAI, your own gateway. You connect one in **Pi Settings → Models**.

**Package.** A bundle of extensions and skills installed from npm, Git or a folder.

**Pause / Continue.** Pause stops a chat's current execution and keeps its progress. Continue starts a new request that carries on from it. See [Conversations](../conversation#pause-and-continue).

**Pi.** The coding agent that pi-webapp is an interface for. Its package is `@earendil-works/pi-coding-agent`.

**Pi SDK.** Pi as a library. The npm package of pi-webapp is pinned to one exact SDK version that it was tested with.

**Plugin.** A pi-webapp feature with its own screen: the built-in Files, Terminal and Git tools, and optional ones such as Excalidraw and OpenPencil. Managed under **Plugins** in the sidebar.

**Hosted plugin.** The kind of plugin that is downloaded and runs in its own process and browser frame, such as Excalidraw and OpenPencil. The term shows up in some logs and messages.

**Preview channel.** The update option that follows the newer of npm's `latest` and `alpha` versions. **Stable** follows `latest` only. See [Updates](../updates#channels).

**Queue.** Messages you send while Pi is working; Pi handles them when the current task finishes. See [Conversations](../conversation).

**Service.** The local program that serves the page and drives Pi. It listens on `127.0.0.1` only.

**Session.** One saved chat with Pi in a workspace, stored as a file under `sessions/`.

**Shell (desktop).** The installed desktop app itself, as opposed to the pi-webapp version it runs.

**Skill.** A `SKILL.md` file or folder of guidance that Pi can load for a task. Skills appear as `skill:<name>` commands.

**Steer.** Sending a message to a working Pi so it reaches Pi at its next opportunity, without waiting for the task to finish. Use **Ctrl/Cmd+Enter**.

**Tool call.** One action the agent took, such as reading a file or running a command. Shown collapsed in the conversation and listed in the Trajectory tab.

**Trajectory.** The tab that lists every message, tool call and reply of a session with timing and token details.

**Turn.** One user message and everything Pi did in response.

**Workspace.** A project folder, where the agent starts and where chats are grouped. Not a security boundary.
