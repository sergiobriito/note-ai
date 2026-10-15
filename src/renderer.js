// NoteAI renderer: tabs, editor, menus, find, rephrase, settings.
'use strict';

const STYLES = {
  'Improve (clearer)': 'Rephrase this so it is clearer and reads more naturally. Keep the same meaning and tone.',
  'Fix grammar & spelling': 'Fix grammar, spelling and punctuation only. Change as little as possible.',
  'More formal': 'Rewrite this in a more formal, professional tone.',
  'More casual': 'Rewrite this in a more casual, friendly tone.',
  Shorter: 'Make this more concise. Remove filler but keep every important point.',
  Longer: 'Expand this with a bit more detail and smoother flow, without inventing new facts.',
  Simpler: 'Rewrite this in simple, plain language that is easy to understand.',
};
const STYLE_SHORT = {
  'Improve (clearer)': 'Improve',
  'Fix grammar & spelling': 'Fix grammar',
  'More formal': 'Formal',
  'More casual': 'Casual',
  Shorter: 'Shorter',
  Longer: 'Longer',
  Simpler: 'Simpler',
};
const MODELS = [
  ['haiku', 'Haiku', 'Fastest'],
  ['sonnet', 'Sonnet', 'Balanced'],
  ['opus', 'Opus', 'Best quality'],
];
const CUSTOM_IDEAS = ['Translate to English', 'Make it sound confident', 'Turn it into bullet points', 'Write it as a polite email', 'Make it friendlier'];
const FONTS = ['Consolas', 'Cascadia Mono', 'Cascadia Code', 'Lucida Console', 'Courier New', 'Segoe UI', 'Segoe UI Variable Text', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Verdana'];
const ENCODING_LABEL = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 with BOM', 'utf-16le': 'UTF-16 LE', 'windows-1252': 'ANSI' };
const G = { // Segoe Fluent Icons
  check: '', chevronRight: '', chevronDown: '', sun: '', moon: '', stop: '',
};

const $ = (sel) => document.querySelector(sel);
const api = window.noteai;

let settings = {};
let docs = [];
let current = null;
let job = null;
let sessionTimer = null;
let activityTimer = null;

// ----- Documents -----------------------------------------------------------------

class Doc {
  constructor({ id, path = null, encoding = 'utf-8', eol = 'crlf', text = '', dirty = false, cursor = 0, scroll = 0 } = {}) {
    this.id = id || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    this.path = path;
    this.encoding = encoding;
    this.eol = eol;
    this.dirty = dirty;
    this.version = 0;
    this.cachedVersion = dirty ? 0 : -1; // restored dirty text is already in the cache
    this.pendingScroll = scroll;

    const ta = (this.ta = document.createElement('textarea'));
    ta.value = text;
    ta.hidden = true;
    ta.spellcheck = settings.spellcheck !== false;
    ta.wrap = settings.word_wrap === false ? 'off' : 'soft';
    ta.setAttribute('aria-label', 'Text editor');
    const pos = Math.min(cursor || 0, text.length);
    ta.setSelectionRange(pos, pos);
    ta.addEventListener('input', () => this.changed());
    for (const ev of ['keyup', 'mouseup', 'select', 'focus']) ta.addEventListener(ev, () => this === current && updateStatus());
    document.addEventListener('selectionchange', () => this === current && document.activeElement === ta && updateStatus());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (!ta.readOnly) document.execCommand('insertText', false, '\t');
      }
    });
    ta.addEventListener('scroll', () => {
      if (this === current) syncHighlightScroll();
      scheduleSession(2000);
    }, { passive: true });
    $('#editors').appendChild(ta);
  }

  get title() {
    if (this.path) return this.path.split(/[\\/]/).pop();
    const first = this.ta.value.split('\n').find((l) => l.trim());
    return first ? first.trim().slice(0, 60) : 'Untitled';
  }

  isBlank() {
    return !this.path && this.ta.value === '';
  }

  changed() {
    this.version++;
    const wasDirty = this.dirty;
    this.dirty = true;
    if (!wasDirty || !this.path) renderTab(this); // dirty dot, or the untitled title follows line 1
    if (this === current) {
      updateStatus();
      updateTitle();
      if (!$('#findbar').hidden) updateFindCount();
    }
    scheduleSession();
  }
}

function addDoc(doc, { select = true, index = docs.length } = {}) {
  docs.splice(index, 0, doc);
  renderTabs();
  if (select) selectDoc(doc);
  return doc;
}

function newTab() {
  return addDoc(new Doc(), { index: current ? docs.indexOf(current) + 1 : docs.length });
}

function selectDoc(doc) {
  if (current && current !== doc) current.ta.hidden = true;
  current = doc;
  doc.ta.hidden = false;
  if (doc.pendingScroll) {
    const top = doc.pendingScroll;
    doc.pendingScroll = 0;
    requestAnimationFrame(() => (doc.ta.scrollTop = top));
  }
  renderTabs();
  updateStatus();
  updateTitle();
  doc.ta.focus({ preventScroll: true });
  if (!$('#findbar').hidden) updateFindCount();
  else renderHighlights();
  scheduleSession(2000);
}

function cycleTab(step) {
  if (docs.length < 2) return;
  const i = docs.indexOf(current);
  selectDoc(docs[(i + step + docs.length) % docs.length]);
}

async function closeDoc(doc) {
  if (doc.dirty && !doc.isBlank()) {
    selectDoc(doc);
    const choice = await choiceDialog('NoteAI', `Do you want to save changes to ${doc.title}?`, [
      { id: 'save', label: 'Save', primary: true },
      { id: 'dont', label: "Don't save" },
      { id: 'cancel', label: 'Cancel' },
    ]);
    if (choice !== 'save' && choice !== 'dont') return false;
    if (choice === 'save' && !(await save(doc))) return false;
  }
  if (job && job.doc === doc) cancelJob();
  const index = docs.indexOf(doc);
  docs.splice(index, 1);
  doc.ta.remove();
  if (!docs.length) {
    current = null;
    await saveSessionNow();
    api.closeWindow(); // closing the last tab closes the window, like Notepad
    return true;
  }
  if (current === doc) {
    current = null;
    selectDoc(docs[Math.min(index, docs.length - 1)]);
  } else {
    renderTabs();
  }
  scheduleSession(0);
  return true;
}

