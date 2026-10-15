// NoteAI main process: window, files, session cache and the Claude Code bridge.
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, shell, session } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = 'NoteAI.Editor';
const DATA_DIR = process.env.NOTEAI_DATA_DIR || path.join(app.getPath('appData'), 'NoteAI');
const SESSION_DIR = path.join(DATA_DIR, 'session');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const CLAUDE_TIMEOUT_MS = 180_000;

// Keep Chromium's own cache folders out of our data folder.
app.setPath('userData', path.join(DATA_DIR, 'electron'));
app.setAppUserModelId(APP_ID);

const SYSTEM_PROMPT =
  'You are the rephrasing engine inside a text editor. ' +
  'You receive an instruction and some text between <text> tags. ' +
  'Reply with ONLY the rewritten text: no preamble, no explanation, no quotes, ' +
  'no markdown code fences, no <text> tags. ' +
  'Write in the same language as the original text unless the instruction says otherwise. ' +
  'Keep names, numbers, links and placeholders exactly as they are, ' +
  'and keep the paragraph and line-break structure where it makes sense.';

const DEFAULT_SETTINGS = {
  version: 3,
  model: 'haiku',
  style: 'Improve (clearer)',
  preview: false,
  theme: 'system',
  word_wrap: true,
  status_bar: true,
  spellcheck: true,
  font_family: 'Consolas',
  font_size: 11,
  zoom: 100,
  bounds: null,
  maximized: false,
  last_custom: '',
};

const THEME_CHROME = {
  dark: { color: '#202020', symbolColor: '#ffffff', background: '#272727' },
  light: { color: '#f3f3f3', symbolColor: '#1a1a1a', background: '#fbfbfb' },
};
const TITLE_BAR_HEIGHT = 44;

let win = null;
let settings = loadSettings();
let pendingFiles = filesFromArgv(process.argv);
let allowClose = false;
const jobs = new Map();

// ----- Helpers ----------------------------------------------------------------

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {}
  const s = { ...DEFAULT_SETTINGS, ...saved, version: DEFAULT_SETTINGS.version };
  // Settings written by the first (Python) version of NoteAI.
  if (!s.bounds && typeof saved.geometry === 'string') {
    const m = saved.geometry.match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
    if (m) s.bounds = { width: +m[1], height: +m[2], x: +m[3], y: +m[4] };
  }
  delete s.geometry;
  if (!saved.version || saved.version < 2) s.preview = false;
  return s;
}

function saveSettings() {
  try {
    writeAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch {}
}

function filesFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.filter((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a)).map((a) => path.resolve(a));
}

function isDark() {
  return nativeTheme.shouldUseDarkColors;
}

function applyWindowChrome() {
  if (!win) return;
  const chrome = THEME_CHROME[isDark() ? 'dark' : 'light'];
  win.setBackgroundColor(chrome.background);
  try {
    win.setTitleBarOverlay({ color: chrome.color, symbolColor: chrome.symbolColor, height: TITLE_BAR_HEIGHT });
  } catch {}
}

// ----- Text files ---------------------------------------------------------------

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16le' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
  }
}

function readTextFile(file) {
  const { text, encoding } = decode(fs.readFileSync(file));
  const eol = /\r\n/.test(text) || !/\n/.test(text) ? 'crlf' : 'lf';
  return { path: file, text: text.replace(/\r\n?/g, '\n'), encoding, eol };
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf-8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf-16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'windows-1252':
      if (/[^\u0000-ÿ]/.test(text)) return null; // can't be represented: caller falls back to UTF-8
      return Buffer.from(text, 'latin1');
    default:
      return Buffer.from(text, 'utf8');
  }
}

// ----- Session cache (unsaved text survives closing the app) --------------------

const LEGACY_ENCODINGS = { 'utf-16': 'utf-16le', cp1252: 'windows-1252', 'latin-1': 'windows-1252' };

function tkIndexToOffset(text, index) {
  // The Python version stored the cursor as Tk "line.column".
  const m = /^(\d+)\.(\d+)$/.exec(String(index || ''));
  if (!m) return 0;
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(+m[1] - 1, lines.length); i++) offset += lines[i].length + 1;
  return Math.min(text.length, offset + +m[2]);
}

