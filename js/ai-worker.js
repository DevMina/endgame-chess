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

function orderMoves(moves) {
  return moves.slice().sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
}

// Quiescence search: at a leaf, don't just take the static evaluation — keep
// resolving captures until the position is "quiet". This avoids the classic
// horizon effect where the search stops mid-exchange and thinks it's ahead
// a piece it's actually about to lose back.
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
    const score = quiescence(chess, alpha, beta, !maximizing, qdepth + 1);
    chess.undo();
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

function minimax(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.isGameOver()) {
    if (chess.isCheckmate()) return maximizing ? -100000 - depth : 100000 + depth;
    if (chess.isDraw() || chess.isStalemate()) return 0;
    return quiescence(chess, alpha, beta, maximizing, 0);
  }
  const moves = orderMoves(chess.moves({ verbose: true }));
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m.san);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false));
      chess.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      chess.move(m.san);
      best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true));
      chess.undo();
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function getBestMove(fen, depth, addNoise) {
  const chess = new Chess(fen);
  const color = chess.turn();
  const maximizing = color === "w";
  const moves = orderMoves(chess.moves({ verbose: true }));

  const scored = [];
  for (const m of moves) {
    chess.move(m.san);
    const ev = minimax(chess, depth - 1, -Infinity, Infinity, !maximizing);
    chess.undo();
    scored.push({ m, ev });
  }
  scored.sort((a, b) => (maximizing ? b.ev - a.ev : a.ev - b.ev));

  let pick = scored[0];
  if (addNoise && scored.length > 1) {
    // Easy/medium: pick randomly among moves within a small margin of the best,
    // so the engine feels human rather than robotically optimal.
    const margin = 60;
    const near = scored.filter((s) => Math.abs(s.ev - scored[0].ev) <= margin);
    pick = near[Math.floor(Math.random() * near.length)];
  }
  return pick.m;
}

self.onmessage = (e) => {
  const { fen, depth, addNoise, requestId } = e.data;
  try {
    const move = getBestMove(fen, depth, addNoise);
    self.postMessage({ requestId, ok: true, move: { from: move.from, to: move.to, promotion: move.promotion || null, san: move.san } });
  } catch (err) {
    self.postMessage({ requestId, ok: false, error: String(err) });
  }
};
