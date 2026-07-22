// Lightweight sound effects, synthesized with the Web Audio API rather than
// shipped as audio files. That keeps this working fully offline the moment
// the service worker has cached the app shell — no extra assets to fetch,
// cache-bust, or version — and keeps the total download tiny.

let ctx = null;
function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Browsers start an AudioContext suspended until a user gesture; every
  // caller here already runs from a click/tap or a move that followed one,
  // so it's safe to just resume on each use rather than track state.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function tone({ freq, duration, type = "sine", gain = 0.15, delay = 0 }) {
  let audio;
  try {
    audio = getCtx();
  } catch (_) {
    return; // Web Audio unavailable — fail silently rather than break a move
  }
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const startAt = audio.currentTime + delay;
  g.gain.setValueAtTime(0, startAt);
  g.gain.linearRampToValueAtTime(gain, startAt + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(g);
  g.connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

let enabled = true;
try {
  enabled = localStorage.getItem("endgame_sound") !== "off";
} catch (_) { /* localStorage unavailable (private browsing, etc.) — default to on */ }

export function isSoundOn() {
  return enabled;
}

export function setSoundOn(on) {
  enabled = on;
  try { localStorage.setItem("endgame_sound", on ? "on" : "off"); } catch (_) { /* best-effort persistence only */ }
}

export function playMove() {
  if (!enabled) return;
  tone({ freq: 440, duration: 0.08, type: "triangle", gain: 0.12 });
}

export function playCapture() {
  if (!enabled) return;
  tone({ freq: 220, duration: 0.1, type: "square", gain: 0.1 });
  tone({ freq: 165, duration: 0.13, type: "square", gain: 0.09, delay: 0.035 });
}

export function playCheck() {
  if (!enabled) return;
  tone({ freq: 660, duration: 0.09, type: "sawtooth", gain: 0.11 });
  tone({ freq: 880, duration: 0.11, type: "sawtooth", gain: 0.11, delay: 0.09 });
}

export function playGameEnd() {
  if (!enabled) return;
  [523, 659, 784].forEach((freq, i) => tone({ freq, duration: 0.2, type: "sine", gain: 0.13, delay: i * 0.12 }));
}

export function playWrong() {
  if (!enabled) return;
  tone({ freq: 150, duration: 0.16, type: "square", gain: 0.1 });
}
