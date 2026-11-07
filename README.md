# Geometry Whiteboard — Argon v4.14

## v4.14 — what is new (2 fixes from device testing, built on v4.13)
1. **Coloured 3D faces keep their colour from the inside** — box shapes (cube, cuboid, both prisms) used to skip back-facing faces entirely, so a coloured face went blank as soon as it rotated to the far side. Back faces are now filled with the same colour (not stroked — their edges stay dashed, as before). Same fix in the PDF export.
2. **Cone & cylinder opening matches the reference video** (mathmarvels "Net of a Cone and Cylinder") — a real peel instead of a cross-fade / widening rectangle: a slit opens at the front centre and the surface peels apart symmetrically; the cone's apex stays fixed and its base circle stays tangent to the sector arc at every step; the cylinder's bottom circle detaches first and is a full face-on circle by ~40% open. The finished flat nets are unchanged (they already matched the video). The PDF now draws the open cone/cylinder the same way instead of only the closed outline.

## v4.13 — what is new (3 fixes from device testing, built on v4.12)
1. **Shapes land inside the working frame** — 3D shapes, 2D shapes and lines now drop at the centre of the frame being worked on (same rule as the v4.11 instruments), instead of the centre of the screen. With no frame under the view centre they still land at the view centre.
2. **Hover-aware mouse wheel** — hovering the left toolbar scrolls the toolbar; hovering the tool-options strip scrolls it sideways; hovering the board zooms as before.
3. **Text box font size edits the written text** — a floating A− / size / A+ bar under a selected text box resizes that box live (synced, undoable); the panel Size box does the same when a text is selected, and still sets the size for the next box when nothing is selected. Double-click a text box (any tool) to edit its words again.

## v4.12 — what is new (code review fixes, 60fps smoothness, UI polish & 6 live-teaching additions, built on v4.11)
1. **Sync & Broadcast reliability fixes (`sync.js` + `interactive.js`)**:
   - **Per-event broadcast throttling (`sync.js`)**: Replaced the single shared `lastInstrumentBroadcast` timestamp with a per-event-and-ID map (`lastBroadcastByType`) so simultaneous broadcasts (such as `compass_draw` sending `instrument_update` + `stroke_update`, or `move_multi` updating multiple objects at once) never drop or starve each other.
   - **Preserved Teacher badge in header (`sync.js`)**: `updateStatusUI()` now updates `#activeRoomLabel`'s text node without wiping the nested `#teacherBadge` element when connecting or joining a room.
   - **Image geometry-only payload on drag release & multi-move (`interactive.js`)**: `endPointerInteraction()` and `move_multi` now use `updatePayloadFor(category, obj)` so releasing a dragged/resized/rotated image (>96 KB data URL) sends lightweight geometry metadata instead of exceeding the 256 KB Supabase Broadcast cap.
   - **Paced chunked image transfer (`interactive.js`)**: `sendChunked()` now paces outgoing 32 KB chunks at 24 ms intervals (and raises client `eventsPerSecond` to 45) so 600 KB–1 MB photos never trigger WebSocket token-bucket drops.
   - **Cloud & IndexedDB persistence on all mutations (`interactive.js`)**: `deleteSelectedObject()`, `addFrameToBoard()`, `insertShapeCentered()`, `insertLineCentered()`, `clearDrawingsOnly()`, `addImageObject()`, `drawCompassCircleAction()`, and `stampProtractorRayAction()` now all trigger `scheduleCloudSave()` and `pushHistory()`.
   - **3D solids included in empty-board guard, Fit-to-Screen, and PDF export (`interactive.js`)**: `hasContent` in `loadCloudBoard()` / `restoreFromLocalBackup()` now checks `board.shapes3d.length`; `fitBoardToScreen()` includes `shapes3d`, `texts`, and `images`; and `drawContentForPdf()` renders 3D shapes and unfolded nets into the exported PDF.
