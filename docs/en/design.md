# UI design with OpenPencil

This page shows how to install the optional OpenPencil plugin, ask Pi to design a screen, edit it by hand, control what Pi may change, and save the design into your project.

OpenPencil is an official plugin built on the open-source [OpenPencil](https://github.com/open-pencil/open-pencil) design editor. It is **not bundled and not installed automatically**. Designs are `.fig` files. Pi edits them directly: its changes appear on the canvas as it makes them, and you can undo the latest one. The editor runs locally in your browser and needs no account. OpenPencil's own AI chat is not included, because Pi does that job with the model you've connected.

::: info New
OpenPencil isn't in a stable release yet. See [Unreleased](./changelog#unreleased) in the changelog.
:::

## 1. Install and enable the plugin

1. In the sidebar, click **Plugins**.
2. Under **Official plugins**, find **OpenPencil (Official)** (its status reads **Not installed · Disabled**) and click **Download**.
3. Wait for the status to change to **Installed · Disabled** and a version number. This needs network access to npm. The package contains the whole editor, its rendering engine and fonts, so it is a larger download than Excalidraw.
4. Turn on the switch at the right of the row. The status becomes **Installed · Enabled**.

Enabling needs every chat to be idle. Click the row for details: the package name (`@chengzhiyi/pi-pencil`), the installed version, **Check updates**, and **Uninstall**. OpenPencil needs no further configuration, but it does need a browser with WebAssembly, which every current browser has.

## 2. Open the editor

Open the tool panel in a conversation. Its start page now has an **OpenPencil** entry (**UI design**). It opens the latest design in the workspace. If there isn't one yet, you get an empty canvas: draw anything and it becomes a design called **Untitled**.

The left panel lists the workspace's designs, so you can switch between them or rename one. Its file menu has:

| Item | What it does |
| --- | --- |
| **New design** | Starts another design. |
| **Save as .fig** | Writes the design into the workspace ([Save](#save)). |
| **Open in tab** | Opens the current design in its own editor tab, which you can split or make fullscreen like any other tool. |

## 3. Ask Pi for a design

Describe what you want in the normal conversation. You don't need to name a tool:

```text
Design a mobile login screen: email and password fields, a primary sign-in button and a "Forgot password?" link.
```

Pi reads OpenPencil's design guide, looks at the current design and sends its change as a batch of typed operations (create, update, delete), never as code. The change takes effect at once:

- The frames it changed are selected and brought into view on your canvas.
- A toast reads **Agent changed:** and the change's title, with an **Undo** button. Undo stays available until you edit after it.
- Pi gets a picture of what it changed, so it can check its own work and fix it in a follow-up.

Keep asking for changes in the conversation ("make the button full width", "add a dark variant"). If you edited the design since Pi last looked at it, Pi's change is refused and Pi reads the design again first, so it never silently overwrites your edits.

## 4. Control what Pi may change

The **Agent** tab in the right panel lists Pi's recent changes, each with its revision, how many operations it had and when it happened. The latest one has **Undo**; undone changes are marked **undone**.

Under **Agent access**, select layers on the canvas or in **Layers** first, then:

| Button | What it does |
| --- | --- |
| **Lock** / **Unlock** | Pi can't change locked layers. Its changes to them are refused. |
| **Only the selection** | Pi may change only the selected layers and what's inside them. |
| **Whole design** | Lifts that limit. |

Undo, saving, locking and limiting are yours only: Pi has no tool for them.

## 5. Edit by hand

The canvas is OpenPencil's own editor: frames, shapes, pen, text, auto layout, components, boolean operations, pages and layers. The right panel also has:

- **Design**: the selected layer's properties.
- **Code**: the selection as JSX, React with Tailwind, or HTML.
- **Inspect**: design checks.
- Export to PNG, JPG, WebP or SVG.

**Preview** (⌥⌘↩ on macOS) runs the design on the canvas. The editing interface goes away, animated fills play, and components with a behaviour (buttons, switches, sliders, tabs, text fields and so on) work as live controls. **Reset** restarts them, and Esc exits.

Theme and language follow **Pi Settings → General**.

## 6. Save {#save}

Your edits and Pi's are kept by the service as revisions while you work. To get a file into your project, choose **Save as .fig**. The first save writes `designs/<title>.fig` in the workspace, creating the `designs/` folder if needed; later saves go to the same file. Then commit it from the [Git panel](./workspace-tools#git) like any other file.

Saving checks the file's content first. If the `.fig` file changed on disk since you last saved it, the save is refused instead of overwriting that change.

## Limits and good to know

- A single `.fig` file can be up to 64 MB.
- Disabling or uninstalling the plugin keeps your `.fig` files in the workspace.
- The plugin updates on its own, and an open editor delays the switch to the new version ([Official plugins](./extensions#official-plugins)).
- If an editor is open and unsaved when you stop the service, `pi-webapp stop` can refuse. See [Troubleshooting](./troubleshooting#stop-is-refused-because-a-plugin-view-has-not-saved).
- Designs made with the earlier preview of this plugin, called **Pencil**, may still hold proposals from before Pi's changes applied directly. They are listed as **Older proposal**, with **Accept** and **Reject**.

Next: [Models and providers](./models).