function loadSession() {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'index.json'), 'utf8'));
  } catch {
    return { selected: 0, tabs: [] };
  }
  const tabs = [];
  for (const t of index.tabs || []) {
    let text = null;
    if (t.cached) {
      try {
        text = fs.readFileSync(path.join(SESSION_DIR, `${t.id}.txt`), 'utf8');
      } catch {}
    }
    let encoding = LEGACY_ENCODINGS[t.encoding] || t.encoding || 'utf-8';
    let eol = t.eol || 'crlf';
    const dirty = text !== null;
    if (text === null && t.path) {
      try {
        ({ text, encoding, eol } = readTextFile(t.path));
      } catch {
        continue; // file is gone and nothing unsaved was cached
      }
    }
    text = text || '';
    const cursor = typeof t.cursor === 'number' ? t.cursor : tkIndexToOffset(text, t.cursor);
    tabs.push({ id: t.id, path: t.path || null, encoding, eol, text, dirty, cursor, scroll: t.scroll || 0 });
  }
  return { selected: index.selected || 0, tabs };
}

function saveSession({ selected, tabs, contents }) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const keep = new Set();
  for (const t of tabs) {
    if (!t.cached) continue;
    keep.add(`${t.id}.txt`);
    const target = path.join(SESSION_DIR, `${t.id}.txt`);
    if (contents && Object.prototype.hasOwnProperty.call(contents, t.id)) writeAtomic(target, contents[t.id]);
  }
  writeAtomic(path.join(SESSION_DIR, 'index.json'), JSON.stringify({ version: 2, selected, tabs }, null, 1));
  for (const name of fs.readdirSync(SESSION_DIR)) {
    if (name.endsWith('.txt') && !keep.has(name)) fs.rmSync(path.join(SESSION_DIR, name), { force: true });
  }
}

// ----- Claude Code ----------------------------------------------------------------