2. **Smoothness & 60fps Canvas Optimizations**:
   - **Cached canvas bounding rect**: Eliminated synchronous `canvas.getBoundingClientRect()` layout reflows on every `mousemove` and `wheel` tick by caching the rect and refreshing on `resize`, `ResizeObserver`, and `visualViewport` events.
   - **Offscreen Protractor dial bitmap cache**: Cached the static protractor semi-circle, 181 degree ticks, and 38 labels onto an offscreen canvas (`getProtractorDialCanvas`), cutting protractor drag/rotate rendering cost by ~90%.
   - **Wheel-zoom event snapshot**: `handleBoardWheel()` now snapshots wheel event fields (`deltaX`, `deltaY`, `clientX`, `clientY`, `ctrlKey`, `deltaMode`) before queuing in `wheelPending` for the 50 ms timer, preventing stale DOM Event reference issues.
   - **2-finger pinch undo cleanup — CUT after review (2026-11-07):** Gemini's pinch handler popped the last undo snapshot when a second finger landed, but v4.11 never pushed a duplicate snapshot on pinch, so the pop silently undid the teacher's last action (e.g. after dragging a ruler or compass) and desynced peers. Removed before shipping; pinching now cancels the single-finger action exactly as in v4.11.
3. **Premium Minimalistic UI (`index.html` / `interactive.html`)**:
   - Consolidated the duplicate `[data-tab-panel="shapes"]` rows into a single clean contextual sub-bar with segmented `.tool-cluster` groups and a fixed `min-height: 44px` (`#contextSubBar`) so switching tools never causes vertical layout jumps.
   - Added a compact, translucent bottom-right HUD pill (`#floatingZoomHud`) restoring one-tap Zoom Out (`−`), Zoom `%` Reset (`100%`), Zoom In (`+`), and Fit to Screen (`⊡`), plus quick Prev/Next Frame stepping (`‹ F1/1 ›`).
4. **6 Modular Live-Teaching Additions (all teacher-gated, zero extra servers/accounts)**:
   - **Live Laser Pointer (`data-pen-sub="laser"`, shortcut `L`)**: Ephemeral glowing red pointer and fading 1.1 s trail under the Pen tool, streamed live to students without cluttering undo history or cloud saves.
   - **"Focus Class" / Bring Students Here (`#btnBringStudents`)**: One tap smoothly animates all connected students' viewports to the teacher's current working frame or board view (`follow_frame` broadcast).
   - **Frame Spotlight / Step-by-Step Reveal Curtain (`#btnToggleSpotlight`)**: Covers the lower portion of the active frame with an opaque shade that the teacher can drag down line-by-line during proofs and derivations (`spotlight_update` broadcast).
   - **Frame Paper Styles (`data-frame-pattern`)**: Per-frame background pattern selector in the Frames bar — **Grid** (1 cm squares), **Dots** (isometric dot grid for 3D & geometry), **Lined** (ruled notebook lines), and **Blank**.
   - **Quick Geometry & Math Symbol Bar (`data-math-sym`)**: One-tap insertion of `∠`, `°`, `△`, `⊥`, `∥`, `≅`, `∼`, `π`, `√`, `²`, `³` in the Text Box sub-bar without closing the active text editor.
   - **Universal Clone / Duplicate (`#btnDuplicateSelected`, `Ctrl/Cmd+D`)**: Clones any selected object or multi-selection (shapes, 3D solids, frames, lines, text boxes, images, strokes) with a clean offset, plus full keyboard shortcuts (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Y`, `Ctrl/Cmd+Shift+Z`, `V/P/S/F/I/T/L/E`, `[` / `]`).

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

## Run it
Open `index.html` (or `interactive.html` — the two files are identical) in
a browser, or deploy the whole folder to GitHub Pages / Netlify. Paste your
Supabase Project URL + anon key once in the sync bar, create or join a room,
and share the room link. For cloud save, also run `../supabase-cloud-save.sql`
in that Supabase project.