// ----- Tabs ----------------------------------------------------------------------

let dragDoc = null;

function renderTabs() {
  const strip = $('#tabs');
  strip.textContent = '';
  const activeIndex = docs.indexOf(current);
  docs.forEach((doc, i) => {
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.draggable = true;
    el.innerHTML =
      '<span class="corner l"></span><span class="title"></span>' +
      '<button class="close" title="Close tab (Ctrl+W)"><span class="glyph"></span><span class="dot"></span></button>' +
      '<span class="corner r"></span>';
    doc.tabEl = el;
    if (i === activeIndex - 1) el.classList.add('before-active');
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.close')) selectDoc(doc);
    });
    el.addEventListener('auxclick', (e) => e.button === 1 && closeDoc(doc));
    el.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDoc(doc);
    });
    el.addEventListener('dragstart', (e) => {
      dragDoc = doc;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      dragDoc = null;
      renderTabs();
      scheduleSession();
    });
    el.addEventListener('dragover', (e) => {
      if (!dragDoc || dragDoc === doc) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      const from = docs.indexOf(dragDoc);
      docs.splice(from, 1);
      let to = docs.indexOf(doc) + (after ? 1 : 0);
      docs.splice(to, 0, dragDoc);
      if (from !== docs.indexOf(dragDoc)) {
        renderTabs();
        dragDoc.tabEl.classList.add('dragging');
      }
    });
    strip.appendChild(el);
    renderTab(doc);
  });
}

function renderTab(doc) {
  const el = doc.tabEl;
  if (!el) return;
  el.classList.toggle('active', doc === current);
  el.classList.toggle('dirty', doc.dirty);
  el.classList.toggle('working', !!job && job.doc === doc);
  el.querySelector('.title').textContent = doc.title;
  el.title = doc.path || doc.title;
}

// ----- Status bar & title ------------------------------------------------------------

function updateTitle() {
  if (current) api.setTitle(`${current.title} - NoteAI`);
}

function updateStatus() {
  if (!current) return;
  const ta = current.ta;
  const value = ta.value;
  const caret = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
  let line = 1;
  let lineStart = 0;
  for (let i = value.indexOf('\n'); i !== -1 && i < caret; i = value.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  $('#stPos').textContent = `Ln ${line}, Col ${caret - lineStart + 1}`;
  const total = value.length.toLocaleString();
  const selected = ta.selectionEnd - ta.selectionStart;
  $('#stChars').textContent = selected ? `${selected.toLocaleString()} of ${total} characters` : `${total} characters`;
  $('#stEol').textContent = current.eol === 'lf' ? 'Unix (LF)' : 'Windows (CRLF)';
  $('#stEnc').textContent = ENCODING_LABEL[current.encoding] || current.encoding.toUpperCase();
  $('#stZoom').textContent = `${settings.zoom}%`;
  $('#stModel').textContent = `Claude · ${settings.model}`;
}

// Paints find matches and the text being rephrased on the mirror layer behind the textarea.
function renderHighlights(matches = [], needleLength = 0, currentStart = -1) {
  const layer = $('#highlights');
  if (!current) return;
  const ranges = matches.map((i) => [i, i + needleLength, i === currentStart ? 'current' : '']);
  if (job && job.doc === current) ranges.push([job.start, job.end, 'working']);
  if (!ranges.length) {
    layer.textContent = '';
    return;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const text = current.ta.value;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  let pos = 0;
  for (const [start, end, cls] of ranges) {
    if (start < pos) continue;
    html += esc(text.slice(pos, start)) + `<mark class="${cls}">${esc(text.slice(start, end))}</mark>`;
    pos = end;
  }
  layer.innerHTML = `${html}${esc(text.slice(pos))}​`;
  syncHighlightScroll();
}

function syncHighlightScroll() {
  const layer = $('#highlights');
  layer.scrollTop = current.ta.scrollTop;
  layer.scrollLeft = current.ta.scrollLeft;
}

function setActivity(text, kind = '') {
  const el = $('#stActivity');
  el.textContent = text;
  el.className = `seg activity ${kind}`;
  clearTimeout(activityTimer);
  if (text && kind !== 'working') activityTimer = setTimeout(() => setActivity(''), 8000);
}

// ----- Settings -------------------------------------------------------------------

function applySettings() {
  const px = ((settings.font_size || 11) * 4) / 3 * ((settings.zoom || 100) / 100);
  document.documentElement.style.setProperty('--editor-size', `${px.toFixed(2)}px`);
  document.documentElement.style.setProperty('--editor-font', `"${settings.font_family}", Consolas, monospace`);
  for (const d of docs) {
    d.ta.wrap = settings.word_wrap ? 'soft' : 'off';
    d.ta.spellcheck = settings.spellcheck;
  }
  $('#statusbar').hidden = !settings.status_bar;
  $('#editors').classList.toggle('nowrap', !settings.word_wrap);
  $('#styleChip').textContent = STYLE_SHORT[settings.style] || settings.style;
  $('#modelLabel').textContent = MODELS.find((m) => m[0] === settings.model)?.[1] || settings.model;
  updateStatus();
}

async function setSetting(changes) {
  Object.assign(settings, changes);
  applySettings();
  const dark = await api.saveSettings(changes);
  if ('theme' in changes) setDark(dark);
}

function setDark(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeGlyph').textContent = dark ? G.sun : G.moon;
}

function zoom(step) {
  const next = step === 0 ? 100 : Math.max(10, Math.min(500, settings.zoom + step * 10));
  setSetting({ zoom: next });
}

// ----- Session cache ----------------------------------------------------------------

function scheduleSession(delay = 800) {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, delay);
}

async function saveSessionNow() {
  clearTimeout(sessionTimer);
  const contents = {};
  const written = [];
  const tabs = docs.map((d) => {
    const cached = d.dirty || (!d.path && d.ta.value !== '');
    if (cached && d.cachedVersion !== d.version) {
      contents[d.id] = d.ta.value;
      written.push([d, d.version]);
    }
    if (!cached) d.cachedVersion = -1;
    return { id: d.id, path: d.path, encoding: d.encoding, eol: d.eol, cached, cursor: d.ta.selectionStart, scroll: d.ta.scrollTop };
  });
  const ok = await api.saveSession({ selected: Math.max(0, docs.indexOf(current)), tabs, contents });
  if (ok) for (const [d, v] of written) d.cachedVersion = v;
}

// ----- Files ---------------------------------------------------------------------

function openFiles(files) {
  for (const f of files) {
    if (f.error) {
      alertDialog('Could not open the file', `${f.path}\n\n${f.error}`);
      continue;
    }
    const existing = docs.find((d) => d.path && d.path.toLowerCase() === f.path.toLowerCase());
    if (existing) {
      selectDoc(existing);
      continue;
    }
    const doc = new Doc({ path: f.path, text: f.text, encoding: f.encoding, eol: f.eol });
    if (current && current.isBlank() && !current.dirty) {
      const blank = current;
      const index = docs.indexOf(blank);
      docs.splice(index, 1);
      blank.ta.remove();
      current = null;
      addDoc(doc, { index });
    } else {
      addDoc(doc, { index: current ? docs.indexOf(current) + 1 : docs.length });
    }
  }
}

async function openFile() {
  openFiles(await api.openDialog());
}

function suggestedName(doc) {
  if (doc.path) return doc.path;
  const name = doc.title === 'Untitled' ? 'Untitled' : doc.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40).trim();
  return `${name || 'Untitled'}.txt`;
}

