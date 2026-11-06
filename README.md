# Geometry Whiteboard — Argon v4.4

## v4.4 — what is new (3 edits, built on v4.3)
1. **Unlock hold is now 1 second** (was 3 seconds). The shaded left-to-right progress bar fills in 1 s; releasing early, or moving the cursor off the unlock icon, still cancels.
2. **Select-tool marquee multi-selection** — Select tool: left-click an object selects it; left-drag starting on EMPTY board draws a dashed marquee box and, on release, selects everything whose bounds intersect the box (frames, shapes, lines, strokes, images, text boxes; instruments are never marquee-selectable). Left-drag starting ON an object moves it (or the whole multi-selection, if it is part of one). Left-drag on empty board NEVER pans any more. **Right-button hold + drag pans the board** anywhere, including on locked frames. Space+drag and two-finger drag pan remain as secondary methods. Pen/shape/line/instrument dragging are unchanged.
3. **Lock / unlock / colour all selected frames at once** — after a marquee covering several frames, right-clicking any selected frame applies the frame menu to the whole selection: Lock locks all of them, Choose colour colours all of them, and (when all selected frames are locked) Hold to unlock unlocks all of them with one 1-second right-button hold. Right-clicking a frame outside the selection affects only that frame. In a multi-move, locked frames stay put while unlocked ones move; if the drag starts on a locked frame, the move is refused with a 'Frame is locked' toast. In multi-delete, locked frames are kept and the rest are deleted. Locked flags and colours sync via frame_update and persist via the existing cloud save (same board_saves table, no new SQL).


## v4.3 — what is new (2 features, built on v4.2)
1. **Magnetic frame snapping (frames only)** — drag a frame near another
   frame and its edge locks exactly onto that frame's edge (no gap, no
   overlap) when within ~15 board px: below (top edge to the other's
   bottom edge), above, and side-by-side left/right, plus centre alignment
   when a centre is the nearest match. When a frame stacks above/below
   another, its left/centre/right edge also aligns within ~40 px, so
   same-width frames match on all four corners. A faint amber dashed guide
   line shows along the snapped edge while dragging. Holding **Alt** while
   dragging disables snapping for that drag. The snapped position is what
   is synced to peers and saved to cloud (snap happens before the move
   commit, not as a visual-only effect). Other object types do not snap.
2. **Frame lock + colour via right-click** — right-click a frame (a right
   press that barely moves; a right-drag still pans the board) to open a
   small icon menu at the cursor, dark-blue buttons with hover names:
   **Lock** (🔒) and **Choose frame colour** (🎨, swatches + custom colour
   picker). A locked frame shows a small lock badge, cannot be dragged,
   resized, rotated or deleted (Delete button/key refuse it with a
   "Frame is locked" toast, and remote deletes are refused too), and a
   right-drag starting on it pans the whole board. Drawing/writing inside
   a locked frame still works — only the frame box itself is locked.
   Right-clicking a locked frame shows ONLY **Hold to unlock** (🔓); no
   colour change while locked. Unlock requires holding that icon with the
   **right mouse button for a full 3 seconds**, with a shaded progress bar
   filling left to right; releasing early cancels and the frame stays
   locked. The locked flag and the colour live on the frame object, so
   they sync via frame_update and persist through cloud save (locked
   frames stay locked after reload). Touch devices have no right-click,
   so this menu simply does not appear there (long-press is out of scope).

# Geometry Whiteboard — Argon v4

A no-account, room-code whiteboard for teaching geometry live, synced
browser-to-browser over Supabase Realtime Broadcast (no server, no tables
needed for live sync). Built from Argon v3; all v3 features are kept.

## v4 — what is new (the confirmed batch, all 10 items)
1. **No frame titles, no hint text** — the title bar drawn above frames and
   the bottom-left "Per-device view" hint are removed. Titles therefore do
   not appear on PDF pages either (intended).
2. **Trapezium** — new shape alongside rectangle, ellipse/circle, triangle
   and diamond, with the same rotate and corner/edge resize handles, synced
   like other shapes, and drawn in the frames-only PDF.
