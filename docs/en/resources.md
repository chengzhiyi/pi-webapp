# Development & archives

This iteration prioritizes users and does not promise internal HTTP routes as stable public APIs. Existing repository paths remain available below. They are **not automatically built as site pages or indexed in site search**, so historical/operator material is not presented as current user behavior.

| Topic | Existing source and user entry |
| --- | --- |
| Architecture, ownership, plugin lifecycle | [architecture.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/architecture.md); users: [tools](./workspace-tools) |
| Web-plugin protocol, pause/resume | [web-plugins.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/web-plugins.md); users: [configuration](./configuration), [controls](./conversation) |
| Desktop builds and opt-in installation | [desktop.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md), [desktop-testing.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md); users: [desktop](./desktop) |
| Sentry operations and diagnostics | [sentry.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md), [sentry-triage.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry-triage.md); users: [security](./security) |
| Decisions and initial specification | [decisions/](https://github.com/chengzhiyi/pi-webapp/tree/main/docs/decisions), [spec.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/spec.md); historical, not a complete current feature contract |

Development and product release procedures remain in the [repository README](https://github.com/chengzhiyi/pi-webapp#develop-locally). `PI_WEBAPP_PLUGIN_DEV_ROOTS` is for trusted local plugin source; follow the plugin notes and sibling `pi-extensions` README.

Use upstream Pi and protocol documentation for their capabilities, rather than duplicating them here. A dedicated contribution guide, minimal plugin example, and protocol compatibility table are phase-C work, not invented compatibility promises.

Documentation maintainers should read repository `docs/MAINTAINING.md` for build, preview, source mappings, and acceptance commands. GitHub main links are development references, not immutable released-version snapshots.
