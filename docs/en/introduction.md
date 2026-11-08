# Introduction

This page explains what pi-webapp is, what it adds to Pi, and which of its three ways of running to pick.

## What pi-webapp is

[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is a coding agent that reads and edits files and runs commands on your machine. pi-webapp is a local interface for it: a browser page or desktop window that sits on top of Pi and adds a workspace around the conversation.

Pi still does the real work. It runs the agent, calls your model provider, executes tools and writes the session history. pi-webapp does not replace any of that, so your Pi models, skills, extensions and saved sessions carry over.

## What you get

| Capability | What it does |
| --- | --- |
| [Conversations](./conversation) | Streaming replies, expandable tool calls, token usage, a per-turn trajectory view, file attachments, and a queue for messages you send while Pi is busy. |
| [Sessions and workspaces](./sessions) | Every project folder is a workspace with its own saved chats. Chats run independently, so switching to another one does not interrupt the first. |
| [Files, terminal and Git](./workspace-tools) | Read-only file previews, real interactive shells, and a Git panel for reviewing diffs, staging, committing and switching local branches. |
| [Diagrams](./diagrams) | An optional Excalidraw plugin that turns a request into an editable diagram. |
| [UI design](./design) | An optional OpenPencil plugin: Pi designs screens on a real design canvas, and you edit, undo and save them as `.fig` files. |
| [Models and providers](./models) | Sign in to a provider or add an API key, pick models, and add your own OpenAI- or Anthropic-compatible endpoint. |
| [Packages, skills and plugins](./extensions) | Manage Pi packages and skills, and switch the built-in Files, Terminal and Git capabilities on or off. |

## Three ways to run it

| Way | Command or download | Best for | How long it runs |
| --- | --- | --- | --- |
| **Web launcher** | `npx pi-webapp` | Most people. Needs only Node.js. | A background service that outlives the terminal and the browser tab, until you run `pi-webapp stop`. |
| **Inside the Pi terminal** | `pi install npm:pi-webapp`, then `/web` in Pi | You already work in Pi's terminal UI and want a browser view of the same session. | Tied to that Pi process; exiting Pi ends it. |
| **Desktop app** | A test build from GitHub Releases | You prefer a window to a browser tab and don't want to install Node. | Offers to keep the service running when you quit. |

Start with the [quick start](./getting-started), which covers the web launcher. The other two are in [Use it from the Pi terminal](./use-from-pi) and [Desktop app](./desktop).

## What you need

- **Node.js 22.19 or later** for the web launcher and for `/web`. The desktop app bundles its own.
- **A model you can use.** pi-webapp does not include one. You sign in to a provider, paste an API key, or point it at a compatible endpoint. A local interface does not mean offline inference: your messages go to whichever provider you choose.
- **Git**, if you want the Git panel.

## How it works, briefly

The launcher starts a small HTTP service on `127.0.0.1` (your own machine only) on a random port. The address it prints contains a random access token, and the page uses that token for every request. The service drives Pi, and Pi keeps its usual data under `~/.pi/agent`. pi-webapp has no cloud service of its own.

::: warning Not a sandbox
The agent and the terminal run with your own user permissions. A workspace is just a starting folder, not a restricted area. Read [Security and privacy](./security) before pointing the agent at anything sensitive.
:::

## Which version am I reading about?

These pages describe the source in this repository. Your installed version can be older or newer: open **Pi Settings → General** and look at **App updates → Current version**. Differences between versions are called out where they matter.

Next: [Quick start](./getting-started).