3. **Cloud save per room + per tab** — board state is saved (debounced) to
   the teacher's own Supabase project via its REST API, using only the URL
   + anon key already pasted into the sync bar (never hardcoded, never a
   service_role key). Run `../supabase-cloud-save.sql` once in that project
   to create the `board_saves` table (room, tab, state JSONB, updated_at).
   Without the table, the board fails silently and live Broadcast sync
   still works. A **New board** button (top bar, with confirm) clears the
   cloud copy for the current tab so an old board does not return.
   Images are still compressed to max 1400 px JPEG before saving, as in v3.
4. **Input remap** — trackpad two-finger drag pans in finger direction;
   trackpad pinch (Chrome: Ctrl+wheel) zooms in/out; mouse wheel scroll up
   zooms in, down zooms out; holding the right mouse button and dragging
   pans (context menu suppressed on the canvas only). Drag-empty-board
   and Space+drag pan still work. Pen/shape/instrument dragging is untouched.
5. **Blank start** — a fresh board opens with no ruler, compass or
   protractor. Instruments are added only by clicking them in the
   Instruments menu. Saved/cloud boards still load their own instruments.
   (The single default 16:9 frame is kept, as in v3.)
6. **Class tabs** — a tab bar above the board, one tab per class, each with
   its own complete board state (frames, strokes, shapes, images, text,
   instruments). Create / rename (✎) / close (×) tabs; switching swaps the
   board; cloud save is per tab. **Live-follow is unsettled in v4: tab
   switching is per-device — students do NOT auto-follow the teacher's tab
   switch.** That decision is left for later.
7. **Left toolbar** — vertical, icon-only, medium icons, no labels, hover
   names, in this order: Select, Pen, Shapes, Frames, Instruments, Text
   box, Add images. Lines live under Shapes, not as a separate top-level
   tool. **Text box (new):** click the board, a box appears, type by
   keyboard; boxes move/resize/rotate like other objects and sync.
   **Undo / Redo** sit at the bottom of the left bar, capped at the last
   20 actions. All icons are original generic symbols (not Miro's artwork);
   icon buttons are dark blue with a white symbol, except Voice call
   (green) and Leave voice call (red).
8. **Top-right export / voice stack** — Export (PDF) sits at the top-right
   in the voice-call section area, icon-only with a hover name. While in a
   call, a vertical stack appears under the Voice call button, in order:
   Leave voice call, Mic on/off, Speaker on/off — all icon-only with hover
   names.
9. **Dark / light theme** — a small theme button on the top bar immediately
   before Room Sync. **First open is always dark theme**; clicking toggles
   to light, and the choice is remembered per device (localStorage). Dark
   mode restyles the canvas/grid, toolbars, panels, class tabs, frame
   backgrounds and near-black ink (rendering-only; stored colours and the
   PDF keep their original colours).
10. **Zoom controls removed** — no − / % / + controls at the bottom-right.
    Zoom remains via pinch, mouse wheel and trackpad.

## v3 features (kept)
Images (file picker / drag-and-drop / paste, multi-upload, resize, rotate,
crop; eraser does not erase images; Clear drawings keeps images),
frames-only PDF (one frame = one page, content only), WebRTC voice call
for 2–3 peers with mic/speaker toggles, Supabase Broadcast live sync with
late-joiner snapshot, resizable ruler with edge-snapped line drawing,
swing-draw compass (partial swing = arc, full swing = circle), resizable
and flippable protractor, pen / highlighter / eraser.

## Run it
Open `index.html` (or `interactive.html` — the two files are identical) in
a browser, or deploy the whole `geometry-whiteboard/` folder to Netlify
(existing site's overview-page drop zone; an upload replaces the whole
site, never merges). Paste your Supabase Project URL + anon key once in
the sync bar, create or join a room, and share the room link. For cloud
save, also run `../supabase-cloud-save.sql` in that Supabase project.

## Test it
See `../TEST-CHECKLIST.md` — it covers every v4 item, the v3 regression
pass, and the known limits (pinch detection is a browser heuristic; cloud
restore never overwrites a board that already has content; tab rename
uses the browser prompt and close uses the browser confirm).
