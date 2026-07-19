// Runs off the main thread so the board never freezes while the engine "thinks".
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Standard midgame piece-square tables (white's perspective, a8=index0 ... h1=index63)
const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10,
      5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5,
      5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40,
      -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
      -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
      -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10,
      -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
      -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
      -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10,
      -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5,
      -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
      20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};

// A handful of well-known opening lines, keyed by the SAN move history so
// far (space-separated). Just enough to keep the first few moves varied and
// sound, without pretending to be a real opening database.
const OPENING_BOOK = {
  "": ["e4", "d4", "c4", "Nf3"],
  "e4": ["e5", "c5", "e6", "c6", "d5"],
  "d4": ["d5", "Nf6", "e6", "g6"],
  "c4": ["e5", "Nf6", "c5"],
  "Nf3": ["Nf6", "d5", "c5"],
  "e4 e5": ["Nf3", "Bc4"],
  "e4 c5": ["Nf3", "Nc3"],
  "e4 e6": ["d4"],
  "e4 c6": ["d4"],
  "e4 d5": ["exd5"],
  "d4 d5": ["c4", "Nf3"],
  "d4 Nf6": ["c4", "Nf3"],
  "d4 g6": ["c4", "Nf3"],
  "e4 e5 Nf3": ["Nc6", "Nf6"],
  "e4 e5 Nf3 Nc6": ["Bb5", "Bc4"],
  "d4 d5 c4": ["e6", "c6", "dxc4"],
  "d4 Nf6 c4": ["e6", "g6"],
};

function pickBookMove(chess) {
  const key = chess.history().join(" ");
  const options = OPENING_BOOK[key];
  if (!options || !options.length) return null;
  const legal = chess.moves({ verbose: true });
  const candidates = options.map((san) => legal.find((m) => m.san === san)).filter(Boolean);
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function sq2idx(square, color) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;
  const rankIdx = color === "w" ? 7 - rank : rank;
  return rankIdx * 8 + file;
}

function evaluateBoard(chess) {
  const board = chess.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const val = PIECE_VALUES[p.type] + PST[p.type][sq2idx(p.square, p.color)];
      score += p.color === "w" ? val : -val;
    }
  }
  return score;
}

function orderMoves(moves, ttBestSan) {
  return moves.slice().sort((a, b) => {
    if (ttBestSan) {
      if (a.san === ttBestSan) return -1;
      if (b.san === ttBestSan) return 1;
    }
    const aScore = a.captured ? PIECE_VALUES[a.captured] * 10 - PIECE_VALUES[a.piece] : 0;
    const bScore = b.captured ? PIECE_VALUES[b.captured] * 10 - PIECE_VALUES[b.piece] : 0;
    return bScore - aScore;
  });
}

