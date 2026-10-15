# Contributing

Thanks for helping improve NoteAI! This guide covers setting up, how the code is organized, and how to
check your changes.

## Setup

You need Windows 10/11, Node.js 20+, and Claude Code installed and signed in (so rephrasing works).

```bash
npm install
npm start
```

`npm start` runs the app from source with your real data in `%APPDATA%\NoteAI`. To experiment
without touching your own notes, point it at a scratch folder:

```powershell
$env:NOTEAI_DATA_DIR = "$env:TEMP\noteai-dev"; npm start
```

NoteAI allows only one instance per data folder. With the default folder, a running `NoteAI.exe`
takes over: `npm start` hands its files to that window and exits. Close it first, or use a scratch
`NOTEAI_DATA_DIR` as shown above to run the two side by side.

## Project layout

| Path | What lives there |
|---|---|
| `src/main.js` | Main process: window, files, encodings, session cache, settings, Claude Code bridge, shortcuts |
| `src/preload.js` | The `window.noteai` API. Every new main-process feature the page needs gets a method here. |
| `src/index.html` | Static layout: title bar, command bar, editor area, status bar |
| `src/styles.css` | All styling. Colors are CSS variables with a light set and a `[data-theme="dark"]` set. |
| `src/renderer.js` | UI logic: `Doc` (one per tab), tabs, menus, dialogs, find/replace, rephrase, settings, shortcuts |
| `scripts/install.js` | Builds `NoteAI.exe` and installs it with shortcuts |
| `scripts/make_icon.py` | Draws `assets/icon.ico` and `assets/icon.png` with Pillow |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) and README screenshots |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before larger changes. In particular, read the
parts on undo (`replaceRange`), the highlight mirror layer, and the session cache.

## Conventions

- **No framework, no bundler, no runtime dependencies.** Plain Electron, HTML, CSS and JavaScript keep
  the app small and the code easy to follow. Discuss it in an issue first if something truly needs a
  dependency.
- **Keep the page sandboxed.** The renderer never gets Node.js access. Add a narrow method to
  `preload.js` and an `ipcMain.handle` in `main.js` instead.
- **Edits must stay undoable.** Change editor text through `replaceRange()` (`execCommand('insertText')`),
  never by assigning `textarea.value`, except when loading a file.
- **Follow Windows 11 Notepad** for look and behavior: spacing, menu wording, shortcuts. When in
  doubt, check what Notepad does.
- **Theme with tokens.** Use the existing CSS variables (`--surface`, `--text`, `--hover`, …) and add
  new ones to both themes. Don't hard-code colors.
- Match the surrounding style: 2-space indent, single quotes, semicolons, small named functions.

## Checking your changes

There is no automated test suite yet. Before opening a pull request, run `npm start` with a scratch
`NOTEAI_DATA_DIR` and go through what you touched. For most changes, cover this list:

- [ ] Type in a new tab, close the window, reopen: the tab and its text come back
- [ ] Select text → <kbd>Ctrl</kbd>+<kbd>R</kbd> → text is replaced → <kbd>Ctrl</kbd>+<kbd>Z</kbd> restores it in one step
- [ ] <kbd>Esc</kbd> during a rephrase stops it, and the text is unchanged
- [ ] Find (<kbd>Ctrl</kbd>+<kbd>F</kbd>) highlights matches, and the highlights stay aligned after scrolling and with word wrap off
- [ ] Open, edit and save a UTF-8 file and an ANSI file: encoding and line endings are kept
- [ ] Light and dark themes both look right, including menus, dialogs and the title bar buttons
- [ ] `npm run install-app` builds, installs and launches correctly

## Building and installing

```bash
npm run install-app
```

This packages the app into `dist/` (ignored by git) and installs it to
`%LOCALAPPDATA%\Programs\NoteAI`. See [Packaging and install](docs/ARCHITECTURE.md#packaging-and-install).

## Changing the icon

Edit `scripts/make_icon.py`, then run:

```bash
pip install pillow
npm run icon
```

It writes `assets/icon.ico` (16–256 px), `assets/icon.png` and `assets/icon-preview.png`, a contact
sheet for checking small sizes on dark and light backgrounds. Rebuild with `npm run install-app` to
see the new icon on the taskbar.

## Pull requests

- Keep each PR to one change, and describe what you checked.
- Update `README.md` / `docs/ARCHITECTURE.md` when behavior, shortcuts, settings or file formats change.
- Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- If the UI changes visibly, include a screenshot.
