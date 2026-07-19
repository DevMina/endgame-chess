import { createGame, PIECE_GLYPH, gameStatusText } from "./engine.js";
import { BoardUI } from "./board.js";
import { OnlineGame, roomIdFromUrl, buildInviteLink } from "./network.js";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline support just won't be available this session — the app
      // still works fine online without it.
    });
  });

  // Every deploy ships a service worker with a new cache name (see sw.js).
  // As soon as that new worker takes control of this tab, reload once so
  // the fresh HTML/CSS/JS actually get used instead of sitting in the
  // background until the next manual refresh.
  let hasReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hasReloaded) return;
    hasReloaded = true;
    window.location.reload();
  });
}

/* ---------------------------------------------------------
   Small DOM helpers
--------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

const screens = {
  home: $("screen-home"),
  singleSetup: $("screen-single-setup"),
  onlineLobby: $("screen-online-lobby"),
  game: $("screen-game"),
};

function goTo(name) {
  Object.values(screens).forEach(hide);
  show(screens[name]);
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), ms);
}

/* ---------------------------------------------------------
   Saved-game persistence (single/local only — an online table is
   inherently ephemeral, since a fresh page load gets a fresh peer id)
--------------------------------------------------------- */
const SAVE_KEY = "endgame-save-v1";

function saveGame() {
  if (state.mode !== "single" && state.mode !== "local") return;
  if (state.gameOver) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      mode: state.mode,
      color: state.localColor,
      difficulty: state.difficulty,
      history: state.chess.history(),
    }));
  } catch (_) {
    // Storage unavailable (private browsing, quota, etc.) — resuming just won't be offered next time.
  }
}

function clearSavedGame() {
  try { localStorage.removeItem(SAVE_KEY); } catch (_) { /* nothing to do */ }
}

function loadSavedGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || (data.mode !== "single" && data.mode !== "local")) return null;
    if (!Array.isArray(data.history) || data.history.length === 0) return null; // nothing worth resuming
    return data;
  } catch (_) {
    return null;
  }
}

function describeSavedGame(data) {
  const moveNo = Math.ceil(data.history.length / 2);
  if (data.mode === "single") {
    const labels = { 1: "Easy", 2: "Medium", 3: "Hard" };
    return `Single Player \u2014 ${labels[data.difficulty]} \u00b7 you're ${data.color === "w" ? "White" : "Black"} \u00b7 move ${moveNo}`;
  }
  return `Two Player \u2014 Same Screen \u00b7 move ${moveNo}`;
}

function refreshResumeBanner() {
  const data = loadSavedGame();
  if (data) {
    $("resume-text").textContent = describeSavedGame(data);
    show($("resume-banner"));
  } else {
    hide($("resume-banner"));
  }
}

$("btn-resume").addEventListener("click", () => {
  const data = loadSavedGame();
  if (!data) { hide($("resume-banner")); return; }
  startGame({ mode: data.mode, color: data.color, difficulty: data.difficulty, resumeHistory: data.history });
});
$("btn-resume-discard").addEventListener("click", () => {
  clearSavedGame();
  hide($("resume-banner"));
});

/* ---------------------------------------------------------
   Application state
--------------------------------------------------------- */
const state = {
  mode: null, // 'single' | 'local' | 'online'
  chess: createGame(),
  localColor: "w", // which side the local player controls (online/single)
  difficulty: 2,
  aiThinking: false,
  online: null, // OnlineGame instance
  onlineConnected: false,
  gameOver: false, // true once checkmate/stalemate/draw/resign has ended the current game
  viewingPly: null, // null = showing the live position; otherwise an index into history() being browsed read-only
};

// Reconstructs the position after `ply` half-moves of the live game (0 = the
// starting position) without mutating state.chess, so browsing old moves in
// the move list never risks touching the real game.
function fenAtPly(ply) {
  const hist = state.chess.history();
  const temp = createGame();
  for (let i = 0; i < ply; i++) temp.move(hist[i]);
  return temp.fen();
}

function getDisplayGame() {
  return state.viewingPly === null ? state.chess : createGame(fenAtPly(state.viewingPly));
}

function viewPly(ply) {
  if (ply === state.chess.history().length) { returnToLive(); return; } // already the live position
  state.viewingPly = ply;
  boardUI.clearSelection();
  const verbose = state.chess.history({ verbose: true });
  const mv = verbose[ply - 1];
  boardUI.setLastMove(mv ? mv.from : null, mv ? mv.to : null);
  renderAll();
}