// Quiescence search: at a leaf, don't just take the static evaluation — keep
// resolving captures until the position is "quiet". This avoids the classic
// horizon effect where the search stops mid-exchange and thinks it's ahead
// a piece it's actually about to lose back. Depth-capped rather than
// time-capped since it's already narrow (captures only) and bounded.
const QUIESCENCE_MAX_DEPTH = 6;
function quiescence(chess, alpha, beta, maximizing, qdepth) {
  if (chess.isCheckmate()) return maximizing ? -100000 : 100000;
  if (chess.isDraw() || chess.isStalemate()) return 0;

  const standPat = evaluateBoard(chess);
  if (qdepth >= QUIESCENCE_MAX_DEPTH) return standPat;

  if (maximizing) {
    if (standPat >= beta) return beta;
    alpha = Math.max(alpha, standPat);
  } else {
    if (standPat <= alpha) return alpha;
    beta = Math.min(beta, standPat);
  }

  const captures = orderMoves(chess.moves({ verbose: true }).filter((m) => m.captured || m.flags.includes("e")));
  for (const m of captures) {
    chess.move(m.san);
    let score;
    try {
      score = quiescence(chess, alpha, beta, !maximizing, qdepth + 1);
    } finally {
      chess.undo();
    }
    if (maximizing) {
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    } else {
      beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
  }
  return maximizing ? alpha : beta;
}

// Thrown to unwind the search the instant the time budget runs out. Every
// chess.move() up the call stack is paired with a try/finally chess.undo(),
// so the exception can propagate freely without ever leaving the board in a
// half-moved state.
const TIME_UP = Symbol("time-up");

// Negamax-style alpha-beta with a transposition table, keyed on FEN. Table
// entries store the best move found so it can be tried first next time the
// same position is reached (from iterative deepening or a transposition).
function search(chess, depth, alpha, beta, maximizing, tt, deadline) {
  if (Date.now() > deadline) throw TIME_UP;

  const alphaOrig = alpha;
  const betaOrig = beta;
  const key = chess.fen();
  const entry = tt.get(key);
  if (entry && entry.depth >= depth) {
    if (entry.flag === 0) return entry.score; // exact
    if (entry.flag === 1) alpha = Math.max(alpha, entry.score); // lower bound
    else beta = Math.min(beta, entry.score); // upper bound
    if (alpha >= beta) return entry.score;
  }

  if (depth === 0 || chess.isGameOver()) {
    if (chess.isCheckmate()) return maximizing ? -100000 - depth : 100000 + depth;
    if (chess.isDraw() || chess.isStalemate()) return 0;
    return quiescence(chess, alpha, beta, maximizing, 0);
  }

  const moves = orderMoves(chess.moves({ verbose: true }), entry?.bestSan);
  let best = maximizing ? -Infinity : Infinity;
  let bestSan = null;

  for (const m of moves) {
    chess.move(m.san);
    let score;
    try {
      score = search(chess, depth - 1, alpha, beta, !maximizing, tt, deadline);
    } finally {
      chess.undo();
    }
    if (maximizing) {
      if (score > best) { best = score; bestSan = m.san; }
      alpha = Math.max(alpha, best);
    } else {
      if (score < best) { best = score; bestSan = m.san; }
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }

  const flag = best <= alphaOrig ? 2 : best >= betaOrig ? 1 : 0; // upper : lower : exact
  tt.set(key, { depth, score: best, flag, bestSan });
  return best;
}

const MAX_DEPTH_CAP = 10;

function getBestMove(fen, timeBudgetMs, addNoise) {
  const chess = new Chess(fen);
  const color = chess.turn();
  const maximizing = color === "w";

  const bookMove = pickBookMove(chess);
  if (bookMove) return bookMove;

  const tt = new Map();
  const deadline = Date.now() + timeBudgetMs;
  let moves = orderMoves(chess.moves({ verbose: true }));
  let bestDepthResults = null; // results from the last fully-completed depth

  let depth = 1;
  while (depth <= MAX_DEPTH_CAP) {
    let scored;
    try {
      scored = [];
      for (const m of moves) {
        chess.move(m.san);
        let ev;
        try {
          ev = search(chess, depth - 1, -Infinity, Infinity, !maximizing, tt, deadline);
        } finally {
          chess.undo();
        }
        scored.push({ m, ev });
      }
    } catch (e) {
      if (e === TIME_UP) break; // discard this partial depth; keep the last completed one
      throw e;
    }
    scored.sort((a, b) => (maximizing ? b.ev - a.ev : a.ev - b.ev));
    bestDepthResults = scored;
    moves = scored.map((s) => s.m); // best-first ordering speeds up the next, deeper pass
    if (Date.now() > deadline) break;
    depth++;
  }

  if (!bestDepthResults) {
    // Time ran out before even depth 1 finished (shouldn't normally happen) — fall back to the raw move order.
    return moves[0];
  }

  let pick = bestDepthResults[0];
  if (addNoise && bestDepthResults.length > 1) {
    // Easy/medium: pick randomly among moves within a small margin of the best,
    // so the engine feels human rather than robotically optimal.
    const margin = 60;
    const near = bestDepthResults.filter((s) => Math.abs(s.ev - bestDepthResults[0].ev) <= margin);
    pick = near[Math.floor(Math.random() * near.length)];
  }
  return pick.m;
}

self.onmessage = (e) => {
  const { fen, timeBudget, addNoise, requestId } = e.data;
  try {
    const move = getBestMove(fen, timeBudget, addNoise);
    self.postMessage({ requestId, ok: true, move: { from: move.from, to: move.to, promotion: move.promotion || null, san: move.san } });
  } catch (err) {
    self.postMessage({ requestId, ok: false, error: String(err) });
  }
};