async function save(doc = current) {
  return doc.path ? writeDoc(doc, doc.path) : saveAs(doc);
}

async function saveAs(doc = current) {
  const file = await api.saveDialog(suggestedName(doc));
  return file ? writeDoc(doc, file) : false;
}

async function saveAll() {
  for (const d of docs) if (d.dirty && !d.isBlank()) if (!(await save(d))) return;
}

async function writeDoc(doc, file) {
  const r = await api.saveFile({ path: file, text: doc.ta.value, encoding: doc.encoding, eol: doc.eol });
  if (!r.ok) {
    await alertDialog('Could not save the file', r.message);
    return false;
  }
  doc.path = file;
  doc.encoding = r.encoding;
  doc.dirty = false;
  renderTab(doc);
  if (doc === current) {
    updateTitle();
    updateStatus();
  }
  setActivity(`Saved ${doc.title}`, 'done');
  scheduleSession(0);
  return true;
}

// ----- Editing helpers ------------------------------------------------------------------

function replaceRange(doc, start, end, text) {
  // execCommand keeps the change on the textarea's own undo stack (Ctrl+Z works).
  const ta = doc.ta;
  const readOnly = ta.readOnly;
  ta.readOnly = false;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  document.execCommand('insertText', false, text);
  ta.readOnly = readOnly;
}

function selectAndReveal(doc, start, end, keepFocusOn) {
  const ta = doc.ta;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, start);
  ta.blur();
  ta.focus(); // caret move scrolls the match into view
  ta.setSelectionRange(start, end);
  if (keepFocusOn) keepFocusOn.focus({ preventScroll: true });
  updateStatus();
}

function insertDateTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  replaceRange(current, current.ta.selectionStart, current.ta.selectionEnd, stamp);
}

function editCommand(cmd) {
  current.ta.focus();
  document.execCommand(cmd);
}

async function paste() {
  current.ta.focus();
  try {
    const text = await navigator.clipboard.readText();
    document.execCommand('insertText', false, text);
  } catch {
    document.execCommand('paste');
  }
}

async function gotoLine() {
  const lines = current.ta.value.split('\n');
  const answer = await inputDialog('Go to line', `Line number (1 - ${lines.length})`, '', { numeric: true });
  const n = parseInt(answer, 10);
  if (!n) return;
  const line = Math.max(1, Math.min(lines.length, n));
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
  selectAndReveal(current, offset, offset);
}

// ----- Find & replace -------------------------------------------------------------------

const find = { caseSensitive: false };

function openFind(replace = false) {
  const bar = $('#findbar');
  bar.hidden = false;
  $('#replaceRow').hidden = !replace;
  $('#findToggleGlyph').textContent = replace ? G.chevronDown : G.chevronRight;
  const ta = current.ta;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (sel && !sel.includes('\n')) $('#findInput').value = sel;
  $('#findInput').focus();
  $('#findInput').select();
  updateFindCount();
}

function closeFind() {
  $('#findbar').hidden = true;
  renderHighlights();
  current?.ta.focus();
}

function matchesIn(text, needle) {
  if (!needle) return [];
  const hay = find.caseSensitive ? text : text.toLowerCase();
  const n = find.caseSensitive ? needle : needle.toLowerCase();
  const out = [];
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) out.push(i);
  return out;
}

function updateFindCount() {
  const needle = $('#findInput').value;
  const matches = matchesIn(current.ta.value, needle);
  const ta = current.ta;
  const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const onMatch = needle && (find.caseSensitive ? selected === needle : selected.toLowerCase() === needle.toLowerCase());
  const at = onMatch ? matches.indexOf(ta.selectionStart) : -1;
  $('#findCount').textContent = !needle ? '' : matches.length ? `${at >= 0 ? `${at + 1} of ` : ''}${matches.length}${at >= 0 ? '' : ' found'}` : 'No results';
  renderHighlights(matches, needle.length, at >= 0 ? ta.selectionStart : -1);
}

