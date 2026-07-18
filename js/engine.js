// Thin wrapper around chess.js (rules engine, loaded from a CDN as an ES module).
// Keeping this in one place means the rest of the app never talks to chess.js directly.
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";

export function createGame(fen) {
  return fen ? new Chess(fen) : new Chess();
}

export const PIECE_GLYPH = {
  w: { p: "\u2659", n: "\u2658", b: "\u2657", r: "\u2656", q: "\u2655", k: "\u2654" },
  b: { p: "\u265F", n: "\u265E", b: "\u265D", r: "\u265C", q: "\u265B", k: "\u265A" },
};

export function squareId(file, rank) {
  // file 0-7 (a-h), rank 0-7 (1-8)
  return "abcdefgh"[file] + (rank + 1);
}

export function gameStatusText(chess) {
  if (chess.isCheckmate()) return { over: true, kind: "checkmate", winner: chess.turn() === "w" ? "b" : "w" };
  if (chess.isStalemate()) return { over: true, kind: "stalemate" };
  if (chess.isThreefoldRepetition()) return { over: true, kind: "repetition" };
  if (chess.isInsufficientMaterial()) return { over: true, kind: "insufficient" };
  if (chess.isDraw()) return { over: true, kind: "draw" };
  return { over: false };
}

export { Chess };
