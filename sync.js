/**
 * sync.js — Real-Time Board Synchronization Layer (Argon v4.17)
 * Uses Supabase Realtime Broadcast (browser-to-browser, no database tables, no server)
 * with automatic URL query parameter room sharing and late-joiner snapshot transfer.
 * Also supports local multi-tab BroadcastChannel sync for instant same-device testing.
 */
(function (global) {
  'use strict';

  const STORAGE_URL_KEY = 'geo_wb_supabase_url';
  const STORAGE_ANON_KEY = 'geo_wb_supabase_anon_key';
  const STORAGE_ROOM_KEY = 'geo_wb_last_room';

  function safeGetStorage(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }

  function safeSetStorage(key, val) {
    try {
      if (val) window.localStorage.setItem(key, val);
    } catch (e) {
      // Ignore storage errors in sandboxed iframes
    }
  }

  class BoardSyncManager {
    constructor() {
      this.clientId = 'peer_' + Math.random().toString(36).substring(2, 9);
      this.roomCode = '';
      this.isCreator = false;
      this.supabase = null;
      this.channel = null;
      this.localChannel = null;
      this.connected = false;
      this.peerCount = 1;
      this.peers = new Set([this.clientId]);
      this.handlers = {};
      this.lastInstrumentBroadcast = 0;
      // v4.12 FIX: per-event throttle timestamps so simultaneous updates (e.g. compass_draw
      // sending instrument_update + stroke_update, or move_multi sending frame_update + shape_update)
      // never starve one another.
      this.lastBroadcastByType = {};
      // v4.8: teacher/student role for this device. Set from interactive.js
      // (myRole). The packet carries it so every peer can ignore board edits
      // sent by a student device; 'student' is the default (view-only).
      this.myRole = 'student';
      // v4.16: connection watchdog. Broadcast has no delivery receipt and
      // the board never noticed a silently dead channel (the green dot
      // stayed on while nothing arrived). lastRxAt records the last
      // received message (or subscribe); the watchdog re-joins when the
      // channel is not joined or nothing has arrived for a while.
      this.lastRxAt = 0;
      this.peerLastSeen = new Map(); // peerId -> timestamp (prunes the device count)
      this.watchdogTimer = null;
      this.rejoinTimer = null;
      this.rejoinDelayMs = 3000;
      this.lastPresenceAt = 0;
      // v4.17: ONE Supabase client for the life of the page. v4.16 created
      // a brand-new client on every rejoin and only removeChannel'd the old
      // CHANNEL — the old client, its GoTrueClient and its socket were never
      // disconnected. The console proved it: 100+ "Multiple GoTrueClient
      // instances detected" warnings in one page session, and each abandoned
      // client could fire a late CLOSED/ERROR that tore down the just-healed
      // channel — the disconnected → reconnecting → reconnected loop that
      // only a force reload fixed. A rejoin now reuses the same client and
      // swaps only the channel.
      this._sbUrl = '';
      this._sbKey = '';
      // v4.17: generation counter — every connectToRoom bumps it and every
      // subscribe/broadcast callback captures its own epoch. A callback
      // from an abandoned channel (whose removal was still in flight) is
      // ignored instead of scheduling another rejoin.
      this._connectEpoch = 0;
      this.channelCreatedAt = 0;
      this.socketDownSince = 0;
      // v4.17: bounded retries. scheduleRejoin backs off (3s, 6s, 12s,
      // 24s, then 30s) and after 8 failed attempts stops auto-retrying and
      // asks for a reload instead of leaking clients forever.
      this._rejoinAttempts = 0;
      this._giveUp = false;
      this._visibilityBound = false;
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    emitLocal(event, payload) {
      if (this.handlers[event]) {
        this.handlers[event](payload);
      }
    }

    initUI() {
      const urlInput = document.getElementById('supabaseUrlInput');
      const keyInput = document.getElementById('supabaseKeyInput');
      const roomInput = document.getElementById('roomCodeInput');
      const btnCreate = document.getElementById('btnCreateRoom');
      const btnJoin = document.getElementById('btnJoinRoom');
      const btnCopy = document.getElementById('btnCopyLink');
      const btnToggleSync = document.getElementById('btnToggleSyncBar');
      const syncDrawer = document.getElementById('syncBarDrawer');

      // Restore saved credentials if available
      const savedUrl = safeGetStorage(STORAGE_URL_KEY);
      const savedKey = safeGetStorage(STORAGE_ANON_KEY);
      if (urlInput && savedUrl) urlInput.value = savedUrl;
      if (keyInput && savedKey) keyInput.value = savedKey;

      // Check URL query parameters for ?room=XXXX
      let queryRoom = '';
      try {
        const params = new URLSearchParams(window.location.search);
        queryRoom = (params.get('room') || '').trim().toUpperCase();
        const urlParam = params.get('sbUrl');
        const keyParam = params.get('sbKey');
        if (urlParam && urlInput && !urlInput.value) urlInput.value = urlParam;
        if (keyParam && keyInput && !keyInput.value) keyInput.value = keyParam;
      } catch (e) {
        queryRoom = '';
      }

      if (queryRoom && roomInput) {
        roomInput.value = queryRoom;
      } else if (roomInput) {
        const prevRoom = safeGetStorage(STORAGE_ROOM_KEY);
        if (prevRoom) roomInput.value = prevRoom;
      }

      if (btnToggleSync && syncDrawer) {
        btnToggleSync.addEventListener('click', () => {
          syncDrawer.classList.toggle('hidden');
          btnToggleSync.classList.toggle('active', !syncDrawer.classList.contains('hidden'));
        });
      }

      if (btnCreate) {
        btnCreate.addEventListener('click', () => {
          const code = this.generateRoomCode();
          if (roomInput) roomInput.value = code;
          this.connectToRoom(code, true);
        });
      }

      if (btnJoin) {
        btnJoin.addEventListener('click', () => {
          let code = roomInput ? roomInput.value.trim().toUpperCase() : '';
          if (!code) {
            code = this.generateRoomCode();
            if (roomInput) roomInput.value = code;
          }
          this.connectToRoom(code, false);
        });
      }

      if (btnCopy) {
        btnCopy.addEventListener('click', () => {
          this.copyShareLink();
        });
      }

      // v4.17: come back to the tab (or back online) and rejoin at once
      // instead of waiting for the next 10 s watchdog tick. The watchdog
      // returns early while the tab is hidden and hidden-tab timers are
      // throttled, so without this the board could sit dead for minutes
      // after the teacher switched back to it. Registered once.
      if (!this._visibilityBound && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        this._visibilityBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.onForeground();
        });
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('online', () => this.onForeground());
        }
      }

      // If URL already had ?room=..., auto-join local channel and Supabase if credentials exist
      if (queryRoom) {
        this.connectToRoom(queryRoom, false);
      } else {
        // v4.8: no ?room= in the link — reopen the last room automatically
        // when this browser already has keys + a saved room, so the saved
        // board comes back on its own. (Without keys there is nothing to
        // load from, so the board still opens fresh.)
        const savedRoom = safeGetStorage(STORAGE_ROOM_KEY);
        if (savedRoom && savedUrl && savedKey) {
          this.connectToRoom(savedRoom, false);
        }
      }
    }

    generateRoomCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let out = '';
      for (let i = 0; i < 6; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return out;
    }

    updateStatusUI(statusText, stateType) {
      const badge = document.getElementById('syncStatusBadge');
      const dot = document.getElementById('syncStatusDot');
      const peerBadge = document.getElementById('peerCountBadge');
      const topRoomLabel = document.getElementById('activeRoomLabel');

      if (badge) badge.textContent = statusText;
      if (topRoomLabel) {
        // v4.12 FIX: preserve #teacherBadge child element inside #activeRoomLabel instead of
        // wiping it with textContent = ...
        const teacherBadge = document.getElementById('teacherBadge');
        const labelText = this.roomCode ? ('Room: ' + this.roomCode) : 'Offline / Solo';
        if (teacherBadge && topRoomLabel.contains(teacherBadge)) {
          const firstNode = topRoomLabel.firstChild;
          if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
            firstNode.nodeValue = labelText + ' ';
          } else {
            topRoomLabel.insertBefore(document.createTextNode(labelText + ' '), teacherBadge);
          }
        } else {
          topRoomLabel.textContent = labelText;
          if (teacherBadge) {
            topRoomLabel.appendChild(document.createTextNode(' '));
            topRoomLabel.appendChild(teacherBadge);
          }
        }
      }
      if (peerBadge) {
        peerBadge.textContent = this.peers.size + (this.peers.size === 1 ? ' device' : ' devices');
      }
      if (dot) {
        dot.className = 'w-2 h-2 rounded-full ';
        if (stateType === 'connected') {
          dot.className += 'bg-emerald-500 animate-pulse';
        } else if (stateType === 'connecting') {
          dot.className += 'bg-amber-500 animate-ping';
        } else if (stateType === 'local') {
          dot.className += 'bg-blue-500';
        } else {
          dot.className += 'bg-slate-400';
        }
      }
    }

    connectToRoom(roomCode, isCreator, isAuto) {
      const urlInput = document.getElementById('supabaseUrlInput');
      const keyInput = document.getElementById('supabaseKeyInput');
      const sbUrl = urlInput ? urlInput.value.trim() : '';
      const sbKey = keyInput ? keyInput.value.trim() : '';

      this.roomCode = roomCode.trim().toUpperCase();
      this.isCreator = Boolean(isCreator);
      this.peers = new Set([this.clientId]);
      // v4.17: a fresh connect starts the liveness clock here, not at the
      // next SUBSCRIBED — a stale lastRxAt from before the rejoin must not
      // trip the 45 s silence rule the moment the new channel is up.
      this.lastRxAt = Date.now();
      this.socketDownSince = 0;
      safeSetStorage(STORAGE_ROOM_KEY, this.roomCode);

      if (sbUrl) safeSetStorage(STORAGE_URL_KEY, sbUrl);
      if (sbKey) safeSetStorage(STORAGE_ANON_KEY, sbKey);

      // A manual connect (button, foreground return, first join) supersedes
      // any scheduled auto-rejoin and resets the backoff / give-up state.
      // Auto-rejoins (isAuto) keep the attempt count so backoff can grow.
      if (!isAuto) {
        this._giveUp = false;
        this._rejoinAttempts = 0;
        if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
      }

      // Update URL parameter without reload when permitted
      try {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('room', this.roomCode);
        window.history.replaceState({}, '', nextUrl.toString());
      } catch (e) {
        // Ignore in sandboxed iframe
      }

      // Cleanup existing channels (fire-and-forget as before — the channel
      // is created synchronously below, so the old removal can only resolve
      // after the new channel already exists; the epoch guard below makes
      // any late callback from the old channel harmless).
      if (this.channel && this.supabase) {
        try {
          this.supabase.removeChannel(this.channel);
        } catch (e) {}
        this.channel = null;
      }
      if (this.localChannel) {
        try {
          this.localChannel.close();
        } catch (e) {}
        this.localChannel = null;
      }

      // 1. Always start local BroadcastChannel for instant multi-tab testing on same browser
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.localChannel = new BroadcastChannel('geo_wb_room_' + this.roomCode);
          this.localChannel.onmessage = (ev) => {
            if (ev && ev.data) this.handleIncomingMessage(ev.data);
          };
        } catch (e) {}
      }

      // 2. Connect to Supabase Realtime Broadcast if Project URL and Anon Key are provided
      if (sbUrl && sbKey && window.supabase && typeof window.supabase.createClient === 'function') {
        this.updateStatusUI('Connecting to Supabase...', 'connecting');
        try {
          // v4.17: ONE client for the life of the page. Creating a new
          // client per rejoin leaked a GoTrueClient + socket every time
          // (100+ in one session, proven by the console) and the abandoned
          // clients' late callbacks tore down each fresh channel. Only a
          // change of URL/key (new project) ever drops the client.
          if (this.supabase && (this._sbUrl !== sbUrl || this._sbKey !== sbKey)) {
            try { this.supabase.removeAllChannels(); } catch (e) {}
            this.supabase = null;
          }
          if (!this.supabase) {
            // v4.12: eventsPerSecond raised to 45 so chunked image bursts and live pointer/laser streams stay smooth
            this.supabase = window.supabase.createClient(sbUrl, sbKey, {
              realtime: { params: { eventsPerSecond: 45 } }
            });
            this._sbUrl = sbUrl;
            this._sbKey = sbKey;
          }

          // v4.17: generation counter — the callbacks below belong to THIS
          // channel only. A late status from an abandoned channel is
          // ignored instead of scheduling a rejoin that kills the healthy
          // channel (the v4.16 flap loop).
          const epoch = ++this._connectEpoch;
          this.channelCreatedAt = Date.now();

          this.channel = this.supabase.channel('geo_room_' + this.roomCode, {
            config: {
              broadcast: { self: false, ack: false }
            }
          });

          this.channel.on('broadcast', { event: 'wb_msg' }, (payload) => {
            if (epoch !== this._connectEpoch) return; // stale channel
            if (payload && payload.payload) {
              this.handleIncomingMessage(payload.payload);
            }
          });

          this.channel.subscribe((status) => {
            if (epoch !== this._connectEpoch) return; // stale channel
            if (status === 'SUBSCRIBED') {
              this.connected = true;
              this.lastRxAt = Date.now();
              this.socketDownSince = 0;
              this._rejoinAttempts = 0;
              this._giveUp = false;
              this.updateStatusUI('Live Sync (' + this.roomCode + ')', 'connected');
              this.announcePresence();
              this.startWatchdog();
              if (!this.isCreator) {
                this.send('request_snapshot', { requesterId: this.clientId });
              }
              this.emitLocal('toast', (this.isCreator ? 'Created' : 'Joined') + ' live room ' + this.roomCode);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              this.connected = false;
              this.updateStatusUI('Supabase error — Tab Sync active', 'local');
              this.emitLocal('toast', 'Supabase connection issue; local tab sync is active.');
              this.scheduleRejoin();
            } else if (status === 'CLOSED') {
              // v4.16: the server closed the channel (it is removed from
              // the socket and never rejoins on its own). The old code
              // ignored this status and kept showing a green "Live Sync"
              // on a dead channel.
              this.connected = false;
              this.updateStatusUI('Connection lost — reconnecting…', 'connecting');
              this.emitLocal('toast', 'Connection lost — reconnecting…');
              this.scheduleRejoin();
            }
          });
        } catch (err) {
          this.connected = false;
          this.updateStatusUI('Tab Sync (' + this.roomCode + ')', 'local');
          this.announcePresence();
          if (!this.isCreator) {
            this.send('request_snapshot', { requesterId: this.clientId });
          }
        }
      } else {
        // Local tab BroadcastChannel mode until user pastes Supabase URL & Anon Key
        this.connected = true;
        this.updateStatusUI('Tab Sync (' + this.roomCode + ')', 'local');
        this.announcePresence();
        if (!this.isCreator) {
          this.send('request_snapshot', { requesterId: this.clientId });
        }
        this.emitLocal(
          'toast',
          sbUrl && sbKey
            ? 'Room ' + this.roomCode + ' ready!'
            : 'Room ' + this.roomCode + ' active (paste Supabase URL & Key for cross-device sync).'
        );
      }
    }

    announcePresence() {
      this.lastPresenceAt = Date.now();
      this.send('peer_hello', { peerId: this.clientId });
    }

    startWatchdog() {
      // v4.16: one 10 s timer for the life of the page. It watches for a
      // silently dead channel, re-announces presence so the device count
      // means live devices, and prunes peers not heard from in 90 s.
      if (this.watchdogTimer) return;
      this.watchdogTimer = setInterval(() => this.watchdogTick(), 10000);
    }

    watchdogTick() {
      const now = Date.now();
      // Prune stale peers (the old count only ever grew).
      let pruned = false;
      for (const [id, at] of this.peerLastSeen) {
        if (now - at > 90000) { this.peerLastSeen.delete(id); this.peers.delete(id); pruned = true; }
      }
      if (pruned) {
        this.updateStatusUI(
          this.supabase ? 'Live Sync (' + this.roomCode + ')' : 'Tab Sync (' + this.roomCode + ')',
          this.supabase ? 'connected' : 'local'
        );
      }
      if (!this.supabase || !this.channel || !this.roomCode) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      // Presence heartbeat so peers can prune us too.
      if (this.connected && now - (this.lastPresenceAt || 0) > 30000) this.announcePresence();
      // v4.17: a channel that is merely 'joining' is NOT dead — the socket
      // may still be connecting (subscribe() reconnects it automatically).
      // Only 'closed' / 'errored' / 'leaving' count at once; 'joining'
      // counts only after 60 s stuck. (v4.16 treated any non-'joined'
      // state as dead, so a slow join re-triggered a rejoin loop.)
      const st = this.channel.state;
      const channelDead = st === 'closed' || st === 'errored' || st === 'leaving' ||
        (st === 'joining' && this.channelCreatedAt && (now - this.channelCreatedAt > 60000));
      // v4.17: socket-level check — the channel object can still say
      // 'joined' while its socket is dead (the solo half-dead case: the
      // 45 s silence rule cannot fire solo because peers.size is 1).
      // Only counts after 20 s down, so a normal transient reconnect
      // (which the library does on its own) is never fought.
      let socketDown = false;
      try {
        socketDown = this.supabase.realtime && typeof this.supabase.realtime.isConnected === 'function' &&
          !this.supabase.realtime.isConnected();
      } catch (e) { socketDown = false; }
      if (socketDown) { if (!this.socketDownSince) this.socketDownSince = now; }
      else { this.socketDownSince = 0; }
      const socketDead = socketDown && this.socketDownSince && (now - this.socketDownSince > 20000);
      // Silence only counts as death when OTHER devices are in the room:
      // the peers set is seeded with this device's own id, so size 1
      // means solo — and a solo board normally hears nothing, so it must
      // not keep "reconnecting" itself. The 30 s presence heartbeat
      // above means a live room refreshes lastRxAt well inside the 45 s
      // window.
      const silentTooLong = this.peers.size > 1 && this.lastRxAt && (now - this.lastRxAt > 45000);
      if (channelDead || socketDead || silentTooLong) {
        // v4.17: if auto-retries have given up, say so instead of
        // showing "reconnecting…" while nothing is retrying.
        if (this._giveUp) {
          this.updateStatusUI('Connection lost — reload the page to reconnect', 'local');
          return;
        }
        this.connected = false;
        this.updateStatusUI('Connection lost — reconnecting…', 'connecting');
        this.scheduleRejoin();
      }
    }

    // v4.17: called when the tab becomes visible again or the browser
    // comes back online. A dead channel is rejoined at once instead of
    // waiting for the next watchdog tick (and the pending auto-rejoin
    // timer, throttled while hidden, is superseded). A healthy board is
    // left alone — the socket's own auto-reconnect handles a merely
    // down socket, so this does not fight the library.
    onForeground() {
      if (!this.roomCode || !this.supabase || !this.channel) return;
      const now = Date.now();
      const st = this.channel.state;
      const channelDead = st === 'closed' || st === 'errored' || st === 'leaving' ||
        (st === 'joining' && this.channelCreatedAt && (now - this.channelCreatedAt > 60000));
      const silentTooLong = this.peers.size > 1 && this.lastRxAt && (now - this.lastRxAt > 45000);
      if (!channelDead && !silentTooLong) return;
      this.manualReconnect();
    }

    // v4.17: a user-driven reconnect — clears any pending auto-rejoin and
    // resets the backoff / give-up state, then connects. Used by the
    // foreground handler; the Join/Create buttons call connectToRoom
    // directly, which resets the same state for manual (non-auto) calls.
    manualReconnect() {
      this._giveUp = false;
      this._rejoinAttempts = 0;
      if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
      this.connectToRoom(this.roomCode, this.isCreator, false);
    }

    scheduleRejoin() {
      // v4.17: bounded, backoff retries on ONE client (no new client per
      // attempt — that leak was the flap loop). Guarded so a flapping
      // network cannot stack rejoin attempts; after 8 failed attempts
      // (~2.5 min) it stops and asks for a reload instead of retrying
      // forever. A manual connect (button / foreground return) resets
      // the count. Delays: 3s, 6s, 12s, 24s, then 30s.
      if (this.rejoinTimer) return;
      if (this._giveUp) return;
      this._rejoinAttempts++;
      if (this._rejoinAttempts > 8) {
        this._giveUp = true;
        this.connected = false;
        this.updateStatusUI('Connection lost — reload the page to reconnect', 'local');
        this.emitLocal('toast', 'Connection lost — reload the page to reconnect');
        return;
      }
      const delay = Math.min(30000, this.rejoinDelayMs * Math.pow(2, this._rejoinAttempts - 1));
      this.rejoinTimer = setTimeout(() => {
        this.rejoinTimer = null;
        if (!this.roomCode) return;
        this.connectToRoom(this.roomCode, this.isCreator, true);
      }, delay);
    }

    handleIncomingMessage(msg) {
      if (!msg || msg.senderId === this.clientId) return;

      // v4.16: any received message proves the channel is alive (even one
      // the role filter below drops — it still arrived).
      this.lastRxAt = Date.now();
      if (msg.senderId) this.peerLastSeen.set(msg.senderId, Date.now());

      // v4.8: teacher-only board. Board-changing events sent by a student-role
      // device are dropped here, on EVERY peer — so a student edit can never
      // land on the teacher's board (or anyone else's), even if a student
      // device's own UI gating is bypassed. Chat and voice events are NOT in
      // this list, so students can still message and listen. Peers on older
      // versions send no senderRole and are treated as teachers (compatible).
      const BOARD_MUTATION_EVENTS = new Set([
        'stroke_add', 'stroke_update',
        'shape_add', 'shape_update',
        'shape3d_add', 'shape3d_update', // v4.10: 3D shapes
        'line_add', 'line_update',
        'frame_add', 'frame_update',
        'image_add', 'image_update', 'image_meta', 'image_chunk',
        'text_add', 'text_update',
        'object_delete', 'clear_drawings', 'board_snapshot', 'instrument_update',
        // v4.12 teacher-only classroom broadcast events:
        'laser_point', 'follow_frame', 'spotlight_update'
      ]);
      if (msg.senderRole === 'student' && BOARD_MUTATION_EVENTS.has(msg.type)) return;

      if (msg.senderId && !this.peers.has(msg.senderId)) {
        this.peers.add(msg.senderId);
        this.updateStatusUI(
          this.supabase ? 'Live Sync (' + this.roomCode + ')' : 'Tab Sync (' + this.roomCode + ')',
          this.supabase ? 'connected' : 'local'
        );
      }

      const { type, data } = msg;
      switch (type) {
        case 'peer_hello':
          this.send('peer_ack', { peerId: this.clientId });
          break;
        case 'peer_ack':
          break;
        case 'request_snapshot':
          // Room creator (or any existing peer) replies with the full board snapshot
          this.emitLocal('provide_snapshot', data);
          break;
        case 'board_snapshot':
          this.emitLocal('apply_snapshot', data);
          break;
        default:
          this.emitLocal(type, data);
          break;
      }
    }

    send(type, data, throttleMs = 0) {
      if (!this.roomCode) return;
      if (throttleMs > 0) {
        const now = performance.now();
        const key = type + ((data && data.id) ? ('_' + data.id) : '');
        const last = this.lastBroadcastByType[key] || 0;
        if (now - last < throttleMs) return;
        this.lastBroadcastByType[key] = now;
        this.lastInstrumentBroadcast = now;
      }

      const packet = {
        senderId: this.clientId,
        senderRole: this.myRole || 'student',
        roomCode: this.roomCode,
        type: type,
        data: data,
        ts: Date.now()
      };

      if (this.localChannel) {
        try {
          this.localChannel.postMessage(packet);
        } catch (e) {}
      }

      if (this.channel && this.connected) {
        try {
          this.channel.send({
            type: 'broadcast',
            event: 'wb_msg',
            payload: packet
          });
        } catch (e) {}
      }
    }

    copyShareLink() {
      const roomInput = document.getElementById('roomCodeInput');
      if (!this.roomCode) {
        const code = (roomInput && roomInput.value.trim()) ? roomInput.value.trim().toUpperCase() : this.generateRoomCode();
        if (roomInput) roomInput.value = code;
        this.connectToRoom(code, true);
      }

      let shareUrl = '';
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('room', this.roomCode);
        shareUrl = u.toString();
      } catch (e) {
        shareUrl = window.location.origin + window.location.pathname + '?room=' + this.roomCode;
      }

      const onCopied = () => {
        this.emitLocal('toast', 'Room link copied: ?room=' + this.roomCode);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).then(onCopied).catch(() => {
          this.fallbackCopyText(shareUrl, onCopied);
        });
      } else {
        this.fallbackCopyText(shareUrl, onCopied);
      }
    }

    fallbackCopyText(text, callback) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (callback) callback();
      } catch (e) {
        this.emitLocal('toast', 'Share code: ' + this.roomCode);
      }
    }
  }

  global.BoardSync = new BoardSyncManager();
})(window);
