# Changelog

## Unreleased

## 2.0.0

Rebuilt with Electron to look and behave like Windows 11 Notepad.

- Tabs in the title bar with native Windows window controls. Tabs can be dragged to reorder, and untitled tabs are named after their first line.
- Command bar with File / Edit / View menus, the Rephrase split button, Custom, the model chip, a theme toggle and Settings.
- Rephrasing replaces the text right away. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes it in one step. Preview mode is optional.
- The text being rephrased shimmers, and the button turns into **Stop** while Claude works.
- Find and replace highlights every match.
- Spell check with right-click suggestions.
- Windows 11-style Settings page: theme, font, word wrap, spell check, status bar, model, default style and preview.
- Keeps each file's encoding (UTF-8, UTF-8 with BOM, UTF-16, ANSI) and line endings.
- New app icon. `npm run install-app` builds `NoteAI.exe` and adds Start menu and Desktop shortcuts.
- Restores tabs and settings saved by NoteAI 1.x.

## 1.0.0

The first version, built with Python and Tkinter.

- Notepad-style editor with tabs, find/replace and Go to line.
- Rephrase through the local Claude Code CLI (`claude -p`, tools disabled) with seven styles and custom instructions.
- Tabs and unsaved text kept between runs.
- Light, dark and system themes.