function findNext(dir = 1, keepFocus = true) {
  const needle = $('#findInput').value;
  if (!needle) {
    openFind();
    return false;
  }
  const ta = current.ta;
  const matches = matchesIn(ta.value, needle);
  if (!matches.length) {
    updateFindCount();
    return false;
  }
  let target;
  if (dir > 0) target = matches.find((i) => i >= ta.selectionEnd) ?? matches[0];
  else target = [...matches].reverse().find((i) => i < ta.selectionStart) ?? matches[matches.length - 1];
  const focusBack = keepFocus && !$('#findbar').hidden ? document.activeElement : null;
  selectAndReveal(current, target, target + needle.length, focusBack && focusBack !== ta ? focusBack : null);
  updateFindCount();
  return true;
}

function replaceOne() {
  const needle = $('#findInput').value;
  const ta = current.ta;
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const same = find.caseSensitive ? sel === needle : sel.toLowerCase() === needle.toLowerCase();
  if (needle && same) replaceRange(current, ta.selectionStart, ta.selectionEnd, $('#replaceInput').value);
  findNext(1);
  $('#replaceInput').focus();
}

function replaceAll() {
  const needle = $('#findInput').value;
  if (!needle) return;
  const ta = current.ta;
  const matches = matchesIn(ta.value, needle);
  if (!matches.length) return;
  const replacement = $('#replaceInput').value;
  let out = '';
  let last = 0;
  for (const i of matches) {
    out += ta.value.slice(last, i) + replacement;
    last = i + needle.length;
  }
  out += ta.value.slice(last);
  replaceRange(current, 0, ta.value.length, out); // one Ctrl+Z undoes all of it
  ta.setSelectionRange(0, 0);
  $('#replaceInput').focus();
  setActivity(`Replaced ${matches.length} occurrence${matches.length === 1 ? '' : 's'}`, 'done');
  updateFindCount();
}

function initFind() {
  $('#findInput').addEventListener('input', updateFindCount);
  $('#findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findNext(e.shiftKey ? -1 : 1);
    }
  });
  $('#replaceInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.ctrlKey && e.altKey ? replaceAll() : replaceOne();
    }
  });
  $('#findNext').onclick = () => findNext(1);
  $('#findPrev').onclick = () => findNext(-1);
  $('#findClose').onclick = closeFind;
  $('#replaceOne').onclick = replaceOne;
  $('#replaceAll').onclick = replaceAll;
  $('#findToggle').onclick = () => openFind($('#replaceRow').hidden);
  $('#findCase').onclick = () => {
    find.caseSensitive = !find.caseSensitive;
    $('#findCase').classList.toggle('on', find.caseSensitive);
    updateFindCount();
  };
}

// ----- Rephrase ---------------------------------------------------------------------

function rephraseStyle(name) {
  if (settings.style !== name) setSetting({ style: name });
  rephrase(STYLES[name], STYLE_SHORT[name] || name);
}

async function rephraseCustom() {
  if (job) return;
  const instruction = await inputDialog(
    'Custom rephrase',
    'How should Claude rewrite the text?',
    settings.last_custom || '',
    { ideas: CUSTOM_IDEAS, okLabel: 'Rephrase' },
  );
  if (!instruction || !instruction.trim()) return;
  setSetting({ last_custom: instruction.trim() });
  rephrase(instruction.trim(), 'Custom');
}

async function rephrase(instruction, label, range = null) {
  if (job) {
    setActivity('Claude is still working… press Esc to stop', 'working');
    return;
  }
  const doc = current;
  const ta = doc.ta;
  let [start, end] = range || [ta.selectionStart, ta.selectionEnd];
  let scope = 'selection';
  if (start === end) {
    start = 0;
    end = ta.value.length;
    scope = 'note';
  }
  const original = ta.value.slice(start, end);
  if (!original.trim()) {
    setActivity('Type or select some text to rephrase', 'error');
    return;
  }
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  ta.readOnly = true; // keeps the target text still while Claude works
  job = { id: crypto.randomUUID(), doc, start, end, original, label, instruction, startedAt: Date.now() };
  setBusy(true, scope);
  renderHighlights();

  const res = await api.rephrase({ jobId: job.id, instruction, text: original.trim(), model: settings.model });
  job = null;
  ta.readOnly = false;
  setBusy(false);
  if (doc === current) renderHighlights();
  if (!docs.includes(doc)) return;
  if (res.status === 'cancelled') return setActivity('Rephrase stopped');
  if (res.status === 'error') {
    setActivity('Rephrase failed', 'error');
    return alertDialog('Rephrase failed', res.message);
  }

  const lead = original.match(/^\s*/)[0];
  const trail = original.slice(lead.length).match(/\s*$/)[0];
  let text = res.text;
  if (settings.preview) {
    const choice = await previewDialog(original.trim(), text, label);
    if (!choice || !docs.includes(doc)) return;
    if (choice.action === 'retry') {
      selectDoc(doc);
      return rephrase(instruction, label, [start, end]);
    }
    text = choice.text.trim();
    if (choice.action === 'insert') {
      if (doc !== current) selectDoc(doc);
      replaceRange(doc, end, end, `\n\n${text}`);
      return;
    }
  }
  if (doc !== current) selectDoc(doc);
  const replacement = lead + text + trail;
  replaceRange(doc, start, end, replacement);
  doc.ta.setSelectionRange(start + lead.length, start + lead.length + text.length);
  updateStatus();
  setActivity(`Rephrased (${label}) · Ctrl+Z to undo`, 'done');
}

function cancelJob() {
  if (job) api.cancelRephrase(job.id);
}

