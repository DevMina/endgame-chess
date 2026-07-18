// Peer-to-peer networking for online games, built on PeerJS.
// PeerJS's public cloud server is used only to broker the initial handshake
// (exchanging connection info) — once connected, moves travel directly
// between the two browsers over a WebRTC data channel.

export class OnlineGame {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'guest'
    this.roomId = null;
    this._closing = false; // true once close() is called deliberately, so a resulting
                            // conn "close" event doesn't get reported as a surprise disconnect
    this._listeners = {};
  }

  on(event, cb) {
    (this._listeners[event] ||= []).push(cb);
    return this;
  }

  _emit(event, payload) {
    (this._listeners[event] || []).forEach((cb) => cb(payload));
  }

  /** Host a new table. Resolves with the room id to embed in the shareable link. */
  host() {
    this.role = "host";
    return new Promise((resolve, reject) => {
      const attempt = () => {
        this.peer = new Peer(this._randomRoomId());
        this.peer.on("open", (id) => { this.roomId = id; resolve(id); });
        this.peer.on("error", (err) => {
          if (err.type === "unavailable-id") {
            // extremely unlikely collision — retry with a fresh id and
            // re-wire listeners onto the new Peer instance
            attempt();
          } else {
            reject(err);
            this._emit("error", err);
          }
        });
        this.peer.on("connection", (conn) => {
          this.conn = conn;
          this._wireConnection();
        });
        // This is the host's own connection to the PeerJS broker going down
        // (distinct from the opponent's data connection closing) — it means
        // no *new* incoming connection can be accepted until it's restored.
        this.peer.on("disconnected", () => this._emit("broker-disconnected"));
      };
      attempt();
    });
  }

  /** Join an existing table by room id. */
  join(roomId) {
    this.role = "guest";
    this.roomId = roomId;
    return new Promise((resolve, reject) => {
      this.peer = new Peer();
      this.peer.on("open", () => this._connectTo(roomId, resolve, reject));
      this.peer.on("error", (err) => {
        reject(err);
        this._emit("error", err);
      });
    });
  }

  /**
   * Re-establish a connection after an unexpected drop.
   * - Guest: redial the host at the stored room id.
   * - Host: the Peer stays alive and already listens for a fresh incoming
   *   connection (see host()'s "connection" handler) — the only thing that
   *   can actually be broken is its own link to the broker, which is what
   *   this restores so a reconnecting guest has somewhere to dial into.
   */
  reconnect() {
    if (this.role === "host") return this._reconnectBroker();

    if (!this.roomId) return Promise.reject(new Error("no table to reconnect to"));
    this._closing = false;
    return new Promise((resolve, reject) => {
      if (!this.peer || this.peer.destroyed) {
        this.peer = new Peer();
        this.peer.on("open", () => this._connectTo(this.roomId, resolve, reject));
        this.peer.on("error", (err) => {
          reject(err);
          this._emit("error", err);
        });
      } else {
        this._connectTo(this.roomId, resolve, reject);
      }
    });
  }

  _reconnectBroker() {
    return new Promise((resolve, reject) => {
      if (!this.peer || this.peer.destroyed) {
        reject(new Error("host peer was destroyed"));
        return;
      }
      if (!this.peer.disconnected) {
        resolve(); // broker link is fine; just waiting on the opponent
        return;
      }
      const cleanup = () => {
        this.peer.off("open", onOpen);
        this.peer.off("error", onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); this._emit("error", err); };
      this.peer.on("open", onOpen);
      this.peer.on("error", onError);
      this.peer.reconnect();
    });
  }

  _connectTo(roomId, resolve, reject) {
    // give up if nothing happens in a reasonable window (e.g. bad/expired room id)
    const timeoutId = setTimeout(() => {
      if (!this.conn || !this.conn.open) reject(new Error("timeout"));
    }, 15000);
    this.conn = this.peer.connect(roomId, { reliable: true });
    this._wireConnection();
    this.conn.on("open", () => {
      clearTimeout(timeoutId);
      resolve();
    });
  }

  _wireConnection() {
    this.conn.on("open", () => this._emit("connected"));
    this.conn.on("data", (msg) => this._emit("message", msg));
    this.conn.on("close", () => { if (!this._closing) this._emit("peer-disconnected"); });
    this.conn.on("error", (err) => this._emit("error", err));
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  close() {
    this._closing = true;
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
  }

  _randomRoomId() {
    // short, link-friendly room code
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return `endgame-${id}`;
  }
}

export function roomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("room");
}

export function buildInviteLink(roomId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}
