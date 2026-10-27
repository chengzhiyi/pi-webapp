# Models, packages & skills

## Models and authentication

Open **Settings → Models** for providers, sign-in, and models. Add models, edit display names, context windows, output limits, and input types, or restore built-in defaults. Changes go to Pi's `models.json`. Select the conversation's model and thinking level in the conversation UI.

Browser sign-in opens the provider page; follow manual-code prompts if the callback cannot reach Pi. Stored provider authentication can be removed here. Credentials stay in Pi's local `auth.json` and are not returned to the browser: never attach that file to a report. Model usage may incur charges from your provider.

## Packages, extensions, skills, and Web plugins differ

| Term | Purpose and entry point |
| --- | --- |
| Pi package | Can contain both extensions and skills. Add npm, Git, or local sources in **Settings → Packages & extensions**. |
| Pi extension | Pi runtime capabilities; local extensions can also load individually. Loading in other workspace sessions depends on host isolation rules. |
| Skill | Discovered task guidance. Inspect or manually configure a `SKILL.md` file/directory in **Settings → Skills**. |
| Web plugin | Web interactions and panels. Bundled Git/Files/Terminal/Diagrams are managed in sidebar **Plugins**; external runtimes remain under **Packages & extensions**. |

Bundled plugin switches persist globally and require all chats to be idle. Disabling closes related tabs and blocks backend requests. Disabling Terminal requires confirmation and ends all service-owned terminals. **Installing a package is not toggling a bundled plugin.** External plugins do not offer a misleading UI-only switch.

## Official plugins

Official plugins in sidebar **Plugins** use the same enable/disable switch as built-in capabilities. Choose **Download** first, then enable the installed plugin; use **Update** for installed packages. Switches are unavailable before installation or while status is unknown, and reflect server-confirmed state only.

Click a plugin row for its description, installed version, required configuration, update checks and uninstall action; **‹ Plugins** returns to the list. The page refresh button reads both built-in and official plugin status. Excalidraw requires no additional configuration.

Installed plugins update with the app. Open editors delay the version switch; immediate reopening requires separate confirmation of the undo-history reset. Disabling or uninstalling saves and closes views first and stops on a failed save, retaining workspace files and plugin data. Failed downloads are not retried automatically and do not discard the current version.

## Diagrams

Ask the agent to draw in the **main chat**. The drawing appears in its tool result; new drawings require no acceptance step. **Edit** opens only the native Excalidraw canvas and toolbar on the right. Request further changes in the main chat; existing-diagram AI edits use **Apply edits / Keep original** in chat, with stale-revision protection. Save/Open/Import, source download, white/transparent PNG export and backup recovery live in Excalidraw's menu. Workspace files use `.excalidraw` and remain conflict-protected. The right-workbench **Excalidraw** entry opens a blank native canvas, without a separate drawing landing page or prompt form.

The editor is embedded locally, without Excalidraw cloud services. Manual editing works without a model. Browser draft backups are not a substitute for saving files. Images, links, collaboration and headless PNG rendering are not supported. See [Diagrams](../diagrams.md) for boundaries. Rebuild/restart the backend after updating; refreshing the page alone is insufficient.

## When to reload

After package/extension configuration changes, follow UI feedback and wait for chats to become idle before reloading. A browser refresh is not a backend extension update. Source development requires a rebuild and launcher restart, or `/reload` followed by `/web` inside Pi when using `pi -e .`. See [updates](./updates) and [developer resources](./resources).