function setBusy(busy, scope) {
  $('#rephraseSplit').classList.toggle('busy', busy);
  $('#rephraseLabel').textContent = busy ? 'Stop' : 'Rephrase';
  $('#rephraseBtn').title = busy ? 'Stop rephrasing (Esc)' : 'Rephrase the selection, or the whole note (Ctrl+R)';
  $('#customBtn').disabled = busy;
  $('#progress').classList.toggle('on', busy);
  if (job) renderTab(job.doc);
  for (const d of docs) renderTab(d);
  if (busy) {
    const tick = () => {
      if (!job) return;
      const s = Math.floor((Date.now() - job.startedAt) / 1000);
      setActivity(`Rephrasing ${scope} with Claude… ${s}s`, 'working');
      setTimeout(tick, 500);
    };
    tick();
  } else {
    setActivity('');
  }
}

// ----- Menus ----------------------------------------------------------------------

let openMenus = [];
let menuBarOpen = null;

function closeMenus({ refocus = true } = {}) {
  for (const m of openMenus) m.el.remove();
  openMenus = [];
  document.querySelectorAll('.menu-btn.open, .split-arrow.open, .chip-btn.open').forEach((b) => b.classList.remove('open'));
  menuBarOpen = null;
  if (refocus && current && !document.querySelector('.overlay')) current.ta.focus({ preventScroll: true });
}