function returnToLive() {
  if (state.viewingPly === null) return;
  state.viewingPly = null;
  boardUI.clearSelection();
  const verbose = state.chess.history({ verbose: true });
  const last = verbose[verbose.length - 1];
  boardUI.setLastMove(last ? last.from : null, last ? last.to : null);
  renderAll();
}
$("btn-return-live").addEventListener("click", returnToLive);

const boardEl = $("board");
const promoEl = $("promo-picker");
const boardUI = new BoardUI(boardEl, promoEl, {
  getGame: () => getDisplayGame(),
  canMove: (square) => canLocalPlayerMove(),
  onMove: (mv) => attemptLocalMove(mv),
});

let aiWorker = null;
function getAiWorker() {
  if (!aiWorker) {
    aiWorker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
  }
  return aiWorker;
}

// Undo / New game / Rematch can all invalidate a move the engine is still
// computing. Terminating the worker (instead of just tracking a request id)
// guarantees a stale response can never be delivered and applied to a game
// state it wasn't computed for. A fresh worker is spun up lazily next time
// requestAiMove() needs one.
function cancelPendingAiMove() {
  if (aiWorker) {
    aiWorker.terminate();
    aiWorker = null;
  }
  state.aiThinking = false;
}

/* ---------------------------------------------------------
   Home screen
--------------------------------------------------------- */
$("mode-single").addEventListener("click", () => {
  resetSetupPills();
  goTo("singleSetup");
});
$("mode-local").addEventListener("click", () => startGame({ mode: "local" }));
$("mode-online").addEventListener("click", () => {
  goTo("onlineLobby");
  resetLobby();
});
document.querySelectorAll('[data-back="home"]').forEach((btn) =>
  btn.addEventListener("click", () => {
    if (state.online) { state.online.close(); state.online = null; }
    refreshResumeBanner();
    goTo("home");
  })
);

/* ---------------------------------------------------------
   Single player setup
--------------------------------------------------------- */
let setupColor = "w";
let setupDifficulty = 2;

function resetSetupPills() {
  setupColor = "w";
  setupDifficulty = 2;
  document.querySelectorAll("#single-color-row .pill").forEach((p) => p.classList.toggle("selected", p.dataset.color === "w"));
  document.querySelectorAll("#single-difficulty-row .pill").forEach((p) => p.classList.toggle("selected", p.dataset.difficulty === "2"));
}

document.querySelectorAll("#single-color-row .pill").forEach((p) =>
  p.addEventListener("click", () => {
    setupColor = p.dataset.color;
    document.querySelectorAll("#single-color-row .pill").forEach((x) => x.classList.toggle("selected", x === p));
  })
);
document.querySelectorAll("#single-difficulty-row .pill").forEach((p) =>
  p.addEventListener("click", () => {
    setupDifficulty = parseInt(p.dataset.difficulty, 10);
    document.querySelectorAll("#single-difficulty-row .pill").forEach((x) => x.classList.toggle("selected", x === p));
  })
);

$("single-start").addEventListener("click", () => {
  const color = setupColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : setupColor;
  startGame({ mode: "single", color, difficulty: setupDifficulty });
});

/* ---------------------------------------------------------
   Online lobby
--------------------------------------------------------- */
function resetLobby() {
  hide($("lobby-hosting"));
  hide($("lobby-joining"));
  show($("lobby-choice"));
  $("lobby-link-input").value = "";
  hide($("lobby-link-box"));
  $("lobby-join-input").value = "";
  $("lobby-join-status").textContent = "";
}

$("lobby-host-btn").addEventListener("click", async () => {
  hide($("lobby-choice"));
  show($("lobby-hosting"));
  $("lobby-host-status").textContent = "Opening a table\u2026";
  const online = new OnlineGame();
  state.online = online;
  try {
    const roomId = await online.host();
    const link = buildInviteLink(roomId);
    $("lobby-host-status").textContent = "Table open. Waiting for your opponent to join\u2026";
    $("lobby-link-input").value = link;
    show($("lobby-link-box"));
    online.on("connected", () => {
      startGame({ mode: "online", color: "w", online });
    });
    online.on("error", () => toast("Connection trouble \u2014 try hosting again."));
  } catch (err) {
    $("lobby-host-status").textContent = "Couldn't open a table. Check your connection and try again.";
  }
});

