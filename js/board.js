import { PIECE_GLYPH, squareId } from "./engine.js";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

export class BoardUI {
  /**
   * @param {HTMLElement} boardEl
   * @param {HTMLElement} promoEl
   * @param {object} opts
   *   getGame(): Chess          - returns current chess.js instance
   *   canMove(from,to): bool    - whether the local player is allowed to attempt this move right now
   *   onMove({from,to,promotion}) - called when the player commits a legal move
   */
  constructor(boardEl, promoEl, opts) {
    this.boardEl = boardEl;
    this.promoEl = promoEl;
    this.opts = opts;
    this.orientation = "w"; // which color sits at the bottom
    this.selected = null; // square id currently selected
    this.legalTargets = []; // verbose move list for the selected square
    this.lastMove = null; // {from, to}
    this.squareEls = new Map();
    this.focusedSquare = null; // square id currently in the keyboard tab order

    // Drag-and-drop state. Click-to-move (select, then click a target) keeps
    // working unchanged; this just layers an alternative gesture on top of
    // the same selection/legal-move machinery.
    this._pointerDrag = null; // { pointerId, from, pieceEl, ghost, startX, startY, dragging }
    this._suppressNextClick = false; // swallow the synthetic click a pointerup-after-drag generates
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onLostPointerCapture = this._onLostPointerCapture.bind(this);

    // Analysis-hint arrow overlay. A single persistent SVG node, re-appended
    // as the last child of boardEl every time _buildGrid() rebuilds the
    // squares (e.g. on flip) — its own contents (the drawn arrow, if any)
    // survive that reattachment since innerHTML="" on the parent only
    // detaches this node, it doesn't tear down this node's own subtree.
    this._hintArrow = null; // { from, to } of the currently-shown arrow, if any
    this.arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.arrowSvg.setAttribute("viewBox", "0 0 8 8");
    this.arrowSvg.setAttribute("preserveAspectRatio", "none");
    this.arrowSvg.setAttribute("aria-hidden", "true");
    this.arrowSvg.classList.add("hint-arrow-layer");

    this._buildGrid();
    this.boardEl.addEventListener("click", (e) => this._onSquareClick(e));
    this.boardEl.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.boardEl.addEventListener("pointerdown", (e) => this._onPointerDown(e));
  }

  setOrientation(color) {
    this.orientation = color;
    this._buildGrid();
    this.render();
    if (this._hintArrow) this.showHintArrow(this._hintArrow.from, this._hintArrow.to);
  }

