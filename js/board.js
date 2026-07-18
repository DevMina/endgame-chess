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

    this._buildGrid();
    this.boardEl.addEventListener("click", (e) => this._onSquareClick(e));
    this.boardEl.addEventListener("keydown", (e) => this._onKeyDown(e));
  }

  setOrientation(color) {
    this.orientation = color;
    this._buildGrid();
    this.render();
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
    const sqEl = e.target.closest(".sq");
    if (!sqEl) return;
    const id = sqEl.dataset.square;
    this.focusedSquare = id;
    this._applyRovingTabIndex();
    this._activateSquare(id);
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