$("lobby-join-btn").addEventListener("click", () => {
  hide($("lobby-choice"));
  show($("lobby-joining"));
});

$("lobby-join-submit").addEventListener("click", () => doJoin($("lobby-join-input").value.trim()));
$("lobby-join-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doJoin($("lobby-join-input").value.trim());
});

async function doJoin(raw) {
  if (!raw) return;
  let roomId = raw;
  try {
    if (raw.includes("://")) {
      const u = new URL(raw);
      roomId = u.searchParams.get("room") || raw;
    }
  } catch (_) { /* not a URL, treat as raw room id */ }

  $("lobby-join-status").textContent = "Connecting\u2026";
  const online = new OnlineGame();
  state.online = online;
  online.on("error", () => { $("lobby-join-status").textContent = "Couldn't reach that table. Check the link and try again."; });
  online.on("connected", () => {
    startGame({ mode: "online", color: "b", online });
  });
  try {
    await online.join(roomId);
  } catch (err) {
    $("lobby-join-status").textContent = "Couldn't reach that table. Check the link and try again.";
  }
}

$("lobby-copy-btn").addEventListener("click", async () => {
  const input = $("lobby-link-input");
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    toast("Link copied");
  } catch (_) {
    document.execCommand("copy");
    toast("Link copied");
  }
});

// Auto-detect an invite link on load
(function checkIncomingInvite() {
  const room = roomIdFromUrl();
  if (room) {
    goTo("onlineLobby");
    hide($("lobby-choice"));
    show($("lobby-joining"));
    hide($("lobby-join-input-box"));
    $("lobby-join-status").textContent = `Joining table ${room}\u2026`;
    doJoin(room);
  }
})();

refreshResumeBanner();

/* ---------------------------------------------------------
   Starting / resetting a game
--------------------------------------------------------- */
function startGame({ mode, color = "w", difficulty = 2, online = null, resumeHistory = null }) {
  cancelPendingAiMove();
  state.mode = mode;
  state.chess = createGame();
  if (resumeHistory) {
    for (const san of resumeHistory) state.chess.move(san);
  }
  state.localColor = color;
  state.difficulty = difficulty;
  state.aiThinking = false;
  state.gameOver = false;
  state.viewingPly = null;
  state.online = online;
  state.onlineConnected = mode === "online";

  boardUI.setOrientation(mode === "online" ? color : "w");
  if (resumeHistory && resumeHistory.length) {
    const verbose = state.chess.history({ verbose: true });
    const last = verbose[verbose.length - 1];
    boardUI.setLastMove(last.from, last.to);
  } else {
    boardUI.setLastMove(null, null);
  }
  boardUI.clearSelection();

  const modeTag = $("game-mode-tag");
  const chatSection = $("chat-section");
  const threadEl = $("thread-indicator");
  const undoBtn = $("btn-undo");
  const newGameBtn = $("btn-newgame");
  const drawOfferBtn = $("btn-draw-offer");

  stopReconnectUI();
  hideDrawOfferBanner();
  drawOfferBtn.disabled = false;

  if (mode === "single") {
    const labels = { 1: "Easy", 2: "Medium", 3: "Hard" };
    modeTag.textContent = `Single Player \u2014 ${labels[difficulty]} \u00b7 you're ${color === "w" ? "White" : "Black"}`;
    hide(chatSection);
    threadEl.hidden = true;
    show(undoBtn);
    show(newGameBtn);
    hide(drawOfferBtn);
  } else if (mode === "local") {
    modeTag.textContent = "Two Player \u2014 Same Screen";
    hide(chatSection);
    threadEl.hidden = true;
    show(undoBtn);
    show(newGameBtn);
    hide(drawOfferBtn);
  } else if (mode === "online") {
    modeTag.textContent = `Online \u2014 you're ${color === "w" ? "White" : "Black"}`;
    show(chatSection);
    threadEl.hidden = false;
    threadEl.classList.remove("waiting");
    threadEl.classList.add("connected");
    hide(undoBtn); // undo would desync the peer
    hide(newGameBtn); // use "Play again" from the game-over overlay instead
    show(drawOfferBtn);
    $("chat-log").innerHTML = "";
    wireOnlineMessages(online);
  }

  renderAll();
  goTo("game");
  saveGame(); // persist the fresh or resumed position as the new baseline

  if (mode === "single" && state.localColor !== state.chess.turn()) {
    requestAiMove();
  }
}