function findClaude() {
  const home = os.homedir();
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [];
  for (const dir of dirs) candidates.push(path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd'));
  candidates.push(
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  );
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

function spawnClaude(exe, args) {
  const options = { cwd: os.tmpdir(), windowsHide: true }; // tmp cwd keeps project CLAUDE.md files out
  if (exe.toLowerCase().endsWith('.cmd')) {
    const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
    return spawn([quote(exe), ...args.map(quote)].join(' '), { ...options, shell: true });
  }
  return spawn(exe, args, options);
}

function cleanResult(text) {
  let t = text.trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  const tagged = t.match(/^<text>\s*([\s\S]*?)\s*<\/text>$/);
  if (tagged) t = tagged[1].trim();
  return t;
}

function rephrase({ jobId, instruction, text, model }) {
  return new Promise((resolve) => {
    const exe = findClaude();
    if (!exe) {
      resolve({
        status: 'error',
        message:
          'Claude Code was not found on this PC. Install it from claude.com/claude-code and sign in by running `claude` once in a terminal.',
      });
      return;
    }
    const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', SYSTEM_PROMPT];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      jobs.delete(jobId);
      resolve(result);
    };
    const child = spawnClaude(exe, args);
    jobs.set(jobId, child);
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.timedOut = true;
      child.kill();
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish({ status: 'error', message: `Could not start Claude Code: ${e.message}` }));
    child.on('close', (code) => {
      if (child.cancelled) return finish({ status: 'cancelled' });
      if (child.timedOut) return finish({ status: 'error', message: 'Claude took too long to answer (timed out).' });
      const stdout = Buffer.concat(out).toString('utf8');
      const result = cleanResult(stdout);
      if (code !== 0 || !result) {
        const detail = (Buffer.concat(err).toString('utf8').trim() || stdout.trim() || `exit code ${code}`).slice(-1500);
        return finish({ status: 'error', message: `Claude Code returned an error:\n\n${detail}` });
      }
      finish({ status: 'ok', text: result });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`Instruction: ${instruction}\n\n<text>\n${text}\n</text>`, 'utf8');
  });
}

// ----- Shortcuts (Start menu / Desktop) --------------------------------------------

function writeShortcuts({ desktop }) {
  const options = {
    target: process.execPath,
    appUserModelId: APP_ID,
    icon: process.execPath,
    iconIndex: 0,
    description: 'Notepad with Claude-powered rephrasing',
  };
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NoteAI.lnk');
  shell.writeShortcutLink(startMenu, fs.existsSync(startMenu) ? 'replace' : 'create', options);
  if (desktop) {
    const link = path.join(app.getPath('desktop'), 'NoteAI.lnk');
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', options);
  }
}

// ----- Window ---------------------------------------------------------------------

function createWindow() {
  nativeTheme.themeSource = settings.theme;
  const chrome = THEME_CHROME[isDark() ? 'dark' : 'light'];
  const bounds = settings.bounds || { width: 1100, height: 720 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 320,
    show: false,
    title: 'NoteAI',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: chrome.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbolColor, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (settings.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  wc.setVisualZoomLevelLimits(1, 1);
  wc.on('context-menu', (_e, p) => {
    wc.send('context-menu', {
      x: p.x,
      y: p.y,
      isEditable: p.isEditable,
      misspelledWord: p.misspelledWord,
      suggestions: p.dictionarySuggestions || [],
    });
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (allowClose) {
      settings.maximized = win.isMaximized();
      if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
      saveSettings();
      return;
    }
    e.preventDefault();
    wc.send('request-close'); // renderer flushes the session cache, then calls window:close
    setTimeout(() => {
      allowClose = true; // the page didn't answer; close anyway (the cache is saved continuously)
      win?.close();
    }, 4000);
  });
  win.on('closed', () => {
    win = null;
  });
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ----- IPC ------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('init', () => {
    const files = pendingFiles;
    pendingFiles = [];
    const opened = [];
    for (const f of files) {
      try {
        opened.push(readTextFile(f));
      } catch {}
    }
    return { settings, session: loadSession(), files: opened, dark: isDark() };
  });

  ipcMain.handle('open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text documents', extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    const files = [];
    for (const f of r.filePaths) {
      try {
        files.push(readTextFile(f));
      } catch (e) {
        files.push({ path: f, error: e.message });
      }
    }
    return files;
  });

  ipcMain.handle('save-dialog', async (_e, suggestedName) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters: [
        { name: 'Text documents', extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('save-file', (_e, { path: file, text, encoding, eol }) => {
    try {
      const body = eol === 'lf' ? text : text.replace(/\n/g, '\r\n');
      let buf = encode(body, encoding);
      let usedEncoding = encoding;
      if (!buf) {
        buf = encode(body, 'utf-8');
        usedEncoding = 'utf-8';
      }
      fs.writeFileSync(file, buf);
      return { ok: true, encoding: usedEncoding };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('save-session', (_e, payload) => {
    try {
      saveSession(payload);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('save-settings', (_e, next) => {
    settings = { ...settings, ...next };
    if (next.theme) {
      nativeTheme.themeSource = settings.theme;
      applyWindowChrome();
    }
    saveSettings();
    return isDark();
  });

  ipcMain.handle('rephrase', (_e, req) => rephrase(req));
  ipcMain.handle('cancel-rephrase', (_e, jobId) => {
    const child = jobs.get(jobId);
    if (child) {
      child.cancelled = true;
      child.kill();
    }
  });

  ipcMain.handle('claude-info', () => {
    const exe = findClaude();
    if (!exe) return { found: false };
    return new Promise((resolve) => {
      execFile(exe, ['--version'], { windowsHide: true, timeout: 30_000, shell: exe.endsWith('.cmd') },
        (err, stdout) => resolve({ found: true, path: exe, version: err ? null : stdout.trim() }));
    });
  });

  ipcMain.on('replace-misspelling', (_e, word) => win?.webContents.replaceMisspelling(word));
  ipcMain.on('add-to-dictionary', (_e, word) => session.defaultSession.addWordToSpellCheckerDictionary(word));
  ipcMain.on('set-title', (_e, title) => win?.setTitle(title));
  ipcMain.on('window:close', () => {
    allowClose = true;
    win?.close();
  });
}

// ----- App lifecycle --------------------------------------------------------------

if (process.argv.includes('--install-shortcuts')) {
  app.whenReady().then(() => {
    writeShortcuts({ desktop: true });
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running window gets our files through 'second-instance'
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    const opened = [];
    for (const f of files) {
      try {
        opened.push(readTextFile(f));
      } catch {}
    }
    win?.webContents.send('open-files', { files: opened, newTab: opened.length === 0 });
    focusWindow();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    nativeTheme.on('updated', () => {
      applyWindowChrome();
      win?.webContents.send('theme-changed', isDark());
    });
    if (app.isPackaged) {
      try {
        writeShortcuts({ desktop: false }); // keeps the Start menu entry (and taskbar pin) pointing here
      } catch {}
    }
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