  flip() {
    this.setOrientation(this.orientation === "w" ? "b" : "w");
  }

  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
  }

  clearSelection() {
    this.selected = null;
    this.legalTargets = [];
    this._updateHighlights();
    this._hidePromoPicker();
  }

  _buildGrid() {
    this.boardEl.innerHTML = "";
    this.squareEls.clear();
    const ranksTop = this.orientation === "w" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    const filesRow = this.orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    let firstId = null;

    for (const rank of ranksTop) {
      for (const file of filesRow) {
        const id = squareId(file, rank);
        if (firstId === null) firstId = id;
        const isLight = (file + rank) % 2 === 1;
        const sq = document.createElement("div");
        sq.className = `sq ${isLight ? "light" : "dark"}`;
        sq.dataset.square = id;
        sq.setAttribute("role", "gridcell");
        sq.tabIndex = -1; // roving tabindex: exactly one square is in the tab order at a time

        if (file === filesRow[0]) {
          const rankLabel = document.createElement("span");
          rankLabel.className = "coord rank";
          rankLabel.textContent = rank + 1;
          sq.appendChild(rankLabel);
        }
        if (rank === ranksTop[ranksTop.length - 1]) {
          const fileLabel = document.createElement("span");
          fileLabel.className = "coord file";
          fileLabel.textContent = FILES[file];
          sq.appendChild(fileLabel);
        }

        this.boardEl.appendChild(sq);
        this.squareEls.set(id, sq);
      }
    }
    this.boardEl.appendChild(this.arrowSvg);

    // Keep the previous focus square if it still exists (e.g. after a flip); otherwise default to the first square in DOM order.
    if (!this.focusedSquare || !this.squareEls.has(this.focusedSquare)) this.focusedSquare = firstId;
    this._applyRovingTabIndex();
  }

  _applyRovingTabIndex() {
    for (const [id, sq] of this.squareEls) sq.tabIndex = id === this.focusedSquare ? 0 : -1;
  }

  render() {
    const chess = this.opts.getGame();
    const board = chess.board();
    // clear pieces & markers, keep coord labels
    for (const [id, sq] of this.squareEls) {
      sq.querySelectorAll(".piece, .move-dot, .capture-ring").forEach((n) => n.remove());
      sq.setAttribute("aria-label", `${id}, empty`);
    }

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (!p) continue;
        const el = document.createElement("span");
        el.className = `piece ${p.color === "w" ? "white" : "black"}`;
        el.textContent = PIECE_GLYPH[p.color][p.type];
        el.dataset.piece = `${p.color}${p.type}`;
        const sq = this.squareEls.get(p.square);
        sq.appendChild(el);
        sq.setAttribute("aria-label", `${p.square}, ${p.color === "w" ? "white" : "black"} ${PIECE_NAMES[p.type]}`);
      }
    }

    this._updateHighlights();
    this._updateCheckHighlight(chess);
  }

  _updateCheckHighlight(chess) {
    for (const sq of this.squareEls.values()) sq.classList.remove("in-check");
    if (chess.isCheck && chess.isCheck()) {
      const board = chess.board();
      const turn = chess.turn();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === "k" && p.color === turn) {
            this.squareEls.get(p.square).classList.add("in-check");
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------
     Analysis-hint arrow
  --------------------------------------------------------- */
  showHintArrow(from, to) {
    const a = this._squareCenter(from);
    const b = this._squareCenter(to);
    if (!a || !b) { this.clearHintArrow(); return; }
    this._hintArrow = { from, to };
    this._drawArrow(a, b);
  }

  clearHintArrow() {
    this._hintArrow = null;
    this.arrowSvg.textContent = "";
  }

  // Square id -> center point in the same 0-8 grid-unit space as the SVG's
  // viewBox, accounting for board orientation the same way _buildGrid() maps
  // file/rank to screen row/column.
  _squareCenter(id) {
    if (!id || id.length < 2) return null;
    const file = "abcdefgh".indexOf(id[0]);
    const rank = Number(id[1]) - 1;
    if (file < 0 || Number.isNaN(rank) || rank < 0 || rank > 7) return null;
    const col = this.orientation === "w" ? file : 7 - file;
    const row = this.orientation === "w" ? 7 - rank : rank;
    return { x: col + 0.5, y: row + 0.5 };
  }

  _drawArrow(a, b) {
    const ns = "http://www.w3.org/2000/svg";
    this.arrowSvg.textContent = ""; // clear any previous arrow first

    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // unit vector along the arrow
    const px = -uy, py = ux; // perpendicular unit vector, for the arrowhead width

    const startX = a.x + ux * 0.16, startY = a.y + uy * 0.16; // pull back from the source square's center a bit
    const tipX = b.x - ux * 0.08, tipY = b.y - uy * 0.08; // stop just shy of the target center
    const headLen = 0.3, headWidth = 0.24;
    const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;

    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", startX);
    line.setAttribute("y1", startY);
    line.setAttribute("x2", baseX);
    line.setAttribute("y2", baseY);
    line.setAttribute("stroke-width", "0.11");
    line.setAttribute("stroke-linecap", "round");
    line.classList.add("hint-arrow-shape");

    const head = document.createElementNS(ns, "polygon");
    const leftX = baseX + px * (headWidth / 2), leftY = baseY + py * (headWidth / 2);
    const rightX = baseX - px * (headWidth / 2), rightY = baseY - py * (headWidth / 2);
    head.setAttribute("points", `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
    head.classList.add("hint-arrow-shape");

    this.arrowSvg.appendChild(line);
    this.arrowSvg.appendChild(head);
  }

  _updateHighlights() {
    for (const [id, sq] of this.squareEls) {
      sq.classList.toggle("selected", id === this.selected);
      sq.classList.toggle(
        "last-move",
        !!this.lastMove && (id === this.lastMove.from || id === this.lastMove.to)
      );
      sq.querySelectorAll(".move-dot, .capture-ring").forEach((n) => n.remove());
    }
    for (const mv of this.legalTargets) {
      const sq = this.squareEls.get(mv.to);
      if (!sq) continue;
      const marker = document.createElement("span");
      marker.className = mv.captured || mv.flags?.includes("e") ? "capture-ring" : "move-dot";
      sq.appendChild(marker);
    }
  }

  _onSquareClick(e) {
    if (this._suppressNextClick) {
      // A drag just committed (or was released over an invalid square) on
      // pointerup; the browser still synthesizes a click afterward, which
      // would otherwise re-run _activateSquare and could re-toggle
      // selection right after a move already went through.
      this._suppressNextClick = false;
      return;
    }
    const sqEl = e.target.closest(".sq");
    if (!sqEl) return;
    const id = sqEl.dataset.square;
    this.focusedSquare = id;
    this._applyRovingTabIndex();
    this._activateSquare(id);
  }

  /* ---------------------------------------------------------
     Drag and drop (mouse + touch, via Pointer Events)
  --------------------------------------------------------- */
  _onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return; // primary button / touch only
    const sqEl = e.target.closest(".sq");
    if (!sqEl) return;
    const id = sqEl.dataset.square;
    const chess = this.opts.getGame();
    const piece = chess.get(id);
    // Only a movable piece of the side to move can start a drag; anything
    // else (empty square, opponent's piece, not-your-turn) falls through to
    // the normal click handling untouched.
    if (!piece || piece.color !== chess.turn() || !this.opts.canMove(id)) return;

    this._hidePromoPicker();
    this.focusedSquare = id;
    this._applyRovingTabIndex();
    this.selected = id;
    this.legalTargets = chess.moves({ square: id, verbose: true });
    this._updateHighlights();

    const pieceEl = sqEl.querySelector(".piece");
    if (!pieceEl) return;

    this._pointerDrag = {
      pointerId: e.pointerId,
      from: id,
      sqEl,
      pieceEl,
      ghost: null,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
    sqEl.setPointerCapture(e.pointerId);
    sqEl.addEventListener("pointermove", this._onPointerMove);
    sqEl.addEventListener("pointerup", this._onPointerUp);
    sqEl.addEventListener("pointercancel", this._onPointerCancel);
    sqEl.addEventListener("lostpointercapture", this._onLostPointerCapture);
  }

  _onPointerMove(e) {
    const drag = this._pointerDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;

    if (!drag.dragging) {
      // Small deadzone so an ordinary tap/click doesn't get mistaken for a drag.
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      drag.dragging = true;
      drag.pieceEl.classList.add("dragging");
      drag.ghost = this._createDragGhost(drag.sqEl, drag.pieceEl, e.clientX, e.clientY);
    }
    this._positionDragGhost(drag.ghost, e.clientX, e.clientY);
  }

  _onPointerUp(e) {
    const drag = this._pointerDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this._teardownPointerDrag(drag);

    if (!drag.dragging) return; // a plain tap/click — let the click event handle it as usual

    this._suppressNextClick = true;
    drag.pieceEl.classList.remove("dragging");
    drag.ghost?.remove();

    const dropEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".sq");
    const dropId = dropEl?.dataset.square;
    const target = dropId ? this.legalTargets.find((m) => m.to === dropId) : null;
    if (target) {
      this._commitMove(drag.from, dropId, target);
    } else {
      // Dropped somewhere that isn't a legal target (including off the
      // board entirely) — snap back, but keep the piece selected so the
      // legal-move dots are still visible for a follow-up click.
      this._updateHighlights();
    }
    // Safety net: if the browser doesn't fire a click after this pointerup
    // for some reason, don't leave a stray click permanently swallowed.
    setTimeout(() => { this._suppressNextClick = false; }, 400);
  }

  _onPointerCancel(e) {
    const drag = this._pointerDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this._teardownPointerDrag(drag);
    drag.pieceEl.classList.remove("dragging");
    drag.ghost?.remove();
    this._updateHighlights();
  }

  // Fires if pointer capture is released for any reason without a pointerup
  // or pointercancel ever arriving first — e.g. the window/tab loses focus
  // mid-drag (switching apps on mobile). Without this, a stuck ghost piece
  // and a permanently-suppressed next click would be the only way the drag
  // ever "ends", and the board would look broken until reloaded.
  _onLostPointerCapture(e) {
    const drag = this._pointerDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this._onPointerCancel(e);
  }

  _teardownPointerDrag(drag) {
    drag.sqEl.removeEventListener("pointermove", this._onPointerMove);
    drag.sqEl.removeEventListener("pointerup", this._onPointerUp);
    drag.sqEl.removeEventListener("pointercancel", this._onPointerCancel);
    drag.sqEl.removeEventListener("lostpointercapture", this._onLostPointerCapture);
    if (drag.sqEl.hasPointerCapture?.(drag.pointerId)) drag.sqEl.releasePointerCapture(drag.pointerId);
    this._pointerDrag = null;
  }

  _createDragGhost(sqEl, pieceEl, clientX, clientY) {
    const rect = sqEl.getBoundingClientRect();
    const ghost = document.createElement("span");
    ghost.className = `${pieceEl.className} drag-ghost`;
    ghost.textContent = pieceEl.textContent;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.fontSize = getComputedStyle(sqEl).fontSize;
    document.body.appendChild(ghost);
    this._positionDragGhost(ghost, clientX, clientY);
    return ghost;
  }

  _positionDragGhost(ghost, clientX, clientY) {
    if (!ghost) return;
    const w = parseFloat(ghost.style.width);
    const h = parseFloat(ghost.style.height);
    ghost.style.transform = `translate(${clientX - w / 2}px, ${clientY - h / 2}px)`;
  }

  _onKeyDown(e) {
    const sqEl = e.target.closest(".sq");
    if (!sqEl) return;
    const id = sqEl.dataset.square;

    const dirs = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (dirs[e.key]) {
      e.preventDefault();
      this._moveFocus(id, dirs[e.key]);
      return;
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      this._activateSquare(id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.clearSelection();
    }
  }

  // Moves keyboard focus by one square. Deltas are screen-relative (right/up
  // as displayed) so arrow keys behave the same regardless of board orientation.
  _moveFocus(fromId, [dFile, dRank]) {
    const file = fromId.charCodeAt(0) - 97;
    const rank = parseInt(fromId[1], 10) - 1;
    const flip = this.orientation === "b";
    const nf = file + (flip ? -dFile : dFile);
    const nr = rank + (flip ? -dRank : dRank);
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) return;
    const nextId = squareId(nf, nr);
    const nextEl = this.squareEls.get(nextId);
    if (!nextEl) return;
    this.focusedSquare = nextId;
    this._applyRovingTabIndex();
    nextEl.focus();
  }

  // Shared by mouse clicks and keyboard activation (Enter/Space): selects a
  // piece, commits a move to a legal target, or clears the current selection.
  _activateSquare(id) {
    const chess = this.opts.getGame();
    this._hidePromoPicker(); // any new square activation cancels a still-open promotion decision

    // If a square is selected and this is a legal target, commit the move.
    if (this.selected) {
      const target = this.legalTargets.find((m) => m.to === id);
      if (target) {
        this._commitMove(this.selected, id, target);
        return;
      }
    }

    const piece = chess.get(id);
    if (piece && piece.color === chess.turn() && this.opts.canMove(id)) {
      this.selected = id;
      this.legalTargets = chess.moves({ square: id, verbose: true });
      this._updateHighlights();
    } else {
      this.clearSelection();
    }
  }

  _commitMove(from, to, sampleMove) {
    const needsPromotion = sampleMove.piece === "p" && (to[1] === "8" || to[1] === "1");
    this.clearSelection();
    if (!needsPromotion) {
      this.opts.onMove({ from, to, promotion: null });
      return;
    }
    this._showPromotionPicker(to, sampleMove.color, (piece) => {
      this.opts.onMove({ from, to, promotion: piece });
    });
  }

  _showPromotionPicker(square, color, callback) {
    const sqEl = this.squareEls.get(square);
    const boardRect = this.boardEl.getBoundingClientRect();
    const sqRect = sqEl.getBoundingClientRect();
    this.promoEl.innerHTML = "";
    ["q", "r", "b", "n"].forEach((p) => {
      const btn = document.createElement("button");
      btn.textContent = PIECE_GLYPH[color][p];
      btn.className = `piece ${color === "w" ? "white" : "black"}`;
      btn.setAttribute("aria-label", `Promote to ${PIECE_NAMES[p]}`);
      btn.addEventListener("click", () => {
        this._hidePromoPicker();
        callback(p);
        this.focusedSquare = square;
        this._applyRovingTabIndex();
        this.squareEls.get(square)?.focus();
      });
      this.promoEl.appendChild(btn);
    });
    this.promoEl.style.left = `${sqRect.left - boardRect.left - 10}px`;
    this.promoEl.style.top = `${sqRect.top - boardRect.top - 10}px`;
    this.promoEl.classList.remove("hidden");
    this.promoEl.querySelector("button")?.focus();
  }

  _hidePromoPicker() {
    if (this.promoEl.classList.contains("hidden")) return;
    this.promoEl.classList.add("hidden");
    this.promoEl.innerHTML = ""; // drop the buttons so their closures (and the pending move) can't fire later
  }
}