function wireOnlineMessages(online) {
  online.on("message", (msg) => {
    if (msg.type === "move") {
      if (state.gameOver) return; // ignore a move that arrives after this game already ended
      const mv = state.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
      if (mv) {
        state.viewingPly = null;
        boardUI.setLastMove(mv.from, mv.to);
        renderAll();
        checkGameOver();
      }
    } else if (msg.type === "resign") {
      if (state.gameOver) return;
      showGameOver({ eyebrow: "Resignation", title: `${state.localColor === "w" ? "White" : "Black"} wins`, detail: "Your opponent resigned." });
    } else if (msg.type === "chat") {
      appendChat("Opponent", msg.text);
    } else if (msg.type === "draw-offer") {
      if (state.gameOver) return;
      show($("draw-offer-banner"));
    } else if (msg.type === "draw-accept") {
      hideDrawOfferBanner();
      showGameOver({ eyebrow: "Draw", title: "Draw agreed", detail: "" });
    } else if (msg.type === "draw-decline") {
      $("btn-draw-offer").disabled = false;
      toast("Your opponent declined the draw");
    } else if (msg.type === "sync") {
      // Arrives after a reconnect. Adopt the opponent's history only if it's
      // strictly ahead of ours and shares our moves as a prefix — i.e. they
      // made move(s) we missed while disconnected. If ours is already equal
      // or longer, we have nothing to catch up on (they'll adopt ours instead).
      const localHist = state.chess.history();
      const incoming = msg.history || [];
      const prefixMatches = localHist.every((san, i) => san === incoming[i]);
      if (incoming.length > localHist.length && prefixMatches) {
        const fresh = createGame();
        for (const san of incoming) fresh.move(san);
        state.chess = fresh;
        state.viewingPly = null;
        const verbose = state.chess.history({ verbose: true });
        const last = verbose[verbose.length - 1];
        boardUI.setLastMove(last ? last.from : null, last ? last.to : null);
        renderAll();
        checkGameOver();
        toast("Caught up on moves you missed");
      }
    } else if (msg.type === "rematch") {
      cancelPendingAiMove();
      state.chess = createGame();
      state.gameOver = false;
      state.viewingPly = null;
      hideDrawOfferBanner();
      $("btn-draw-offer").disabled = false;
      boardUI.setLastMove(null, null);
      boardUI.clearSelection();
      renderAll();
      hide($("overlay-gameover"));
      toast("Opponent started a rematch");
    }
  });
  online.on("connected", () => {
    // Fires again here (beyond the initial lobby handshake) whenever a
    // dropped connection is re-established.
    if (state.mode !== "online") return;
    const wasReconnecting = !state.onlineConnected;
    state.onlineConnected = true;
    const threadEl = $("thread-indicator");
    threadEl.classList.remove("waiting");
    threadEl.classList.add("connected");
    if (wasReconnecting) {
      stopReconnectUI();
      toast("Reconnected");
      online.send({ type: "sync", history: state.chess.history() });
      renderAll();
    }
  });
  online.on("peer-disconnected", () => {
    state.onlineConnected = false;
    const threadEl = $("thread-indicator");
    threadEl.classList.remove("connected");
    threadEl.classList.add("waiting");
    if (state.gameOver) return;
    if (online.role === "guest") {
      toast("Connection lost \u2014 reconnecting\u2026");
      startReconnectAttempts(online);
    } else {
      toast("Opponent disconnected");
      $("reconnect-text").textContent = "Opponent disconnected. Waiting for them to reconnect\u2026";
      hide($("btn-reconnect-retry"));
      show($("reconnect-banner"));
    }
  });
  online.on("broker-disconnected", () => {
    // Host-only: its own link to the matchmaking server dropped, so a
    // reconnecting guest would have nowhere to dial into until this is fixed.
    if (state.gameOver) return;
    toast("Lost connection to the matchmaking server \u2014 reconnecting\u2026");
    reconnectHostBroker(online);
  });
}

