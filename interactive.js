/**
 * interactive.js — Geometry Whiteboard Interactive Engine
 * Supports:
 * 1. Infinite-feeling canvas board with per-device zoom (wheel to cursor, 2-finger pinch) & pan
 * 2. Selection tool (move, resize handles, rotate handle, Delete key/button)
 * 3. Pen tab (Pen, Highlighter, Eraser, Measure Line, 5 colours + custom, 3+ widths)
 * 4. Shapes tab (Rectangle, Ellipse/Circle, Triangle, Diamond with fill, border, width)
 * 5. Lines tab (Straight Line, Arrow with arrowhead, colour & thickness)
 * 6. Geometry Instruments (Protractor with 0-180 & 180-0 + live ray angle, 0-30cm Ruler with mm ticks,
 *    Compass with Needle/Hinge/Pencil + live cm radius + Draw Circle with "r = x cm" label)
 * 7. Frames (Mobile 9:16, Desktop 16:9, Custom size, background colour picker, editable title)
 * 8. Top bar live readouts (Protractor angle, Compass radius, Line length) & Clear Drawings
 * 9. v3: Images (+ picker, drag-drop, paste; compressed before sync; move/resize/rotate/crop),
 *    frames-only PDF export (self-contained PDF writer, no CDN library), and small-group
 *    WebRTC voice call (2-3 peers, signalling over the existing Supabase Broadcast channel)
 * 10. v4: left icon-only toolbar + text box + undo/redo (20), class tabs, cloud save per
 *    room+tab, dark-first theme, input remap (trackpad pan / pinch zoom / right-drag pan),
 *    blank start (no default instruments), trapezium shape, no frame titles, no zoom UI.
 * 11. v4.3: magnetic frame snapping (frames only, Alt disables) + frame lock/colour
 *    via right-click (1-second right-hold to unlock, progress bar, locked flag synced).
 * v4.4: unlock hold 1 s (was 3 s); Select-tool marquee multi-selection; left-drag = marquee,
 *    right-drag = pan; right-click on a multi-selection locks/unlocks/colours all its frames.
 */
