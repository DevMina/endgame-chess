// A small bundled set of tactics puzzles. No backend, so these ship with
// the app rather than being fetched — every FEN and every move in every
// solution was verified against chess.js itself before being added here
// (chess.js 1.x throws on an illegal move, so a typo'd solution would break
// the puzzle outright rather than just being "wrong").
//
// `solution` is a sequence of UCI moves (fromTo, plus a trailing promotion
// letter if needed) alternating solver / opponent-reply / solver / ...
// always ending on a move the *solver* plays.

export const PUZZLES = [
  {
    id: "p1",
    title: "Mate in 1",
    theme: "Back-rank mate",
    fen: "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1",
    solution: ["a1a8"],
  },
  {
    id: "p2",
    title: "Mate in 1",
    theme: "Queen and king",
    fen: "7k/8/6K1/8/8/8/8/7Q w - - 0 1",
    solution: ["h1h7"],
  },
  {
    id: "p3",
    title: "Mate in 1",
    theme: "The Scholar's Mate trap",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4",
    solution: ["h5f7"],
  },
  {
    id: "p4",
    title: "Win material",
    theme: "Knight fork",
    fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1",
    solution: ["b5c7", "e8d8", "c7a8"],
  },
  {
    id: "p5",
    title: "Mate in 2",
    theme: "Rook and king",
    fen: "6k1/8/6K1/8/8/8/8/R7 w - - 0 1",
    solution: ["a1f1", "g8h8", "f1f8"],
  },
  {
    id: "p6",
    title: "Win material",
    theme: "Pin and capture",
    fen: "4k3/8/8/8/2b5/8/4Q3/4K3 w - - 0 1",
    solution: ["e2c4"],
  },
];