/* ---------------------------------------------------------
   Reconnection (guest side auto-retries; host just waits,
   since its Peer stays open and listening for a new connection)
--------------------------------------------------------- */
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 4;

function stopReconnectUI() {
  hide($("reconnect-banner"));
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
}

function startReconnectAttempts(online) {
  reconnectAttempts = 0;
  attemptReconnect(online);
}

function attemptReconnect(online) {
  reconnectAttempts++;
  $("reconnect-text").textContent = `Connection lost. Reconnecting\u2026 (attempt ${reconnectAttempts})`;
  hide($("btn-reconnect-retry"));
  show($("reconnect-banner"));
  online.reconnect().catch(() => {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectTimer = setTimeout(() => attemptReconnect(online), 2000);
    } else {
      $("reconnect-text").textContent = "Couldn't reconnect. Your opponent may have left.";
      show($("btn-reconnect-retry"));
    }
  });
}

function reconnectHostBroker(online) {
  $("reconnect-text").textContent = "Reconnecting to the network\u2026";
  hide($("btn-reconnect-retry"));
  show($("reconnect-banner"));
  online.reconnect().then(() => {
    $("reconnect-text").textContent = "Back online. Waiting for your opponent to rejoin\u2026";
  }).catch(() => {
    $("reconnect-text").textContent = "Couldn't reconnect to the network.";
    show($("btn-reconnect-retry"));
  });
}

$("btn-reconnect-retry").addEventListener("click", () => {
  if (!state.online) return;
  if (state.online.role === "guest") attemptReconnect(state.online);
  else reconnectHostBroker(state.online);
});

/* ---------------------------------------------------------
   Draw offers (online only)
--------------------------------------------------------- */
function hideDrawOfferBanner() {
  hide($("draw-offer-banner"));
}

$("btn-draw-offer").addEventListener("click", () => {
  if (state.mode !== "online" || state.gameOver || !state.onlineConnected) return;
  state.online.send({ type: "draw-offer" });
  $("btn-draw-offer").disabled = true;
  toast("Draw offered \u2014 waiting for a response");
});

$("draw-accept-btn").addEventListener("click", () => {
  hideDrawOfferBanner();
  if (state.online) state.online.send({ type: "draw-accept" });
  showGameOver({ eyebrow: "Draw", title: "Draw agreed", detail: "" });
});

$("draw-decline-btn").addEventListener("click", () => {
  hideDrawOfferBanner();
  if (state.online) state.online.send({ type: "draw-decline" });
});

/* ---------------------------------------------------------
   Move handling
--------------------------------------------------------- */
function canLocalPlayerMove() {
  if (state.viewingPly !== null) return false;
  if (state.gameOver) return false;
  if (state.aiThinking) return false;
  if (state.mode === "single") return state.chess.turn() === state.localColor;
  if (state.mode === "online") return state.onlineConnected && state.chess.turn() === state.localColor;
  return true; // local pass-and-play: whoever's turn it is may move
}

function attemptLocalMove({ from, to, promotion }) {
  const mv = state.chess.move({ from, to, promotion: promotion || undefined });
  if (!mv) return;
  state.viewingPly = null;
  boardUI.setLastMove(mv.from, mv.to);
  renderAll();

  if (state.mode === "online") {
    state.online.send({ type: "move", from: mv.from, to: mv.to, promotion: promotion || null });
  }

  if (checkGameOver()) return;
  saveGame();

  if (state.mode === "single" && state.chess.turn() !== state.localColor) {
    requestAiMove();
  }
}

function requestAiMove() {
  state.aiThinking = true;
  $("turn-banner").textContent = "The engine is thinking\u2026";
  const worker = getAiWorker();
  const requestId = Math.random().toString(36).slice(2);
  const timeBudgetByDifficulty = { 1: 250, 2: 700, 3: 1800 }; // ms, iterative deepening runs until this budget is spent
  const noiseByDifficulty = { 1: true, 2: true, 3: false };

  const handler = (e) => {
    if (e.data.requestId !== requestId) return;
    worker.removeEventListener("message", handler);
    state.aiThinking = false;
    if (!e.data.ok || !e.data.move) { renderAll(); return; }
    const mv = state.chess.move({ from: e.data.move.from, to: e.data.move.to, promotion: e.data.move.promotion || undefined });
    state.viewingPly = null;
    if (mv) boardUI.setLastMove(mv.from, mv.to);
    renderAll();
    if (!checkGameOver()) saveGame();
  };
  worker.addEventListener("message", handler);
  worker.postMessage({
    fen: state.chess.fen(),
    timeBudget: timeBudgetByDifficulty[state.difficulty],
    addNoise: noiseByDifficulty[state.difficulty],
    requestId,
  });
}

