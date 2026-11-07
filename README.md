# Geometry Whiteboard — Argon v4.11

## v4.11 — what is new (6 items, built on v4.10)
1. **Select tool: left-drag = select, right-drag = pan** — the v4.10
   right-drag marquee is reverted. Left-drag on empty board draws the
   dashed marquee box; right-drag pans the board in any tool; a plain
   right-click still opens the frame menu.
2. **360° rotation for 3D shapes** — drag the body of an already-selected
   shape to rotate it: sideways = spin, up/down = tilt, a full 360°+ in one
   drag with no snap-back. The rotate handle is fixed the same way (v4.10
   could only turn it 180° per drag). Dragging a shape that is not selected
   yet still moves it. Tilt visibly rotates cube, cuboid and prisms;
   cylinder, cone and hemisphere do not tilt yet (their tilt rendering is
   a follow-up); spinning them is invisible because they are symmetric.
3. **Net picker scrolls with the mouse wheel** — hovering over the 11-net
   popup + wheel scrolls the nets; outside the popup the wheel still zooms.
4. **Net picker closes on click outside** — left-click anywhere outside the
   popup closes it (a board click is swallowed, so nothing is drawn or
   selected). The Net button now toggles the popup.
5. **Re-selecting a 3D shape restores all its options + "no colour" fill**
   — clicking a shape always selects the shape, even where writing lies
   over it, so the colour / net / open / rotate / resize / delete options
   always appear. A new ✕ swatch clears all face colours, leaving the
   shape as wireframe (edges only); colouring a face again ends wireframe
   mode.
6. **Instruments land inside the working frame** — tapping Ruler, Compass
   or Protractor now places it inside the frame you are looking at (the
   frame containing the centre of the view), instead of at a fixed spot on
   the board. An instrument you placed deliberately stays where you put it.

## v4.10 — what is new (6 fixes + 3D shapes, built on v4.9)
1. **Right-drag marquee-select in Select** — a right-button drag in Select
   mode now draws a dashed marquee box and selects everything inside it
   (frames, shapes, 3D shapes, images, texts, lines, strokes), whether the
   drag started inside or outside a frame. A plain right-click still opens
   the frame menu. Panning stays on middle button / Space+drag / two-finger
   drag; right-drag in other tools (or for students) still pans.
2. **Pen thickness is a slider (1–20 px, default 4)** with a live px
   readout, replacing the Fine / Medium / Bold buttons. Highlighter still
   draws at penWidth × 4.2. Per-device, new strokes only.
3. **Pen dot cursor follows the thickness** — dot diameter = stroke width
   × 2, capped at 32px (default 4 px → 8px, as before); highlighter × 4.2.
   Colour still follows the theme.
4. **Compass: no automatic circle, thickness follows the slider** — adding
   the compass no longer draws a faint locus circle; a circle appears only
   when swung or via "Draw Compass Circle", and that circle's thickness now
   follows the pen Thickness slider. Compass colour still borrows the pen
   colour (no separate control).
5. **Ruler selection outline uses the ruler's own pivot** (top-left corner,
   not the bounds centre), so the dashed box sits exactly on the ruler at
   any angle; the protractor uses its centre pin.
6. **Text box stays open** — the canvas mousedown now prevents the default
   focus move, so the editor no longer blurs shut the instant it opens;
   type, then click away or press Esc.
7. **3D shapes (🧊 in the left toolbar, between Instruments and Text
   box)** — 8 shapes: Cube, Cuboid, Cylinder, Cone, Sphere, Hemisphere,
   Rectangular prism, Square prism. Tap one to place it at the centre of
   the view. Isometric render with dashed hidden edges and vertex labels
   (A, B, C…) while selected. A floating toolbar under the selected shape
   has an **Open slider** (drag right to unfold into the net bit by bit,
   drag left to close — a real hinge fold, so faces never bowtie),
   **face-by-face colouring** (tap a colour, tap a face), a **Net** picker
   with all 11 nets for cube/cuboid/prisms (labelled 1-4-1 / 2-3-1 / 2-2-2
   / 3-3), **Clone** and **Delete**. Sphere and hemisphere cannot unfold
   (no slider). Rotate handle spins the shape around its vertical axis;
   corner handles scale it. 3D shapes sync over Broadcast and persist
   through cloud save / snapshots / undo / backup, like 2D shapes.
   Known limit: the frames-only PDF export does not draw 3D shapes yet.

## v4.9 — what is new (1 fix, built on v4.8)
1. **Mouse wheel finally zooms (burst-aware detection)** — v4.8 read one wheel
   event at the start of each burst, so a smooth-scroll mouse sending the SAME
   tiny fractional delta on every detent (Rahul's mouse: exactly ±4.000244140625
   per tick) was read as a trackpad drag and panned the board instead of
   zooming. The board now reads the SHAPE of the burst: repeated identical
   deltas = mouse-wheel detents → zoom; a stream of varying small deltas =
   trackpad drag → pan; a lone tick with no follow-up = a mouse notch → zoom.
   The clear rules are unchanged (Ctrl+wheel pinch, line mode, |deltaY| >= 40,
   integer steps >= 10 → zoom; |deltaX| > 3 → pan), and the page scroll is
   blocked immediately on every wheel event. Trackpad two-finger drag still
   pans. Verified in the VM with Rahul's exact 20 diagnostic numbers — all 20
   zoom — plus synthetic trackpad streams that all pan (`wheel-test.js`).

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