(function () {
  'use strict';

  // Scale constant: 30 board pixels = 1.0 cm (3 board pixels = 1 mm)
  const PX_PER_CM = 30;
  const DEG_TO_RAD = Math.PI / 180;
  const RAD_TO_DEG = 180 / Math.PI;

  const canvas = document.getElementById('boardCanvas');
  const ctx = canvas.getContext('2d');

  // Per-device viewport state (NEVER synced so each device controls its own view)
  const viewport = {
    panX: 120,
    panY: 90,
    zoom: 1.0,
    minZoom: 0.2,
    maxZoom: 4.0
  };

  // Active tool & sub-options state
  const uiState = {
    activeTab: 'select', // 'select' | 'pen' | 'shapes' | 'lines' | 'frames' | 'instruments' | 'textbox'
    textColor: '#0f172a',
    textSize: 22,
    penSubTool: 'pen',   // 'pen' | 'highlighter' | 'eraser' | 'measure'
    penColor: '#0f172a',
    penWidth: 4,
    shapeType: 'rect',   // 'rect' | 'ellipse' | 'triangle' | 'diamond' | 'trapezium'
    shapeFill: '#dbeafe',
    shapeNoFill: false,
    shapeStroke: '#1d4ed8',
    shapeStrokeWidth: 3,
    lineType: 'line',    // 'line' | 'arrow' | 'measure'
    drawLineMode: false, // v4: true when a line type was last picked under Shapes, so board drag draws a line
    lineColor: '#0f172a',
    lineWidth: 3,
    lineDashed: false,
    framePreset: '16:9', // '9:16' | '16:9' | 'custom'
    frameBg: '#ffffff',
    frameTitle: 'Lesson Frame 1',
    frameCustomW: 600,
    frameCustomH: 450,
    snapToRuler: true,
    spacePanning: false,
    panModeToggle: false,
    liveLineLengthCm: 0
  };

  // Shared Board State (Synced across all room peers)
  const board = {
    frames: [
      {
        id: 'frame_default_1',
        type: 'frame',
        x: 60,
        y: 40,
        w: 960,
        h: 540,
        bg: '#ffffff',
        title: 'Desktop Board (16:9) — Triangle & Circle Constructions',
        preset: '16:9',
        locked: false
      }
    ],
    shapes: [],
    texts: [], // v4: {id, type:'text', x, y, w, h, rotation, text, color, fontSize}
    lines: [],
    images: [], // v3: {id, type:'image', x, y, w, h, rotation, src (compressed data URL)}
    strokes: [], // includes freehand pen/highlighter strokes, drawn compass circles, and measure lines
    instruments: {
      protractor: {
        id: 'inst_protractor',
        visible: false,
        x: 340,
        y: 340,
        rotation: 0,      // baseline angle in degrees
        rayAngle: 55,     // angle in degrees relative to baseline (0..180)
        radius: 210       // 7 cm radius
      },
      ruler: {
        id: 'inst_ruler',
        visible: false,
        x: 130,
        y: 450,
        rotation: 0,      // angle in degrees
        lengthCm: 30,     // 0-30 cm
        heightPx: 54
      },
      compass: {
        id: 'inst_compass',
        visible: false,
        nx: 720,          // needle X
        ny: 280,          // needle Y
        px: 870,          // pencil X (default 150px = 5.0 cm)
        py: 280,          // pencil Y
        color: '#dc2626'
      }
    }
  };

  // Selection & Active Pointer Interaction State
  let selectedObject = null; // { category: 'frame'|'shape'|'line'|'stroke'|'image'|'instrument', id: string }
  // v4.4: marquee multi-selection (per-device; the objects themselves still sync individually)
  let multiSelection = []; // [{category, id}] in marquee order
  let multiActive = false; // true only after a marquee completes; single clicks clear it
  let marquee = null; // {x1,y1,x2,y2} world coords while a marquee drag is in progress
  const UNLOCK_HOLD_MS = 1000; // v4.4: was 3000
  let frameMenuTargets = null; // v4.4: frames the frame menu applies to (single frame or whole selection)
  let interaction = null;    // current pointer/touch action
  const activeTouches = new Map();
  let pinchState = null;

  // v3 state: image element cache, crop mode, voice call
  const imageElementCache = new Map(); // id -> { src, el }
  let cropMode = null; // { imageId, startWx, startWy, curWx, curWy } or null
  // v4.3: magnetic frame snapping + frame lock/colour menu state
  let frameSnapGuide = []; // [{x1,y1,x2,y2}] in world coords, drawn while a snap is active
  let altHeld = false; // Alt disables frame snapping for that drag
  let frameMenuFrameId = null;
  let unlockHold = null; // {frameId, timeout, raf}
  const voiceState = {
    inCall: false,
    micOn: true,
    speakerOn: true,
    localStream: null,
    peers: new Map() // peerId -> { pc, audioEl }
  };

  // ---- v4 state: theme, class tabs, undo/redo, cloud save, text editing ----
  function storedTheme() {
    try { return window.localStorage.getItem('geo_wb_theme') || ''; } catch (e) { return ''; }
  }
  let currentTheme = storedTheme() === 'light' ? 'light' : 'dark'; // v4: first open is ALWAYS dark
  function displayColor(c) {
    // Rendering-only readability fix in dark mode: near-black ink becomes near-white.
    if (currentTheme === 'dark' && (c === '#0f172a' || c === '#000000' || c === '#111827')) return '#f1f5f9';
    return c;
  }
  let undoStack = []; // JSON strings of board state, capped at 20
  let redoStack = [];
  let suppressHistory = false;
  let cloudSaveTimer = null;
  let cloudSaveInFlight = false;
  let textEditor = null; // { textarea, obj, isNew }
  // Class tabs: each tab owns a complete board state. Tab switching is PER-DEVICE in v4:
  // students do NOT auto-follow the teacher's tab switch (decision left open for later).
  // v4.1 FIX (cloud save lost on refresh): tab ids must be STABLE across reloads.
  // v4 gave the first tab a fresh 'tab_' + Date.now() id on every page load, so the
  // cloud row key (room, tab) never matched the previous save and load found nothing.
  // The first tab is now always 'tab_class1'; the tab list (id + name) and the active
  // tab are persisted per room in localStorage and restored on room join, BEFORE
  // loadCloudBoard runs. New tabs keep their id on rename (only the name changes).
  function tabsStorageKey(room) { return 'geo_wb_tabs_' + (room || 'noroom'); }
  function defaultClassTabs() { return [{ id: 'tab_class1', name: 'Class 1', state: null }]; }
  let classTabs = defaultClassTabs();
  let activeClassTabId = classTabs[0].id;
  function persistClassTabs() {
    try {
      const r = (window.BoardSync && window.BoardSync.roomCode) ? window.BoardSync.roomCode : '';
      if (!r) return;
      window.localStorage.setItem(tabsStorageKey(r), JSON.stringify({
        tabs: classTabs.map((t) => ({ id: t.id, name: t.name })), active: activeClassTabId
      }));
    } catch (e) {}
  }
  function restoreClassTabs(room) {
    try {
      if (!room) return;
      const raw = window.localStorage.getItem(tabsStorageKey(room));
      if (!raw) { classTabs = defaultClassTabs(); activeClassTabId = classTabs[0].id; return; }
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return;
      const tabs = data.tabs.filter((t) => t && typeof t.id === 'string' && t.id && typeof t.name === 'string' && t.name.trim())
        .map((t) => ({ id: t.id, name: t.name.trim(), state: null }));
      if (!tabs.length) return;
      classTabs = tabs;
      activeClassTabId = (data.active && tabs.some((t) => t.id === data.active)) ? data.active : tabs[0].id;
    } catch (e) { classTabs = defaultClassTabs(); activeClassTabId = classTabs[0].id; }
  }
  function serializeBoard() {
    return JSON.parse(JSON.stringify({
      frames: board.frames, shapes: board.shapes, texts: board.texts || [],
      lines: board.lines, images: board.images, strokes: board.strokes,
      instruments: board.instruments
    }));
  }
  function applyBoardState(st) {
    if (!st) return;
    suppressHistory = true;
    if (Array.isArray(st.frames)) board.frames = st.frames;
    ensureFrameSeqs(); // v4.8: frames from cloud / snapshot / an old version may lack a number
    if (Array.isArray(st.shapes)) board.shapes = st.shapes;
    if (Array.isArray(st.texts)) board.texts = st.texts;
    if (Array.isArray(st.lines)) board.lines = st.lines;
    if (Array.isArray(st.images)) board.images = st.images;
    if (Array.isArray(st.strokes)) board.strokes = st.strokes;
    if (st.instruments) {
      if (st.instruments.protractor) Object.assign(board.instruments.protractor, st.instruments.protractor);
      if (st.instruments.ruler) Object.assign(board.instruments.ruler, st.instruments.ruler);
      if (st.instruments.compass) Object.assign(board.instruments.compass, st.instruments.compass);
    }
    selectedObject = null;
    suppressHistory = false;
    updateReadouts();
    requestRender();
  }
  function pushHistory() {
    if (suppressHistory) return;
    try { undoStack.push(JSON.stringify(serializeBoard())); } catch (e) { return; }
    while (undoStack.length > 20) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function updateUndoButtons() {
    const u = document.getElementById('btnUndo');
    const r = document.getElementById('btnRedo');
    if (u) u.classList.toggle('icon-disabled', undoStack.length === 0);
    if (r) r.classList.toggle('icon-disabled', redoStack.length === 0);
  }
  function doUndo() {
    if (!isTeacher()) return; // v4.8: students are view-only
    if (!undoStack.length) { showToast('Nothing to undo'); return; }
    redoStack.push(JSON.stringify(serializeBoard()));
    const prev = JSON.parse(undoStack.pop());
    applyBoardState(prev);
    sendBoardSnapshot(); // v4.7: photos travel chunked, not inside the snapshot
    scheduleCloudSave();
    updateUndoButtons();
    showToast('Undone');
  }
  function doRedo() {
    if (!isTeacher()) return; // v4.8: students are view-only
    if (!redoStack.length) { showToast('Nothing to redo'); return; }
    undoStack.push(JSON.stringify(serializeBoard()));
    const next = JSON.parse(redoStack.pop());
    applyBoardState(next);
    sendBoardSnapshot(); // v4.7: photos travel chunked, not inside the snapshot
    scheduleCloudSave();
    updateUndoButtons();
    showToast('Redone');
  }
  function saveCurrentTabState() {
    const tab = classTabs.find((t) => t.id === activeClassTabId);
    if (tab) tab.state = serializeBoard();
  }
  function renderClassTabs() {
    const bar = document.getElementById('classTabBarInner');
    if (!bar) return;
    persistClassTabs(); // v4.1: every tab change (add/rename/close/switch) is persisted per room
    bar.innerHTML = '';
    classTabs.forEach((tab) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'class-tab-btn' + (tab.id === activeClassTabId ? ' active' : '');
      btn.title = 'Switch to ' + tab.name;
      const label = document.createElement('span');
      label.textContent = tab.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => switchClassTab(tab.id));
      const ren = document.createElement('span');
      ren.textContent = ' ✎';
      ren.title = 'Rename tab';
      ren.style.cursor = 'pointer';
      ren.addEventListener('click', (e) => {
        e.stopPropagation();
        const nv = window.prompt('Rename class tab:', tab.name);
        if (nv && nv.trim()) { tab.name = nv.trim(); renderClassTabs(); }
      });
      btn.appendChild(ren);
      if (classTabs.length > 1) {
        const cl = document.createElement('span');
        cl.textContent = ' ×';
        cl.title = 'Close tab';
        cl.style.cursor = 'pointer';
        cl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.confirm('Close tab "' + tab.name + '"? Its saved board is kept in cloud save until New board clears it.')) {
            classTabs = classTabs.filter((t) => t.id !== tab.id);
            if (activeClassTabId === tab.id) switchClassTab(classTabs[0].id);
            else renderClassTabs();
          }
        });
        btn.appendChild(cl);
      }
      bar.appendChild(btn);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'class-tab-btn class-tab-add' + (isTeacher() ? '' : ' hidden'); // v4.8: students cannot create tabs
    add.title = 'Add a new class tab';
    add.textContent = '+ New tab';
    add.addEventListener('click', () => {
      const name = window.prompt('Name for the new class tab:', 'Class ' + (classTabs.length + 1));
      if (!name || !name.trim()) return;
      saveCurrentTabState();
      const tab = { id: 'tab_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5), name: name.trim(), state: null };
      classTabs.push(tab);
      activeClassTabId = tab.id;
      // New tab starts from a fresh blank board (no instruments, default frame kept for teaching).
      const fresh = JSON.parse(JSON.stringify(serializeBoard()));
      fresh.frames = [{ id: 'frame_default_' + tab.id, type: 'frame', x: 60, y: 40, w: 960, h: 540, bg: '#ffffff', title: 'Frame 1', preset: '16:9' }];
      fresh.shapes = []; fresh.texts = []; fresh.lines = []; fresh.images = []; fresh.strokes = [];
      fresh.instruments.protractor.visible = false; fresh.instruments.ruler.visible = false; fresh.instruments.compass.visible = false;
      applyBoardState(fresh);
      tab.state = serializeBoard();
      renderClassTabs();
      scheduleCloudSave();
      showToast('New tab: ' + tab.name);
    });
    bar.appendChild(add);
  }
  function switchClassTab(tabId) {
    if (tabId === activeClassTabId) return;
    saveCurrentTabState();
    const tab = classTabs.find((t) => t.id === tabId);
    if (!tab) return;
    activeClassTabId = tabId;
    multiActive = false; multiSelection = []; selectedObject = null; // v4.4: a tab switch clears any multi-selection
    cloudLoadDone = false; cloudLoadResolvedFor = ''; // v4.1: re-guard saves until this tab's load resolves
    if (tab.state) applyBoardState(tab.state);
    else { tab.state = serializeBoard(); }
    renderClassTabs();
    loadCloudBoard();
    showToast('Tab: ' + tab.name + ' (per-device — students do not auto-follow tab switches)');
  }
  function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    try { window.localStorage.setItem('geo_wb_theme', currentTheme); } catch (e) {}
    document.body.setAttribute('data-theme', currentTheme);
    const btn = document.getElementById('btnThemeToggle');
    if (btn) {
      btn.textContent = currentTheme === 'dark' ? '☀' : '☾';
      btn.title = currentTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    }
    updateCursorStyle(); // v4.8: the pen dot colour follows the theme
    requestRender();
  }
  // ---- v4 cloud save (REST, anon key the user already pasted; never hardcoded) ----
  function cloudCreds() {
    const uEl = document.getElementById('supabaseUrlInput');
    const kEl = document.getElementById('supabaseKeyInput');
    const url = uEl ? uEl.value.trim().replace(/\/$/, '') : '';
    const key = kEl ? kEl.value.trim() : '';
    const room = (window.BoardSync && window.BoardSync.roomCode) ? window.BoardSync.roomCode : '';
    return { url, key, room };
  }
  // ---------------------------------------------------------
  // v4.8: TEACHER / STUDENT ROLES. Default is student (view-only);
  // the teacher unlocks with a PIN (once per device, remembered in
  // localStorage). The PIN is a classroom lock, not security — it is
  // stored as a hash on the device and never sent anywhere.
  // ---------------------------------------------------------
  let myRole = 'student';
  const TEACHER_PIN_KEY = 'geo_wb_teacher_pin';
  const TEACHER_FLAG_KEY = 'geo_wb_teacher';
  let teacherPinAttempts = 0;
  let teacherPinLockedUntil = 0;

  function teacherPinHash(pin) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < pin.length; i++) {
      const ch = pin.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  }
  function storedTeacherPinHash() {
    try { return window.localStorage.getItem(TEACHER_PIN_KEY) || ''; } catch (e) { return ''; }
  }
  function isTeacher() { return myRole === 'teacher'; }
  function setRole(role) {
    myRole = role;
    if (window.BoardSync) window.BoardSync.myRole = role;
    try {
      if (role === 'teacher') window.localStorage.setItem(TEACHER_FLAG_KEY, '1');
      else window.localStorage.removeItem(TEACHER_FLAG_KEY);
    } catch (e) {}
    applyRoleUI();
    updateCursorStyle();
  }
  function applyRoleUI() {
    const teacher = isTeacher();
    document.body.classList.toggle('student-mode', !teacher);
    document.querySelectorAll('.teacher-only').forEach((el) => el.classList.toggle('hidden', !teacher));
    const badge = document.getElementById('teacherBadge');
    if (badge) badge.classList.toggle('hidden', !teacher);
    const btn = document.getElementById('btnTeacherMode');
    if (btn) btn.title = teacher ? 'Teacher mode on — tap to lock' : 'Teacher mode — enter PIN';
    // renderClassTabs rebuilds the + New tab button, so re-apply its state here too.
    const addTab = document.querySelector('.class-tab-add');
    if (addTab) addTab.classList.toggle('hidden', !teacher);
  }
  function restoreRole() {
    try {
      if (window.localStorage.getItem(TEACHER_FLAG_KEY) === '1') {
        myRole = 'teacher';
        if (window.BoardSync) window.BoardSync.myRole = 'teacher';
      }
    } catch (e) {}
    applyRoleUI();
  }
  function openTeacherPinModal() {
    if (isTeacher()) {
      setRole('student');
      showToast('Teacher mode locked — view only');
      return;
    }
    const hasPin = !!storedTeacherPinHash();
    const title = document.getElementById('teacherPinTitle');
    const text = document.getElementById('teacherPinText');
    const confirm = document.getElementById('teacherPinConfirm');
    const submit = document.getElementById('btnTeacherPinSubmit');
    if (title) title.textContent = hasPin ? 'Teacher mode' : 'Set a teacher PIN';
    if (text) text.textContent = hasPin
      ? 'Enter the teacher PIN to control the board on this device.'
      : 'Choose a PIN (at least 4 digits). Only you should know it — it unlocks the board controls on each of your devices.';
    if (confirm) confirm.classList.toggle('hidden', hasPin);
    if (submit) submit.textContent = hasPin ? 'Unlock' : 'Set PIN';
    const input = document.getElementById('teacherPinInput');
    if (input) input.value = '';
    if (confirm) confirm.value = '';
    showTeacherPinError('');
    const modal = document.getElementById('teacherPinModal');
    if (modal) modal.classList.add('open');
    if (input) input.focus();
  }
  function showTeacherPinError(msg) {
    const el = document.getElementById('teacherPinError');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  }
  function submitTeacherPin() {
    const input = document.getElementById('teacherPinInput');
    const confirm = document.getElementById('teacherPinConfirm');
    const pin = input ? input.value.trim() : '';
    if (Date.now() < teacherPinLockedUntil) {
      showTeacherPinError('Too many wrong tries — wait ' + Math.ceil((teacherPinLockedUntil - Date.now()) / 1000) + 's');
      return;
    }
    if (!/^\d{4,8}$/.test(pin)) { showTeacherPinError('PIN needs 4–8 digits'); return; }
    const stored = storedTeacherPinHash();
    if (!stored) {
      const pin2 = confirm ? confirm.value.trim() : '';
      if (pin !== pin2) { showTeacherPinError('The two PINs do not match'); return; }
      try { window.localStorage.setItem(TEACHER_PIN_KEY, teacherPinHash(pin)); } catch (e) {}
      setRole('teacher');
      closeTeacherPinModal();
      showToast('Teacher PIN set — this device can control the board');
      return;
    }
    if (teacherPinHash(pin) === stored) {
      teacherPinAttempts = 0;
      setRole('teacher');
      closeTeacherPinModal();
      showToast('Teacher mode on');
    } else {
      teacherPinAttempts++;
      if (teacherPinAttempts >= 5) {
        teacherPinLockedUntil = Date.now() + 60000;
        teacherPinAttempts = 0;
        showTeacherPinError('Too many wrong tries — wait 1 minute');
      } else {
        showTeacherPinError('Wrong PIN');
      }
    }
  }
  function closeTeacherPinModal() {
    const modal = document.getElementById('teacherPinModal');
    if (modal) modal.classList.remove('open');
  }
  function bindTeacherUI() {
    const btn = document.getElementById('btnTeacherMode');
    if (btn) btn.addEventListener('click', openTeacherPinModal);
    const submit = document.getElementById('btnTeacherPinSubmit');
    if (submit) submit.addEventListener('click', submitTeacherPin);
    const cancel = document.getElementById('btnTeacherPinCancel');
    if (cancel) cancel.addEventListener('click', closeTeacherPinModal);
    const input = document.getElementById('teacherPinInput');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitTeacherPin(); } });
    const modal = document.getElementById('teacherPinModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeTeacherPinModal(); });
  }

  // v4.1: block scheduled saves until the first loadCloudBoard for this room+tab has
  // resolved, so a fresh empty default board can never overwrite a saved board on
  // first load. The flag is also set when load early-returns (live content present),
  // since in that case saving the live board is correct, not destructive.
  let cloudLoadDone = false;
  let cloudLoadResolvedFor = '';
  let cloudLoadInFlight = false;
  // v4.2: a save requested while the first load is still pending must NOT be dropped
  // (v4.1 dropped it: scheduleCloudSave called loadCloudBoard and returned, so a
  // single drawing followed by a refresh could vanish even though the user waited).
  let cloudSavePending = false;
  let cloudMissingKeysToastShown = false;
  function cloudTimeNow() {
    try {
      const d = new Date();
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return ''; }
  }
  function setCloudStatus(text) {
    try {
      const el = document.getElementById('cloudStatusLine');
      if (el) el.textContent = text;
    } catch (e) {}
  }
  function cloudMissingKeys() {
    setCloudStatus('Cloud: no keys entered');
    if (!cloudMissingKeysToastShown) {
      cloudMissingKeysToastShown = true;
      showToast('Cloud save needs the Supabase URL + anon key in the Room Sync bar');
    }
  }
  function flushCloudSavePending() {
    if (!cloudSavePending) return;
    cloudSavePending = false;
    scheduleCloudSave();
  }
  function scheduleCloudSave() {
    // v4.8: the on-device backup saves on the same schedule, even when the
    // cloud cannot (no keys / not joined / offline).
    scheduleLocalBackup();
    // v4.2: queue the save instead of dropping it, and run it once the load resolves.
    if (!cloudLoadDone) {
      cloudSavePending = true;
      if (!cloudLoadInFlight) loadCloudBoard();
      return;
    }
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(saveCloudBoard, 1200);
  }
  // bypassGuard=true is only for the manual 'Save to cloud now' button: it skips the
  // load guard (the user explicitly asked for a save) but still requires url/key/room.
  function saveCloudBoard(bypassGuard) {
    const { url, key, room } = cloudCreds();
    if (!url || !key || !room) { cloudMissingKeys(); return; }
    if (cloudSaveInFlight) { showToast('Cloud save in progress…'); return; }
    saveCurrentTabState();
    const payload = { room: room, tab: activeClassTabId, state: serializeBoard(), updated_at: new Date().toISOString() };
    cloudSaveInFlight = true;
    // v4.1 FIX: ?on_conflict=room,tab is required for merge-duplicates to UPDATE the
    // existing row; without it the second save for the same room+tab conflicts.
    fetch(url + '/rest/v1/board_saves?on_conflict=room,tab', {
      method: 'POST',
      headers: {
        'apikey': key, 'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    }).then(async (r) => {
      if (!r.ok) {
        let detail = '';
        try { detail = (await r.text() || '').slice(0, 120); } catch (e) {}
        throw new Error('HTTP ' + r.status + (detail ? ' — ' + detail : ''));
      }
      return r;
    }).then(() => {
      setCloudStatus('Cloud: saved ' + cloudTimeNow());
      showToast('Cloud saved');
    }).catch((err) => {
      const msg = (err && err.message) ? String(err.message) : '';
      if (msg.indexOf('HTTP ') === 0) {
        setCloudStatus('Cloud: failed ' + msg.slice(0, 120));
        showToast(('Cloud save failed: ' + msg).slice(0, 180));
      } else {
        setCloudStatus('Cloud: failed network error');
        showToast('Cloud save failed: network error');
      }
    }).finally(() => { cloudSaveInFlight = false; });
  }
  function loadCloudBoard() {
    const { url, key, room } = cloudCreds();
    // v4.2: missing credentials must NOT leave saves blocked forever. Mark the load
    // resolved, surface the state, and flush any queued save (which will show the
    // once-per-session missing-keys toast) instead of silently dropping it.
    if (!url || !key || !room) {
      cloudLoadDone = true; cloudLoadResolvedFor = (room || '') + '|' + activeClassTabId;
      cloudMissingKeys();
      flushCloudSavePending();
      restoreFromLocalBackup(); // v4.8: no keys — the device backup still remembers
      return;
    }
    // Never overwrite a board that already has content (e.g. a live host snapshot just
    // arrived): cloud restore is for an empty tab / a fresh reload, not a live room takeover.
    const hasContent = (board.strokes && board.strokes.length) || (board.shapes && board.shapes.length)
      || (board.lines && board.lines.length) || (board.images && board.images.length)
      || (board.texts && board.texts.length)
      || board.instruments.protractor.visible || board.instruments.ruler.visible || board.instruments.compass.visible;
    const tab = activeClassTabId;
    if (hasContent) { cloudLoadDone = true; cloudLoadResolvedFor = room + '|' + tab; flushCloudSavePending(); return; }
    cloudLoadInFlight = true;
    setCloudStatus('Cloud: loading saved board…');
    fetch(url + '/rest/v1/board_saves?room=eq.' + encodeURIComponent(room) + '&tab=eq.' + encodeURIComponent(tab) + '&select=state&limit=1', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    }).then(async (r) => {
      if (!r.ok) {
        let detail = '';
        try { detail = (await r.text() || '').slice(0, 120); } catch (e) {}
        throw new Error('HTTP ' + r.status + (detail ? ' — ' + detail : ''));
      }
      return r.json();
    }).then((rows) => {
      if (rows && rows.length && rows[0].state) {
        // Only adopt a cloud board when the current tab is still empty-ish, or it was
        // explicitly requested by a tab switch: a fresh page with a saved board restores it.
        applyBoardState(rows[0].state);
        const t = classTabs.find((x) => x.id === tab);
        if (t) t.state = serializeBoard();
        setCloudStatus('Cloud: restored saved board ' + cloudTimeNow());
        showToast('Restored saved board for this tab');
      } else {
        setCloudStatus('Cloud: no saved board for this tab yet');
        restoreFromLocalBackup(); // v4.8: cloud has nothing — the device backup may
      }
    }).catch((err) => {
      // v4.2: load failures are now visible in the status line (not silent), but the
      // board keeps working live via Broadcast sync.
      const msg = (err && err.message) ? String(err.message) : 'network error';
      setCloudStatus('Cloud: load failed ' + msg.slice(0, 120));
      restoreFromLocalBackup(); // v4.8: cloud unreachable — fall back to the device backup
    })
    .finally(() => { cloudLoadInFlight = false; cloudLoadDone = true; cloudLoadResolvedFor = room + '|' + tab; flushCloudSavePending(); });
  }
  // ---------------------------------------------------------
  // v4.8: ON-DEVICE BACKUP (IndexedDB) — the board remembers even
  // with no keys, no room joined, or no internet. Cloud save stays
  // the shared source of truth; this is the per-device safety net.
  // Keyed by room+tab, like the cloud row. Photos included (data URLs).
  // ---------------------------------------------------------
  let localBackupDb = null;
  let localBackupReady = false;
  let localBackupTimer = null;
  function openLocalBackup() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(false);
        const req = window.indexedDB.open('geo_wb_backup', 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore('boards'); } catch (e) {} };
        req.onsuccess = () => { localBackupDb = req.result; localBackupReady = true; resolve(true); };
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }
  function backupRoom() {
    if (window.BoardSync && window.BoardSync.roomCode) return window.BoardSync.roomCode;
    const input = document.getElementById('roomCodeInput');
    return input ? input.value.trim().toUpperCase() : '';
  }
  function localBackupKey(room, tab) { return (room || '') + '|' + (tab || ''); }
  function saveLocalBackup() {
    if (!localBackupReady || !localBackupDb) return;
    try {
      const tx = localBackupDb.transaction('boards', 'readwrite');
      tx.objectStore('boards').put(serializeBoard(), localBackupKey(backupRoom(), activeClassTabId));
    } catch (e) {}
  }
  function scheduleLocalBackup() {
    clearTimeout(localBackupTimer);
    localBackupTimer = setTimeout(saveLocalBackup, 1200);
  }
  function loadLocalBackup() {
    return new Promise((resolve) => {
      if (!localBackupReady || !localBackupDb) return resolve(null);
      try {
        const req = localBackupDb.transaction('boards', 'readonly').objectStore('boards').get(localBackupKey(backupRoom(), activeClassTabId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function deleteLocalBackup() {
    if (!localBackupReady || !localBackupDb) return;
    try {
      localBackupDb.transaction('boards', 'readwrite').objectStore('boards').delete(localBackupKey(backupRoom(), activeClassTabId));
    } catch (e) {}
  }
  function restoreFromLocalBackup() {
    // Restores this device's backup for the current room+tab, but only
    // when the tab is still empty — never overwrites live content.
    loadLocalBackup().then((st) => {
      if (!st) return;
      const hasContent = (board.strokes && board.strokes.length) || (board.shapes && board.shapes.length)
        || (board.lines && board.lines.length) || (board.images && board.images.length)
        || (board.texts && board.texts.length);
      if (hasContent) return;
      applyBoardState(st);
      const t = classTabs.find((x) => x.id === activeClassTabId);
      if (t) t.state = serializeBoard();
      setCloudStatus('Cloud: restored from this device');
      showToast('Restored saved board from this device');
    });
  }

  function newBoardCloud() {
    const { url, key, room } = cloudCreds();
    saveCurrentTabState();
    const fresh = serializeBoard();
    fresh.frames = []; fresh.shapes = []; fresh.texts = []; fresh.lines = []; fresh.images = []; fresh.strokes = [];
    fresh.instruments.protractor.visible = false; fresh.instruments.ruler.visible = false; fresh.instruments.compass.visible = false;
    pushHistory();
    applyBoardState(fresh);
    sendBoardSnapshot(); // v4.7: photos travel chunked, not inside the snapshot
    if (url && key && room) {
      fetch(url + '/rest/v1/board_saves?room=eq.' + encodeURIComponent(room) + '&tab=eq.' + encodeURIComponent(activeClassTabId), {
        method: 'DELETE', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
      }).catch(() => {});
    }
    deleteLocalBackup(); // v4.8: "until I delete" — clear the device backup too
    clearTimeout(cloudSaveTimer); cloudSavePending = false; // do not immediately re-save the empty board over the delete
    cloudLoadDone = true; // v4.1: the delete IS the resolved state for this tab; later saves must work
    setCloudStatus('Cloud: board cleared for this tab');
    showToast('New board started (cloud copy cleared for this tab)');
  }

  // ---------------------------------------------------------
  // UTILITY FUNCTIONS
  // ---------------------------------------------------------
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - viewport.panX) / viewport.zoom,
      y: (sy - viewport.panY) / viewport.zoom
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * viewport.zoom + viewport.panX,
      y: wy * viewport.zoom + viewport.panY
    };
  }

  function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  function rotatePoint(px, py, cx, cy, angleDeg) {
    const rad = angleDeg * DEG_TO_RAD;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos
    };
  }

  function unrotatePoint(px, py, cx, cy, angleDeg) {
    return rotatePoint(px, py, cx, cy, -angleDeg);
  }

  function normalizeAngle180(deg) {
    let a = ((deg % 360) + 360) % 360;
    if (a > 180) a = 360 - a;
    return a;
  }

  function showToast(msg) {
    const toast = document.getElementById('toastBanner');
    const toastText = document.getElementById('toastText');
    if (!toast || !toastText) return;
    toastText.textContent = msg;
    toast.classList.remove('hidden', 'opacity-0');
    toast.classList.add('opacity-100');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.add('opacity-0');
      setTimeout(() => toast.classList.add('hidden'), 200);
    }, 2800);
  }

  // ---------------------------------------------------------
  // READOUTS & UI UPDATES
  // ---------------------------------------------------------
  function getCompassRadiusCm() {
    const c = board.instruments.compass;
    return dist(c.nx, c.ny, c.px, c.py) / PX_PER_CM;
  }

  function updateReadouts() {
    const protEl = document.getElementById('readoutProtractor');
    const compEl = document.getElementById('readoutCompass');
    const lineEl = document.getElementById('readoutLine');
    const zoomEl = document.getElementById('zoomPercentDisplay');
    const delBtn = document.getElementById('btnDeleteSelected');

    const p = board.instruments.protractor;
    const angleVal = Math.round(p.rayAngle * 10) / 10;
    if (protEl) protEl.textContent = '∠ ' + angleVal.toFixed(1) + '°';

    const rCm = getCompassRadiusCm();
    if (compEl) {
      if (interaction && interaction.type === 'compass_draw') {
        compEl.textContent = 'r = ' + rCm.toFixed(2) + ' cm · swept ' + Math.round((interaction.sweep || 0) * RAD_TO_DEG) + '°';
      } else {
        compEl.textContent = 'r = ' + rCm.toFixed(2) + ' cm';
      }
    }

    let lineLen = uiState.liveLineLengthCm;
    if (selectedObject) {
      const obj = findObject(selectedObject.category, selectedObject.id);
      if (obj && selectedObject.category === 'line') {
        lineLen = dist(obj.x1, obj.y1, obj.x2, obj.y2) / PX_PER_CM;
      } else if (obj && selectedObject.category === 'stroke' && obj.kind === 'measure') {
        lineLen = dist(obj.x1, obj.y1, obj.x2, obj.y2) / PX_PER_CM;
      } else if (obj && selectedObject.category === 'stroke' && obj.kind === 'circle') {
        lineLen = (obj.r || 0) / PX_PER_CM;
      }
    }
    if (lineEl) lineEl.textContent = 'L = ' + lineLen.toFixed(2) + ' cm';

    if (zoomEl) {
      zoomEl.textContent = Math.round(viewport.zoom * 100) + '%';
    }

    // v4.7: the toolbar Delete button follows the same enable rule as the
    // header Delete button — enabled only while something is selected.
    const delBtnToolbar = document.getElementById('btnDeleteToolbar');
    for (const b of [delBtn, delBtnToolbar]) {
      if (!b) continue;
      if (selectedObject) {
        b.classList.remove('opacity-40', 'pointer-events-none');
      } else {
        b.classList.add('opacity-40', 'pointer-events-none');
      }
    }

    // v3: Crop button only makes sense for a selected image
    const btnCrop = document.getElementById('btnCropImage');
    if (btnCrop) {
      const show = Boolean(selectedObject && selectedObject.category === 'image');
      btnCrop.classList.toggle('hidden', !show);
      btnCrop.textContent = cropMode ? '✂ Cropping… (Esc to cancel)' : '✂ Crop image';
    }

    // Update instrument toggle pill active states
    const btnToggleProt = document.getElementById('btnToggleProtractor');
    const btnToggleRuler = document.getElementById('btnToggleRuler');
    const btnToggleComp = document.getElementById('btnToggleCompass');
    if (btnToggleProt) btnToggleProt.classList.toggle('active', board.instruments.protractor.visible);
    if (btnToggleRuler) btnToggleRuler.classList.toggle('active', board.instruments.ruler.visible);
    if (btnToggleComp) btnToggleComp.classList.toggle('active', board.instruments.compass.visible);
  }

  function findObject(category, id) {
    if (category === 'frame') return board.frames.find((f) => f.id === id) || null;
    if (category === 'shape') return board.shapes.find((s) => s.id === id) || null;
    if (category === 'image') return board.images.find((im) => im.id === id) || null;
    if (category === 'line') return board.lines.find((l) => l.id === id) || null;
    if (category === 'stroke') return board.strokes.find((st) => st.id === id) || null;
    if (category === 'text') return (board.texts || []).find((t) => t.id === id) || null;
    if (category === 'instrument') {
      if (id === 'inst_protractor') return board.instruments.protractor;
      if (id === 'inst_ruler') return board.instruments.ruler;
      if (id === 'inst_compass') return board.instruments.compass;
    }
    return null;
  }

  // ---------------------------------------------------------
  // BOUNDING BOXES & HIT TESTING
  // ---------------------------------------------------------
  function getStrokeBounds(st) {
    if (st.kind === 'circle') {
      return {
        x: st.cx - st.r,
        y: st.cy - st.r,
        w: st.r * 2,
        h: st.r * 2,
        rotation: 0
      };
    }
    if (st.kind === 'measure') {
      const minX = Math.min(st.x1, st.x2);
      const minY = Math.min(st.y1, st.y2);
      const maxX = Math.max(st.x1, st.x2);
      const maxY = Math.max(st.y1, st.y2);
      return {
        x: minX - 10,
        y: minY - 10,
        w: Math.max(20, maxX - minX + 20),
        h: Math.max(20, maxY - minY + 20),
        rotation: 0
      };
    }
    // Freehand stroke
    if (!st.points || !st.points.length) {
      return { x: 0, y: 0, w: 10, h: 10, rotation: 0 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < st.points.length; i++) {
      const pt = st.points[i];
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    const pad = Math.max(8, (st.width || 4));
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(16, maxX - minX + pad * 2),
      h: Math.max(16, maxY - minY + pad * 2),
      rotation: st.rotation || 0
    };
  }

  function getObjectBounds(category, obj) {
    if (!obj) return null;
    if (category === 'frame' || category === 'shape' || category === 'image' || category === 'text') {
      return {
        x: obj.x,
        y: obj.y,
        w: obj.w,
        h: obj.h,
        rotation: obj.rotation || 0
      };
    }
    if (category === 'line') {
      const minX = Math.min(obj.x1, obj.x2);
      const minY = Math.min(obj.y1, obj.y2);
      const maxX = Math.max(obj.x1, obj.x2);
      const maxY = Math.max(obj.y1, obj.y2);
      return {
        x: minX - 8,
        y: minY - 8,
        w: Math.max(16, maxX - minX + 16),
        h: Math.max(16, maxY - minY + 16),
        rotation: 0
      };
    }
    if (category === 'stroke') {
      return getStrokeBounds(obj);
    }
    if (category === 'instrument') {
      if (obj.id === 'inst_protractor') {
        return {
          x: obj.x - obj.radius,
          y: obj.y - obj.radius,
          w: obj.radius * 2,
          h: obj.radius + 25,
          rotation: obj.rotation || 0
        };
      }
      if (obj.id === 'inst_ruler') {
        const w = obj.lengthCm * PX_PER_CM;
        return {
          x: obj.x,
          y: obj.y,
          w: w,
          h: obj.heightPx,
          rotation: obj.rotation || 0
        };
      }
      if (obj.id === 'inst_compass') {
        const minX = Math.min(obj.nx, obj.px) - 30;
        const maxX = Math.max(obj.nx, obj.px) + 30;
        const hinge = getCompassHinge(obj);
        const minY = Math.min(obj.ny, obj.py, hinge.y) - 30;
        const maxY = Math.max(obj.ny, obj.py, hinge.y) + 30;
        return {
          x: minX,
          y: minY,
          w: maxX - minX,
          h: maxY - minY,
          rotation: 0
        };
      }
    }
    return null;
  }

  function getCompassHinge(comp) {
    const mx = (comp.nx + comp.px) / 2;
    const my = (comp.ny + comp.py) / 2;
    const d = dist(comp.nx, comp.ny, comp.px, comp.py);
    const legLen = Math.max(135, d * 0.65);
    const h = Math.sqrt(Math.max(30 * 30, legLen * legLen - (d / 2) * (d / 2)));
    // Perpendicular upward-biased direction
    const angle = Math.atan2(comp.py - comp.ny, comp.px - comp.nx);
    let perpX = Math.sin(angle);
    let perpY = -Math.cos(angle);
    if (perpY > 0) {
      perpX = -perpX;
      perpY = -perpY;
    }
    return {
      x: mx + perpX * h,
      y: my + perpY * h
    };
  }

  function getCompassDrawDot(comp) {
    const hinge = getCompassHinge(comp);
    const dx = comp.px - hinge.x;
    const dy = comp.py - hinge.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: comp.px + (dx / len) * 56,
      y: comp.py + (dy / len) * 56
    };
  }

  // Is the point on the ruler's top measuring edge? Returns the snapped edge point + axis.
  function rulerEdgeInfo(wx, wy) {
    const ruler = board.instruments.ruler;
    if (!ruler.visible || !uiState.snapToRuler) return { onEdge: false };
    const local = unrotatePoint(wx, wy, ruler.x, ruler.y, ruler.rotation);
    const lx = local.x - ruler.x;
    const ly = local.y - ruler.y;
    const w = ruler.lengthCm * PX_PER_CM;
    if (lx < -10 || lx > w + 10 || Math.abs(ly) > 18) return { onEdge: false };
    const rad = ruler.rotation * DEG_TO_RAD;
    const cx = Math.max(0, Math.min(w, lx));
    const snapped = rotatePoint(ruler.x + cx, ruler.y, ruler.x, ruler.y, ruler.rotation);
    return {
      onEdge: true,
      x: snapped.x,
      y: snapped.y,
      ox: ruler.x,
      oy: ruler.y,
      ux: Math.cos(rad),
      uy: Math.sin(rad)
    };
  }

  function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (l2 === 0) return dist(px, py, x1, y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return dist(px, py, x1 + t * (x2 - x1), y1 + t * (y2 - y1));
  }

  // Test interactive handles on geometry instruments first
  function hitTestInstruments(wx, wy) {
    const hitR = 18 / viewport.zoom;

    // 1. Compass handles (Hinge, Pencil, Needle, Draw Circle button)
    const comp = board.instruments.compass;
    if (comp.visible) {
      const hinge = getCompassHinge(comp);
      // Draw Circle button sits 28px above the hinge
      const btnX = hinge.x;
      const btnY = hinge.y - 32;
      if (Math.abs(wx - btnX) <= 46 && Math.abs(wy - btnY) <= 14) {
        return { type: 'compass_draw_btn', inst: comp };
      }
      if (dist(wx, wy, comp.px, comp.py) <= hitR * 1.2) {
        return { type: 'compass_pencil', inst: comp };
      }
      // Swing-to-draw handle sits beyond the pencil along the leg
      const drawDot = getCompassDrawDot(comp);
      if (dist(wx, wy, drawDot.x, drawDot.y) <= hitR * 1.2) {
        return { type: 'compass_draw', inst: comp };
      }
      if (dist(wx, wy, comp.nx, comp.ny) <= hitR * 1.2) {
        return { type: 'compass_needle', inst: comp };
      }
      if (dist(wx, wy, hinge.x, hinge.y) <= hitR * 1.3) {
        return { type: 'compass_hinge', inst: comp };
      }
      // Check legs
      if (
        pointToSegmentDist(wx, wy, hinge.x, hinge.y, comp.nx, comp.ny) <= 10 / viewport.zoom ||
        pointToSegmentDist(wx, wy, hinge.x, hinge.y, comp.px, comp.py) <= 10 / viewport.zoom
      ) {
        return { type: 'compass_hinge', inst: comp };
      }
    }

    // 2. Protractor handles (Ray handle, Rotate handle, Body)
    const prot = board.instruments.protractor;
    if (prot.visible) {
      const local = unrotatePoint(wx, wy, prot.x, prot.y, prot.rotation);
      const lx = local.x - prot.x;
      const ly = local.y - prot.y;

      // Ray handle position in local protractor coordinates (0 deg = right, counter-clockwise up)
      const rayRad = -prot.rayAngle * DEG_TO_RAD;
      const rayHx = Math.cos(rayRad) * (prot.radius + 14);
      const rayHy = Math.sin(rayRad) * (prot.radius + 14);
      if (dist(lx, ly, rayHx, rayHy) <= hitR * 1.3) {
        return { type: 'protractor_ray', inst: prot };
      }

      // Rotate handle on right baseline end
      const rotHx = prot.radius - 16;
      const rotHy = 14;
      if (dist(lx, ly, rotHx, rotHy) <= hitR * 1.25) {
        return { type: 'protractor_rotate', inst: prot };
      }

      // Resize handle on left baseline end
      if (dist(lx, ly, -(prot.radius - 16), 14) <= hitR * 1.25) {
        return { type: 'protractor_resize', inst: prot };
      }

      // Semi-circle body hit test
      const d = Math.hypot(lx, ly);
      if (d <= prot.radius && ly <= 22 && ly >= -prot.radius) {
        return { type: 'protractor_body', inst: prot };
      }
    }

    // 3. Ruler handles (Rotate handle, Body)
    const ruler = board.instruments.ruler;
    if (ruler.visible) {
      const w = ruler.lengthCm * PX_PER_CM;
      const h = ruler.heightPx;
      const local = unrotatePoint(wx, wy, ruler.x, ruler.y, ruler.rotation);
      const lx = local.x - ruler.x;
      const ly = local.y - ruler.y;

      // Resize handle at the left end (drag to change length, right end stays fixed)
      if (dist(lx, ly, 24, h / 2 + 4) <= hitR * 1.2) {
        return { type: 'ruler_resize', inst: ruler };
      }
      // Rotate handle near right end
      if (dist(lx, ly, w - 24, h / 2) <= hitR * 1.2) {
        return { type: 'ruler_rotate', inst: ruler };
      }
      if (lx >= 0 && lx <= w && ly >= 0 && ly <= h) {
        return { type: 'ruler_body', inst: ruler };
      }
    }

    return null;
  }

  // Test selection handles on currently selected object
  function hitTestSelectionHandles(wx, wy) {
    if (!selectedObject) return null;
    const obj = findObject(selectedObject.category, selectedObject.id);
    if (!obj) return null;
    const handleR = 11 / viewport.zoom;

    if (selectedObject.category === 'line') {
      if (dist(wx, wy, obj.x1, obj.y1) <= handleR * 1.3) return { handle: 'p1', obj };
      if (dist(wx, wy, obj.x2, obj.y2) <= handleR * 1.3) return { handle: 'p2', obj };
      return null;
    }

    if (selectedObject.category === 'stroke' && obj.kind === 'measure') {
      if (dist(wx, wy, obj.x1, obj.y1) <= handleR * 1.3) return { handle: 'p1', obj };
      if (dist(wx, wy, obj.x2, obj.y2) <= handleR * 1.3) return { handle: 'p2', obj };
      return null;
    }

    const b = getObjectBounds(selectedObject.category, obj);
    if (!b) return null;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const local = b.rotation ? unrotatePoint(wx, wy, cx, cy, b.rotation) : { x: wx, y: wy };

    // Rotation handle (top center - 26px)
    if (selectedObject.category === 'shape' || selectedObject.category === 'image' || selectedObject.category === 'text' || selectedObject.category === 'instrument') {
      if (dist(local.x, local.y, cx, b.y - 26 / viewport.zoom) <= handleR * 1.3) {
        return { handle: 'rotate', obj, bounds: b };
      }
    }

    // 8 resize handles for frames, shapes, images, circles
    if (
      selectedObject.category === 'frame' ||
      selectedObject.category === 'shape' ||
      selectedObject.category === 'image' ||
      selectedObject.category === 'text' ||
      (selectedObject.category === 'stroke' && obj.kind === 'circle')
    ) {
      const pts = [
        { name: 'nw', x: b.x, y: b.y },
        { name: 'n', x: cx, y: b.y },
        { name: 'ne', x: b.x + b.w, y: b.y },
        { name: 'e', x: b.x + b.w, y: cy },
        { name: 'se', x: b.x + b.w, y: b.y + b.h },
        { name: 's', x: cx, y: b.y + b.h },
        { name: 'sw', x: b.x, y: b.y + b.h },
        { name: 'w', x: b.x, y: cy }
      ];
      for (const pt of pts) {
        if (dist(local.x, local.y, pt.x, pt.y) <= handleR * 1.25) {
          return { handle: pt.name, obj, bounds: b };
        }
      }
    }
    return null;
  }

  function hitTestBoardObjects(wx, wy) {
    const tol = 10 / viewport.zoom;

    // 1. Strokes (top-most first)
    for (let i = board.strokes.length - 1; i >= 0; i--) {
      const st = board.strokes[i];
      if (st.kind === 'circle') {
        const d = dist(wx, wy, st.cx, st.cy);
        if (Math.abs(d - st.r) <= tol || d <= tol) {
          return { category: 'stroke', id: st.id, obj: st };
        }
      } else if (st.kind === 'measure') {
        if (pointToSegmentDist(wx, wy, st.x1, st.y1, st.x2, st.y2) <= tol) {
          return { category: 'stroke', id: st.id, obj: st };
        }
      } else if (st.points && st.points.length) {
        for (let j = 0; j < st.points.length - 1; j++) {
          const p1 = st.points[j];
          const p2 = st.points[j + 1];
          if (pointToSegmentDist(wx, wy, p1.x, p1.y, p2.x, p2.y) <= Math.max(tol, (st.width || 4) / 2)) {
            return { category: 'stroke', id: st.id, obj: st };
          }
        }
        if (st.points.length === 1 && dist(wx, wy, st.points[0].x, st.points[0].y) <= tol) {
          return { category: 'stroke', id: st.id, obj: st };
        }
      }
    }

    // 2. Lines & Arrows
    for (let i = board.lines.length - 1; i >= 0; i--) {
      const ln = board.lines[i];
      if (pointToSegmentDist(wx, wy, ln.x1, ln.y1, ln.x2, ln.y2) <= Math.max(tol, (ln.width || 3))) {
        return { category: 'line', id: ln.id, obj: ln };
      }
    }

    // 3. Shapes
    for (let i = board.shapes.length - 1; i >= 0; i--) {
      const sh = board.shapes[i];
      const cx = sh.x + sh.w / 2;
      const cy = sh.y + sh.h / 2;
      const local = sh.rotation ? unrotatePoint(wx, wy, cx, cy, sh.rotation) : { x: wx, y: wy };
      if (local.x >= sh.x - tol && local.x <= sh.x + sh.w + tol && local.y >= sh.y - tol && local.y <= sh.y + sh.h + tol) {
        return { category: 'shape', id: sh.id, obj: sh };
      }
    }

    // 3a. Text boxes (v4)
    for (let i = (board.texts || []).length - 1; i >= 0; i--) {
      const tx = board.texts[i];
      const cx = tx.x + tx.w / 2;
      const cy = tx.y + tx.h / 2;
      const local = tx.rotation ? unrotatePoint(wx, wy, cx, cy, tx.rotation) : { x: wx, y: wy };
      if (local.x >= tx.x - tol && local.x <= tx.x + tx.w + tol && local.y >= tx.y - tol && local.y <= tx.y + tx.h + tol) {
        return { category: 'text', id: tx.id, obj: tx };
      }
    }

    // 3b. Images (v3) — inside rotated bounds
    for (let i = board.images.length - 1; i >= 0; i--) {
      const im = board.images[i];
      const cx = im.x + im.w / 2;
      const cy = im.y + im.h / 2;
      const local = im.rotation ? unrotatePoint(wx, wy, cx, cy, im.rotation) : { x: wx, y: wy };
      if (local.x >= im.x - tol && local.x <= im.x + im.w + tol && local.y >= im.y - tol && local.y <= im.y + im.h + tol) {
        return { category: 'image', id: im.id, obj: im };
      }
    }

    // 4. Frames (prefer header bar or border, or body if clicked in Select mode)
    for (let i = board.frames.length - 1; i >= 0; i--) {
      const fr = board.frames[i];
      const inHeader = wx >= fr.x && wx <= fr.x + fr.w && wy >= fr.y - 32 && wy <= fr.y;
      const inBody = wx >= fr.x && wx <= fr.x + fr.w && wy >= fr.y && wy <= fr.y + fr.h;
      if (inHeader || inBody) {
        return { category: 'frame', id: fr.id, obj: fr };
      }
    }

    return null;
  }

  // Snap point to ruler's top measuring edge if close
  function maybeSnapToRulerEdge(wx, wy) {
    const ruler = board.instruments.ruler;
    if (!ruler.visible || !uiState.snapToRuler) return { x: wx, y: wy };
    const local = unrotatePoint(wx, wy, ruler.x, ruler.y, ruler.rotation);
    const lx = local.x - ruler.x;
    const ly = local.y - ruler.y;
    const w = ruler.lengthCm * PX_PER_CM;
    if (lx >= -10 && lx <= w + 10 && Math.abs(ly) <= 18) {
      const snappedWorld = rotatePoint(ruler.x + Math.max(0, Math.min(w, lx)), ruler.y - 2, ruler.x, ruler.y, ruler.rotation);
      return snappedWorld;
    }
    return { x: wx, y: wy };
  }

  // ---------------------------------------------------------
  // COMPASS "DRAW CIRCLE" ACTION
  // ---------------------------------------------------------
  function drawCompassCircleAction() {
    const comp = board.instruments.compass;
    const rPx = dist(comp.nx, comp.ny, comp.px, comp.py);
    const rCm = rPx / PX_PER_CM;
    const circleObj = {
      id: uid('circle'),
      kind: 'circle',
      cx: comp.nx,
      cy: comp.ny,
      r: rPx,
      rCm: Number(rCm.toFixed(2)),
      color: comp.color || uiState.penColor || '#dc2626',
      width: 2.5,
      label: 'r = ' + rCm.toFixed(1) + ' cm'
    };
    board.strokes.push(circleObj);
    window.BoardSync.send('stroke_add', circleObj);
    updateReadouts();
    requestRender();
    showToast('Drew circle (' + circleObj.label + ')');
  }

  // Stamp Protractor Ray Line Action
  function stampProtractorRayAction() {
    const prot = board.instruments.protractor;
    const totalDeg = prot.rotation - prot.rayAngle;
    const rad = totalDeg * DEG_TO_RAD;
    const x2 = prot.x + Math.cos(rad) * prot.radius;
    const y2 = prot.y + Math.sin(rad) * prot.radius;
    const lineObj = {
      id: uid('line'),
      type: 'arrow',
      x1: prot.x,
      y1: prot.y,
      x2: x2,
      y2: y2,
      color: '#2563eb',
      width: 2.5,
      dashed: false,
      angleLabel: prot.rayAngle.toFixed(1) + '°'
    };
    board.lines.push(lineObj);
    window.BoardSync.send('line_add', lineObj);
    requestRender();
    showToast('Stamped ' + prot.rayAngle.toFixed(1) + '° ray');
  }

  // ---------------------------------------------------------
  // CANVAS RENDERING
  // ---------------------------------------------------------
  let renderPending = false;
  function requestRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(renderBoard);
    }
  }

  // v4.8: only reset the backing store when the size actually changed.
  // Resetting canvas.width clears the bitmap, so an unconditional reset on
  // every call would flash the board; and a cheap no-op lets resizeCanvas
  // be called safely at the start of every stroke.
  function resizeCanvas() {
    const container = canvas.parentElement;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      requestRender();
    }
  }

  function renderBoard() {
    renderPending = false;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Clear background
    ctx.fillStyle = currentTheme === 'dark' ? '#0f172a' : '#f1f5f9';
    ctx.fillRect(0, 0, width, height);

    // 2. Apply per-device viewport transform
    ctx.save();
    ctx.translate(viewport.panX, viewport.panY);
    ctx.scale(viewport.zoom, viewport.zoom);

    // 3. Draw infinite subtle grid (1 cm = 30px major grid, 5mm = 15px minor grid)
    drawInfiniteGrid(width, height);

    // 4. Draw Frames (bottom board layer)
    for (const fr of board.frames) {
      drawFrame(fr);
    }

    // 5. Draw Shapes
    for (const sh of board.shapes) {
      drawShape(sh);
    }

    // 5b. Draw Images (v3) — pen/shapes can annotate over them, strokes draw above
    for (const im of board.images) {
      drawImageObject(im, ctx);
    }

    // 5c. Draw Text boxes (v4)
    for (const tx of (board.texts || [])) {
      drawTextObject(tx);
    }

    // 6. Draw Lines & Arrows
    for (const ln of board.lines) {
      drawLineObject(ln);
    }

    // 7. Draw Freehand Strokes, Measure Lines & Drawn Compass Circles
    for (const st of board.strokes) {
      drawStrokeObject(st);
    }

    // 8. Draw in-progress creation preview (stroke / shape / line)
    if (interaction && interaction.preview) {
      if (interaction.type === 'draw_stroke' || interaction.type === 'compass_draw') {
        drawStrokeObject(interaction.preview);
      } else if (interaction.type === 'draw_shape') {
        drawShape(interaction.preview);
      } else if (interaction.type === 'draw_line' || interaction.type === 'ruler_line') {
        drawLineObject(interaction.preview);
      }
    }

    // 9. Draw Geometry Instruments (Ruler, Protractor, Compass)
    if (board.instruments.ruler.visible) {
      drawRuler(board.instruments.ruler);
    }
    if (board.instruments.protractor.visible) {
      drawProtractor(board.instruments.protractor);
    }
    if (board.instruments.compass.visible) {
      drawCompass(board.instruments.compass);
    }

    // 10. Draw Selection Overlay & Handles (v4.4: every item in a multi-selection gets an overlay)
    if (multiActive && multiSelection.length > 1) {
      for (const s of multiSelection) drawSelectionOverlay(s);
    } else if (selectedObject) {
      drawSelectionOverlay(selectedObject);
    }

    // 10a. v4.3 magnetic snap guide lines (while a frame drag is snapped)
    drawSnapGuides();

    // 10a2. v4.4 marquee selection box while dragging
    drawMarquee();

    // 10b. Crop-mode rectangle (v3)
    if (cropMode) {
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2 / viewport.zoom;
      ctx.setLineDash([8 / viewport.zoom, 6 / viewport.zoom]);
      ctx.strokeRect(
        Math.min(cropMode.startWx, cropMode.curWx),
        Math.min(cropMode.startWy, cropMode.curWy),
        Math.abs(cropMode.curWx - cropMode.startWx),
        Math.abs(cropMode.curWy - cropMode.startWy)
      );
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();
    ctx.restore();
  }

  function drawInfiniteGrid(screenW, screenH) {
    const startWorld = screenToWorld(0, 0);
    const endWorld = screenToWorld(screenW, screenH);

    const majorStep = PX_PER_CM * 2; // 60px (2 cm)
    const minorStep = PX_PER_CM / 2; // 15px (0.5 cm)

    // Minor grid (hide when zoomed far out)
    if (viewport.zoom >= 0.45) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = 1 / viewport.zoom;
      const firstMinorX = Math.floor(startWorld.x / minorStep) * minorStep;
      const firstMinorY = Math.floor(startWorld.y / minorStep) * minorStep;
      for (let x = firstMinorX; x <= endWorld.x; x += minorStep) {
        ctx.moveTo(x, startWorld.y);
        ctx.lineTo(x, endWorld.y);
      }
      for (let y = firstMinorY; y <= endWorld.y; y += minorStep) {
        ctx.moveTo(startWorld.x, y);
        ctx.lineTo(endWorld.x, y);
      }
      ctx.stroke();
    }

    // Major grid
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 1 / viewport.zoom;
    const firstMajorX = Math.floor(startWorld.x / majorStep) * majorStep;
    const firstMajorY = Math.floor(startWorld.y / majorStep) * majorStep;
    for (let x = firstMajorX; x <= endWorld.x; x += majorStep) {
      ctx.moveTo(x, startWorld.y);
      ctx.lineTo(x, endWorld.y);
    }
    for (let y = firstMajorY; y <= endWorld.y; y += majorStep) {
      ctx.moveTo(startWorld.x, y);
      ctx.lineTo(endWorld.x, y);
    }
    ctx.stroke();
  }

  function drawFrame(fr) {
    ctx.save();
    // Subtle drop shadow
    ctx.shadowColor = 'rgba(15, 23, 42, 0.08)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;

    ctx.fillStyle = (currentTheme === 'dark' && (!fr.bg || fr.bg === '#ffffff')) ? '#1e293b' : (fr.bg || '#ffffff');
    ctx.fillRect(fr.x, fr.y, fr.w, fr.h);

    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);

    // Subtle internal grid inside frame
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    for (let x = fr.x + PX_PER_CM; x < fr.x + fr.w; x += PX_PER_CM) {
      ctx.moveTo(x, fr.y);
      ctx.lineTo(x, fr.y + fr.h);
    }
    for (let y = fr.y + PX_PER_CM; y < fr.y + fr.h; y += PX_PER_CM) {
      ctx.moveTo(fr.x, y);
      ctx.lineTo(fr.x + fr.w, y);
    }
    ctx.stroke();

    // v4: frame titles are NOT drawn (removed by request; title field kept in data only).
    // v4.3: locked frames show a small lock badge at the top-left corner.
    if (fr.locked) {
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(fr.x + 6, fr.y + 6, 26, 26);
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔒', fr.x + 19, fr.y + 20);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    // v4.8: frame number (creation order) at the top-right corner.
    if (fr.seq && fr.w >= 70) {
      const label = String(fr.seq);
      ctx.font = 'bold 13px Inter, sans-serif';
      const bw = ctx.measureText(label).width + 12;
      const bh = 22;
      const bx = fr.x + fr.w - bw - 6;
      const by = fr.y + 6;
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  // v3: cached <img> element for a board image object (loads once, re-renders on load)
  function getImageElement(im) {
    if (!im || !im.src) return null;
    const cached = imageElementCache.get(im.id);
    if (cached && cached.src === im.src) return cached.el;
    const el = new Image();
    el.onload = () => requestRender();
    el.onerror = () => requestRender();
    el.src = im.src;
    imageElementCache.set(im.id, { src: im.src, el: el });
    return el;
  }

  // v3: draw one board image (targetCtx defaults to the main canvas ctx)
  function drawImageObject(im, targetCtx) {
    const c = targetCtx || ctx;
    const el = getImageElement(im);
    c.save();
    const cx = im.x + im.w / 2;
    const cy = im.y + im.h / 2;
    if (im.rotation) {
      c.translate(cx, cy);
      c.rotate(im.rotation * DEG_TO_RAD);
      c.translate(-cx, -cy);
    }
    if (el && el.complete && el.naturalWidth > 0) {
      c.drawImage(el, im.x, im.y, im.w, im.h);
    } else {
      c.fillStyle = '#e2e8f0';
      c.fillRect(im.x, im.y, im.w, im.h);
      c.fillStyle = '#475569';
      c.font = '600 13px Inter, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('Loading image…', cx, cy);
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
    }
    c.restore();
  }

  function drawShape(sh) {
    ctx.save();
    const cx = sh.x + sh.w / 2;
    const cy = sh.y + sh.h / 2;
    if (sh.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate(sh.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }

    ctx.beginPath();
    if (sh.shapeType === 'rect') {
      ctx.roundRect(sh.x, sh.y, sh.w, sh.h, 4);
    } else if (sh.shapeType === 'ellipse') {
      ctx.ellipse(cx, cy, Math.abs(sh.w / 2), Math.abs(sh.h / 2), 0, 0, Math.PI * 2);
    } else if (sh.shapeType === 'triangle') {
      ctx.moveTo(cx, sh.y);
      ctx.lineTo(sh.x + sh.w, sh.y + sh.h);
      ctx.lineTo(sh.x, sh.y + sh.h);
      ctx.closePath();
    } else if (sh.shapeType === 'diamond') {
      ctx.moveTo(cx, sh.y);
      ctx.lineTo(sh.x + sh.w, cy);
      ctx.lineTo(cx, sh.y + sh.h);
      ctx.lineTo(sh.x, cy);
      ctx.closePath();
    } else if (sh.shapeType === 'trapezium') {
      ctx.moveTo(sh.x + sh.w * 0.2, sh.y);
      ctx.lineTo(sh.x + sh.w * 0.8, sh.y);
      ctx.lineTo(sh.x + sh.w, sh.y + sh.h);
      ctx.lineTo(sh.x, sh.y + sh.h);
      ctx.closePath();
    }

    if (sh.fill && sh.fill !== 'transparent') {
      ctx.fillStyle = sh.fill;
      ctx.fill();
    }
    ctx.strokeStyle = displayColor(sh.stroke || '#1d4ed8');
    ctx.lineWidth = sh.strokeWidth || 3;
    ctx.stroke();
    ctx.restore();
  }

  function drawTextObject(tx) {
    if (!tx || !tx.text) return;
    ctx.save();
    const cx = tx.x + tx.w / 2;
    const cy = tx.y + tx.h / 2;
    if (tx.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate(tx.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = displayColor(tx.color || '#0f172a');
    ctx.font = '600 ' + (tx.fontSize || 22) + 'px Inter, sans-serif';
    ctx.textBaseline = 'top';
    const lines = String(tx.text).split('\n');
    const lh = (tx.fontSize || 22) * 1.35;
    lines.forEach((line, i) => { ctx.fillText(line, tx.x + 6, tx.y + 6 + i * lh); });
    ctx.restore();
  }

  function drawLineObject(ln) {
    ctx.save();
    ctx.strokeStyle = displayColor(ln.color || '#0f172a');
    ctx.fillStyle = displayColor(ln.color || '#0f172a');
    ctx.lineWidth = ln.width || 3;
    ctx.lineCap = 'round';
    if (ln.dashed) {
      ctx.setLineDash([8, 6]);
    }

    ctx.beginPath();
    ctx.moveTo(ln.x1, ln.y1);
    ctx.lineTo(ln.x2, ln.y2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw arrowhead if type === 'arrow'
    if (ln.type === 'arrow') {
      const angle = Math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1);
      const headLen = Math.max(12, (ln.width || 3) * 3.8);
      ctx.beginPath();
      ctx.moveTo(ln.x2, ln.y2);
      ctx.lineTo(
        ln.x2 - headLen * Math.cos(angle - Math.PI / 6),
        ln.y2 - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        ln.x2 - headLen * Math.cos(angle + Math.PI / 6),
        ln.y2 - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }

    if (ln.angleLabel) {
      const mx = (ln.x1 + ln.x2) / 2;
      const my = (ln.y1 + ln.y2) / 2;
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillStyle = ln.color || '#2563eb';
      ctx.fillText(ln.angleLabel, mx + 8, my - 8);
    }

    ctx.restore();
  }

  function drawStrokeObject(st) {
    ctx.save();

    if (st.kind === 'circle') {
      // Drawn Compass Circle with center dot, dashed radius line, and "r = x cm" label
      ctx.strokeStyle = st.color || '#dc2626';
      ctx.lineWidth = st.width || 2.5;
      ctx.beginPath();
      ctx.arc(st.cx, st.cy, st.r, 0, Math.PI * 2);
      ctx.stroke();

      // Center vertex point
      ctx.fillStyle = st.color || '#dc2626';
      ctx.beginPath();
      ctx.arc(st.cx, st.cy, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Dashed radius indicator line
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = st.color || '#dc2626';
      ctx.beginPath();
      ctx.moveTo(st.cx, st.cy);
      ctx.lineTo(st.cx + st.r, st.cy);
      ctx.stroke();
      ctx.restore();

      // Radius badge ("r = x cm")
      const label = st.label || ('r = ' + (st.r / PX_PER_CM).toFixed(1) + ' cm');
      ctx.font = '600 12px Inter, sans-serif';
      const tw = ctx.measureText(label).width;
      const lx = st.cx + st.r / 2 - tw / 2 - 5;
      const ly = st.cy - 22;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, tw + 10, 18, 4);
      ctx.fill();
      ctx.fillStyle = st.color || '#dc2626';
      ctx.fillText(label, lx + 5, ly + 13);

      ctx.restore();
      return;
    }

    if (st.kind === 'measure') {
      // Measured segment with ticks at ends and live cm label
      ctx.strokeStyle = st.color || '#059669';
      ctx.lineWidth = st.width || 2.5;
      ctx.beginPath();
      ctx.moveTo(st.x1, st.y1);
      ctx.lineTo(st.x2, st.y2);
      ctx.stroke();

      const angle = Math.atan2(st.y2 - st.y1, st.x2 - st.x1);
      const px = -Math.sin(angle) * 7;
      const py = Math.cos(angle) * 7;
      ctx.beginPath();
      ctx.moveTo(st.x1 - px, st.y1 - py);
      ctx.lineTo(st.x1 + px, st.y1 + py);
      ctx.moveTo(st.x2 - px, st.y2 - py);
      ctx.lineTo(st.x2 + px, st.y2 + py);
      ctx.stroke();

      const lenCm = dist(st.x1, st.y1, st.x2, st.y2) / PX_PER_CM;
      const text = lenCm.toFixed(2) + ' cm';
      const mx = (st.x1 + st.x2) / 2;
      const my = (st.y1 + st.y2) / 2;
      ctx.font = '600 12px Inter, sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.beginPath();
      ctx.roundRect(mx - tw / 2 - 6, my - 22, tw + 12, 20, 5);
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = st.color || '#059669';
      ctx.fillText(text, mx - tw / 2, my - 8);
      ctx.restore();
      return;
    }

    // Freehand Pen / Highlighter stroke
    if (!st.points || st.points.length === 0) {
      ctx.restore();
      return;
    }

    ctx.globalAlpha = st.isHighlighter ? 0.36 : 1.0;
    ctx.strokeStyle = displayColor(st.color || '#0f172a');
    ctx.fillStyle = displayColor(st.color || '#0f172a');
    ctx.lineWidth = st.width || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (st.points.length === 1) {
      ctx.beginPath();
      ctx.arc(st.points[0].x, st.points[0].y, (st.width || 4) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (let i = 1; i < st.points.length - 1; i++) {
        const xc = (st.points[i].x + st.points[i + 1].x) / 2;
        const yc = (st.points[i].y + st.points[i + 1].y) / 2;
        ctx.quadraticCurveTo(st.points[i].x, st.points[i].y, xc, yc);
      }
      const last = st.points[st.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------
  // GEOMETRY INSTRUMENTS RENDERING
  // ---------------------------------------------------------
  function drawRuler(ruler) {
    const w = ruler.lengthCm * PX_PER_CM; // 900px for 30 cm
    const h = ruler.heightPx;

    ctx.save();
    ctx.translate(ruler.x, ruler.y);
    ctx.rotate(ruler.rotation * DEG_TO_RAD);

    // Shadow & translucent acrylic body
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(240, 249, 255, 0.92)');
    grad.addColorStop(1, 'rgba(224, 242, 254, 0.88)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, [2, 2, 8, 8]);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Top beveled straightedge highlight
    ctx.fillStyle = 'rgba(2, 132, 199, 0.14)';
    ctx.fillRect(0, 0, w, 5);

    // Millimeter & Centimeter ticks (0 to 30 cm)
    ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 10px Inter, sans-serif';
    ctx.textAlign = 'center';

    const totalMm = ruler.lengthCm * 10;
    const pxPerMm = PX_PER_CM / 10; // 3px per mm

    ctx.beginPath();
    for (let mm = 0; mm <= totalMm; mm++) {
      const x = mm * pxPerMm;
      let tickH = 6;
      if (mm % 10 === 0) {
        tickH = 15;
      } else if (mm % 5 === 0) {
        tickH = 10;
      }
      ctx.moveTo(x, 0);
      ctx.lineTo(x, tickH);

      if (mm % 10 === 0) {
        const cmVal = mm / 10;
        const labelX = cmVal === 0 ? x + 6 : (cmVal === ruler.lengthCm ? x - 8 : x);
        ctx.fillText(String(cmVal), labelX, 25);
      }
    }
    ctx.lineWidth = 1;
    ctx.stroke();

    // Ruler label & angle badge
    ctx.textAlign = 'left';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillStyle = '#0369a1';
    ctx.fillText(ruler.lengthCm.toFixed(1) + ' cm Drafting Ruler  (' + (((ruler.rotation % 360) + 360) % 360).toFixed(1) + '°)', 18, h - 10);

    // Rotate handle on the right side
    const rx = w - 24;
    const ry = h / 2 + 4;
    ctx.fillStyle = '#0284c7';
    ctx.beginPath();
    ctx.arc(rx, ry, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⟳', rx, ry);

    // Resize handle on the left end (drag to change length)
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.arc(24, h / 2 + 4, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↔', 24, h / 2 + 4);

    ctx.restore();
  }

  function drawProtractor(prot) {
    const R = prot.radius; // 210px

    ctx.save();
    ctx.translate(prot.x, prot.y);
    ctx.rotate(prot.rotation * DEG_TO_RAD);

    // Outer semi-circle + base strip
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 3;

    ctx.fillStyle = 'rgba(238, 242, 255, 0.86)';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.6;

    ctx.beginPath();
    ctx.arc(0, 0, R, Math.PI, 0, false);
    ctx.lineTo(R, 20);
    ctx.lineTo(-R, 20);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    // Inner cutout window for clarity
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.42, Math.PI, 0, false);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79, 70, 229, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Baseline and origin crosshairs
    ctx.beginPath();
    ctx.strokeStyle = '#312e81';
    ctx.lineWidth = 1.4;
    ctx.moveTo(-R + 8, 0);
    ctx.lineTo(R - 8, 0);
    ctx.moveTo(0, -R + 8);
    ctx.lineTo(0, 14);
    ctx.stroke();

    // Origin vertex target
    ctx.fillStyle = '#4f46e5';
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Degree markings in BOTH directions:
    // Outer scale: 0 -> 180 (left to right clockwise)
    // Inner scale: 180 -> 0 (right to left counter-clockwise)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = 0; deg <= 180; deg++) {
      const rad = -deg * DEG_TO_RAD; // 0 is right (+X), 180 is left (-X)
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      let tickLen = 5;
      if (deg % 10 === 0) tickLen = 14;
      else if (deg % 5 === 0) tickLen = 9;

      ctx.beginPath();
      ctx.strokeStyle = deg % 10 === 0 ? '#1e1b4b' : 'rgba(49, 46, 129, 0.65)';
      ctx.lineWidth = deg % 10 === 0 ? 1.2 : 0.8;
      ctx.moveTo(cos * R, sin * R);
      ctx.lineTo(cos * (R - tickLen), sin * (R - tickLen));
      ctx.stroke();

      if (deg % 10 === 0) {
        // Inner scale (0 at right, 180 at left)
        const rInner = R - 24;
        ctx.font = '600 9px Inter, sans-serif';
        ctx.fillStyle = '#1e40af';
        ctx.fillText(String(deg), cos * rInner, sin * rInner);

        // Outer scale (0 at left, 180 at right)
        const rOuter = R - 38;
        ctx.font = '500 8.5px Inter, sans-serif';
        ctx.fillStyle = '#6d28d9';
        ctx.fillText(String(180 - deg), cos * rOuter, sin * rOuter);
      }
    }

    // Active Angle Ray & Shaded Angle Sector
    const rayRad = -prot.rayAngle * DEG_TO_RAD;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 52, 0, rayRad, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.24)';
    ctx.fill();
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Ray line from vertex to Ray Handle
    const hx = Math.cos(rayRad) * (R + 14);
    const hy = Math.sin(rayRad) * (R + 14);
    ctx.beginPath();
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 2.5;
    ctx.moveTo(0, 0);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    // Draggable Ray Handle
    ctx.fillStyle = '#ea580c';
    ctx.beginPath();
    ctx.arc(hx, hy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.fillText('∠', hx, hy);

    // Live Angle Readout Pill on Protractor
    const angleStr = prot.rayAngle.toFixed(1) + '°  (' + (180 - prot.rayAngle).toFixed(1) + '°)';
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.beginPath();
    ctx.roundRect(-62, -36, 124, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText('∠ ' + angleStr, 0, -25);

    // Rotate Handle at right baseline corner
    const rx = R - 16;
    const ry = 10;
    ctx.fillStyle = '#4f46e5';
    ctx.beginPath();
    ctx.arc(rx, ry, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText('⟳', rx, ry);

    // Resize Handle at left baseline corner (drag to change size)
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.arc(-(R - 16), 10, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText('↔', -(R - 16), 10);

    ctx.restore();
  }

  function drawCompass(comp) {
    const hinge = getCompassHinge(comp);
    const rPx = dist(comp.nx, comp.ny, comp.px, comp.py);
    const rCm = rPx / PX_PER_CM;

    ctx.save();

    // Faint preview circle showing exact locus of the compass
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(comp.nx, comp.ny, rPx, 0, Math.PI * 2);
    ctx.stroke();

    // Radius line between needle and pencil
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
    ctx.beginPath();
    ctx.moveTo(comp.nx, comp.ny);
    ctx.lineTo(comp.px, comp.py);
    ctx.stroke();
    ctx.restore();

    // Left leg: Hinge to Needle
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hinge.x, hinge.y);
    ctx.lineTo(comp.nx, comp.ny);
    ctx.stroke();

    // Right leg: Hinge to Pencil
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(hinge.x, hinge.y);
    ctx.lineTo(comp.px, comp.py);
    ctx.stroke();

    // Needle tip (draggable vertex point)
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(comp.nx, comp.ny, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', comp.nx, comp.ny);

    // Pencil tip (draggable radius/swing point)
    ctx.fillStyle = comp.color || '#dc2626';
    ctx.beginPath();
    ctx.arc(comp.px, comp.py, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Inter, sans-serif';
    ctx.fillText('✎', comp.px, comp.py);

    // Hinge crown (draggable whole-compass mover)
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(hinge.x, hinge.y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.fillText('✥', hinge.x, hinge.y);

    // Swing-to-draw handle beyond the pencil: drag it around the needle to trace an arc (or a full circle)
    const drawDot = getCompassDrawDot(comp);
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.arc(drawDot.x, drawDot.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText('↻', drawDot.x, drawDot.y);

    // Floating "Draw circle (r = X.X cm)" button above hinge
    const btnW = 92;
    const btnH = 24;
    const btnX = hinge.x - btnW / 2;
    const btnY = hinge.y - 44;
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText('◯ Draw Circle', hinge.x, btnY + btnH / 2);

    // Live radius badge at midpoint between needle and pencil
    const mx = (comp.nx + comp.px) / 2;
    const my = (comp.ny + comp.py) / 2;
    const rText = 'r = ' + rCm.toFixed(2) + ' cm';
    ctx.font = '600 11px Inter, sans-serif';
    const tw = ctx.measureText(rText).width;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
    ctx.beginPath();
    ctx.roundRect(mx - tw / 2 - 7, my + 8, tw + 14, 20, 5);
    ctx.fill();
    ctx.fillStyle = '#fca5a5';
    ctx.fillText(rText, mx, my + 18);

    ctx.restore();
  }

  // ---------------------------------------------------------
  // SELECTION OVERLAY RENDERING
  // ---------------------------------------------------------
  function drawSelectionOverlay(sel) {
    const obj = findObject(sel.category, sel.id);
    if (!obj) return;

    const handleR = 6 / viewport.zoom;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.5 / viewport.zoom;

    if (sel.category === 'line' || (sel.category === 'stroke' && obj.kind === 'measure')) {
      ctx.setLineDash([5 / viewport.zoom, 4 / viewport.zoom]);
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(obj.x2, obj.y2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const pt of [{ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, handleR * 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    const b = getObjectBounds(sel.category, obj);
    if (!b) {
      ctx.restore();
      return;
    }

    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (b.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate(b.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }

    ctx.setLineDash([6 / viewport.zoom, 4 / viewport.zoom]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);

    // Rotation handle for shapes, images, text & instruments
    if (sel.category === 'shape' || sel.category === 'image' || sel.category === 'text' || sel.category === 'instrument') {
      const rotY = b.y - 26 / viewport.zoom;
      ctx.beginPath();
      ctx.moveTo(cx, b.y);
      ctx.lineTo(cx, rotY);
      ctx.stroke();

      ctx.fillStyle = '#eff6ff';
      ctx.beginPath();
      ctx.arc(cx, rotY, handleR * 1.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 8 Resize handles for frames, shapes, images, circles (v4.3: never for a locked frame)
    if (
      (sel.category === 'frame' && !(obj && obj.locked)) ||
      sel.category === 'shape' ||
      sel.category === 'image' ||
      sel.category === 'text' ||
      (sel.category === 'stroke' && obj.kind === 'circle')
    ) {
      const pts = [
        { x: b.x, y: b.y },
        { x: cx, y: b.y },
        { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: cy },
        { x: b.x + b.w, y: b.y + b.h },
        { x: cx, y: b.y + b.h },
        { x: b.x, y: b.y + b.h },
        { x: b.x, y: cy }
      ];
      ctx.fillStyle = '#ffffff';
      for (const pt of pts) {
        ctx.fillRect(pt.x - handleR, pt.y - handleR, handleR * 2, handleR * 2);
        ctx.strokeRect(pt.x - handleR, pt.y - handleR, handleR * 2, handleR * 2);
      }
    }

    ctx.restore();
  }


  // ---------------------------------------------------------
  // v4.3: MAGNETIC FRAME SNAPPING + FRAME LOCK / COLOUR
  // ---------------------------------------------------------
  function frameHitTest(wx, wy) {
    // Topmost frame containing the point (body or the 32px header strip above it),
    // ignoring strokes/shapes/images/text that may sit inside the frame.
    for (let i = board.frames.length - 1; i >= 0; i--) {
      const fr = board.frames[i];
      if (wx >= fr.x && wx <= fr.x + fr.w && wy >= fr.y - 32 && wy <= fr.y + fr.h) return fr;
    }
    return null;
  }

  function isFrameLocked(fr) { return !!(fr && fr.locked); }

  function syncFrameChange(fr) {
    if (!fr) return;
    window.BoardSync.send('frame_update', fr);
    scheduleCloudSave();
    requestRender();
  }

  function setFrameLocked(fr, locked, silent) {
    if (!fr) return;
    fr.locked = !!locked;
    syncFrameChange(fr);
    if (!silent) showToast(locked ? 'Frame locked' : 'Frame unlocked');
  }

  function setFrameColour(fr, colour, silent) {
    if (!fr) return;
    if (isFrameLocked(fr)) { if (!silent) showToast('Frame is locked'); return; }
    fr.bg = colour;
    syncFrameChange(fr);
  }

  // ---- v4.4 marquee multi-selection helpers (instruments are never marquee-selectable) ----
  function boundsIntersect(b, rx1, ry1, rx2, ry2) {
    if (!b) return false;
    return b.x < rx2 && b.x + b.w > rx1 && b.y < ry2 && b.y + b.h > ry1;
  }
  function collectMarqueeSelection(rx1, ry1, rx2, ry2) {
    const list = [];
    const tryAdd = (category, obj) => {
      if (!obj) return;
      const b = getObjectBounds(category, obj);
      if (boundsIntersect(b, rx1, ry1, rx2, ry2)) list.push({ category: category, id: obj.id });
    };
    for (const fr of board.frames) tryAdd('frame', fr);
    for (const sh of board.shapes) tryAdd('shape', sh);
    for (const im of board.images) tryAdd('image', im);
    for (const tx of (board.texts || [])) tryAdd('text', tx);
    for (const ln of board.lines) tryAdd('line', ln);
    for (const st of board.strokes) tryAdd('stroke', st);
    return list;
  }
  function drawMarquee() {
    if (!marquee) return;
    const x = Math.min(marquee.x1, marquee.x2), y = Math.min(marquee.y1, marquee.y2);
    const w = Math.abs(marquee.x2 - marquee.x1), h = Math.abs(marquee.y2 - marquee.y1);
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.lineWidth = 1.5 / viewport.zoom;
    ctx.setLineDash([6 / viewport.zoom, 4 / viewport.zoom]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }
  function setObjectFromOrig(category, obj, orig, dx, dy) {
    if (category === 'frame' || category === 'shape' || category === 'image' || category === 'text') {
      obj.x = orig.x + dx; obj.y = orig.y + dy;
    } else if (category === 'line') {
      obj.x1 = orig.x1 + dx; obj.y1 = orig.y1 + dy; obj.x2 = orig.x2 + dx; obj.y2 = orig.y2 + dy;
    } else if (category === 'stroke') {
      if (obj.kind === 'circle') { obj.cx = orig.cx + dx; obj.cy = orig.cy + dy; }
      else if (obj.kind === 'measure') { obj.x1 = orig.x1 + dx; obj.y1 = orig.y1 + dy; obj.x2 = orig.x2 + dx; obj.y2 = orig.y2 + dy; }
      else if (obj.points && orig.points) {
        for (let i = 0; i < obj.points.length; i++) { obj.points[i].x = orig.points[i].x + dx; obj.points[i].y = orig.points[i].y + dy; }
      }
    }
  }
  function addObjectDelta(category, obj, dx, dy) {
    if (category === 'frame' || category === 'shape' || category === 'image' || category === 'text') {
      obj.x += dx; obj.y += dy;
    } else if (category === 'line') {
      obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy;
    } else if (category === 'stroke') {
      if (obj.kind === 'circle') { obj.cx += dx; obj.cy += dy; }
      else if (obj.kind === 'measure') { obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy; }
      else if (obj.points) { for (const p of obj.points) { p.x += dx; p.y += dy; } }
    }
  }
  function multiTargetFrames() {
    if (!frameMenuTargets || !frameMenuTargets.length) return [];
    return frameMenuTargets.map((f) => findObject('frame', f.id)).filter(Boolean);
  }

  // Snap a dragged frame's position to another frame's edges.
  // Primary contact snap: within 15 board px. When a frame stacks above/below
  // another (Y contact), its X is also aligned to the nearest left/centre/right
  // edge of that frame within 40 px, so same-width frames match on all corners;
  // the mirror rule applies for side-by-side (X contact) stacking.
  // Returns {x, y, guides:[{x1,y1,x2,y2}]} in world coords. Frames only, axis-aligned.
  function snapFramePosition(fr, nx, ny) {
    const TOL = 15, ALIGN = 40;
    if (!fr || fr.rotation) return { x: nx, y: ny, guides: [] };
    let x = nx, y = ny, snapY = null, snapX = null;
    for (const o of board.frames) {
      if (!o || o.id === fr.id || o.rotation) continue;
      const yCands = [
        { target: o.y + o.h, kind: 'top-to-bottom' },
        { target: o.y - fr.h, kind: 'bottom-to-top' },
        { target: o.y, kind: 'top-to-top' },
        { target: o.y + o.h - fr.h, kind: 'bottom-to-bottom' },
        { target: o.y + o.h / 2 - fr.h / 2, kind: 'centre-y' }
      ];
      for (const c of yCands) {
        const d = Math.abs(ny - c.target);
        if (d <= TOL && (!snapY || d < snapY.d)) snapY = { y: c.target, d: d, other: o, kind: c.kind };
      }
      const xCands = [
        { target: o.x - fr.w, kind: 'right-to-left' },
        { target: o.x + o.w, kind: 'left-to-right' },
        { target: o.x, kind: 'left-to-left' },
        { target: o.x + o.w - fr.w, kind: 'right-to-right' },
        { target: o.x + o.w / 2 - fr.w / 2, kind: 'centre-x' }
      ];
      for (const c of xCands) {
        const d = Math.abs(nx - c.target);
        if (d <= TOL && (!snapX || d < snapX.d)) snapX = { x: c.target, d: d, other: o, kind: c.kind };
      }
    }
    const guides = [];
    if (snapY) {
      y = snapY.y;
      // Secondary X alignment when stacking vertically: align to the same frame.
      const o = snapY.other;
      if (snapY.kind === 'top-to-bottom' || snapY.kind === 'bottom-to-top') {
        const opts = [
          { target: o.x, edge: 'left' },
          { target: o.x + o.w / 2 - fr.w / 2, edge: 'centre' },
          { target: o.x + o.w - fr.w, edge: 'right' }
        ];
        let best = null;
        for (const c of opts) { const d = Math.abs(nx - c.target); if (d <= ALIGN && (!best || d < best.d)) best = { x: c.target, d: d, edge: c.edge }; }
        if (best) {
          x = best.x;
          const gx = best.edge === 'left' ? x : (best.edge === 'right' ? x + fr.w : x + fr.w / 2);
          guides.push({ x1: gx, y1: Math.min(y, o.y), x2: gx, y2: Math.max(y + fr.h, o.y + o.h) });
        }
      }
      const gy = (snapY.kind === 'top-to-bottom') ? y : (snapY.kind === 'bottom-to-top' ? y + fr.h : (snapY.kind === 'centre-y' ? y + fr.h / 2 : y));
      guides.push({ x1: Math.min(x, snapY.other.x) - 20, y1: gy, x2: Math.max(x + fr.w, snapY.other.x + snapY.other.w) + 20, y2: gy });
    }
    if (snapX) {
      x = snapX.x;
      const o = snapX.other;
      if (snapX.kind === 'left-to-right' || snapX.kind === 'right-to-left') {
        const opts = [
          { target: o.y, edge: 'top' },
          { target: o.y + o.h / 2 - fr.h / 2, edge: 'centre' },
          { target: o.y + o.h - fr.h, edge: 'bottom' }
        ];
        let best = null;
        for (const c of opts) { const d = Math.abs(ny - c.target); if (d <= ALIGN && (!best || d < best.d)) best = { y: c.target, d: d, edge: c.edge }; }
        if (best) {
          y = best.y;
          const gy = best.edge === 'top' ? y : (best.edge === 'bottom' ? y + fr.h : y + fr.h / 2);
          guides.push({ x1: Math.min(x, o.x), y1: gy, x2: Math.max(x + fr.w, o.x + o.w), y2: gy });
        }
      }
      const gx = (snapX.kind === 'left-to-right') ? x : (snapX.kind === 'right-to-left' ? x + fr.w : (snapX.kind === 'centre-x' ? x + fr.w / 2 : x));
      guides.push({ x1: gx, y1: Math.min(y, snapX.other.y) - 20, x2: gx, y2: Math.max(y + fr.h, snapX.other.y + snapX.other.h) + 20 });
    }
    return { x: x, y: y, guides: guides };
  }

  function drawSnapGuides() {
    if (!frameSnapGuide || !frameSnapGuide.length) return;
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2 / viewport.zoom;
    ctx.setLineDash([8 / viewport.zoom, 6 / viewport.zoom]);
    ctx.beginPath();
    for (const g of frameSnapGuide) { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---- v4.3 frame right-click menu (DOM, positioned at the cursor) ----
  function frameMenuEl() { return document.getElementById('frameContextMenu'); }
  function closeFrameMenu() {
    cancelUnlockHold();
    const el = frameMenuEl();
    if (el) el.style.display = 'none';
    frameMenuFrameId = null;
    frameMenuTargets = null;
    const picker = document.getElementById('frameColourPicker');
    if (picker) picker.style.display = 'none';
  }
  function openFrameMenu(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(clientX - rect.left, clientY - rect.top);
    const fr = frameHitTest(world.x, world.y);
    if (!fr) { closeFrameMenu(); return; }
    // v4.4: right-click on a frame inside a multi-selection applies to the whole selection.
    const inMulti = multiActive && multiSelection.some((s) => s.category === 'frame' && s.id === fr.id);
    frameMenuTargets = inMulti
      ? multiSelection.filter((s) => s.category === 'frame').map((s) => ({ id: s.id }))
      : [{ id: fr.id }];
    frameMenuFrameId = fr.id;
    if (!inMulti) selectedObject = { category: 'frame', id: fr.id };
    syncSelectedObjectToControls('frame', fr);
    const el = frameMenuEl();
    if (!el) return;
    const targets = multiTargetFrames();
    const locked = targets.length > 1 ? targets.every((f) => isFrameLocked(f)) : isFrameLocked(fr);
    const unlockedRow = document.getElementById('frameMenuUnlocked');
    const lockedRow = document.getElementById('frameMenuLocked');
    const picker = document.getElementById('frameColourPicker');
    if (unlockedRow) unlockedRow.style.display = locked ? 'none' : 'flex';
    if (lockedRow) lockedRow.style.display = locked ? 'block' : 'none';
    if (picker) picker.style.display = 'none';
    const bar = document.getElementById('unlockProgressBar');
    if (bar) bar.style.width = '0%';
    el.style.display = 'block';
    const w = 220, h = locked ? 110 : 60; // locked here = ALL targets locked (mixed selections show Lock + Colour)
    el.style.left = Math.max(8, Math.min(clientX, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(clientY, window.innerHeight - h - 8)) + 'px';
    requestRender();
  }
  function menuFrame() {
    if (!frameMenuFrameId) return null;
    return board.frames.find((f) => f.id === frameMenuFrameId) || null;
  }
  function cancelUnlockHold() {
    if (!unlockHold) return;
    if (unlockHold.timeout) clearTimeout(unlockHold.timeout);
    if (unlockHold.raf) cancelAnimationFrame(unlockHold.raf);
    unlockHold = null;
    const bar = document.getElementById('unlockProgressBar');
    if (bar) bar.style.width = '0%';
  }
  function startUnlockHold() {
    // v4.4: unlocks every locked frame in the menu targets (single frame or whole selection).
    const targets = multiTargetFrames();
    if (!targets.length || !targets.every((f) => isFrameLocked(f))) return;
    cancelUnlockHold();
    const start = performance.now();
    const bar = document.getElementById('unlockProgressBar');
    const step = () => {
      if (!unlockHold) return;
      const pct = Math.min(100, ((performance.now() - start) / UNLOCK_HOLD_MS) * 100);
      if (bar) bar.style.width = pct + '%';
      if (pct < 100) unlockHold.raf = requestAnimationFrame(step);
    };
    unlockHold = {
      frameIds: targets.map((f) => f.id),
      raf: requestAnimationFrame(step),
      timeout: setTimeout(() => {
        unlockHold = null;
        if (bar) bar.style.width = '0%';
        for (const f of targets) setFrameLocked(f, false, true);
        showToast(targets.length > 1 ? 'Frames unlocked' : 'Frame unlocked');
        closeFrameMenu();
      }, UNLOCK_HOLD_MS)
    };
  }
  function bindFrameMenu() {
    const el = frameMenuEl();
    if (!el) return;
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    // Clicking anywhere outside the menu closes it (canvas mousedown included).
    document.addEventListener('mousedown', (e) => {
      if (el.style.display === 'block' && !el.contains(e.target)) closeFrameMenu();
    });
    const lockBtn = document.getElementById('btnFrameLock');
    if (lockBtn) lockBtn.addEventListener('click', () => {
      // v4.4: locks every frame in the menu targets at once.
      const targets = multiTargetFrames();
      if (targets.length > 1) {
        for (const f of targets) setFrameLocked(f, true, true);
        showToast('Frames locked');
      } else {
        const fr = menuFrame();
        if (fr) setFrameLocked(fr, true);
      }
      closeFrameMenu();
    });
    const colourBtn = document.getElementById('btnFrameColour');
    if (colourBtn) colourBtn.addEventListener('click', () => {
      const picker = document.getElementById('frameColourPicker');
      if (picker) picker.style.display = (picker.style.display === 'none' || !picker.style.display) ? 'flex' : 'none';
    });
    document.querySelectorAll('[data-frame-menu-colour]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // v4.4: colours every frame in the menu targets at once.
        const targets = multiTargetFrames();
        if (targets.length > 1) {
          for (const f of targets) setFrameColour(f, btn.getAttribute('data-frame-menu-colour'), true);
        } else {
          const fr = menuFrame();
          if (fr) setFrameColour(fr, btn.getAttribute('data-frame-menu-colour'));
        }
        closeFrameMenu();
      });
    });
    const colourInput = document.getElementById('frameColourInput');
    if (colourInput) {
      colourInput.addEventListener('input', (e) => {
        // v4.4: custom colour also applies to every frame in the menu targets.
        const targets = multiTargetFrames();
        if (targets.length > 1) {
          for (const f of targets) setFrameColour(f, e.target.value, true);
        } else {
          const fr = menuFrame();
          if (fr) setFrameColour(fr, e.target.value);
        }
      });
      colourInput.addEventListener('change', () => closeFrameMenu());
    }
    const unlockBtn = document.getElementById('btnFrameUnlock');
    if (unlockBtn) {
      unlockBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      unlockBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (e.button === 2) startUnlockHold();
        else showToast('Hold with the right button for 1 second to unlock');
      });
      const cancel = () => cancelUnlockHold();
      unlockBtn.addEventListener('pointerup', cancel);
      unlockBtn.addEventListener('pointerleave', cancel);
      unlockBtn.addEventListener('pointercancel', cancel);
    }
  }

  // ---------------------------------------------------------
  // POINTER, MOUSE WHEEL & TOUCH INTERACTION
  // ---------------------------------------------------------
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top
    };
  }

  function eraseAtWorldPoint(wx, wy) {
    const hit = hitTestBoardObjects(wx, wy);
    if (!hit) return;
    if (hit.category === 'stroke') {
      board.strokes = board.strokes.filter((s) => s.id !== hit.id);
      window.BoardSync.send('object_delete', { category: 'stroke', id: hit.id });
      requestRender();
    } else if (hit.category === 'line') {
      board.lines = board.lines.filter((l) => l.id !== hit.id);
      window.BoardSync.send('object_delete', { category: 'line', id: hit.id });
      requestRender();
    } else if (hit.category === 'shape') {
      board.shapes = board.shapes.filter((s) => s.id !== hit.id);
      window.BoardSync.send('object_delete', { category: 'shape', id: hit.id });
      requestRender();
    } else if (hit.category === 'text') {
      board.texts = (board.texts || []).filter((t) => t.id !== hit.id);
      window.BoardSync.send('object_delete', { category: 'text', id: hit.id });
      requestRender();
    }
  }

  function startPointerInteraction(sx, sy, isMiddleOrSpace) {
    // v4.8: re-size at the start of every stroke — the board's height can
    // have changed (address bar, drawer, scroll) without any resize event.
    resizeCanvas();
    // v4.8: students are view-only — any pointer press only pans the board.
    if (!isTeacher()) {
      interaction = {
        type: 'pan',
        startSx: sx,
        startSy: sy,
        origPanX: viewport.panX,
        origPanY: viewport.panY
      };
      return;
    }
    const world = screenToWorld(sx, sy);
    const wx = world.x;
    const wy = world.y;

    // v3: crop mode captures the pointer first — drag a rectangle over the selected image
    if (cropMode) {
      interaction = { type: 'crop_image', startWx: wx, startWy: wy };
      cropMode.startWx = wx;
      cropMode.startWy = wy;
      cropMode.curWx = wx;
      cropMode.curWy = wy;
      return;
    }

    // 1. Pan mode if spacebar held, middle click, or hand pan toggle active
    if (isMiddleOrSpace || uiState.spacePanning || uiState.panModeToggle) {
      interaction = {
        type: 'pan',
        startSx: sx,
        startSy: sy,
        origPanX: viewport.panX,
        origPanY: viewport.panY
      };
      return;
    }

    // 2. Always check instrument interactive handles & bodies first if in Select or Instruments mode
    const instHit = hitTestInstruments(wx, wy);
    if (instHit) {
      multiActive = false; multiSelection = []; // v4.4: instruments are never part of a multi-selection
      if (instHit.type === 'compass_draw_btn') {
        drawCompassCircleAction();
        return;
      }
      if (instHit.type === 'compass_pencil') {
        selectedObject = { category: 'instrument', id: 'inst_compass' };
        interaction = { type: 'compass_pencil' };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'compass_draw') {
        selectedObject = { category: 'instrument', id: 'inst_compass' };
        const comp = board.instruments.compass;
        interaction = {
          type: 'compass_draw',
          cx: comp.nx,
          cy: comp.ny,
          r: dist(comp.nx, comp.ny, comp.px, comp.py),
          lastAngle: Math.atan2(comp.py - comp.ny, comp.px - comp.nx),
          sweep: 0,
          preview: {
            id: uid('stroke'),
            kind: 'freehand',
            isHighlighter: false,
            color: comp.color || uiState.penColor || '#dc2626',
            width: uiState.penWidth,
            points: [{ x: comp.px, y: comp.py }]
          }
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'compass_needle') {
        selectedObject = { category: 'instrument', id: 'inst_compass' };
        const comp = board.instruments.compass;
        interaction = {
          type: 'compass_needle',
          dx: comp.px - comp.nx,
          dy: comp.py - comp.ny
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'compass_hinge') {
        selectedObject = { category: 'instrument', id: 'inst_compass' };
        const comp = board.instruments.compass;
        interaction = {
          type: 'compass_hinge',
          startWx: wx,
          startWy: wy,
          origNx: comp.nx,
          origNy: comp.ny,
          origPx: comp.px,
          origPy: comp.py
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'protractor_ray') {
        selectedObject = { category: 'instrument', id: 'inst_protractor' };
        interaction = { type: 'protractor_ray' };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'protractor_rotate') {
        selectedObject = { category: 'instrument', id: 'inst_protractor' };
        interaction = { type: 'protractor_rotate' };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'protractor_resize') {
        selectedObject = { category: 'instrument', id: 'inst_protractor' };
        interaction = { type: 'protractor_resize' };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'protractor_body' && (uiState.activeTab === 'select' || uiState.activeTab === 'instruments')) {
        selectedObject = { category: 'instrument', id: 'inst_protractor' };
        const prot = board.instruments.protractor;
        interaction = {
          type: 'protractor_body',
          startWx: wx,
          startWy: wy,
          origX: prot.x,
          origY: prot.y
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'ruler_rotate') {
        selectedObject = { category: 'instrument', id: 'inst_ruler' };
        interaction = { type: 'ruler_rotate' };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'ruler_resize') {
        selectedObject = { category: 'instrument', id: 'inst_ruler' };
        const ruler = board.instruments.ruler;
        const rad = ruler.rotation * DEG_TO_RAD;
        const w = ruler.lengthCm * PX_PER_CM;
        interaction = {
          type: 'ruler_resize',
          origX: ruler.x,
          origY: ruler.y,
          origLenPx: w,
          axisX: Math.cos(rad),
          axisY: Math.sin(rad),
          rightX: ruler.x + Math.cos(rad) * w,
          rightY: ruler.y + Math.sin(rad) * w
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (instHit.type === 'ruler_body' && (uiState.activeTab === 'select' || uiState.activeTab === 'instruments')) {
        selectedObject = { category: 'instrument', id: 'inst_ruler' };
        const ruler = board.instruments.ruler;
        interaction = {
          type: 'ruler_body',
          startWx: wx,
          startWy: wy,
          origX: ruler.x,
          origY: ruler.y
        };
        updateReadouts();
        requestRender();
        return;
      }
    }

    // 3. Mode-specific handling
    if (uiState.activeTab === 'select' || uiState.activeTab === 'instruments') {
      // Check selection handles on currently selected object (not for a multi-selection: drag moves it)
      const handleHit = multiActive ? null : hitTestSelectionHandles(wx, wy);
      // v4.3: a locked frame has no handles to grab — ignore handle hits on it.
      if (handleHit && selectedObject && selectedObject.category === 'frame') {
        const lockedFr = findObject('frame', selectedObject.id);
        if (lockedFr && lockedFr.locked) { updateReadouts(); requestRender(); return; }
      }
      if (handleHit) {
        pushHistory();
        const b = handleHit.bounds || getObjectBounds(selectedObject.category, handleHit.obj);
        interaction = {
          type: 'transform_object',
          handle: handleHit.handle,
          category: selectedObject.category,
          obj: handleHit.obj,
          startWx: wx,
          startWy: wy,
          origBounds: b ? { ...b } : null,
          origObj: JSON.parse(JSON.stringify(handleHit.obj))
        };
        return;
      }

      // Check clicking any object on the board
      const objHit = hitTestBoardObjects(wx, wy);
      // v4.4: dragging an object that is already in a multi-selection moves the whole selection.
      if (objHit && multiActive && multiSelection.some((s) => s.category === objHit.category && s.id === objHit.id)) {
        if (objHit.category === 'frame' && objHit.obj && objHit.obj.locked) {
          showToast('Frame is locked');
          updateReadouts();
          requestRender();
          return;
        }
        const items = [];
        for (const s of multiSelection) {
          const o = findObject(s.category, s.id);
          if (!o) continue;
          if (s.category === 'frame' && o.locked) continue; // locked frames stay put in a multi-move
          items.push({ category: s.category, obj: o, orig: JSON.parse(JSON.stringify(o)) });
        }
        if (!items.length) { showToast('Frame is locked'); updateReadouts(); requestRender(); return; }
        pushHistory();
        interaction = {
          type: 'move_multi',
          items: items,
          primaryCategory: objHit.category,
          primaryId: objHit.id,
          startWx: wx,
          startWy: wy
        };
        updateReadouts();
        requestRender();
        return;
      }
      if (objHit) {
        multiActive = false; multiSelection = []; // v4.4: a single click replaces any multi-selection
        // v4.3: a locked frame can be selected but never dragged — left-drag pans instead.
        if (objHit.category === 'frame' && objHit.obj && objHit.obj.locked) {
          selectedObject = { category: 'frame', id: objHit.id };
          syncSelectedObjectToControls('frame', objHit.obj);
          interaction = { type: 'pan', startSx: sx, startSy: sy, origPanX: viewport.panX, origPanY: viewport.panY };
          updateReadouts();
          requestRender();
          return;
        }
        pushHistory();
        selectedObject = { category: objHit.category, id: objHit.id };
        syncSelectedObjectToControls(objHit.category, objHit.obj);
        interaction = {
          type: 'move_object',
          category: objHit.category,
          obj: objHit.obj,
          startWx: wx,
          startWy: wy,
          origObj: JSON.parse(JSON.stringify(objHit.obj))
        };
        updateReadouts();
        requestRender();
        return;
      }

      // v4.4: clicked empty board in Select mode -> start a marquee selection box.
      // Left-drag on empty board NEVER pans any more; panning is right-button drag.
      selectedObject = null;
      multiActive = false; multiSelection = [];
      interaction = { type: 'marquee', startWx: wx, startWy: wy, curWx: wx, curWy: wy };
      marquee = { x1: wx, y1: wy, x2: wx, y2: wy };
      updateReadouts();
      requestRender();
      return;
    }

    if (uiState.activeTab === 'pen') {
      pushHistory();
      selectedObject = null;
      if (uiState.penSubTool === 'eraser') {
        interaction = { type: 'erase' };
        eraseAtWorldPoint(wx, wy);
        return;
      }
      if (uiState.penSubTool === 'measure') {
        const snapPt = maybeSnapToRulerEdge(wx, wy);
        interaction = {
          type: 'draw_stroke',
          preview: {
            id: uid('meas'),
            kind: 'measure',
            x1: snapPt.x,
            y1: snapPt.y,
            x2: snapPt.x,
            y2: snapPt.y,
            color: uiState.penColor,
            width: 2.5
          }
        };
        return;
      }
      // Pen or Highlighter: pressing on the ruler's top edge draws a straight line along the edge
      const edge = rulerEdgeInfo(wx, wy);
      if (edge.onEdge) {
        interaction = {
          type: 'ruler_line',
          edgeX: edge.ox,
          edgeY: edge.oy,
          edgeUx: edge.ux,
          edgeUy: edge.uy,
          preview: {
            id: uid('line'),
            type: 'line',
            x1: edge.x,
            y1: edge.y,
            x2: edge.x,
            y2: edge.y,
            color: uiState.penColor,
            width: uiState.penWidth,
            dashed: false
          }
        };
        requestRender();
        return;
      }
      // Pen or Highlighter
      const snapPt = maybeSnapToRulerEdge(wx, wy);
      const isHi = uiState.penSubTool === 'highlighter';
      interaction = {
        type: 'draw_stroke',
        preview: {
          id: uid('stroke'),
          kind: 'freehand',
          isHighlighter: isHi,
          color: uiState.penColor,
          width: isHi ? uiState.penWidth * 4.2 : uiState.penWidth,
          points: [{ x: snapPt.x, y: snapPt.y }]
        }
      };
      requestRender();
      return;
    }

    if (uiState.activeTab === 'shapes') {
      pushHistory();
      selectedObject = null;
      // v4: lines live under Shapes — if a line type was picked last, drag draws a line, not a shape.
      if (uiState.drawLineMode) {
        const snapPt = maybeSnapToRulerEdge(wx, wy);
        if (uiState.lineType === 'measure') {
          interaction = { type: 'draw_stroke', preview: { id: uid('meas'), kind: 'measure', x1: snapPt.x, y1: snapPt.y, x2: snapPt.x, y2: snapPt.y, color: uiState.lineColor, width: uiState.lineWidth } };
        } else {
          interaction = { type: 'draw_line', preview: { id: uid('line'), type: uiState.lineType, x1: snapPt.x, y1: snapPt.y, x2: snapPt.x, y2: snapPt.y, color: uiState.lineColor, width: uiState.lineWidth, dashed: uiState.lineDashed } };
        }
        requestRender();
        return;
      }
      interaction = {
        type: 'draw_shape',
        startWx: wx,
        startWy: wy,
        preview: {
          id: uid('shape'),
          shapeType: uiState.shapeType,
          x: wx,
          y: wy,
          w: 4,
          h: 4,
          rotation: 0,
          fill: uiState.shapeNoFill ? 'transparent' : uiState.shapeFill,
          stroke: uiState.shapeStroke,
          strokeWidth: uiState.shapeStrokeWidth
        }
      };
      requestRender();
      return;
    }

    if (uiState.activeTab === 'lines') {
      pushHistory();
      selectedObject = null;
      const snapPt = maybeSnapToRulerEdge(wx, wy);
      if (uiState.lineType === 'measure') {
        interaction = {
          type: 'draw_stroke',
          preview: {
            id: uid('meas'),
            kind: 'measure',
            x1: snapPt.x,
            y1: snapPt.y,
            x2: snapPt.x,
            y2: snapPt.y,
            color: uiState.lineColor,
            width: uiState.lineWidth
          }
        };
      } else {
        interaction = {
          type: 'draw_line',
          preview: {
            id: uid('line'),
            type: uiState.lineType, // 'line' or 'arrow'
            x1: snapPt.x,
            y1: snapPt.y,
            x2: snapPt.x,
            y2: snapPt.y,
            color: uiState.lineColor,
            width: uiState.lineWidth,
            dashed: uiState.lineDashed
          }
        };
      }
      requestRender();
      return;
    }

    if (uiState.activeTab === 'textbox') {
      const hit = hitTestBoardObjects(wx, wy);
      const existing = (hit && hit.category === 'text') ? hit.obj : null;
      openTextEditor(wx, wy, existing);
      interaction = { type: 'text_edit' };
      return;
    }

    if (uiState.activeTab === 'frames') {
      // Clicking board in Frames mode pans or selects existing frame
      interaction = {
        type: 'pan',
        startSx: sx,
        startSy: sy,
        origPanX: viewport.panX,
        origPanY: viewport.panY
      };
    }
  }

  function movePointerInteraction(sx, sy) {
    if (!interaction) return;
    const world = screenToWorld(sx, sy);
    const wx = world.x;
    const wy = world.y;

    if (interaction.type === 'pan') {
      if (interaction.rightButton && Math.hypot(sx - interaction.startSx, sy - interaction.startSy) > 6) interaction.moved = true;
      viewport.panX = interaction.origPanX + (sx - interaction.startSx);
      viewport.panY = interaction.origPanY + (sy - interaction.startSy);
      requestRender();
      return;
    }

    // v4.4: marquee drag — just track the box; selection happens on release.
    if (interaction.type === 'marquee') {
      interaction.curWx = wx;
      interaction.curWy = wy;
      marquee = { x1: interaction.startWx, y1: interaction.startWy, x2: wx, y2: wy };
      requestRender();
      return;
    }

    // v4.4: moving a whole multi-selection together (locked frames were excluded at drag start).
    if (interaction.type === 'move_multi') {
      const dx = wx - interaction.startWx;
      const dy = wy - interaction.startWy;
      for (const it of interaction.items) setObjectFromOrig(it.category, it.obj, it.orig, dx, dy);
      const primary = interaction.items.find((it) => it.category === interaction.primaryCategory && it.obj.id === interaction.primaryId);
      if (primary && primary.category === 'frame') {
        if (!altHeld) {
          const snapped = snapFramePosition(primary.obj, primary.obj.x, primary.obj.y);
          const sdx = snapped.x - primary.obj.x, sdy = snapped.y - primary.obj.y;
          primary.obj.x = snapped.x; primary.obj.y = snapped.y; frameSnapGuide = snapped.guides;
          if (sdx || sdy) {
            for (const it of interaction.items) {
              if (it === primary) continue;
              addObjectDelta(it.category, it.obj, sdx, sdy);
            }
          }
        } else { frameSnapGuide = []; }
      }
      for (const it of interaction.items) window.BoardSync.send(it.category + '_update', it.obj, 40);
      requestRender();
      return;
    }

    // Instrument interactions
    if (interaction.type === 'compass_pencil') {
      const comp = board.instruments.compass;
      // Enforce reasonable min/max compass opening (1 cm to 16 cm)
      const d = dist(comp.nx, comp.ny, wx, wy);
      const clampedD = Math.max(PX_PER_CM * 0.8, Math.min(PX_PER_CM * 16, d));
      const ang = Math.atan2(wy - comp.ny, wx - comp.nx);
      comp.px = comp.nx + Math.cos(ang) * clampedD;
      comp.py = comp.ny + Math.sin(ang) * clampedD;
      window.BoardSync.send('instrument_update', { key: 'compass', state: comp }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'compass_needle') {
      const comp = board.instruments.compass;
      comp.nx = wx;
      comp.ny = wy;
      comp.px = wx + interaction.dx;
      comp.py = wy + interaction.dy;
      window.BoardSync.send('instrument_update', { key: 'compass', state: comp }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'compass_hinge') {
      const comp = board.instruments.compass;
      const dx = wx - interaction.startWx;
      const dy = wy - interaction.startWy;
      comp.nx = interaction.origNx + dx;
      comp.ny = interaction.origNy + dy;
      comp.px = interaction.origPx + dx;
      comp.py = interaction.origPy + dy;
      window.BoardSync.send('instrument_update', { key: 'compass', state: comp }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    // Compass swing-to-draw: needle stays fixed, pencil sweeps an arc (partial swing) or a full circle
    if (interaction.type === 'compass_draw') {
      const comp = board.instruments.compass;
      const dx = wx - interaction.cx;
      const dy = wy - interaction.cy;
      if (Math.hypot(dx, dy) < 5) return;
      const ang = Math.atan2(dy, dx);
      let diff = ang - interaction.lastAngle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > 0.001) {
        const steps = Math.max(1, Math.ceil(Math.abs(diff) / (Math.PI / 60)));
        for (let i = 1; i <= steps; i++) {
          const a = interaction.lastAngle + (diff * i) / steps;
          interaction.preview.points.push({
            x: interaction.cx + Math.cos(a) * interaction.r,
            y: interaction.cy + Math.sin(a) * interaction.r
          });
        }
        interaction.lastAngle = ang;
        interaction.sweep += Math.abs(diff);
        comp.px = interaction.cx + Math.cos(ang) * interaction.r;
        comp.py = interaction.cy + Math.sin(ang) * interaction.r;
        window.BoardSync.send('instrument_update', { key: 'compass', state: comp }, 35);
        window.BoardSync.send('stroke_update', interaction.preview, 35);
        updateReadouts();
        requestRender();
      }
      return;
    }

    if (interaction.type === 'protractor_ray') {
      const prot = board.instruments.protractor;
      const local = unrotatePoint(wx, wy, prot.x, prot.y, prot.rotation);
      let deg = -Math.atan2(local.y - prot.y, local.x - prot.x) * RAD_TO_DEG;
      deg = Math.max(0, Math.min(180, deg));
      // Snap gently to whole degrees when close
      if (Math.abs(deg - Math.round(deg)) < 0.35) deg = Math.round(deg);
      prot.rayAngle = deg;
      window.BoardSync.send('instrument_update', { key: 'protractor', state: prot }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'protractor_rotate') {
      const prot = board.instruments.protractor;
      const deg = Math.atan2(wy - prot.y, wx - prot.x) * RAD_TO_DEG;
      prot.rotation = Math.abs(deg - Math.round(deg)) < 0.4 ? Math.round(deg) : deg;
      window.BoardSync.send('instrument_update', { key: 'protractor', state: prot }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'protractor_resize') {
      const prot = board.instruments.protractor;
      const local = unrotatePoint(wx, wy, prot.x, prot.y, prot.rotation);
      const d = Math.hypot(local.x - prot.x, local.y - prot.y);
      prot.radius = Math.max(140, Math.min(340, Math.round(d)));
      window.BoardSync.send('instrument_update', { key: 'protractor', state: prot }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'protractor_body') {
      const prot = board.instruments.protractor;
      prot.x = interaction.origX + (wx - interaction.startWx);
      prot.y = interaction.origY + (wy - interaction.startWy);
      window.BoardSync.send('instrument_update', { key: 'protractor', state: prot }, 35);
      requestRender();
      return;
    }

    if (interaction.type === 'ruler_rotate') {
      const ruler = board.instruments.ruler;
      const deg = Math.atan2(wy - ruler.y, wx - ruler.x) * RAD_TO_DEG;
      ruler.rotation = Math.abs(deg - Math.round(deg)) < 0.4 ? Math.round(deg) : deg;
      window.BoardSync.send('instrument_update', { key: 'ruler', state: ruler }, 35);
      requestRender();
      return;
    }

    if (interaction.type === 'ruler_resize') {
      const ruler = board.instruments.ruler;
      const s = (wx - interaction.origX) * interaction.axisX + (wy - interaction.origY) * interaction.axisY;
      let newLen = (interaction.origLenPx - s) / PX_PER_CM;
      newLen = Math.max(5, Math.min(30, Math.round(newLen * 10) / 10));
      const newLenPx = newLen * PX_PER_CM;
      ruler.x = interaction.rightX - interaction.axisX * newLenPx;
      ruler.y = interaction.rightY - interaction.axisY * newLenPx;
      ruler.lengthCm = newLen;
      window.BoardSync.send('instrument_update', { key: 'ruler', state: ruler }, 35);
      updateReadouts();
      requestRender();
      return;
    }

    if (interaction.type === 'ruler_body') {
      const ruler = board.instruments.ruler;
      ruler.x = interaction.origX + (wx - interaction.startWx);
      ruler.y = interaction.origY + (wy - interaction.startWy);
      window.BoardSync.send('instrument_update', { key: 'ruler', state: ruler }, 35);
      requestRender();
      return;
    }

    // Moving selected board object
    if (interaction.type === 'move_object') {
      const dx = wx - interaction.startWx;
      const dy = wy - interaction.startWy;
      const obj = interaction.obj;
      const orig = interaction.origObj;

      if (interaction.category === 'frame' || interaction.category === 'shape' || interaction.category === 'image' || interaction.category === 'text') {
        obj.x = orig.x + dx;
        obj.y = orig.y + dy;
        // v4.3: magnetic snapping, frames only; Alt held disables it for this drag.
        if (interaction.category === 'frame' && !altHeld) {
          const snapped = snapFramePosition(obj, obj.x, obj.y);
          obj.x = snapped.x; obj.y = snapped.y; frameSnapGuide = snapped.guides;
        } else if (interaction.category === 'frame') { frameSnapGuide = []; }
        // v4.7: image moves send geometry only — re-sending the whole
        // photo on every move would exceed the 256 KB broadcast cap.
        // The receiver keeps the photo it already has (see image_update).
        window.BoardSync.send(interaction.category + '_update', updatePayloadFor(interaction.category, obj), 40);
      } else if (interaction.category === 'line') {
        obj.x1 = orig.x1 + dx;
        obj.y1 = orig.y1 + dy;
        obj.x2 = orig.x2 + dx;
        obj.y2 = orig.y2 + dy;
        window.BoardSync.send('line_update', obj, 40);
      } else if (interaction.category === 'stroke') {
        if (obj.kind === 'circle') {
          obj.cx = orig.cx + dx;
          obj.cy = orig.cy + dy;
        } else if (obj.kind === 'measure') {
          obj.x1 = orig.x1 + dx;
          obj.y1 = orig.y1 + dy;
          obj.x2 = orig.x2 + dx;
          obj.y2 = orig.y2 + dy;
        } else if (obj.points && orig.points) {
          for (let i = 0; i < obj.points.length; i++) {
            obj.points[i].x = orig.points[i].x + dx;
            obj.points[i].y = orig.points[i].y + dy;
          }
        }
        window.BoardSync.send('stroke_update', obj, 40);
      }
      requestRender();
      return;
    }

    // Transforming (resizing / rotating) selected object
    if (interaction.type === 'transform_object') {
      const obj = interaction.obj;
      const orig = interaction.origObj;
      const h = interaction.handle;

      if (h === 'p1') {
        obj.x1 = wx;
        obj.y1 = wy;
        uiState.liveLineLengthCm = dist(obj.x1, obj.y1, obj.x2, obj.y2) / PX_PER_CM;
        window.BoardSync.send(interaction.category + '_update', obj, 40);
        updateReadouts();
        requestRender();
        return;
      }
      if (h === 'p2') {
        obj.x2 = wx;
        obj.y2 = wy;
        uiState.liveLineLengthCm = dist(obj.x1, obj.y1, obj.x2, obj.y2) / PX_PER_CM;
        window.BoardSync.send(interaction.category + '_update', obj, 40);
        updateReadouts();
        requestRender();
        return;
      }

      const b = interaction.origBounds;
      if (!b) return;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;

      if (h === 'rotate') {
        const ang = Math.atan2(wy - cy, wx - cx) * RAD_TO_DEG + 90;
        obj.rotation = ang;
        if (interaction.category === 'instrument') {
          window.BoardSync.send('instrument_update', {
            key: obj.id === 'inst_protractor' ? 'protractor' : 'ruler',
            state: obj
          }, 40);
        } else {
          // v4.7: image rotate sends geometry only (see updatePayloadFor)
          window.BoardSync.send(interaction.category + '_update', updatePayloadFor(interaction.category, obj), 40);
        }
        requestRender();
        return;
      }

      // Resize handles
      if (interaction.category === 'stroke' && obj.kind === 'circle') {
        const newR = Math.max(15, dist(obj.cx, obj.cy, wx, wy));
        obj.r = newR;
        obj.rCm = Number((newR / PX_PER_CM).toFixed(2));
        obj.label = 'r = ' + (newR / PX_PER_CM).toFixed(1) + ' cm';
        window.BoardSync.send('stroke_update', obj, 40);
        updateReadouts();
        requestRender();
        return;
      }

      const local = b.rotation ? unrotatePoint(wx, wy, cx, cy, b.rotation) : { x: wx, y: wy };
      let nx = orig.x;
      let ny = orig.y;
      let nw = orig.w;
      let nh = orig.h;

      if (h.includes('e')) nw = Math.max(30, local.x - orig.x);
      if (h.includes('s')) nh = Math.max(30, local.y - orig.y);
      if (h.includes('w')) {
        const right = orig.x + orig.w;
        nx = Math.min(right - 30, local.x);
        nw = right - nx;
      }
      if (h.includes('n')) {
        const bottom = orig.y + orig.h;
        ny = Math.min(bottom - 30, local.y);
        nh = bottom - ny;
      }

      obj.x = nx;
      obj.y = ny;
      obj.w = nw;
      obj.h = nh;
      // v4.7: image resize sends geometry only (see updatePayloadFor)
      window.BoardSync.send(interaction.category + '_update', updatePayloadFor(interaction.category, obj), 40);
      requestRender();
      return;
    }

    // v3: crop rectangle drag
    if (interaction.type === 'crop_image' && cropMode) {
      cropMode.curWx = wx;
      cropMode.curWy = wy;
      requestRender();
      return;
    }

    // Erasing
    if (interaction.type === 'erase') {
      eraseAtWorldPoint(wx, wy);
      return;
    }

    // Drawing freehand stroke or measure line
    if (interaction.type === 'draw_stroke') {
      const p = interaction.preview;
      const snapPt = maybeSnapToRulerEdge(wx, wy);
      if (p.kind === 'measure') {
        p.x2 = snapPt.x;
        p.y2 = snapPt.y;
        uiState.liveLineLengthCm = dist(p.x1, p.y1, p.x2, p.y2) / PX_PER_CM;
        updateReadouts();
      } else {
        const last = p.points[p.points.length - 1];
        if (dist(last.x, last.y, snapPt.x, snapPt.y) >= 1.5 / viewport.zoom) {
          p.points.push({ x: snapPt.x, y: snapPt.y });
        }
      }
      requestRender();
      return;
    }

    // Drawing shape
    if (interaction.type === 'draw_shape') {
      const p = interaction.preview;
      p.x = Math.min(interaction.startWx, wx);
      p.y = Math.min(interaction.startWy, wy);
      p.w = Math.max(12, Math.abs(wx - interaction.startWx));
      p.h = Math.max(12, Math.abs(wy - interaction.startWy));
      requestRender();
      return;
    }

    // Drawing straight line or arrow
    if (interaction.type === 'draw_line') {
      const p = interaction.preview;
      const snapPt = maybeSnapToRulerEdge(wx, wy);
      p.x2 = snapPt.x;
      p.y2 = snapPt.y;
      uiState.liveLineLengthCm = dist(p.x1, p.y1, p.x2, p.y2) / PX_PER_CM;
      updateReadouts();
      requestRender();
      return;
    }

    // Straight line drawn along the ruler's top edge (stays on the edge axis)
    if (interaction.type === 'ruler_line') {
      const p = interaction.preview;
      const s = (wx - interaction.edgeX) * interaction.edgeUx + (wy - interaction.edgeY) * interaction.edgeUy;
      p.x2 = interaction.edgeX + interaction.edgeUx * s;
      p.y2 = interaction.edgeY + interaction.edgeUy * s;
      uiState.liveLineLengthCm = Math.abs(s) / PX_PER_CM;
      updateReadouts();
      requestRender();
      return;
    }
  }

  function endPointerInteraction() {
    if (!interaction) return;
    const act = interaction;
    interaction = null;
    frameSnapGuide = []; // v4.3: guide lines live only during the drag

    if (act.type === 'text_edit') return; // commit happens when the textarea loses focus

    // v3: crop rectangle released — apply it (or keep crop mode if the drag was a tap)
    if (act.type === 'crop_image') {
      if (cropMode && Math.abs(cropMode.curWx - cropMode.startWx) > 10 && Math.abs(cropMode.curWy - cropMode.startWy) > 10) {
        applyCropImage();
      } else {
        showToast('Drag a rectangle over the image to crop it');
        requestRender();
      }
      updateReadouts();
      scheduleCloudSave();
      return;
    }

    // v4.4: marquee released — select everything whose bounds intersect the box.
    if (act.type === 'marquee') {
      marquee = null;
      const rx1 = Math.min(act.startWx, act.curWx), ry1 = Math.min(act.startWy, act.curWy);
      const rx2 = Math.max(act.startWx, act.curWx), ry2 = Math.max(act.startWy, act.curWy);
      if (Math.abs(act.curWx - act.startWx) < 10 && Math.abs(act.curWy - act.startWy) < 10) {
        selectedObject = null; multiActive = false; multiSelection = [];
      } else {
        const list = collectMarqueeSelection(rx1, ry1, rx2, ry2);
        if (list.length) {
          multiSelection = list; multiActive = true; selectedObject = list[0];
          showToast('Selected ' + list.length + ' items');
        } else {
          selectedObject = null; multiActive = false; multiSelection = [];
        }
      }
      updateReadouts();
      requestRender();
      return;
    }

    // Broadcast final instrument or object state
    if (act.type === 'compass_draw' && act.preview) {
      if (act.preview.points.length >= 2) {
        board.strokes.push(act.preview);
        window.BoardSync.send('stroke_add', act.preview);
        const deg = Math.round((act.sweep || 0) * RAD_TO_DEG);
        showToast(deg >= 359 ? 'Drew a full circle by swing' : 'Drew an arc (' + deg + '°)');
      }
      window.BoardSync.send('instrument_update', { key: 'compass', state: board.instruments.compass });
    } else if (act.type && act.type.startsWith('compass_')) {
      window.BoardSync.send('instrument_update', { key: 'compass', state: board.instruments.compass });
    } else if (act.type && act.type.startsWith('protractor_')) {
      window.BoardSync.send('instrument_update', { key: 'protractor', state: board.instruments.protractor });
    } else if (act.type && act.type.startsWith('ruler_')) {
      window.BoardSync.send('instrument_update', { key: 'ruler', state: board.instruments.ruler });
    } else if (act.type === 'move_multi') {
      for (const it of act.items) window.BoardSync.send(it.category + '_update', it.obj);
    } else if (act.type === 'move_object' || act.type === 'transform_object') {
      if (act.category === 'instrument') {
        const key = act.obj.id === 'inst_protractor' ? 'protractor' : 'ruler';
        window.BoardSync.send('instrument_update', { key, state: act.obj });
      } else {
        window.BoardSync.send(act.category + '_update', act.obj);
      }
    } else if (act.type === 'draw_stroke' && act.preview) {
      if (act.preview.kind === 'measure') {
        if (dist(act.preview.x1, act.preview.y1, act.preview.x2, act.preview.y2) > 4) {
          board.strokes.push(act.preview);
          window.BoardSync.send('stroke_add', act.preview);
        }
      } else {
        board.strokes.push(act.preview);
        window.BoardSync.send('stroke_add', act.preview);
      }
    } else if (act.type === 'draw_shape' && act.preview) {
      if (act.preview.w < 16 && act.preview.h < 16) {
        act.preview.w = 140;
        act.preview.h = 100;
      }
      board.shapes.push(act.preview);
      selectedObject = { category: 'shape', id: act.preview.id };
      window.BoardSync.send('shape_add', act.preview);
    } else if (act.type === 'draw_line' && act.preview) {
      if (dist(act.preview.x1, act.preview.y1, act.preview.x2, act.preview.y2) < 10) {
        act.preview.x2 = act.preview.x1 + 150;
      }
      board.lines.push(act.preview);
      selectedObject = { category: 'line', id: act.preview.id };
      window.BoardSync.send('line_add', act.preview);
    } else if (act.type === 'ruler_line' && act.preview) {
      if (dist(act.preview.x1, act.preview.y1, act.preview.x2, act.preview.y2) < 10) {
        act.preview.x2 = act.preview.x1 + act.edgeUx * 150;
        act.preview.y2 = act.preview.y1 + act.edgeUy * 150;
      }
      board.lines.push(act.preview);
      selectedObject = { category: 'line', id: act.preview.id };
      window.BoardSync.send('line_add', act.preview);
    }

    updateReadouts();
    requestRender();
    if (act.type && act.type !== 'pan') scheduleCloudSave();
  }

  // ---------------------------------------------------------
  // ZOOM & FIT TO SCREEN (PER-DEVICE VIEWPORT)
  // ---------------------------------------------------------
  function zoomAtScreenPoint(factor, sx, sy) {
    const prevZoom = viewport.zoom;
    const nextZoom = Math.max(viewport.minZoom, Math.min(viewport.maxZoom, prevZoom * factor));
    if (nextZoom === prevZoom) return;

    // Keep world coordinate under (sx, sy) anchored
    const wx = (sx - viewport.panX) / prevZoom;
    const wy = (sy - viewport.panY) / prevZoom;
    viewport.zoom = nextZoom;
    viewport.panX = sx - wx * nextZoom;
    viewport.panY = sy - wy * nextZoom;

    updateReadouts();
    requestRender();
  }

  function resetZoom100() {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - viewport.panX) / viewport.zoom;
    const wy = (cy - viewport.panY) / viewport.zoom;
    viewport.zoom = 1.0;
    viewport.panX = cx - wx;
    viewport.panY = cy - wy;
    updateReadouts();
    requestRender();
  }

  function fitBoardToScreen() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expand = (b) => {
      if (!b) return;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    };

    board.frames.forEach((f) => expand(getObjectBounds('frame', f)));
    board.shapes.forEach((s) => expand(getObjectBounds('shape', s)));
    board.lines.forEach((l) => expand(getObjectBounds('line', l)));
    board.strokes.forEach((st) => expand(getObjectBounds('stroke', st)));
    if (board.instruments.protractor.visible) expand(getObjectBounds('instrument', board.instruments.protractor));
    if (board.instruments.ruler.visible) expand(getObjectBounds('instrument', board.instruments.ruler));
    if (board.instruments.compass.visible) expand(getObjectBounds('instrument', board.instruments.compass));

    if (!isFinite(minX)) {
      viewport.zoom = 1.0;
      viewport.panX = 100;
      viewport.panY = 80;
    } else {
      const rect = canvas.getBoundingClientRect();
      const pad = 60;
      const bw = Math.max(200, maxX - minX);
      const bh = Math.max(200, maxY - minY);
      const scaleX = Math.max(100, rect.width - pad * 2) / bw;
      const scaleY = Math.max(100, rect.height - pad * 2) / bh;
      viewport.zoom = Math.max(viewport.minZoom, Math.min(1.5, Math.min(scaleX, scaleY)));
      viewport.panX = (rect.width - bw * viewport.zoom) / 2 - minX * viewport.zoom;
      viewport.panY = (rect.height - bh * viewport.zoom) / 2 - minY * viewport.zoom;
    }
    updateReadouts();
    requestRender();
  }

  // ---------------------------------------------------------
  // ATTACH CANVAS INPUT LISTENERS (MOUSE + TOUCH)
  // ---------------------------------------------------------
  function bindCanvasEvents() {
    // v3: drag-and-drop images onto the canvas (never let the browser navigate away)
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      // v4.8: students are view-only — nothing may be dropped onto the board.
      if (!isTeacher()) { showToast('View-only — only the teacher can change the board'); return; }
      const rect = canvas.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      // v4.8: a picture dragged from the chat lands on the board.
      const chatId = e.dataTransfer ? e.dataTransfer.getData('application/x-chat-image') : '';
      if (chatId) {
        const msg = chatMessages.find((m) => m.id === chatId);
        if (msg && msg.src) addImageObject({ src: msg.src, displayW: msg.w || 400, displayH: msg.h || 300 }, world);
        return;
      }
      addImagesFromFiles(e.dataTransfer ? e.dataTransfer.files : [], world);
    });
    // v3: paste an image from the clipboard (Ctrl/Cmd+V)
    window.addEventListener('paste', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;
      // v4.8: students are view-only — pasting cannot add to the board.
      if (!isTeacher()) return;
      const items = e.clipboardData ? e.clipboardData.items : [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addImagesFromFiles(files);
      }
    });

    // Mouse events — v4: right-button drag also pans (context menu suppressed on canvas only)
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    canvas.addEventListener('mousedown', (e) => {
      const { sx, sy } = getCanvasCoords(e);
      if (e.button === 2) {
        // Right-drag pan, in drag direction, regardless of active tool (except while editing text).
        // v4.3: a right press that barely moves is a right-CLICK (frame menu), not a pan.
        if (textEditor) commitTextEditor();
        interaction = { type: 'pan', rightButton: true, moved: false, startSx: sx, startSy: sy, origPanX: viewport.panX, origPanY: viewport.panY };
        return;
      }
      if (e.button !== 0 && e.button !== 1) return;
      startPointerInteraction(sx, sy, e.button === 1);
    });

    window.addEventListener('mousemove', (e) => {
      if (!interaction) return;
      altHeld = !!e.altKey;
      const { sx, sy } = getCanvasCoords(e);
      movePointerInteraction(sx, sy);
    });

    window.addEventListener('mouseup', (e) => {
      // v4.3: right-click = right press that did not drag; open the frame menu at the cursor.
      const wasRightClick = !!(interaction && interaction.type === 'pan' && interaction.rightButton && !interaction.moved);
      if (interaction) endPointerInteraction();
      if (wasRightClick && isTeacher()) openFrameMenu(e.clientX, e.clientY); // v4.8: students get no frame menu
    });

    // v4.8: wheel = zoom only (see handleBoardWheel below); trackpad
    // two-finger drag still pans. The old single-event delta-size guess
    // misread smooth-scroll mice as trackpads and fast trackpad flicks
    // as mouse wheels.
    // v4.8: the wheel does ONE job — zoom — everywhere on the board area,
    // and the trackpad two-finger drag still pans. The old code guessed
    // mouse-vs-trackpad from a single event's delta size (|deltaY| >= 40 =
    // mouse), so a smooth-scroll mouse that sends small steps panned the
    // board instead of zooming, and a fast trackpad flick zoomed instead of
    // panning. Now the gesture is classified once and held for its whole
    // burst, using deltaMode + step size + integer steps.
    let wheelGesture = { kind: null, time: 0 };
    function classifyWheelEvent(e) {
      const now = performance.now();
      if (wheelGesture.kind && now - wheelGesture.time < 200) return wheelGesture.kind;
      const ay = Math.abs(e.deltaY);
      let kind;
      if (e.ctrlKey) kind = 'zoom'; // trackpad pinch arrives as Ctrl+wheel
      else if (e.deltaMode === 1) kind = 'zoom'; // line-mode steps = a real mouse wheel
      else if (ay >= 40) kind = 'zoom';
      else if (ay > 0 && Number.isInteger(e.deltaY) && ay >= 10) kind = 'zoom'; // smooth mouse wheel, small integer steps
      else kind = 'pan'; // small fractional deltas = trackpad two-finger drag
      wheelGesture = { kind: kind, time: now };
      return kind;
    }
    function handleBoardWheel(e) {
      const kind = classifyWheelEvent(e);
      e.preventDefault();
      // Zoom toward the cursor; clamp the anchor inside the canvas so a
      // wheel over the header/toolbar still zooms sensibly.
      const rect = canvas.getBoundingClientRect();
      const sx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const sy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
      if (kind === 'zoom') {
        const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : (e.deltaY < 0 ? 1.12 : 1 / 1.12);
        zoomAtScreenPoint(factor, sx, sy);
      } else {
        viewport.panX -= e.deltaX;
        viewport.panY -= e.deltaY;
        requestRender();
      }
    }
    document.addEventListener('wheel', (e) => {
      // The chat list and the big-picture view keep their own scrolling/zoom.
      if (e.target && e.target.closest && (e.target.closest('#chatList') || e.target.closest('#imageLightbox'))) return;
      handleBoardWheel(e);
    }, { passive: false });

    // Touch Events: 1 finger pans (in Select) or draws (in Pen/Shapes/Lines); 2 fingers pinch-zoom!
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        activeTouches.set(t.identifier, {
          sx: t.clientX - rect.left,
          sy: t.clientY - rect.top
        });
      }

      if (activeTouches.size === 2) {
        // Cancel single-finger action and switch to 2-finger pinch zoom
        interaction = null;
        const pts = Array.from(activeTouches.values());
        pinchState = {
          dist: Math.max(10, dist(pts[0].sx, pts[0].sy, pts[1].sx, pts[1].sy)),
          midX: (pts[0].sx + pts[1].sx) / 2,
          midY: (pts[0].sy + pts[1].sy) / 2
        };
      } else if (activeTouches.size === 1) {
        const pt = Array.from(activeTouches.values())[0];
        startPointerInteraction(pt.sx, pt.sy, false);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (activeTouches.has(t.identifier)) {
          activeTouches.set(t.identifier, {
            sx: t.clientX - rect.left,
            sy: t.clientY - rect.top
          });
        }
      }

      if (activeTouches.size === 2 && pinchState) {
        const pts = Array.from(activeTouches.values());
        const newDist = Math.max(10, dist(pts[0].sx, pts[0].sy, pts[1].sx, pts[1].sy));
        const midX = (pts[0].sx + pts[1].sx) / 2;
        const midY = (pts[0].sy + pts[1].sy) / 2;

        // Pan by midpoint delta
        viewport.panX += midX - pinchState.midX;
        viewport.panY += midY - pinchState.midY;

        // Zoom by finger spread ratio
        const factor = newDist / pinchState.dist;
        zoomAtScreenPoint(factor, midX, midY);

        pinchState.dist = newDist;
        pinchState.midX = midX;
        pinchState.midY = midY;
      } else if (activeTouches.size === 1 && interaction) {
        const pt = Array.from(activeTouches.values())[0];
        movePointerInteraction(pt.sx, pt.sy);
      }
    }, { passive: false });

    const onTouchEnd = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        activeTouches.delete(e.changedTouches[i].identifier);
      }
      if (activeTouches.size < 2) {
        pinchState = null;
      }
      if (activeTouches.size === 0 && interaction) {
        endPointerInteraction();
      }
    };

    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // Keyboard shortcuts (Delete / Backspace to delete selected, Space to pan)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Alt') altHeld = true; // v4.3: Alt disables frame snapping while held
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.code === 'Space') {
        uiState.spacePanning = true;
        canvas.style.cursor = 'grab';
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelectedObject();
      } else if (e.key === 'Escape') {
        closeFrameMenu(); // v4.3
        if (cropMode) {
          // v3: Esc cancels crop mode first, without deselecting the image
          cropMode = null;
          showToast('Crop cancelled');
        } else {
          selectedObject = null; multiActive = false; multiSelection = [];
        }
        updateReadouts();
        requestRender();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') altHeld = false; // v4.3
      if (e.code === 'Space') {
        uiState.spacePanning = false;
        updateCursorStyle();
      }
    });
  }

  function updateCursorStyle() {
    if (!isTeacher()) {
      // v4.8: students are view-only — every drag pans, so show the pan hand.
      canvas.style.cursor = 'grab';
    } else if (uiState.panModeToggle || uiState.spacePanning) {
      canvas.style.cursor = 'grab';
    } else if (uiState.activeTab === 'select') {
      canvas.style.cursor = 'default';
    } else if (uiState.activeTab === 'pen') {
      // v4.8: a dot, not a + — white on dark, black on light.
      canvas.style.cursor = penDotCursor();
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  // v4.8: CSS has no dot cursor, so the pen dot is a tiny SVG data-URL
  // cursor (8px dot, hotspot at its centre). Colour follows the theme.
  function penDotCursor() {
    const color = currentTheme === 'dark' ? '#ffffff' : '#000000';
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><circle cx='8' cy='8' r='4.5' fill='" + color + "'/></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 8 8, crosshair';
  }

  // ---------------------------------------------------------
  // OBJECT ACTIONS (DELETE, ADD FRAME, ADD SHAPE, CLEAR)
  // ---------------------------------------------------------
  function deleteSelectedObject() {
    if (!isTeacher()) return; // v4.8: students are view-only
    if (!selectedObject && !multiActive) return;
    // v4.4: delete a whole multi-selection together; locked frames are kept, never deleted.
    if (multiActive && multiSelection.length > 1) {
      const items = multiSelection.map((s) => ({ category: s.category, obj: findObject(s.category, s.id) })).filter((i) => i.obj);
      const locked = items.filter((i) => i.category === 'frame' && i.obj.locked);
      const deletable = items.filter((i) => !(i.category === 'frame' && i.obj.locked));
      if (!deletable.length) { showToast('Frame is locked'); return; }
      pushHistory();
      for (const it of deletable) {
        if (it.category === 'frame') board.frames = board.frames.filter((f) => f.id !== it.obj.id);
        else if (it.category === 'shape') board.shapes = board.shapes.filter((s) => s.id !== it.obj.id);
        else if (it.category === 'text') board.texts = (board.texts || []).filter((t) => t.id !== it.obj.id);
        else if (it.category === 'image') board.images = board.images.filter((im) => im.id !== it.obj.id);
        else if (it.category === 'line') board.lines = board.lines.filter((l) => l.id !== it.obj.id);
        else if (it.category === 'stroke') board.strokes = board.strokes.filter((s) => s.id !== it.obj.id);
        window.BoardSync.send('object_delete', { category: it.category, id: it.obj.id });
      }
      multiActive = false; multiSelection = []; selectedObject = null;
      updateReadouts();
      requestRender();
      showToast(locked.length ? ('Removed ' + deletable.length + ' items; locked frames kept') : ('Removed ' + deletable.length + ' items'));
      return;
    }
    // v4.3: a locked frame cannot be deleted (button or Delete key).
    if (selectedObject.category === 'frame') {
      const fr = findObject('frame', selectedObject.id);
      if (fr && fr.locked) { showToast('Frame is locked'); return; }
    }
    pushHistory();
    const { category, id } = selectedObject;

    if (category === 'frame') {
      board.frames = board.frames.filter((f) => f.id !== id);
    } else if (category === 'shape') {
      board.shapes = board.shapes.filter((s) => s.id !== id);
    } else if (category === 'text') {
      board.texts = (board.texts || []).filter((t) => t.id !== id);
    } else if (category === 'image') {
      board.images = board.images.filter((im) => im.id !== id);
    } else if (category === 'line') {
      board.lines = board.lines.filter((l) => l.id !== id);
    } else if (category === 'stroke') {
      board.strokes = board.strokes.filter((s) => s.id !== id);
    } else if (category === 'instrument') {
      const inst = findObject('instrument', id);
      if (inst) {
        inst.visible = false;
        const key = id === 'inst_protractor' ? 'protractor' : (id === 'inst_ruler' ? 'ruler' : 'compass');
        window.BoardSync.send('instrument_update', { key, state: inst });
      }
    }

    if (category !== 'instrument') {
      window.BoardSync.send('object_delete', { category, id });
    }
    selectedObject = null;
    updateReadouts();
    requestRender();
    showToast('Removed selected item');
  }

  function syncSelectedObjectToControls(category, obj) {
    if (!obj) return;
    if (category === 'frame') {
      const titleInput = document.getElementById('frameTitleInput');
      const bgInput = document.getElementById('frameBgInput');
      if (titleInput) titleInput.value = obj.title || '';
      if (bgInput) bgInput.value = obj.bg || '#ffffff';
    } else if (category === 'shape') {
      const fillInput = document.getElementById('shapeFillPicker');
      const strokeInput = document.getElementById('shapeStrokePicker');
      if (fillInput && obj.fill && obj.fill !== 'transparent') fillInput.value = obj.fill;
      if (strokeInput && obj.stroke) strokeInput.value = obj.stroke;
    }
  }

    // v4.8: frame numbers follow creation time — a frame keeps its number
    // for life (deleting a frame leaves a gap, never renumbers the rest),
    // so the number on each frame shows the board's chronology at a glance.
    // Numbers also match the PDF page order (pages are creation order).
    function nextFrameSeq() {
      let m = 0;
      for (const f of board.frames) m = Math.max(m, f.seq || 0);
      return m + 1;
    }
    function ensureFrameSeqs() {
      let m = 0;
      for (const f of board.frames) m = Math.max(m, f.seq || 0);
      for (const f of board.frames) {
        if (!f.seq) { m++; f.seq = m; }
      }
      // Two devices creating at the same moment can collide on a number:
      // keep the first, renumber the rest in board order.
      const seen = new Set();
      for (const f of board.frames) {
        if (seen.has(f.seq)) { m++; f.seq = m; }
        seen.add(f.seq);
      }
    }
    function addFrameToBoard(preset) {
    pushHistory();
    const rect = canvas.getBoundingClientRect();
    const center = screenToWorld(rect.width / 2, rect.height / 2);

    let w = 960, h = 540, label = '16:9';
    if (preset === '9:16') {
      w = 450;
      h = 800;
      label = '9:16';
    } else if (preset === '16:9') {
      w = 960;
      h = 540;
      label = '16:9';
    } else {
      const cw = parseInt(document.getElementById('frameCustomWInput').value, 10) || 600;
      const ch = parseInt(document.getElementById('frameCustomHInput').value, 10) || 450;
      w = Math.max(160, Math.min(2400, cw));
      h = Math.max(160, Math.min(2400, ch));
      label = w + '×' + h;
    }

    const titleInput = document.getElementById('frameTitleInput');
    const titleVal = (titleInput && titleInput.value.trim())
      ? titleInput.value.trim()
      : ('Frame ' + (board.frames.length + 1));

    const newFrame = {
      id: uid('frame'),
      type: 'frame',
      seq: nextFrameSeq(),
      x: Math.round(center.x - w / 2),
      y: Math.round(center.y - h / 2),
      w: w,
      h: h,
      bg: uiState.frameBg || '#ffffff',
      title: titleVal,
      preset: label,
      locked: false
    };

    board.frames.push(newFrame);
    selectedObject = { category: 'frame', id: newFrame.id };
    window.BoardSync.send('frame_add', newFrame);
    updateReadouts();
    requestRender();
    showToast('Added ' + label + ' frame');
  }

  function insertShapeCentered(shapeType) {
    pushHistory();
    const rect = canvas.getBoundingClientRect();
    const center = screenToWorld(rect.width / 2, rect.height / 2);
    const w = shapeType === 'ellipse' ? 140 : 160;
    const h = shapeType === 'ellipse' ? 140 : 120;
    const newShape = {
      id: uid('shape'),
      shapeType: shapeType,
      x: Math.round(center.x - w / 2),
      y: Math.round(center.y - h / 2),
      w: w,
      h: h,
      rotation: 0,
      fill: uiState.shapeNoFill ? 'transparent' : uiState.shapeFill,
      stroke: uiState.shapeStroke,
      strokeWidth: uiState.shapeStrokeWidth
    };
    board.shapes.push(newShape);
    selectedObject = { category: 'shape', id: newShape.id };
    window.BoardSync.send('shape_add', newShape);
    updateReadouts();
    requestRender();
  }

  function insertLineCentered(lineType) {
    pushHistory();
    const rect = canvas.getBoundingClientRect();
    const center = screenToWorld(rect.width / 2, rect.height / 2);
    if (lineType === 'measure') {
      const m = {
        id: uid('meas'),
        kind: 'measure',
        x1: Math.round(center.x - 90),
        y1: Math.round(center.y),
        x2: Math.round(center.x + 90),
        y2: Math.round(center.y),
        color: uiState.lineColor,
        width: uiState.lineWidth
      };
      board.strokes.push(m);
      selectedObject = { category: 'stroke', id: m.id };
      window.BoardSync.send('stroke_add', m);
    } else {
      const ln = {
        id: uid('line'),
        type: lineType,
        x1: Math.round(center.x - 90),
        y1: Math.round(center.y),
        x2: Math.round(center.x + 90),
        y2: Math.round(center.y),
        color: uiState.lineColor,
        width: uiState.lineWidth,
        dashed: uiState.lineDashed
      };
      board.lines.push(ln);
      selectedObject = { category: 'line', id: ln.id };
      window.BoardSync.send('line_add', ln);
    }
    updateReadouts();
    requestRender();
  }

  function clearDrawingsOnly() {
    pushHistory();
    board.strokes = [];
    board.shapes = [];
    board.lines = [];
    board.texts = [];
    if (selectedObject && selectedObject.category !== 'instrument' && selectedObject.category !== 'frame') {
      selectedObject = null;
    }
    window.BoardSync.send('clear_drawings', {});
    updateReadouts();
    requestRender();
    showToast('Cleared drawings (instruments & frames kept)');
  }

  // ---- v4 text box editor (floating textarea over the board) ----
  function openTextEditor(wx, wy, existing) {
    if (textEditor) commitTextEditor();
    let obj = existing;
    if (!obj) {
      pushHistory();
      obj = {
        id: uid('text'), type: 'text',
        x: Math.round(wx), y: Math.round(wy), w: 260, h: 40, rotation: 0,
        text: '', color: uiState.textColor, fontSize: uiState.textSize
      };
      board.texts.push(obj);
      selectedObject = { category: 'text', id: obj.id };
    } else {
      pushHistory();
    }
    const rect = canvas.getBoundingClientRect();
    const sx = wx * viewport.zoom + viewport.panX;
    const sy = wy * viewport.zoom + viewport.panY;
    const ta = document.createElement('textarea');
    ta.value = obj.text || '';
    ta.placeholder = 'Type here…';
    ta.style.position = 'fixed';
    ta.style.left = (rect.left + sx) + 'px';
    ta.style.top = (rect.top + sy) + 'px';
    ta.style.width = Math.max(120, obj.w * viewport.zoom) + 'px';
    ta.style.minHeight = Math.max(32, obj.h * viewport.zoom) + 'px';
    ta.style.fontSize = Math.max(12, (obj.fontSize || 22) * viewport.zoom) + 'px';
    ta.style.fontFamily = 'Inter, sans-serif';
    ta.style.zIndex = '9999';
    ta.style.background = currentTheme === 'dark' ? '#1e293b' : '#ffffff';
    ta.style.color = currentTheme === 'dark' ? '#f8fafc' : '#0f172a';
    ta.style.border = '2px solid #2563eb';
    ta.style.borderRadius = '6px';
    ta.style.padding = '4px 6px';
    ta.style.resize = 'both';
    document.body.appendChild(ta);
    textEditor = { textarea: ta, obj: obj };
    ta.focus();
    ta.addEventListener('blur', () => commitTextEditor());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') commitTextEditor();
    });
  }
  function commitTextEditor() {
    if (!textEditor) return;
    const { textarea, obj } = textEditor;
    textEditor = null;
    const val = textarea.value;
    if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    if (!val.trim()) {
      board.texts = (board.texts || []).filter((t) => t.id !== obj.id);
      if (selectedObject && selectedObject.id === obj.id) selectedObject = null;
    } else {
      obj.text = val;
      const lines = val.split('\n');
      const longest = Math.max.apply(null, lines.map((l) => l.length));
      obj.w = Math.max(120, Math.round(longest * (obj.fontSize || 22) * 0.62 + 24));
      obj.h = Math.max(32, Math.round(lines.length * (obj.fontSize || 22) * 1.35 + 14));
      selectedObject = { category: 'text', id: obj.id };
      window.BoardSync.send('text_add', obj);
    }
    scheduleCloudSave();
    requestRender();
  }

  // ---------------------------------------------------------
  // BIND UI CONTROLS & TABS
  // ---------------------------------------------------------
  function switchTab(tabName) {
    uiState.activeTab = tabName;
    document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab-btn') === tabName);
    });
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== tabName);
    });
    updateCursorStyle();
  }

  function bindToolbarControls() {
    // Main tool tabs
    document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab-btn'));
      });
    });

    // Pan mode toggle button
    const btnPanMode = document.getElementById('btnPanMode');
    if (btnPanMode) {
      btnPanMode.addEventListener('click', () => {
        uiState.panModeToggle = !uiState.panModeToggle;
        btnPanMode.classList.toggle('active', uiState.panModeToggle);
        updateCursorStyle();
      });
    }

    // Delete selected object button
    const btnDelete = document.getElementById('btnDeleteSelected');
    if (btnDelete) {
      btnDelete.addEventListener('click', () => deleteSelectedObject());
    }

    // v4.7: Delete button in the left toolbar — the header Delete button
    // is unreachable on a phone (no keyboard, and the header scrolls away
    // in landscape), so this is the mobile delete control. It deletes
    // whatever is selected, images included.
    const btnDeleteToolbar = document.getElementById('btnDeleteToolbar');
    if (btnDeleteToolbar) {
      btnDeleteToolbar.addEventListener('click', () => deleteSelectedObject());
    }

    // v3: Images — + picker button, hidden file input, Crop button
    const btnAddImage = document.getElementById('btnAddImage');
    const imageFileInput = document.getElementById('imageFileInput');
    if (btnAddImage && imageFileInput) {
      btnAddImage.addEventListener('click', () => imageFileInput.click());
      imageFileInput.addEventListener('change', () => {
        addImagesFromFiles(imageFileInput.files);
        imageFileInput.value = '';
      });
    }
    const btnCropImage = document.getElementById('btnCropImage');
    if (btnCropImage) {
      btnCropImage.addEventListener('click', () => startCropMode());
    }

    // v3: Frames-only PDF export
    const btnExportPdf = document.getElementById('btnExportPdf');
    if (btnExportPdf) {
      btnExportPdf.addEventListener('click', () => exportFramesToPdf());
    }

    // v3: Voice call buttons
    const btnVoiceCall = document.getElementById('btnVoiceCall');
    const btnVoiceMic = document.getElementById('btnVoiceMic');
    const btnVoiceSpeaker = document.getElementById('btnVoiceSpeaker');
    if (btnVoiceCall) btnVoiceCall.addEventListener('click', () => joinVoiceCall());
    if (btnVoiceMic) btnVoiceMic.addEventListener('click', () => toggleVoiceMic());
    if (btnVoiceSpeaker) btnVoiceSpeaker.addEventListener('click', () => toggleVoiceSpeaker());
    const btnVoiceLeave = document.getElementById('btnVoiceLeave');
    if (btnVoiceLeave) btnVoiceLeave.addEventListener('click', () => leaveVoiceCall());
    updateVoiceButtons();

    // Pen sub-tools
    document.querySelectorAll('[data-pen-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.penSubTool = btn.getAttribute('data-pen-sub');
        document.querySelectorAll('[data-pen-sub]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-pen-sub') === uiState.penSubTool);
        });
      });
    });

    // Pen color swatches & custom picker
    document.querySelectorAll('[data-pen-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.penColor = btn.getAttribute('data-pen-color');
        board.instruments.compass.color = uiState.penColor;
        document.querySelectorAll('[data-pen-color]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-pen-color') === uiState.penColor);
        });
        const customInput = document.getElementById('penColorCustom');
        if (customInput) customInput.value = uiState.penColor;
      });
    });

    const penColorCustom = document.getElementById('penColorCustom');
    if (penColorCustom) {
      penColorCustom.addEventListener('input', (e) => {
        uiState.penColor = e.target.value;
        board.instruments.compass.color = uiState.penColor;
      });
    }

    // Pen widths
    document.querySelectorAll('[data-pen-width]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.penWidth = parseFloat(btn.getAttribute('data-pen-width')) || 4;
        document.querySelectorAll('[data-pen-width]').forEach((b) => {
          b.classList.toggle('active', parseFloat(b.getAttribute('data-pen-width')) === uiState.penWidth);
        });
      });
    });

    // Snap to Ruler edge checkbox
    const chkSnapRuler = document.getElementById('chkSnapRuler');
    if (chkSnapRuler) {
      chkSnapRuler.addEventListener('change', (e) => {
        uiState.snapToRuler = e.target.checked;
      });
    }

    // Shapes tab controls
    document.querySelectorAll('[data-shape-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.shapeType = btn.getAttribute('data-shape-type');
        uiState.drawLineMode = false;
        document.querySelectorAll('[data-shape-type]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-shape-type') === uiState.shapeType);
        });
      });
    });

    const btnInsertShapeNow = document.getElementById('btnInsertShapeNow');
    if (btnInsertShapeNow) {
      btnInsertShapeNow.addEventListener('click', () => {
        insertShapeCentered(uiState.shapeType);
      });
    }

    const shapeFillPicker = document.getElementById('shapeFillPicker');
    if (shapeFillPicker) {
      shapeFillPicker.addEventListener('input', (e) => {
        uiState.shapeFill = e.target.value;
        uiState.shapeNoFill = false;
        const noFillChk = document.getElementById('chkShapeNoFill');
        if (noFillChk) noFillChk.checked = false;
        if (selectedObject && selectedObject.category === 'shape') {
          const sh = findObject('shape', selectedObject.id);
          if (sh) {
            sh.fill = uiState.shapeFill;
            window.BoardSync.send('shape_update', sh);
            requestRender();
          }
        }
      });
    }

    const chkShapeNoFill = document.getElementById('chkShapeNoFill');
    if (chkShapeNoFill) {
      chkShapeNoFill.addEventListener('change', (e) => {
        uiState.shapeNoFill = e.target.checked;
        if (selectedObject && selectedObject.category === 'shape') {
          const sh = findObject('shape', selectedObject.id);
          if (sh) {
            sh.fill = uiState.shapeNoFill ? 'transparent' : uiState.shapeFill;
            window.BoardSync.send('shape_update', sh);
            requestRender();
          }
        }
      });
    }

    const shapeStrokePicker = document.getElementById('shapeStrokePicker');
    if (shapeStrokePicker) {
      shapeStrokePicker.addEventListener('input', (e) => {
        uiState.shapeStroke = e.target.value;
        if (selectedObject && selectedObject.category === 'shape') {
          const sh = findObject('shape', selectedObject.id);
          if (sh) {
            sh.stroke = uiState.shapeStroke;
            window.BoardSync.send('shape_update', sh);
            requestRender();
          }
        }
      });
    }

    document.querySelectorAll('[data-shape-width]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.shapeStrokeWidth = parseFloat(btn.getAttribute('data-shape-width')) || 3;
        document.querySelectorAll('[data-shape-width]').forEach((b) => {
          b.classList.toggle('active', parseFloat(b.getAttribute('data-shape-width')) === uiState.shapeStrokeWidth);
        });
        if (selectedObject && selectedObject.category === 'shape') {
          const sh = findObject('shape', selectedObject.id);
          if (sh) {
            sh.strokeWidth = uiState.shapeStrokeWidth;
            window.BoardSync.send('shape_update', sh);
            requestRender();
          }
        }
      });
    });

    // Lines tab controls
    document.querySelectorAll('[data-line-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.lineType = btn.getAttribute('data-line-type');
        uiState.drawLineMode = true;
        document.querySelectorAll('[data-line-type]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-line-type') === uiState.lineType);
        });
      });
    });

    const btnInsertLineNow = document.getElementById('btnInsertLineNow');
    if (btnInsertLineNow) {
      btnInsertLineNow.addEventListener('click', () => {
        insertLineCentered(uiState.lineType);
      });
    }

    const lineColorPicker = document.getElementById('lineColorPicker');
    if (lineColorPicker) {
      lineColorPicker.addEventListener('input', (e) => {
        uiState.lineColor = e.target.value;
        if (selectedObject && selectedObject.category === 'line') {
          const ln = findObject('line', selectedObject.id);
          if (ln) {
            ln.color = uiState.lineColor;
            window.BoardSync.send('line_update', ln);
            requestRender();
          }
        }
      });
    }

    document.querySelectorAll('[data-line-width]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.lineWidth = parseFloat(btn.getAttribute('data-line-width')) || 3;
        document.querySelectorAll('[data-line-width]').forEach((b) => {
          b.classList.toggle('active', parseFloat(b.getAttribute('data-line-width')) === uiState.lineWidth);
        });
        if (selectedObject && selectedObject.category === 'line') {
          const ln = findObject('line', selectedObject.id);
          if (ln) {
            ln.width = uiState.lineWidth;
            window.BoardSync.send('line_update', ln);
            requestRender();
          }
        }
      });
    });

    const chkLineDashed = document.getElementById('chkLineDashed');
    if (chkLineDashed) {
      chkLineDashed.addEventListener('change', (e) => {
        uiState.lineDashed = e.target.checked;
        if (selectedObject && selectedObject.category === 'line') {
          const ln = findObject('line', selectedObject.id);
          if (ln) {
            ln.dashed = uiState.lineDashed;
            window.BoardSync.send('line_update', ln);
            requestRender();
          }
        }
      });
    }

    // Frames tab controls
    const btnAddFrameMobile = document.getElementById('btnAddFrameMobile');
    const btnAddFrameDesktop = document.getElementById('btnAddFrameDesktop');
    const btnAddFrameCustom = document.getElementById('btnAddFrameCustom');

    if (btnAddFrameMobile) btnAddFrameMobile.addEventListener('click', () => addFrameToBoard('9:16'));
    if (btnAddFrameDesktop) btnAddFrameDesktop.addEventListener('click', () => addFrameToBoard('16:9'));
    if (btnAddFrameCustom) btnAddFrameCustom.addEventListener('click', () => addFrameToBoard('custom'));

    const frameTitleInput = document.getElementById('frameTitleInput');
    if (frameTitleInput) {
      frameTitleInput.addEventListener('input', (e) => {
        uiState.frameTitle = e.target.value;
        if (selectedObject && selectedObject.category === 'frame') {
          const fr = findObject('frame', selectedObject.id);
          if (fr && fr.locked) { showToast('Frame is locked'); if (frameTitleInput) frameTitleInput.value = fr.title || ''; return; }
          if (fr) {
            fr.title = e.target.value;
            window.BoardSync.send('frame_update', fr, 50);
            requestRender();
          }
        }
      });
    }

    const frameBgInput = document.getElementById('frameBgInput');
    if (frameBgInput) {
      frameBgInput.addEventListener('input', (e) => {
        uiState.frameBg = e.target.value;
        if (selectedObject && selectedObject.category === 'frame') {
          const fr = findObject('frame', selectedObject.id);
          if (fr && fr.locked) { showToast('Frame is locked'); if (frameBgInput) frameBgInput.value = fr.bg || '#ffffff'; return; }
          if (fr) {
            fr.bg = e.target.value;
            window.BoardSync.send('frame_update', fr, 50);
            requestRender();
          }
        }
      });
    }

    document.querySelectorAll('[data-frame-bg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const col = btn.getAttribute('data-frame-bg');
        uiState.frameBg = col;
        if (frameBgInput) frameBgInput.value = col;
        if (selectedObject && selectedObject.category === 'frame') {
          const fr = findObject('frame', selectedObject.id);
          if (fr && fr.locked) { showToast('Frame is locked'); return; }
          if (fr) {
            fr.bg = col;
            window.BoardSync.send('frame_update', fr);
            requestRender();
          }
        }
      });
    });

    // Instruments controls
    const btnToggleProtractor = document.getElementById('btnToggleProtractor');
    const btnToggleRuler = document.getElementById('btnToggleRuler');
    const btnToggleCompass = document.getElementById('btnToggleCompass');
    const btnCompassDrawCircle = document.getElementById('btnCompassDrawCircle');
    const btnStampProtractorRay = document.getElementById('btnStampProtractorRay');

    if (btnToggleProtractor) {
      btnToggleProtractor.addEventListener('click', () => {
        pushHistory();
        board.instruments.protractor.visible = !board.instruments.protractor.visible;
        window.BoardSync.send('instrument_update', { key: 'protractor', state: board.instruments.protractor });
        updateReadouts();
        requestRender();
      });
    }
    if (btnToggleRuler) {
      btnToggleRuler.addEventListener('click', () => {
        pushHistory();
        board.instruments.ruler.visible = !board.instruments.ruler.visible;
        window.BoardSync.send('instrument_update', { key: 'ruler', state: board.instruments.ruler });
        updateReadouts();
        requestRender();
      });
    }
    if (btnToggleCompass) {
      btnToggleCompass.addEventListener('click', () => {
        pushHistory();
        board.instruments.compass.visible = !board.instruments.compass.visible;
        window.BoardSync.send('instrument_update', { key: 'compass', state: board.instruments.compass });
        updateReadouts();
        requestRender();
      });
    }
    if (btnCompassDrawCircle) {
      btnCompassDrawCircle.addEventListener('click', () => {
        if (!board.instruments.compass.visible) {
          board.instruments.compass.visible = true;
          window.BoardSync.send('instrument_update', { key: 'compass', state: board.instruments.compass });
        }
        drawCompassCircleAction();
      });
    }
    if (btnStampProtractorRay) {
      btnStampProtractorRay.addEventListener('click', () => {
        if (!board.instruments.protractor.visible) {
          board.instruments.protractor.visible = true;
          window.BoardSync.send('instrument_update', { key: 'protractor', state: board.instruments.protractor });
        }
        stampProtractorRayAction();
      });
    }

    const btnFlipProtractor = document.getElementById('btnFlipProtractor');
    if (btnFlipProtractor) {
      btnFlipProtractor.addEventListener('click', () => {
        const prot = board.instruments.protractor;
        prot.rayAngle = 180 - prot.rayAngle;
        window.BoardSync.send('instrument_update', { key: 'protractor', state: prot });
        updateReadouts();
        requestRender();
        showToast('Protractor flipped');
      });
    }

    // Clear Drawings button & in-page confirmation popover
    const btnClearDrawings = document.getElementById('btnClearDrawings');
    const clearConfirmModal = document.getElementById('clearConfirmModal');
    const btnConfirmClearYes = document.getElementById('btnConfirmClearYes');
    const btnConfirmClearNo = document.getElementById('btnConfirmClearNo');

    if (btnClearDrawings && clearConfirmModal) {
      btnClearDrawings.addEventListener('click', () => {
        clearConfirmModal.classList.remove('hidden');
      });
    }
    if (btnConfirmClearNo && clearConfirmModal) {
      btnConfirmClearNo.addEventListener('click', () => {
        clearConfirmModal.classList.add('hidden');
      });
    }
    if (btnConfirmClearYes && clearConfirmModal) {
      btnConfirmClearYes.addEventListener('click', () => {
        clearConfirmModal.classList.add('hidden');
        clearDrawingsOnly();
      });
    }

    // Viewport Zoom Controls (Bottom-Right Floating Bar)
    const btnZoomIn = document.getElementById('btnZoomIn');
    const btnZoomOut = document.getElementById('btnZoomOut');
    const btnZoomReset = document.getElementById('btnZoomReset');
    const btnZoomFit = document.getElementById('btnZoomFit');

    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        const rect = canvas.getBoundingClientRect();
        zoomAtScreenPoint(1.2, rect.width / 2, rect.height / 2);
      });
    }
    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        const rect = canvas.getBoundingClientRect();
        zoomAtScreenPoint(1 / 1.2, rect.width / 2, rect.height / 2);
      });
    }
    if (btnZoomReset) {
      btnZoomReset.addEventListener('click', () => resetZoom100());
    }
    if (btnZoomFit) {
      btnZoomFit.addEventListener('click', () => fitBoardToScreen());
    }
  }

  // =========================================================
  // v3 FEATURES
  // =========================================================

  // ---------------------------------------------------------
  // v3.1 IMAGES — compress, add, crop
  // ---------------------------------------------------------
  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image'));
      el.src = src;
    });
  }

  // Compress one image file: longest side at most 1400px, JPEG 0.85.
  // PNG is used only if the source is PNG and the resized PNG is smaller.
  // Returns { src, displayW, displayH } — display size fits in 600 board px.
  function compressImageFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const probe = new Image();
      probe.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const scale = Math.min(1, 1400 / Math.max(probe.naturalWidth, probe.naturalHeight));
        const cw = Math.max(1, Math.round(probe.naturalWidth * scale));
        const ch = Math.max(1, Math.round(probe.naturalHeight * scale));
        const cnv = document.createElement('canvas');
        cnv.width = cw;
        cnv.height = ch;
        const cctx = cnv.getContext('2d');
        cctx.fillStyle = '#ffffff';
        cctx.fillRect(0, 0, cw, ch);
        cctx.drawImage(probe, 0, 0, cw, ch);
        const jpeg = cnv.toDataURL('image/jpeg', 0.85);
        let src = jpeg;
        if (file.type === 'image/png') {
          const png = cnv.toDataURL('image/png');
          if (png.length < jpeg.length) src = png;
        }
        const dispScale = Math.min(1, 600 / Math.max(cw, ch));
        resolve({
          src: src,
          displayW: Math.max(60, Math.round(cw * dispScale)),
          displayH: Math.max(60, Math.round(ch * dispScale))
        });
      };
      probe.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not read that image'));
      };
      probe.src = objectUrl;
    });
  }

  // ---------------------------------------------------------
  // v4.7 CHUNKED IMAGE TRANSFER
  // Supabase's free plan caps each Realtime broadcast message at 256 KB,
  // but a compressed photo (up to 1400px JPEG 0.85) is commonly 200 KB–
  // 1 MB as a data URL, so sending a whole photo in one message is
  // silently dropped and the photo never appears on the other device
  // (pen strokes are tiny, so they always got through). Photos are
  // therefore sent as one small metadata message plus ~32 KB pieces,
  // reassembled on the receiving side. Small photos (data URL <= 96 KB)
  // still go in a single plain image_add message.
  // ---------------------------------------------------------
  const IMAGE_CHUNK_SIZE = 32768; // chars of data URL per chunk (~32 KB)
  const IMAGE_DIRECT_LIMIT = 98304; // data URLs at or below this go direct

  function imageMetaFor(im) {
    return { id: im.id, type: 'image', x: im.x, y: im.y, w: im.w, h: im.h, rotation: im.rotation || 0 };
  }

  // v4.7: geometry-only update payload for live drags — for images this
  // strips the photo data URL (the receiver keeps the photo it already
  // has). Other object types pass through unchanged.
  function updatePayloadFor(category, obj) {
    if (category === 'image') return imageMetaFor(obj);
    return obj;
  }

  function splitDataUrlForTransfer(src) {
    const chunks = [];
    for (let i = 0; i < src.length; i += IMAGE_CHUNK_SIZE) chunks.push(src.slice(i, i + IMAGE_CHUNK_SIZE));
    return chunks;
  }

  // v4.8: generic chunked transfer — the same 256 KB broadcast cap that
  // forced chunking for board photos applies to chat pictures too. One
  // sender + one receiver factory, shared by board images and chat images.
  // sendChunked returns true when it chunked, false when the payload fits
  // in one direct message (the caller sends that itself).
  function sendChunked(metaEvent, chunkEvent, id, meta, src) {
    if (!src || src.length <= IMAGE_DIRECT_LIMIT) return false;
    const transferId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const chunks = splitDataUrlForTransfer(src);
    window.BoardSync.send(metaEvent, Object.assign({}, meta, { id: id, transferId: transferId, totalChunks: chunks.length, totalLength: src.length }));
    for (let i = 0; i < chunks.length; i++) {
      window.BoardSync.send(chunkEvent, { id: id, transferId: transferId, index: i, chunk: chunks[i] });
    }
    return true;
  }
  function registerChunkReceiver(metaEvent, chunkEvent, onMeta, onComplete) {
    const pending = new Map(); // id -> { transferId, totalChunks, totalLength, chunks, received }
    const bus = window.BoardSync;
    bus.on(metaEvent, (meta) => {
      if (!meta || !meta.id) return;
      pending.set(meta.id, { transferId: meta.transferId, totalChunks: meta.totalChunks, totalLength: meta.totalLength, chunks: new Array(meta.totalChunks), received: 0 });
      if (onMeta) onMeta(meta);
    });
    bus.on(chunkEvent, (c) => {
      if (!c || !c.id) return;
      const t = pending.get(c.id);
      if (!t || t.transferId !== c.transferId) return; // stale chunk from an older transfer
      if (t.chunks[c.index] === undefined) { t.chunks[c.index] = c.chunk; t.received++; }
      if (t.received >= t.totalChunks) {
        const src = t.chunks.join('');
        pending.delete(c.id);
        if (onComplete) onComplete(c.id, src.length === t.totalLength ? src : null);
      }
    });
  }

  function sendImageFull(im) {
    if (!im || !im.src) return;
    if (im.src.length <= IMAGE_DIRECT_LIMIT) {
      window.BoardSync.send('image_add', im);
      return;
    }
    sendChunked('image_meta', 'image_chunk', im.id, imageMetaFor(im), im.src);
    showToast('Sending image…');
  }

  // v4.7: a board snapshot carries photos as metadata only (no src) — a
  // full board with photos would exceed the 256 KB broadcast cap and be
  // dropped whole. Each photo's data then follows via sendImageFull.
  function sendBoardSnapshot() {
    const snap = serializeBoard();
    snap.images = board.images.map((im) => imageMetaFor(im));
    window.BoardSync.send('board_snapshot', snap);
    for (const im of board.images) {
      if (im.src) sendImageFull(im);
    }
  }

  // ---------------------------------------------------------
  // v4.8: CLASS CHAT — text + pictures over the same live room.
  // No history: messages live in memory only while people are in the
  // room; a student who joins late sees only new messages. Pictures are
  // compressed like board photos (<=1400px JPEG) and chunked like them.
  // ---------------------------------------------------------
  const chatMessages = []; // { id, kind, from, text?, src?, w?, h?, ts, mine?, loading?, _el? }
  let chatOpen = false;
  let chatUnread = 0;

  function chatTime(ts) {
    try {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return ''; }
  }
  function chatSenderLabel(msg) {
    if (msg.mine) return 'You';
    return msg.from === 'teacher' ? 'Teacher' : 'Student';
  }
  function updateChatBadge() {
    const badge = document.getElementById('chatUnreadBadge');
    if (!badge) return;
    badge.textContent = String(chatUnread);
    badge.classList.toggle('hidden', chatUnread <= 0);
  }
  function setChatOpen(open) {
    chatOpen = open;
    const panel = document.getElementById('chatPanel');
    if (panel) panel.classList.toggle('open', open);
    if (open) {
      chatUnread = 0;
      updateChatBadge();
      const list = document.getElementById('chatList');
      if (list) list.scrollTop = list.scrollHeight;
      const input = document.getElementById('chatInput');
      if (input) input.focus();
    }
  }
  function buildChatMessageNode(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col items-start';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble' + (msg.mine ? ' own' : '');
    const from = document.createElement('div');
    from.className = 'chat-from';
    from.textContent = chatSenderLabel(msg) + ' · ' + chatTime(msg.ts);
    bubble.appendChild(from);
    if (msg.kind === 'text') {
      const t = document.createElement('div');
      t.textContent = msg.text || '';
      bubble.appendChild(t);
    } else {
      if (msg.src) {
        const img = document.createElement('img');
        img.className = 'chat-img';
        img.src = msg.src;
        img.alt = 'Shared picture';
        img.draggable = true;
        img.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-chat-image', msg.id);
          e.dataTransfer.effectAllowed = 'copy';
        });
        img.addEventListener('click', () => openLightbox(msg.src));
        bubble.appendChild(img);
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'chat-add-board';
        addBtn.textContent = '⤢ Add to board';
        addBtn.addEventListener('click', () => addChatImageToBoard(msg));
        bubble.appendChild(addBtn);
      } else {
        const ph = document.createElement('div');
        ph.className = 'text-xs';
        ph.textContent = msg.loading ? 'Receiving picture…' : 'Picture unavailable';
        bubble.appendChild(ph);
      }
    }
    wrap.appendChild(bubble);
    msg._el = wrap;
    return wrap;
  }
  function refreshChatMessageNode(msg) {
    const list = document.getElementById('chatList');
    if (!list || !msg._el) return;
    const fresh = buildChatMessageNode(msg);
    list.replaceChild(fresh, msg._el);
    list.scrollTop = list.scrollHeight;
  }
  function addChatMessage(msg) {
    if (!msg || !msg.id) return;
    if (chatMessages.some((m) => m.id === msg.id)) return; // dedupe
    chatMessages.push(msg);
    const list = document.getElementById('chatList');
    if (list) {
      list.appendChild(buildChatMessageNode(msg));
      list.scrollTop = list.scrollHeight;
    }
    if (!chatOpen && !msg.mine) {
      chatUnread++;
      updateChatBadge();
    }
  }
  function sendChatText() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const msg = { id: uid('chat'), kind: 'text', from: myRole, text: text, ts: Date.now(), mine: true };
    input.value = '';
    addChatMessage(msg);
    window.BoardSync.send('chat_text', { id: msg.id, kind: 'text', from: msg.from, text: msg.text, ts: msg.ts });
  }
  function sendChatPicture(file) {
    compressImageFile(file).then((compressed) => {
      if (!compressed || !compressed.src) return;
      const msg = { id: uid('chat'), kind: 'image', from: myRole, src: compressed.src, w: compressed.displayW, h: compressed.displayH, ts: Date.now(), mine: true };
      addChatMessage(msg);
      if (compressed.src.length <= IMAGE_DIRECT_LIMIT) {
        window.BoardSync.send('chat_image', { id: msg.id, kind: 'image', from: msg.from, src: msg.src, w: msg.w, h: msg.h, ts: msg.ts });
      } else {
        sendChunked('chat_image_meta', 'chat_image_chunk', msg.id, { from: msg.from, w: msg.w, h: msg.h, ts: msg.ts }, msg.src);
        showToast('Sending picture…');
      }
    }).catch(() => { showToast('Could not read that picture'); });
  }
  function addChatImageToBoard(msg) {
    if (!msg || !msg.src) return;
    if (!isTeacher()) { showToast('Only the teacher can add pictures to the board'); return; }
    const rect = canvas.getBoundingClientRect();
    const centre = screenToWorld(rect.width / 2, rect.height / 2);
    addImageObject({ src: msg.src, displayW: msg.w || 400, displayH: msg.h || 300 }, centre);
  }

  // v4.8: big-picture view — scroll to zoom, drag to move, tap outside to close.
  let lightboxScale = 1, lightboxTx = 0, lightboxTy = 0;
  function applyLightboxTransform() {
    const img = document.getElementById('lightboxImg');
    if (img) img.style.transform = 'translate(' + lightboxTx + 'px,' + lightboxTy + 'px) scale(' + lightboxScale + ')';
  }
  function openLightbox(src) {
    const box = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImg');
    if (!box || !img || !src) return;
    img.src = src;
    lightboxScale = 1; lightboxTx = 0; lightboxTy = 0;
    applyLightboxTransform();
    box.classList.add('open');
  }
  function closeLightbox() {
    const box = document.getElementById('imageLightbox');
    if (box) box.classList.remove('open');
  }
  function lightboxZoom(factor) {
    lightboxScale = Math.max(0.5, Math.min(6, lightboxScale * factor));
    applyLightboxTransform();
  }
  function bindChatUI() {
    const btnChat = document.getElementById('btnChat');
    if (btnChat) btnChat.addEventListener('click', () => setChatOpen(!chatOpen));
    const btnClose = document.getElementById('btnChatClose');
    if (btnClose) btnClose.addEventListener('click', () => setChatOpen(false));
    const btnSend = document.getElementById('btnChatSend');
    if (btnSend) btnSend.addEventListener('click', sendChatText);
    const input = document.getElementById('chatInput');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChatText(); } });
    const btnAdd = document.getElementById('btnChatAddImage');
    const fileInput = document.getElementById('chatImageInput');
    if (btnAdd && fileInput) {
      btnAdd.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        files.forEach((f) => sendChatPicture(f));
        fileInput.value = '';
      });
    }
    // Lightbox: tap the backdrop (not the picture) to close; scroll zooms.
    const box = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImg');
    if (box) {
      box.addEventListener('click', (e) => { if (e.target === box) closeLightbox(); });
      box.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); lightboxZoom(Math.exp(-e.deltaY * 0.002)); }, { passive: false });
    }
    const zIn = document.getElementById('btnLightboxZoomIn');
    if (zIn) zIn.addEventListener('click', () => lightboxZoom(1.25));
    const zOut = document.getElementById('btnLightboxZoomOut');
    if (zOut) zOut.addEventListener('click', () => lightboxZoom(1 / 1.25));
    const zReset = document.getElementById('btnLightboxReset');
    if (zReset) zReset.addEventListener('click', () => { lightboxScale = 1; lightboxTx = 0; lightboxTy = 0; applyLightboxTransform(); });
    const zClose = document.getElementById('btnLightboxClose');
    if (zClose) zClose.addEventListener('click', closeLightbox);
    if (img) {
      let drag = null;
      img.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX - lightboxTx, y: e.clientY - lightboxTy };
        try { img.setPointerCapture(e.pointerId); } catch (err) {}
      });
      img.addEventListener('pointermove', (e) => {
        if (!drag) return;
        lightboxTx = e.clientX - drag.x;
        lightboxTy = e.clientY - drag.y;
        applyLightboxTransform();
      });
      img.addEventListener('pointerup', () => { drag = null; });
      img.addEventListener('pointercancel', () => { drag = null; });
    }
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  }

  function addImageObject(compressed, centreWorld) {
    pushHistory();
    const im = {
      id: uid('image'),
      type: 'image',
      x: Math.round(centreWorld.x - compressed.displayW / 2),
      y: Math.round(centreWorld.y - compressed.displayH / 2),
      w: compressed.displayW,
      h: compressed.displayH,
      rotation: 0,
      src: compressed.src
    };
    board.images.push(im);
    selectedObject = { category: 'image', id: im.id };
    sendImageFull(im); // v4.7: chunked transfer for large photos
    updateReadouts();
    requestRender();
    return im;
  }

  function viewCentreWorld() {
    const rect = canvas.getBoundingClientRect();
    return screenToWorld(rect.width / 2, rect.height / 2);
  }

  // Add every image file in `files` (FileList/Array), staggered so multiples do not stack.
  function addImagesFromFiles(files, centreWorld) {
    const list = Array.from(files || []).filter((f) => f && f.type && f.type.indexOf('image/') === 0);
    if (!list.length) return;
    const base = centreWorld || viewCentreWorld();
    let done = 0;
    list.forEach((file, idx) => {
      compressImageFile(file).then((compressed) => {
        addImageObject(compressed, {
          x: base.x + idx * 32,
          y: base.y + idx * 32
        });
        done++;
        if (done === list.length) showToast('Added ' + list.length + ' image' + (list.length > 1 ? 's' : ''));
      }).catch(() => {
        showToast('Could not add one image — try a JPG or PNG');
      });
    });
  }

  function startCropMode() {
    if (!selectedObject || selectedObject.category !== 'image') {
      showToast('Select an image first, then Crop image');
      return;
    }
    if (cropMode) {
      cropMode = null;
      showToast('Crop cancelled');
    } else {
      const im = findObject('image', selectedObject.id);
      if (!im) return;
      cropMode = { imageId: im.id, startWx: 0, startWy: 0, curWx: 0, curWy: 0 };
      showToast('Crop: drag a rectangle over the image, release to apply, Esc to cancel');
    }
    updateReadouts();
    requestRender();
  }

  // Cut the crop rectangle out of the selected image via an offscreen canvas.
  function applyCropImage() {
    if (!cropMode) return;
    pushHistory();
    const im = findObject('image', cropMode.imageId);
    const rect = cropMode;
    cropMode = null;
    if (!im) {
      requestRender();
      return;
    }
    const cx = im.x + im.w / 2;
    const cy = im.y + im.h / 2;
    // Convert the world-space drag rectangle into image-local coordinates.
    const p1 = im.rotation ? unrotatePoint(rect.startWx, rect.startWy, cx, cy, im.rotation) : { x: rect.startWx, y: rect.startWy };
    const p2 = im.rotation ? unrotatePoint(rect.curWx, rect.curWy, cx, cy, im.rotation) : { x: rect.curWx, y: rect.curWy };
    const lx = Math.max(im.x, Math.min(p1.x, p2.x));
    const ly = Math.max(im.y, Math.min(p1.y, p2.y));
    const rx = Math.min(im.x + im.w, Math.max(p1.x, p2.x));
    const ry = Math.min(im.y + im.h, Math.max(p1.y, p2.y));
    const cropDisplayW = rx - lx;
    const cropDisplayH = ry - ly;
    if (cropDisplayW < 10 || cropDisplayH < 10) {
      showToast('Crop area too small — try again');
      updateReadouts();
      requestRender();
      return;
    }
    const el = getImageElement(im);
    if (!el || !el.complete || el.naturalWidth === 0) {
      showToast('Image still loading — try Crop again in a moment');
      updateReadouts();
      requestRender();
      return;
    }
    // Map display coordinates to source-image pixels.
    const sxScale = el.naturalWidth / im.w;
    const syScale = el.naturalHeight / im.h;
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(1, Math.round(cropDisplayW * sxScale));
    cnv.height = Math.max(1, Math.round(cropDisplayH * syScale));
    const cctx = cnv.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, cnv.width, cnv.height);
    cctx.drawImage(
      el,
      Math.round((lx - im.x) * sxScale), Math.round((ly - im.y) * syScale),
      cnv.width, cnv.height,
      0, 0, cnv.width, cnv.height
    );
    im.src = cnv.toDataURL('image/jpeg', 0.9);
    im.x = Math.round(lx);
    im.y = Math.round(ly);
    im.w = Math.round(cropDisplayW);
    im.h = Math.round(cropDisplayH);
    imageElementCache.delete(im.id);
    sendImageFull(im); // v4.7: crop changed the photo — send it chunked, not as one big image_update
    selectedObject = { category: 'image', id: im.id };
    updateReadouts();
    requestRender();
    showToast('Image cropped');
  }

  // ---------------------------------------------------------
  // v3.2 FRAMES-ONLY PDF EXPORT (self-contained, no library)
  // ---------------------------------------------------------
  function isInsideFrame(objBounds, fr) {
    if (!objBounds) return false;
    const cx = objBounds.x + objBounds.w / 2;
    const cy = objBounds.y + objBounds.h / 2;
    const centreInside = cx >= fr.x && cx <= fr.x + fr.w && cy >= fr.y && cy <= fr.y + fr.h;
    const overlaps = objBounds.x < fr.x + fr.w && objBounds.x + objBounds.w > fr.x &&
      objBounds.y < fr.y + fr.h && objBounds.y + objBounds.h > fr.y;
    return centreInside || overlaps;
  }

  function drawContentForPdf(pctx, fr, scale) {
    // pctx is already translated so board (0,0) maps correctly; draw only frame content.
    pctx.save();
    pctx.beginPath();
    pctx.rect(fr.x, fr.y, fr.w, fr.h);
    pctx.clip();
    pctx.fillStyle = fr.bg || '#ffffff';
    pctx.fillRect(fr.x, fr.y, fr.w, fr.h);
    // Shapes
    for (const sh of board.shapes) {
      const b = getObjectBounds('shape', sh);
      if (!isInsideFrame(b, fr)) continue;
      pctx.save();
      const cx = sh.x + sh.w / 2;
      const cy = sh.y + sh.h / 2;
      if (sh.rotation) {
        pctx.translate(cx, cy);
        pctx.rotate(sh.rotation * DEG_TO_RAD);
        pctx.translate(-cx, -cy);
      }
      pctx.beginPath();
      if (sh.shapeType === 'rect') pctx.rect(sh.x, sh.y, sh.w, sh.h);
      else if (sh.shapeType === 'ellipse') pctx.ellipse(cx, cy, Math.abs(sh.w / 2), Math.abs(sh.h / 2), 0, 0, Math.PI * 2);
      else if (sh.shapeType === 'triangle') {
        pctx.moveTo(cx, sh.y);
        pctx.lineTo(sh.x + sh.w, sh.y + sh.h);
        pctx.lineTo(sh.x, sh.y + sh.h);
        pctx.closePath();
      } else if (sh.shapeType === 'diamond') {
        pctx.moveTo(cx, sh.y);
        pctx.lineTo(sh.x + sh.w, cy);
        pctx.lineTo(cx, sh.y + sh.h);
        pctx.lineTo(sh.x, cy);
        pctx.closePath();
      } else if (sh.shapeType === 'trapezium') {
        pctx.moveTo(sh.x + sh.w * 0.2, sh.y);
        pctx.lineTo(sh.x + sh.w * 0.8, sh.y);
        pctx.lineTo(sh.x + sh.w, sh.y + sh.h);
        pctx.lineTo(sh.x, sh.y + sh.h);
        pctx.closePath();
      }
      if (sh.fill && sh.fill !== 'transparent') {
        pctx.fillStyle = sh.fill;
        pctx.fill();
      }
      pctx.strokeStyle = sh.stroke || '#1d4ed8';
      pctx.lineWidth = sh.strokeWidth || 3;
      pctx.stroke();
      pctx.restore();
    }
    // Text boxes (v4) — drawn in the PDF with their own colour (printable, not dark-mapped)
    for (const tx of (board.texts || [])) {
      if (!tx.text) continue;
      const b = getObjectBounds('text', tx);
      if (!isInsideFrame(b, fr)) continue;
      pctx.save();
      const cx = tx.x + tx.w / 2;
      const cy = tx.y + tx.h / 2;
      if (tx.rotation) {
        pctx.translate(cx, cy);
        pctx.rotate(tx.rotation * DEG_TO_RAD);
        pctx.translate(-cx, -cy);
      }
      pctx.fillStyle = tx.color || '#0f172a';
      pctx.font = '600 ' + (tx.fontSize || 22) + 'px sans-serif';
      pctx.textBaseline = 'top';
      String(tx.text).split('\n').forEach((line, i) => {
        pctx.fillText(line, tx.x + 6, tx.y + 6 + i * (tx.fontSize || 22) * 1.35);
      });
      pctx.restore();
    }
    // Lines
    for (const ln of board.lines) {
      const b = {
        x: Math.min(ln.x1, ln.x2), y: Math.min(ln.y1, ln.y2),
        w: Math.abs(ln.x2 - ln.x1), h: Math.abs(ln.y2 - ln.y1)
      };
      if (!isInsideFrame(b, fr)) continue;
      pctx.save();
      pctx.strokeStyle = ln.color || '#0f172a';
      pctx.fillStyle = ln.color || '#0f172a';
      pctx.lineWidth = ln.width || 3;
      pctx.lineCap = 'round';
      if (ln.dashed) pctx.setLineDash([8, 6]);
      pctx.beginPath();
      pctx.moveTo(ln.x1, ln.y1);
      pctx.lineTo(ln.x2, ln.y2);
      pctx.stroke();
      pctx.setLineDash([]);
      if (ln.type === 'arrow') {
        const angle = Math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1);
        const headLen = Math.max(12, (ln.width || 3) * 3.8);
        pctx.beginPath();
        pctx.moveTo(ln.x2, ln.y2);
        pctx.lineTo(ln.x2 - headLen * Math.cos(angle - Math.PI / 6), ln.y2 - headLen * Math.sin(angle - Math.PI / 6));
        pctx.lineTo(ln.x2 - headLen * Math.cos(angle + Math.PI / 6), ln.y2 - headLen * Math.sin(angle + Math.PI / 6));
        pctx.closePath();
        pctx.fill();
      }
      pctx.restore();
    }
    // Images
    for (const im of board.images) {
      const b = getObjectBounds('image', im);
      if (!isInsideFrame(b, fr)) continue;
      drawImageObject(im, pctx);
    }
    // Strokes (freehand, measure, circle)
    for (const st of board.strokes) {
      const b = getStrokeBounds(st);
      if (!isInsideFrame(b, fr)) continue;
      pctx.save();
      if (st.kind === 'circle') {
        pctx.strokeStyle = st.color || '#dc2626';
        pctx.lineWidth = st.width || 2.5;
        pctx.beginPath();
        pctx.arc(st.cx, st.cy, st.r, 0, Math.PI * 2);
        pctx.stroke();
      } else if (st.kind === 'measure') {
        pctx.strokeStyle = st.color || '#059669';
        pctx.lineWidth = st.width || 2.5;
        pctx.beginPath();
        pctx.moveTo(st.x1, st.y1);
        pctx.lineTo(st.x2, st.y2);
        pctx.stroke();
      } else if (st.points && st.points.length) {
        pctx.globalAlpha = st.isHighlighter ? 0.36 : 1.0;
        pctx.strokeStyle = st.color || '#0f172a';
        pctx.lineWidth = st.width || 4;
        pctx.lineCap = 'round';
        pctx.lineJoin = 'round';
        if (st.points.length === 1) {
          pctx.beginPath();
          pctx.arc(st.points[0].x, st.points[0].y, (st.width || 4) / 2, 0, Math.PI * 2);
          pctx.fill();
        } else {
          pctx.beginPath();
          pctx.moveTo(st.points[0].x, st.points[0].y);
          for (let i = 1; i < st.points.length - 1; i++) {
            const xc = (st.points[i].x + st.points[i + 1].x) / 2;
            const yc = (st.points[i].y + st.points[i + 1].y) / 2;
            pctx.quadraticCurveTo(st.points[i].x, st.points[i].y, xc, yc);
          }
          const last = st.points[st.points.length - 1];
          pctx.lineTo(last.x, last.y);
          pctx.stroke();
        }
      }
      pctx.restore();
    }
    pctx.restore();
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function asciiBytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
  }

  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  // Minimal PDF 1.4 writer: one page per frame, each page embeds one JPEG XObject.
  function buildMinimalPdf(pages) {
    // pages: [{ widthPt, heightPt, jpegBytes, imgW, imgH }]
    const objects = []; // index 0 unused; objects[i] = Uint8Array body (without "N 0 obj" wrapper)
    const catalogId = 1;
    const pagesId = 2;
    const pageIds = [];
    const imageIds = [];
    const contentIds = [];
    let nextId = 3;
    for (let i = 0; i < pages.length; i++) {
      pageIds.push(nextId++);
      imageIds.push(nextId++);
      contentIds.push(nextId++);
    }
    const kids = pageIds.join(' 0 R ') + (pageIds.length ? ' 0 R' : '');
    objects[catalogId] = asciiBytes('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
    objects[pagesId] = asciiBytes('<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>');
    pages.forEach((pg, i) => {
      objects[pageIds[i]] = asciiBytes(
        '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pg.widthPt + ' ' + pg.heightPt + ']' +
        ' /Resources << /XObject << /Im0 ' + imageIds[i] + ' 0 R >> >> /Contents ' + contentIds[i] + ' 0 R >>'
      );
      const stream = 'q ' + pg.widthPt + ' 0 0 ' + pg.heightPt + ' 0 0 cm /Im0 Do Q';
      objects[contentIds[i]] = concatBytes([
        asciiBytes('<< /Length ' + stream.length + ' >>\nstream\n'),
        asciiBytes(stream),
        asciiBytes('\nendstream')
      ]);
      objects[imageIds[i]] = concatBytes([
        asciiBytes('<< /Type /XObject /Subtype /Image /Width ' + pg.imgW + ' /Height ' + pg.imgH +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpegBytes.length + ' >>\nstream\n'),
        pg.jpegBytes,
        asciiBytes('\nendstream')
      ]);
    });
    const parts = [asciiBytes('%PDF-1.4\n')];
    const offsets = [0];
    for (let id = 1; id < nextId; id++) {
      offsets[id] = parts.reduce((sum, p) => sum + p.length, 0);
      parts.push(asciiBytes(id + ' 0 obj\n'));
      parts.push(objects[id]);
      parts.push(asciiBytes('\nendobj\n'));
    }
    const xrefPos = parts.reduce((sum, p) => sum + p.length, 0);
    let xref = 'xref\n0 ' + nextId + '\n0000000000 65535 f \n';
    for (let id = 1; id < nextId; id++) {
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += 'trailer\n<< /Size ' + nextId + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
    parts.push(asciiBytes(xref));
    return new Blob([concatBytes(parts)], { type: 'application/pdf' });
  }

  function waitForBoardImages(timeoutMs) {
    const pending = board.images.map((im) => {
      const el = getImageElement(im);
      if (!el || el.complete) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, timeoutMs || 2000);
      });
    });
    return Promise.all(pending);
  }

  function exportFramesToPdf() {
    if (!board.frames.length) {
      showToast('Add a frame first');
      return;
    }
    showToast('Making PDF…');
    waitForBoardImages(2000).then(() => {
      const pages = [];
      for (const fr of board.frames) {
        const scale = 2000 / Math.max(fr.w, fr.h);
        const pw = Math.max(1, Math.round(fr.w * scale));
        const ph = Math.max(1, Math.round(fr.h * scale));
        const cnv = document.createElement('canvas');
        cnv.width = pw;
        cnv.height = ph;
        const pctx = cnv.getContext('2d');
        pctx.scale(scale, scale);
        pctx.translate(-fr.x, -fr.y);
        drawContentForPdf(pctx, fr, scale);
        const dataUrl = cnv.toDataURL('image/jpeg', 0.9);
        const longSide = 842;
        let widthPt, heightPt;
        if (fr.w >= fr.h) {
          widthPt = longSide;
          heightPt = Math.max(1, Math.round(longSide * fr.h / fr.w));
        } else {
          heightPt = longSide;
          widthPt = Math.max(1, Math.round(longSide * fr.w / fr.h));
        }
        pages.push({ widthPt: widthPt, heightPt: heightPt, jpegBytes: dataUrlToBytes(dataUrl), imgW: pw, imgH: ph });
      }
      const blob = buildMinimalPdf(pages);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = 'whiteboard-frames-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
        '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('PDF saved (' + pages.length + ' frame page' + (pages.length > 1 ? 's' : '') + ') — check Downloads');
    }).catch(() => {
      showToast('PDF export failed — try again');
    });
  }

  // ---------------------------------------------------------
  // v3.3 LIVE VOICE CALL (WebRTC, small group, signalling via Broadcast)
  // ---------------------------------------------------------
  function voiceAudioContainer() {
    let el = document.getElementById('voiceAudioContainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'voiceAudioContainer';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }

  function updateVoiceButtons() {
    // v4: icon-only with hover names; mic/speaker/leave live in the top-right stack under Voice call.
    const btnCall = document.getElementById('btnVoiceCall');
    const btnMic = document.getElementById('btnVoiceMic');
    const btnSpk = document.getElementById('btnVoiceSpeaker');
    const btnLeave = document.getElementById('btnVoiceLeave');
    const stack = document.getElementById('voiceStack');
    if (stack) stack.style.display = voiceState.inCall ? 'flex' : 'none';
    if (btnCall) {
      btnCall.textContent = '📞';
      btnCall.title = voiceState.inCall ? 'In voice call — use Leave voice call below' : 'Voice call';
      btnCall.classList.toggle('active', voiceState.inCall);
    }
    if (btnLeave) {
      btnLeave.textContent = '📞';
      btnLeave.title = 'Leave voice call';
    }
    if (btnMic) {
      btnMic.textContent = voiceState.micOn ? '🎤' : '🔇';
      // v4.8: students listen only — say so on the mic button.
      btnMic.title = !isTeacher() ? 'Mic off (students listen only)' : (voiceState.micOn ? 'Mic on' : 'Mic off');
      btnMic.classList.toggle('active', voiceState.micOn);
    }
    if (btnSpk) {
      btnSpk.textContent = voiceState.speakerOn ? '🔊' : '🔈';
      btnSpk.title = voiceState.speakerOn ? 'Speaker on' : 'Speaker off';
      btnSpk.classList.toggle('active', voiceState.speakerOn);
    }
  }

  function closeVoicePeer(peerId) {
    const peer = voiceState.peers.get(peerId);
    if (!peer) return;
    try {
      if (peer.pc) peer.pc.close();
    } catch (e) {}
    if (peer.audioEl && peer.audioEl.parentNode) peer.audioEl.parentNode.removeChild(peer.audioEl);
    voiceState.peers.delete(peerId);
  }

  function createVoicePeer(peerId) {
    if (voiceState.peers.has(peerId)) return voiceState.peers.get(peerId);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    if (voiceState.localStream) {
      voiceState.localStream.getTracks().forEach((t) => pc.addTrack(t, voiceState.localStream));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        window.BoardSync.send('voice_ice', { from: window.BoardSync.clientId, to: peerId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      const peer = voiceState.peers.get(peerId);
      if (!peer) return;
      let audioEl = peer.audioEl;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        voiceAudioContainer().appendChild(audioEl);
        peer.audioEl = audioEl;
      }
      audioEl.srcObject = e.streams[0];
      audioEl.muted = !voiceState.speakerOn;
      audioEl.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closeVoicePeer(peerId);
    };
    const peer = { pc: pc, audioEl: null };
    voiceState.peers.set(peerId, peer);
    return peer;
  }

  function joinVoiceCall() {
    if (voiceState.inCall) {
      leaveVoiceCall();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Voice calls need a browser with microphone support');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
      voiceState.localStream = stream;
      voiceState.inCall = true;
      // v4.8: students listen only — their mic starts off and stays off.
      voiceState.micOn = isTeacher();
      voiceState.speakerOn = true;
      stream.getTracks().forEach((t) => { t.enabled = isTeacher(); });
      updateVoiceButtons();
      window.BoardSync.send('voice_join', { from: window.BoardSync.clientId });
      showToast(isTeacher() ? 'Voice call on — tap Mic / Speaker to mute either side' : 'Voice call on — listening (students stay muted)');
    }).catch(() => {
      showToast('Microphone blocked — allow microphone access and try again');
    });
  }

  function leaveVoiceCall() {
    window.BoardSync.send('voice_leave', { from: window.BoardSync.clientId });
    Array.from(voiceState.peers.keys()).forEach((pid) => closeVoicePeer(pid));
    if (voiceState.localStream) {
      voiceState.localStream.getTracks().forEach((t) => t.stop());
      voiceState.localStream = null;
    }
    voiceState.inCall = false;
    updateVoiceButtons();
    showToast('Left voice call');
  }

  function toggleVoiceMic() {
    if (!voiceState.inCall || !voiceState.localStream) return;
    // v4.8: students listen only — the mic cannot be switched on.
    if (!isTeacher()) { showToast('Students listen only in voice calls'); return; }
    voiceState.micOn = !voiceState.micOn;
    voiceState.localStream.getTracks().forEach((t) => { t.enabled = voiceState.micOn; });
    updateVoiceButtons();
    showToast(voiceState.micOn ? 'Microphone on' : 'Microphone off');
  }

  function toggleVoiceSpeaker() {
    if (!voiceState.inCall) return;
    voiceState.speakerOn = !voiceState.speakerOn;
    voiceState.peers.forEach((peer) => {
      if (peer.audioEl) peer.audioEl.muted = !voiceState.speakerOn;
    });
    updateVoiceButtons();
    showToast(voiceState.speakerOn ? 'Speaker on' : 'Speaker off');
  }

  // Handle one incoming voice signalling message. Board handlers never see these types.
  function handleVoiceMessage(type, data) {
    if (!data || !data.from || data.from === window.BoardSync.clientId) return;
    const myId = window.BoardSync.clientId;
    if (data.to && data.to !== myId) return; // addressed to another peer
    if (type === 'voice_join') {
      // Existing call members initiate to the newcomer (one offer per pair, no glare).
      if (!voiceState.inCall) return;
      const peer = createVoicePeer(data.from);
      peer.pc.createOffer().then((offer) => {
        return peer.pc.setLocalDescription(offer).then(() => {
          window.BoardSync.send('voice_offer', { from: myId, to: data.from, sdp: offer });
        });
      }).catch(() => {});
      return;
    }
    if (type === 'voice_leave') {
      closeVoicePeer(data.from);
      return;
    }
    if (!voiceState.inCall) return;
    if (type === 'voice_offer') {
      const peer = createVoicePeer(data.from);
      peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        return peer.pc.createAnswer();
      }).then((answer) => {
        return peer.pc.setLocalDescription(answer).then(() => {
          window.BoardSync.send('voice_answer', { from: myId, to: data.from, sdp: answer });
        });
      }).catch(() => {});
      return;
    }
    if (type === 'voice_answer') {
      const peer = voiceState.peers.get(data.from);
      if (peer && peer.pc.signalingState !== 'stable') {
        peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(() => {});
      }
      return;
    }
    if (type === 'voice_ice') {
      const peer = voiceState.peers.get(data.from);
      if (peer && data.candidate) {
        peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
      return;
    }
  }

  // ---------------------------------------------------------
  // REGISTER SYNC EVENT HANDLERS
  // ---------------------------------------------------------
  function bindSyncEvents() {
    const sync = window.BoardSync;
    if (!sync) return;

    sync.on('toast', (msg) => showToast(msg));

    sync.on('provide_snapshot', () => {
      sendBoardSnapshot(); // v4.7: photos travel chunked, not in the snapshot
    });

    sync.on('apply_snapshot', (snap) => {
      if (!snap) return;
      if (Array.isArray(snap.frames)) board.frames = snap.frames;
      ensureFrameSeqs(); // v4.8: snapshots may carry frames without numbers
      if (Array.isArray(snap.shapes)) board.shapes = snap.shapes;
      if (Array.isArray(snap.texts)) board.texts = snap.texts;
      if (Array.isArray(snap.lines)) board.lines = snap.lines;
      if (Array.isArray(snap.images)) {
        // v4.7: snapshots carry photo metadata only (no src). Keep the
        // photo data this device already has for the same id; a photo
        // this device has never seen arrives with src '' and is filled
        // in by the chunked transfer that follows the snapshot.
        const prevSrc = new Map(board.images.map((im) => [im.id, im.src]));
        board.images = snap.images.map((im) => {
          const out = Object.assign({}, im);
          if (!out.src && prevSrc.has(im.id)) out.src = prevSrc.get(im.id);
          return out;
        });
      }
      if (Array.isArray(snap.strokes)) board.strokes = snap.strokes;
      if (snap.instruments) {
        if (snap.instruments.protractor) Object.assign(board.instruments.protractor, snap.instruments.protractor);
        if (snap.instruments.ruler) Object.assign(board.instruments.ruler, snap.instruments.ruler);
        if (snap.instruments.compass) Object.assign(board.instruments.compass, snap.instruments.compass);
      }
      updateReadouts();
      requestRender();
      showToast('Synced board snapshot from room');
    });

    sync.on('instrument_update', (payload) => {
      if (!payload || !payload.key || !payload.state) return;
      if (board.instruments[payload.key]) {
        Object.assign(board.instruments[payload.key], payload.state);
        updateReadouts();
        requestRender();
      }
    });

    sync.on('stroke_add', (st) => {
      if (!st || !st.id) return;
      const idx = board.strokes.findIndex((x) => x.id === st.id);
      if (idx >= 0) board.strokes[idx] = st;
      else board.strokes.push(st);
      updateReadouts();
      requestRender();
    });

    sync.on('stroke_update', (st) => {
      if (!st || !st.id) return;
      const idx = board.strokes.findIndex((x) => x.id === st.id);
      if (idx >= 0) board.strokes[idx] = st;
      else board.strokes.push(st);
      updateReadouts();
      requestRender();
    });

    sync.on('shape_add', (sh) => {
      if (!sh || !sh.id) return;
      const idx = board.shapes.findIndex((x) => x.id === sh.id);
      if (idx >= 0) board.shapes[idx] = sh;
      else board.shapes.push(sh);
      requestRender();
    });

    sync.on('shape_update', (sh) => {
      if (!sh || !sh.id) return;
      const idx = board.shapes.findIndex((x) => x.id === sh.id);
      if (idx >= 0) board.shapes[idx] = sh;
      else board.shapes.push(sh);
      requestRender();
    });

    sync.on('line_add', (ln) => {
      if (!ln || !ln.id) return;
      const idx = board.lines.findIndex((x) => x.id === ln.id);
      if (idx >= 0) board.lines[idx] = ln;
      else board.lines.push(ln);
      requestRender();
    });

    sync.on('line_update', (ln) => {
      if (!ln || !ln.id) return;
      const idx = board.lines.findIndex((x) => x.id === ln.id);
      if (idx >= 0) board.lines[idx] = ln;
      else board.lines.push(ln);
      requestRender();
    });

    sync.on('frame_add', (fr) => {
      if (!fr || !fr.id) return;
      const idx = board.frames.findIndex((x) => x.id === fr.id);
      if (idx >= 0) board.frames[idx] = fr;
      else board.frames.push(fr);
      ensureFrameSeqs(); // v4.8
      requestRender();
    });

    sync.on('frame_update', (fr) => {
      if (!fr || !fr.id) return;
      const idx = board.frames.findIndex((x) => x.id === fr.id);
      if (idx >= 0) board.frames[idx] = fr;
      else board.frames.push(fr);
      ensureFrameSeqs(); // v4.8
      requestRender();
    });

    // v4: text boxes (add / update via the generic move/transform path)
    sync.on('text_add', (tx) => {
      if (!tx || !tx.id) return;
      board.texts = board.texts || [];
      const idx = board.texts.findIndex((x) => x.id === tx.id);
      if (idx >= 0) board.texts[idx] = tx;
      else board.texts.push(tx);
      requestRender();
    });
    sync.on('text_update', (tx) => {
      if (!tx || !tx.id) return;
      board.texts = board.texts || [];
      const idx = board.texts.findIndex((x) => x.id === tx.id);
      if (idx >= 0) board.texts[idx] = tx;
      else board.texts.push(tx);
      requestRender();
    });

    // v3: images (add / update / delete) + voice signalling (routed only to voice handler)
    sync.on('image_add', (im) => {
      if (!im || !im.id) return;
      const idx = board.images.findIndex((x) => x.id === im.id);
      if (idx >= 0) board.images[idx] = im;
      else board.images.push(im);
      requestRender();
    });

    sync.on('image_update', (im) => {
      if (!im || !im.id) return;
      // v4.7: move updates carry geometry only (no src) — keep the photo
      // this device already has. Never let a src-less update erase it.
      const idx = board.images.findIndex((x) => x.id === im.id);
      if (idx >= 0) {
        const keepSrc = board.images[idx].src || '';
        board.images[idx] = Object.assign({}, im, { src: im.src || keepSrc });
      } else if (im.src) {
        board.images.push(im);
      }
      requestRender();
    });

    // v4.7: chunked image transfer — reassemble a photo sent in pieces
    // (v4.8: now via the shared registerChunkReceiver; behaviour unchanged).
    registerChunkReceiver('image_meta', 'image_chunk',
      (meta) => {
        // Show the photo's place on the board at once (geometry now, pixels
        // in the chunks that follow); keep any photo data already here.
        const idx = board.images.findIndex((x) => x.id === meta.id);
        const base = { id: meta.id, type: 'image', x: meta.x, y: meta.y, w: meta.w, h: meta.h, rotation: meta.rotation || 0, src: '' };
        if (idx >= 0) {
          const keepSrc = board.images[idx].src || '';
          board.images[idx] = Object.assign(base, { src: keepSrc });
        } else {
          board.images.push(base);
        }
        requestRender();
      },
      (id, src) => {
        const idx = board.images.findIndex((x) => x.id === id);
        if (idx >= 0 && src) {
          board.images[idx].src = src;
          imageElementCache.delete(id);
          updateReadouts();
          requestRender();
          showToast('Image received');
        } else if (idx >= 0) {
          showToast('Image arrived incomplete — please add it again');
        }
      });

    // v4.8: class chat — text goes direct (tiny); pictures go chunked.
    sync.on('chat_text', (m) => {
      if (!m || !m.id) return;
      addChatMessage({ id: m.id, kind: 'text', from: m.from, text: m.text, ts: m.ts });
    });
    sync.on('chat_image', (m) => {
      if (!m || !m.id) return;
      addChatMessage({ id: m.id, kind: 'image', from: m.from, src: m.src, w: m.w, h: m.h, ts: m.ts });
    });
    registerChunkReceiver('chat_image_meta', 'chat_image_chunk',
      (meta) => {
        addChatMessage({ id: meta.id, kind: 'image', from: meta.from, w: meta.w, h: meta.h, ts: meta.ts, loading: true });
      },
      (id, src) => {
        const msg = chatMessages.find((m) => m.id === id);
        if (!msg) return;
        if (src) msg.src = src;
        msg.loading = false;
        refreshChatMessageNode(msg);
      });

    sync.on('voice_join', (d) => handleVoiceMessage('voice_join', d));
    sync.on('voice_offer', (d) => handleVoiceMessage('voice_offer', d));
    sync.on('voice_answer', (d) => handleVoiceMessage('voice_answer', d));
    sync.on('voice_ice', (d) => handleVoiceMessage('voice_ice', d));
    sync.on('voice_leave', (d) => handleVoiceMessage('voice_leave', d));

    sync.on('object_delete', (info) => {
      if (!info || !info.id) return;
      if (info.category === 'stroke') board.strokes = board.strokes.filter((s) => s.id !== info.id);
      else if (info.category === 'shape') board.shapes = board.shapes.filter((s) => s.id !== info.id);
      else if (info.category === 'image') board.images = board.images.filter((im) => im.id !== info.id);
      else if (info.category === 'line') board.lines = board.lines.filter((l) => l.id !== info.id);
      else if (info.category === 'text') board.texts = (board.texts || []).filter((t) => t.id !== info.id);
      else if (info.category === 'frame') {
        const existing = board.frames.find((f) => f.id === info.id);
        if (!(existing && existing.locked)) board.frames = board.frames.filter((f) => f.id !== info.id); // v4.3: locked frames refuse remote delete
      }
      if (selectedObject && selectedObject.id === info.id) selectedObject = null;
      updateReadouts();
      requestRender();
    });

    sync.on('clear_drawings', () => {
      board.strokes = [];
      board.shapes = [];
      board.lines = [];
      board.texts = [];
      if (selectedObject && selectedObject.category !== 'instrument' && selectedObject.category !== 'frame') {
        selectedObject = null;
      }
      updateReadouts();
      requestRender();
      showToast('Room drawings cleared');
    });
  }

  // ---------------------------------------------------------
  // INITIALIZE APPLICATION
  // ---------------------------------------------------------
  function initApp() {
    bindToolbarControls();
    bindSyncEvents();
    restoreRole(); // v4.8: teacher PIN remembered per device (before any UI renders)
    bindTeacherUI(); // v4.8
    // v4: theme (first open always dark, choice remembered per device), class tabs, undo/redo
    applyTheme(currentTheme);
    if (window.BoardSync && window.BoardSync.roomCode) restoreClassTabs(window.BoardSync.roomCode);
    renderClassTabs();
    ensureFrameSeqs(); // v4.8: the default frame needs its number
    const btnTheme = document.getElementById('btnThemeToggle');
    if (btnTheme) btnTheme.addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
    const btnUndo = document.getElementById('btnUndo');
    if (btnUndo) btnUndo.addEventListener('click', () => doUndo());
    const btnRedo = document.getElementById('btnRedo');
    if (btnRedo) btnRedo.addEventListener('click', () => doRedo());
    updateUndoButtons();
    const btnNewBoard = document.getElementById('btnNewBoard');
    if (btnNewBoard) btnNewBoard.addEventListener('click', () => {
      if (window.confirm('Start a new board for this tab? The saved cloud board for this tab will be cleared.')) newBoardCloud();
    });
    const textColor = document.getElementById('textColorPicker');
    if (textColor) textColor.addEventListener('input', (e) => { uiState.textColor = e.target.value; });
    const textSize = document.getElementById('textSizeInput');
    if (textSize) textSize.addEventListener('input', (e) => { uiState.textSize = parseInt(e.target.value, 10) || 22; });
    // v4: after joining/creating a room, try the cloud-saved board (fails silently without the table).
    // v4.1: restore this room's tab list FIRST (stable tab ids), reset the load guard,
    // and only then load — otherwise load queries a random tab id and finds nothing.
    if (window.BoardSync && window.BoardSync.connectToRoom) {
      const origConnect = window.BoardSync.connectToRoom.bind(window.BoardSync);
      window.BoardSync.connectToRoom = function () {
        const r = origConnect.apply(null, arguments);
        if (window.BoardSync.roomCode) {
          restoreClassTabs(window.BoardSync.roomCode);
          renderClassTabs();
          cloudLoadDone = false; cloudLoadResolvedFor = '';
        }
        setTimeout(loadCloudBoard, 800);
        return r;
      };
      // Auto-joined via ?room= in the URL: initUI already connected, so load directly too.
      if (window.BoardSync.roomCode) setTimeout(loadCloudBoard, 800);
    }
    if (window.BoardSync) {
      window.BoardSync.initUI();
    }
    // v4.8: open the on-device backup store. If this browser did not
    // auto-join a room (no keys / no saved room), try restoring the last
    // room's board from the device backup so the board still remembers.
    // Also save the backup when the page closes, and tell a first-time
    // visitor that the board is view-only until the teacher unlocks it.
    openLocalBackup().then(() => {
      setTimeout(() => {
        if (!window.BoardSync.roomCode) loadCloudBoard();
      }, 900);
    });
    window.addEventListener('pagehide', saveLocalBackup);
    if (!isTeacher()) {
      setTimeout(() => showToast('View-only mode — tap 👨‍🏫 to unlock teacher controls'), 1200);
    }
    // v4.2: manual cloud-save test button + initial status line in the sync bar drawer.
    setCloudStatus('Cloud: never saved yet');
    const btnSaveCloudNow = document.getElementById('btnSaveCloudNow');
    if (btnSaveCloudNow) btnSaveCloudNow.addEventListener('click', () => saveCloudBoard(true));
    bindFrameMenu(); // v4.3
    bindCanvasEvents();
    bindChatUI(); // v4.8
    window.addEventListener('resize', resizeCanvas);
    // v4.8: the board's size also changes WITHOUT a window resize — the
    // phone browser's address bar sliding away, the Room Sync drawer
    // toggling, and scrolling in landscape all resize the board shell, and
    // a stale backing store is what made the ink drift from the finger.
    // Watch the box itself (ResizeObserver), the phone's visual viewport,
    // and pixel-density changes (moving the window between displays).
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      const boardResizeObserver = new ResizeObserver(() => resizeCanvas());
      boardResizeObserver.observe(canvas.parentElement);
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resizeCanvas);
    }
    let observedDpr = window.devicePixelRatio || 1;
    function watchDpr() {
      try {
        const mq = window.matchMedia('(resolution: ' + observedDpr + 'dppx)');
        const onChange = () => {
          observedDpr = window.devicePixelRatio || 1;
          resizeCanvas();
          watchDpr();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) {}
    }
    watchDpr();
    resizeCanvas();
    updateReadouts();
    // Fit initial view cleanly on mobile screens
    if (window.innerWidth < 768) {
      setTimeout(fitBoardToScreen, 60);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