function checkGameOver() {
  const status = gameStatusText(state.chess);
  if (!status.over) return false;
  const messages = {
    checkmate: () => ({
      eyebrow: "Checkmate",
      title: `${status.winner === "w" ? "White" : "Black"} wins`,
      detail: state.mode === "single"
        ? (status.winner === state.localColor ? "You found the mating net." : "The engine gets this one.")
        : "",
    }),
    stalemate: () => ({ eyebrow: "Draw", title: "Stalemate", detail: "No legal moves, but no king in check either." }),
    repetition: () => ({ eyebrow: "Draw", title: "Threefold repetition", detail: "The same position has occurred three times." }),
    insufficient: () => ({ eyebrow: "Draw", title: "Insufficient material", detail: "Neither side has enough left to force mate." }),
    draw: () => ({ eyebrow: "Draw", title: "Draw", detail: "" }),
  };
  const m = (messages[status.kind] || (() => ({ eyebrow: "Game over", title: "", detail: "" })))();
  showGameOver(m);
  return true;
}

function showGameOver({ eyebrow, title, detail }) {
  state.gameOver = true;
  stopReconnectUI();
  hideDrawOfferBanner();
  clearSavedGame();
  $("gameover-eyebrow").textContent = eyebrow;
  $("gameover-title").textContent = title;
  $("gameover-detail").textContent = detail;
  show($("overlay-gameover"));
}

$("gameover-rematch").addEventListener("click", () => {
  hide($("overlay-gameover"));
  if (state.mode === "single") {
    startGame({ mode: "single", color: state.localColor, difficulty: state.difficulty });
  } else if (state.mode === "local") {
    startGame({ mode: "local" });
  } else if (state.mode === "online") {
    cancelPendingAiMove();
    state.chess = createGame();
    state.gameOver = false;
    state.viewingPly = null;
    hideDrawOfferBanner();
    $("btn-draw-offer").disabled = false;
    boardUI.setLastMove(null, null);
    boardUI.clearSelection();
    renderAll();
    state.online.send({ type: "rematch" });
    toast("Rematch started");
  }
});
$("gameover-home").addEventListener("click", () => {
  hide($("overlay-gameover"));
  stopReconnectUI();
  if (state.online) { state.online.close(); state.online = null; }
  refreshResumeBanner();
  goTo("home");
});

/* ---------------------------------------------------------
   Board controls
--------------------------------------------------------- */
$("btn-undo").addEventListener("click", () => {
  cancelPendingAiMove();
  state.viewingPly = null;
  if (state.mode === "single") {
    state.chess.undo();
    if (state.chess.history().length && state.chess.turn() !== state.localColor) state.chess.undo();
  } else {
    state.chess.undo();
  }
  boardUI.setLastMove(null, null);
  boardUI.clearSelection();
  renderAll();
  saveGame();
});
$("btn-flip").addEventListener("click", () => boardUI.flip());
$("btn-copy-pgn").addEventListener("click", async () => {
  const pgn = state.chess.pgn();
  if (!pgn) { toast("No moves yet"); return; }
  try {
    await navigator.clipboard.writeText(pgn);
    toast("PGN copied");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = pgn;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("PGN copied");
  }
});
$("btn-newgame").addEventListener("click", () => {
  if (state.mode === "single") startGame({ mode: "single", color: state.localColor, difficulty: state.difficulty });
  else startGame({ mode: "local" });
});
$("btn-resign").addEventListener("click", () => {
  if (state.gameOver) return;
  if (state.mode === "online") {
    state.online.send({ type: "resign" });
    showGameOver({ eyebrow: "Resignation", title: `${state.localColor === "w" ? "Black" : "White"} wins`, detail: "You resigned." });
  } else if (state.mode === "single") {
    showGameOver({ eyebrow: "Resignation", title: `${state.localColor === "w" ? "Black" : "White"} wins`, detail: "You resigned." });
  } else {
    const mover = state.chess.turn() === "w" ? "White" : "Black";
    const winner = state.chess.turn() === "w" ? "Black" : "White";
    showGameOver({ eyebrow: "Resignation", title: `${winner} wins`, detail: `${mover} resigned.` });
  }
});
$("game-quit").addEventListener("click", () => {
  stopReconnectUI();
  if (state.online) { state.online.close(); state.online = null; }
  hide($("overlay-gameover"));
  refreshResumeBanner();
  goTo("home");
});