function showMenu(items, { x, y, anchor, level = 0, align = 'left' } = {}) {
  while (openMenus.length > level) openMenus.pop().el.remove();
  const el = document.createElement('div');
  el.className = 'menu';
  el.tabIndex = -1;
  const rows = [];
  for (const item of items) {
    if (item.separator) {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
      continue;
    }
    if (item.header) {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'header', textContent: item.header }));
      continue;
    }
    const row = document.createElement('div');
    row.className = `item${item.disabled ? ' disabled' : ''}${item.bold ? ' bold' : ''}`;
    const icon = document.createElement('span');
    icon.className = item.icon === 'sparkle' ? 'icon-cell' : 'check';
    if (item.icon === 'sparkle') icon.innerHTML = '<svg><use href="#i-sparkle"/></svg>';
    else icon.textContent = item.checked ? G.check : '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    if (item.note) label.appendChild(Object.assign(document.createElement('small'), { textContent: item.note }));
    const shortcut = Object.assign(document.createElement('span'), { className: 'shortcut', textContent: item.shortcut || '' });
    const sub = Object.assign(document.createElement('span'), { className: 'sub', textContent: item.submenu ? G.chevronRight : '' });
    row.append(icon, label, shortcut, sub);
    row.addEventListener('mouseenter', () => activate(rows.indexOf(entry), true));
    row.addEventListener('click', () => choose(entry));
    const entry = { row, item };
    rows.push(entry);
    el.appendChild(row);
  }
  document.getElementById('menuLayer').appendChild(el);

  // Position (flip / clamp to the window)
  const r = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === 'right' ? a.right - r.width : a.left;
    top = a.bottom + 4;
  }
  if (left + r.width > innerWidth - 4) left = level > 0 && x != null ? x - r.width - openMenus[level - 1].el.offsetWidth + 8 : innerWidth - r.width - 4;
  if (top + r.height > innerHeight - 4) top = Math.max(4, innerHeight - r.height - 4);
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${top}px`;

  const menu = { el, rows, active: -1, level };
  openMenus.push(menu);
  el.focus({ preventScroll: true });

  function activate(i, fromMouse) {
    menu.active = i;
    rows.forEach((e, j) => e.row.classList.toggle('active', j === i));
    const entry = rows[i];
    if (fromMouse) {
      clearTimeout(menu.subTimer);
      if (entry?.item.submenu) menu.subTimer = setTimeout(() => openSub(entry), 120);
      else while (openMenus.length > level + 1) openMenus.pop().el.remove();
    }
  }
  function openSub(entry) {
    const rr = entry.row.getBoundingClientRect();
    showMenu(entry.item.submenu, { x: rr.right + 2, y: rr.top - 5, level: level + 1 });
  }
  function choose(entry) {
    if (!entry || entry.item.disabled) return;
    if (entry.item.submenu) return openSub(entry);
    closeMenus({ refocus: !entry.item.keepFocus });
    entry.item.action?.();
  }
  el.addEventListener('keydown', (e) => {
    const enabled = rows.map((r2, i) => (!r2.item.disabled ? i : -1)).filter((i) => i >= 0);
    const pos = enabled.indexOf(menu.active);
    if (e.key === 'ArrowDown') activate(enabled[(pos + 1) % enabled.length]);
    else if (e.key === 'ArrowUp') activate(enabled[(pos - 1 + enabled.length) % enabled.length]);
    else if (e.key === 'Enter' || e.key === ' ') choose(rows[menu.active]);
    else if (e.key === 'ArrowRight' && rows[menu.active]?.item.submenu) openSub(rows[menu.active]);
    else if (e.key === 'ArrowLeft' && level > 0) {
      openMenus.pop().el.remove();
      openMenus[openMenus.length - 1].el.focus();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && menuBarOpen) {
      const keys = ['file', 'edit', 'view'];
      const next = keys[(keys.indexOf(menuBarOpen) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      openMenuBar(next, true);
    } else if (e.key === 'Escape') closeMenus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  return menu;
}

function openMenuBar(key, viaKeyboard = false) {
  closeMenus({ refocus: false });
  const btn = document.querySelector(`.menu-btn[data-menu="${key}"]`);
  btn.classList.add('open');
  const menu = showMenu(MENUS[key](), { anchor: btn });
  menuBarOpen = key;
  if (viaKeyboard) menu.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
}

function styleItems() {
  return [
    { header: 'Rephrase as' },
    ...Object.keys(STYLES).map((name, i) => ({
      label: name,
      shortcut: `Alt+${i + 1}`,
      checked: settings.style === name,
      action: () => rephraseStyle(name),
    })),
    { separator: true },
    { label: 'Custom instruction…', shortcut: 'Ctrl+Shift+R', action: rephraseCustom },
  ];
}

const MENUS = {
  file: () => [
    { label: 'New tab', shortcut: 'Ctrl+N', action: newTab },
    { label: 'Open…', shortcut: 'Ctrl+O', action: openFile },
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl+S', action: () => save() },
    { label: 'Save as…', shortcut: 'Ctrl+Shift+S', action: () => saveAs() },
    { label: 'Save all', shortcut: 'Ctrl+Alt+S', action: saveAll },
    { separator: true },
    { label: 'Close tab', shortcut: 'Ctrl+W', action: () => closeDoc(current) },
    { label: 'Close window', shortcut: 'Alt+F4', action: requestClose },
  ],
  edit: () => [
    { label: 'Undo', shortcut: 'Ctrl+Z', action: () => editCommand('undo') },
    { label: 'Redo', shortcut: 'Ctrl+Y', action: () => editCommand('redo') },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl+X', action: () => editCommand('cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', action: () => editCommand('copy') },
    { label: 'Paste', shortcut: 'Ctrl+V', action: paste },
    { label: 'Delete', shortcut: 'Del', action: () => editCommand('delete') },
    { separator: true },
    { label: 'Find', shortcut: 'Ctrl+F', action: () => openFind(false), keepFocus: true },
    { label: 'Find next', shortcut: 'F3', action: () => findNext(1, false) },
    { label: 'Find previous', shortcut: 'Shift+F3', action: () => findNext(-1, false) },
    { label: 'Replace', shortcut: 'Ctrl+H', action: () => openFind(true), keepFocus: true },
    { label: 'Go to line', shortcut: 'Ctrl+G', action: gotoLine, keepFocus: true },
    { separator: true },
    { label: 'Select all', shortcut: 'Ctrl+A', action: () => editCommand('selectAll') },
    { label: 'Time/Date', shortcut: 'F5', action: insertDateTime },
    { separator: true },
    { label: 'Font', action: openSettings, keepFocus: true },
  ],
  view: () => [
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', shortcut: 'Ctrl+Plus', action: () => zoom(1) },
        { label: 'Zoom out', shortcut: 'Ctrl+Minus', action: () => zoom(-1) },
        { label: 'Restore default zoom', shortcut: 'Ctrl+0', action: () => zoom(0) },
      ],
    },
    {
      label: 'Theme',
      submenu: [
        ['system', 'Use system setting'],
        ['light', 'Light'],
        ['dark', 'Dark'],
      ].map(([value, label]) => ({ label, checked: settings.theme === value, action: () => setSetting({ theme: value }) })),
    },
    { separator: true },
    { label: 'Status bar', checked: settings.status_bar, action: () => setSetting({ status_bar: !settings.status_bar }) },
    { label: 'Word wrap', checked: settings.word_wrap, action: () => setSetting({ word_wrap: !settings.word_wrap }) },
    { label: 'Spell check', checked: settings.spellcheck, action: () => setSetting({ spellcheck: !settings.spellcheck }) },
  ],
};

function contextMenu({ x, y, misspelledWord, suggestions }) {
  const items = [];
  if (misspelledWord) {
    for (const s of suggestions.slice(0, 5)) items.push({ label: s, bold: true, action: () => api.replaceMisspelling(s) });
    if (!suggestions.length) items.push({ label: 'No suggestions', disabled: true });
    items.push({ label: 'Add to dictionary', action: () => api.addToDictionary(misspelledWord) });
    items.push({ separator: true });
  }
  const ta = current.ta;
  const hasSel = ta.selectionEnd > ta.selectionStart;
  items.push(
    {
      label: hasSel ? 'Rephrase selection' : 'Rephrase note',
      icon: 'sparkle',
      shortcut: 'Ctrl+R',
      action: () => rephraseStyle(settings.style),
    },
    { label: 'Rephrase as', submenu: styleItems().slice(1) },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSel, action: () => editCommand('cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSel, action: () => editCommand('copy') },
    { label: 'Paste', shortcut: 'Ctrl+V', action: paste },
    { separator: true },
    { label: 'Select all', shortcut: 'Ctrl+A', action: () => editCommand('selectAll') },
  );
  closeMenus({ refocus: false });
  showMenu(items, { x, y });
}

// ----- Dialogs ----------------------------------------------------------------------

function dialog({ title, body, buttons, wide = false, onKey }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const box = document.createElement('div');
    box.className = `dialog${wide ? ' wide' : ''}`;
    const content = document.createElement('div');
    content.className = 'content';
    if (title) content.appendChild(Object.assign(document.createElement('h2'), { textContent: title }));
    if (typeof body === 'string') content.appendChild(Object.assign(document.createElement('p'), { textContent: body }));
    else if (body) content.appendChild(body);
    const footer = document.createElement('div');
    footer.className = 'footer';
    const finish = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', keys, true);
      current?.ta.focus({ preventScroll: true });
      resolve(value);
    };
    for (const b of buttons) {
      const btn = Object.assign(document.createElement('button'), { className: `btn${b.primary ? ' primary' : ''}`, textContent: b.label });
      btn.onclick = () => finish(b.value ? b.value() : b.id);
      footer.appendChild(btn);
    }
    box.append(content, footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => e.target === overlay && finish(null));
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (onKey) onKey(e, finish);
    };
    document.addEventListener('keydown', keys, true);
    $('#modalLayer').appendChild(overlay);
    const focusTarget = box.querySelector('[autofocus]') || footer.querySelector('.primary');
    focusTarget?.focus();
    if (focusTarget?.select) focusTarget.select();
  });
}

function alertDialog(title, message) {
  return dialog({ title, body: message, buttons: [{ id: 'ok', label: 'OK', primary: true }] });
}

function choiceDialog(title, message, buttons) {
  return dialog({ title, body: message, buttons });
}

function inputDialog(title, prompt, initial = '', { ideas = null, okLabel = 'OK', numeric = false } = {}) {
  const body = document.createElement('div');
  body.appendChild(Object.assign(document.createElement('p'), { textContent: prompt }));
  const input = Object.assign(document.createElement('input'), { value: initial, spellcheck: false });
  if (numeric) input.inputMode = 'numeric';
  input.setAttribute('autofocus', '');
  body.appendChild(input);
  if (ideas) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const idea of ideas) {
      const c = Object.assign(document.createElement('button'), { textContent: idea });
      c.onclick = () => {
        input.value = idea;
        input.focus();
      };
      chips.appendChild(c);
    }
    body.appendChild(chips);
  }
  return dialog({
    title,
    body,
    buttons: [
      { label: okLabel, primary: true, value: () => input.value },
      { id: null, label: 'Cancel' },
    ],
    onKey: (e, finish) => {
      if (e.key === 'Enter' && document.activeElement === input) {
        e.preventDefault();
        finish(input.value);
      }
    },
  });
}

function previewDialog(original, rephrased, label) {
  const body = document.createElement('div');
  body.className = 'preview-grid';
  const make = (text, readOnly) => {
    const t = document.createElement('textarea');
    t.value = text;
    t.readOnly = readOnly;
    t.spellcheck = !readOnly;
    return t;
  };
  const result = make(rephrased, false);
  result.setAttribute('autofocus', '');
  body.append(
    Object.assign(document.createElement('label'), { textContent: 'Original' }),
    make(original, true),
    Object.assign(document.createElement('label'), { textContent: `Rephrased (${label}) — you can edit it` }),
    result,
  );
  return dialog({
    title: 'Rephrase',
    body,
    wide: true,
    buttons: [
      { label: 'Replace', primary: true, value: () => ({ action: 'replace', text: result.value }) },
      { label: 'Insert below', value: () => ({ action: 'insert', text: result.value }) },
      { label: 'Try again', value: () => ({ action: 'retry' }) },
      { id: null, label: 'Cancel' },
    ],
    onKey: (e, finish) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        finish({ action: 'replace', text: result.value });
      }
    },
  });
}

function settingRow(glyph, title, description, control) {
  const row = document.createElement('div');
  row.className = 'card-row';
  row.innerHTML = `<span class="glyph">${glyph}</span><div class="text"><div></div><div></div></div>`;
  row.querySelector('.text div:first-child').textContent = title;
  row.querySelector('.text div + div').textContent = description || '';
  if (control) row.appendChild(control);
  return row;
}

function selectControl(options, value, onChange) {
  const s = document.createElement('select');
  for (const [v, label] of options) s.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: label }));
  s.value = String(value);
  s.onchange = () => onChange(s.value);
  return s;
}

function switchControl(checked, onChange) {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked });
  input.onchange = () => onChange(input.checked);
  label.append(input, document.createElement('span'));
  return label;
}

async function openSettings() {
  closeMenus({ refocus: false });
  const body = document.createElement('div');
  body.className = 'settings';
  const h = (text) => body.appendChild(Object.assign(document.createElement('h3'), { textContent: text }));

  h('Appearance');
  body.appendChild(settingRow('', 'App theme', 'Select which app theme to display',
    selectControl([['system', 'Use system setting'], ['light', 'Light'], ['dark', 'Dark']], settings.theme, (v) => setSetting({ theme: v }))));
  body.appendChild(settingRow('', 'Font', 'Family and size of the text',
    (() => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:8px';
      const families = FONTS.includes(settings.font_family) ? FONTS : [settings.font_family, ...FONTS];
      wrap.appendChild(selectControl(families.map((f) => [f, f]), settings.font_family, (v) => setSetting({ font_family: v })));
      const size = selectControl([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28].map((n) => [n, `${n}`]), settings.font_size,
        (v) => setSetting({ font_size: Number(v) }));
      size.style.minWidth = '70px';
      wrap.appendChild(size);
      return wrap;
    })()));
  body.appendChild(settingRow('', 'Word wrap', 'Fit text to the window width', switchControl(settings.word_wrap, (v) => setSetting({ word_wrap: v }))));
  body.appendChild(settingRow('', 'Spell check', 'Underline misspelled words', switchControl(settings.spellcheck, (v) => setSetting({ spellcheck: v }))));
  body.appendChild(settingRow('', 'Status bar', 'Show line, characters, zoom and encoding', switchControl(settings.status_bar, (v) => setSetting({ status_bar: v }))));

  h('Rephrase with Claude');
  body.appendChild(settingRow('', 'Model', 'Haiku is fastest; Sonnet and Opus write better but take longer',
    selectControl(MODELS.map(([v, l, n]) => [v, `${l} — ${n}`]), settings.model, (v) => setSetting({ model: v }))));
  body.appendChild(settingRow('', 'Default style', 'Used by the Rephrase button and Ctrl+R',
    selectControl(Object.keys(STYLES).map((s) => [s, s]), settings.style, (v) => setSetting({ style: v }))));
  body.appendChild(settingRow('', 'Preview before replacing', 'Off: the new text replaces the old right away (Ctrl+Z undoes it)',
    switchControl(settings.preview, (v) => setSetting({ preview: v }))));
  const claudeRow = settingRow('', 'Claude Code', 'Checking…');
  body.appendChild(claudeRow);
  api.claudeInfo().then((info) => {
    claudeRow.querySelector('.text div + div').textContent = info.found
      ? `${info.version || 'Installed'} · ${info.path}`
      : 'Not found. Install Claude Code and sign in by running `claude` once.';
  });

  h('Keyboard shortcuts');
  const keys = document.createElement('div');
  keys.className = 'shortcuts';
  for (const [k, d] of [
    ['Ctrl+R', 'Rephrase selection (or whole note)'],
    ['Ctrl+Shift+R', 'Rephrase with your own instruction'],
    ['Alt+1 … Alt+7', 'Rephrase as Improve, Fix grammar, Formal, Casual, Shorter, Longer, Simpler'],
    ['Esc', 'Stop rephrasing'],
    ['Ctrl+Z', 'Undo (also undoes a rephrase)'],
    ['Ctrl+N / Ctrl+W', 'New tab / close tab'],
    ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+F / Ctrl+H', 'Find / replace'],
  ]) {
    keys.appendChild(Object.assign(document.createElement('kbd'), { textContent: k }));
    keys.appendChild(Object.assign(document.createElement('span'), { textContent: d }));
  }
  body.appendChild(keys);

  await dialog({ title: 'Settings', body, wide: true, buttons: [{ id: 'close', label: 'Done', primary: true }] });
}

// ----- Keyboard -------------------------------------------------------------------

function onKeyDown(e) {
  if (document.querySelector('.overlay')) return; // dialogs handle their own keys
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey && !e.altKey;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (e.key === 'Escape') {
    if (openMenus.length) return handled(), closeMenus();
    if (job) return handled(), cancelJob();
    if (!$('#findbar').hidden) return handled(), closeFind();
    return;
  }
  if (openMenus.length) return;

  if (ctrl && !e.shiftKey && (key === 'n' || key === 't')) return handled(), newTab();
  if (ctrl && key === 'w') return handled(), closeDoc(current);
  if (ctrl && key === 'tab') return handled(), cycleTab(e.shiftKey ? -1 : 1);
  if (ctrl && key === 'o') return handled(), openFile();
  if (ctrl && key === 's') return handled(), e.shiftKey ? saveAs() : save();
  if (e.ctrlKey && e.altKey && key === 's') return handled(), saveAll();
  if (ctrl && key === 'f') return handled(), openFind(false);
  if (ctrl && key === 'h') return handled(), openFind(true);
  if (ctrl && key === 'g') return handled(), gotoLine();
  if (ctrl && key === 'r') return handled(), e.shiftKey ? rephraseCustom() : rephraseStyle(settings.style);
  if (ctrl && (key === '=' || key === '+')) return handled(), zoom(1);
  if (ctrl && key === '-') return handled(), zoom(-1);
  if (ctrl && key === '0') return handled(), zoom(0);
  if (ctrl && key === ',') return handled(), openSettings();
  if (e.key === 'F3') return handled(), findNext(e.shiftKey ? -1 : 1, false);
  if (e.key === 'F5') return handled(), insertDateTime();
  if (e.altKey && !e.ctrlKey && /^Digit[1-7]$/.test(e.code)) {
    return handled(), rephraseStyle(Object.keys(STYLES)[Number(e.code.slice(5)) - 1]);
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const menu = { KeyF: 'file', KeyE: 'edit', KeyV: 'view' }[e.code];
    if (menu) return handled(), openMenuBar(menu, true);
  }
}

// ----- Wiring -------------------------------------------------------------------

async function requestClose() {
  await saveSessionNow(); // nothing to ask: unsaved text is kept for next time, like Notepad
  api.closeWindow();
}

function wireUi() {
  $('#newTab').onclick = newTab;
  document.querySelectorAll('.menu-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (menuBarOpen === btn.dataset.menu) closeMenus();
      else openMenuBar(btn.dataset.menu);
    });
    btn.addEventListener('mouseenter', () => {
      if (menuBarOpen && menuBarOpen !== btn.dataset.menu) openMenuBar(btn.dataset.menu);
    });
  });
  $('#rephraseBtn').onclick = () => (job ? cancelJob() : rephraseStyle(settings.style));
  $('#styleMenuBtn').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const btn = $('#styleMenuBtn');
    if (btn.classList.contains('open')) return closeMenus();
    closeMenus({ refocus: false });
    btn.classList.add('open');
    showMenu([
      ...styleItems(),
      { separator: true },
      { label: 'Preview before replacing', checked: settings.preview, action: () => setSetting({ preview: !settings.preview }) },
    ], { anchor: $('#rephraseSplit') });
  });
  $('#customBtn').onclick = rephraseCustom;
  $('#modelBtn').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const btn = $('#modelBtn');
    if (btn.classList.contains('open')) return closeMenus();
    closeMenus({ refocus: false });
    btn.classList.add('open');
    showMenu([
      { header: 'Claude model' },
      ...MODELS.map(([v, label, note]) => ({ label, note, checked: settings.model === v, action: () => setSetting({ model: v }) })),
    ], { anchor: btn, align: 'right' });
  });
  $('#themeBtn').onclick = () => setSetting({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
  $('#settingsBtn').onclick = openSettings;

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', (e) => {
    if (openMenus.length && !e.target.closest('.menu') && !e.target.closest('.menu-btn, .split-arrow, .chip-btn')) closeMenus({ refocus: false });
  });
  window.addEventListener('blur', () => closeMenus({ refocus: false }));
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1 : -1);
      }
    },
    { passive: false },
  );
  initFind();

  api.on('context-menu', (p) => {
    if (p.isEditable && document.activeElement === current?.ta) contextMenu(p);
  });
  api.on('request-close', requestClose);
  api.on('open-files', ({ files, newTab: wantsNew }) => {
    openFiles(files);
    if (wantsNew) newTab();
  });
  api.on('theme-changed', (dark) => setDark(dark));
}

async function start() {
  const init = await api.init();
  settings = { zoom: 100, ...init.settings };
  setDark(init.dark);
  applySettings();
  wireUi();

  for (const tab of init.session.tabs) addDoc(new Doc(tab), { select: false });
  if (docs.length) selectDoc(docs[Math.max(0, Math.min(init.session.selected, docs.length - 1))]);
  openFiles(init.files);
  if (!docs.length) newTab();
  applySettings();
}

start();
