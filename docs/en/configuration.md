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
| Web plugin | Web interactions and panels. Bundled Git/Files/Terminal are managed in sidebar **Plugins**; external runtimes remain under **Packages & extensions**. |

Bundled plugin switches persist globally and require all chats to be idle. Disabling closes related tabs and blocks backend requests. Disabling Terminal requires confirmation and ends all service-owned terminals. **Installing a package is not toggling a bundled plugin.** External plugins do not offer a misleading UI-only switch.

## When to reload

After package/extension configuration changes, follow UI feedback and wait for chats to become idle before reloading. A browser refresh is not a backend extension update. Source development requires a rebuild and launcher restart, or `/reload` followed by `/web` inside Pi when using `pi -e .`. See [updates](./updates) and [developer resources](./resources).