/* ---------------------------------------------------------
   Chat
--------------------------------------------------------- */
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !state.online) return;
  appendChat("You", text);
  state.online.send({ type: "chat", text });
  input.value = "";
});

function appendChat(who, text) {
  const log = $("chat-log");
  const line = document.createElement("div");
  line.className = "chat-line";
  const whoSpan = document.createElement("span");
  whoSpan.className = "who";
  whoSpan.textContent = who + ":";
  line.appendChild(whoSpan);
  line.appendChild(document.createTextNode(text));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/* ---------------------------------------------------------
   Rendering
--------------------------------------------------------- */
function renderAll() {
  boardUI.render();
  renderTurnBanner();
  renderCaptures();
  renderMoveList();
  $("board-wrap").classList.toggle("viewing", state.viewingPly !== null);
}

function renderTurnBanner() {
  const el = $("turn-banner");
  const viewingBanner = $("viewing-banner");

  if (state.viewingPly !== null) {
    show(viewingBanner);
    el.textContent = state.viewingPly === 0 ? "Starting position" : `After move ${Math.ceil(state.viewingPly / 2)}${state.viewingPly % 2 === 1 ? " (White)" : " (Black)"}`;
    el.classList.remove("in-check");
    return;
  }
  hide(viewingBanner);

  if (state.aiThinking) { el.textContent = "The engine is thinking\u2026"; el.classList.remove("in-check"); return; }
  if (state.mode === "online" && !state.onlineConnected) { el.textContent = "Waiting for opponent\u2026"; el.classList.remove("in-check"); return; }

  const chess = state.chess;
  const turnName = chess.turn() === "w" ? "White" : "Black";
  const inCheck = chess.isCheck && chess.isCheck();
  el.textContent = inCheck ? `${turnName} is in check` : `${turnName} to move`;
  el.classList.toggle("in-check", !!inCheck);
}

function renderCaptures() {
  const hist = state.chess.history({ verbose: true });
  let byWhite = "", byBlack = "";
  hist.forEach((m) => {
    if (!m.captured) return;
    const capturedColor = m.color === "w" ? "b" : "w";
    const glyph = PIECE_GLYPH[capturedColor][m.captured];
    if (m.color === "w") byWhite += glyph; else byBlack += glyph;
  });
  $("captures-white").textContent = byWhite ? `White took: ${byWhite}` : "";
  $("captures-black").textContent = byBlack ? `Black took: ${byBlack}` : "";
}

function renderMoveList() {
  const hist = state.chess.history();
  const list = $("move-list");
  list.innerHTML = "";
  const highlightPly = state.viewingPly !== null ? state.viewingPly : hist.length;
  const highlightClass = state.viewingPly !== null ? "mv-viewing" : "mv-current";

  for (let i = 0; i < hist.length; i += 2) {
    const num = document.createElement("li");
    num.className = "mv-num";
    num.textContent = `${i / 2 + 1}.`;

    const white = document.createElement("li");
    white.className = "mv-white";
    if (hist[i]) {
      white.textContent = hist[i];
      white.classList.add("mv-clickable");
      white.tabIndex = 0;
      white.setAttribute("role", "button");
      const ply = i + 1;
      white.addEventListener("click", () => viewPly(ply));
      white.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); viewPly(ply); } });
      if (ply === highlightPly) white.classList.add(highlightClass);
    }

    const black = document.createElement("li");
    black.className = "mv-black";
    if (hist[i + 1]) {
      black.textContent = hist[i + 1];
      black.classList.add("mv-clickable");
      black.tabIndex = 0;
      black.setAttribute("role", "button");
      const ply = i + 2;
      black.addEventListener("click", () => viewPly(ply));
      black.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); viewPly(ply); } });
      if (ply === highlightPly) black.classList.add(highlightClass);
    }

    list.append(num, white, black);
  }
  if (state.viewingPly === null) list.scrollTop = list.scrollHeight;
}
