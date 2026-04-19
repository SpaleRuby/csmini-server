import http from "node:http";
  import { Server } from "socket.io";

  const PORT = Number(process.env.PORT || 3000);
  const DEFAULT_ROOM_ID = process.env.DEFAULT_ROOM_ID || "global_lobby";
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

  const rooms = new Map();

  function getRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    return rooms.get(roomId);
  }

  function serializePeers(room, exceptSocketId = null) {
    return [...room.values()]
      .filter((peer) => peer.socketId !== exceptSocketId)
      .map((peer) => ({
        peerId: peer.socketId,
        joinedAt: peer.joinedAt,
      }));
  }

  function leaveCurrentRoom(io, socket) {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    room.delete(socket.id);
    socket.to(roomId).emit("peer-left", {
      peerId: socket.id,
      roomId,
    });
    socket.leave(roomId);
    socket.data.roomId = null;

    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit("room-state", {
        roomId,
        peers: serializePeers(room),
      });
    }
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({
        ok: true,
        rooms: [...rooms.entries()].map(([roomId, room]) => ({
          roomId,
          peers: serializePeers(room),
        })),
      });

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
    });
    res.end("CS Mini P2P signaling server");
  });

  const io = new Server(httpServer, {
    cors: {
      origin: CORS_ORIGIN,
      methods: ["GET", "POST"],
    },
    pingInterval: 25000,
    pingTimeout: 10000,
  });

  io.on("connection", (socket) => {
    socket.emit("connected", {
      peerId: socket.id,
      defaultRoomId: DEFAULT_ROOM_ID,
    });

    socket.on("join-room", ({ roomId = DEFAULT_ROOM_ID } = {}, ack) => {
      leaveCurrentRoom(io, socket);

      const room = getRoom(roomId);
      socket.join(roomId);
      socket.data.roomId = roomId;

      room.set(socket.id, {
        socketId: socket.id,
        joinedAt: Date.now(),
      });

      const payload = {
        roomId,
        selfPeerId: socket.id,
        peers: serializePeers(room, socket.id),
      };

      if (typeof ack === "function") {
        ack(payload);
      } else {
        socket.emit("room-joined", payload);
      }

      socket.to(roomId).emit("peer-joined", {
        roomId,
        peerId: socket.id,
        joinedAt: room.get(socket.id).joinedAt,
      });
    });

    socket.on("signal", ({ to, description, candidate } = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId || !to) {
        return;
      }

      const room = rooms.get(roomId);
      if (!room?.has(to)) {
        return;
      }

      io.to(to).emit("signal", {
        from: socket.id,
        roomId,
        description,
        candidate,
      });
    });

    socket.on("leave-room", () => {
      leaveCurrentRoom(io, socket);
    });

    socket.on("disconnect", () => {
      leaveCurrentRoom(io, socket);
    });
  });

  httpServer.listen(PORT, () => {
    console.log(`[signaling] listening on :${PORT}`);
    console.log(`[signaling] default room: ${DEFAULT_ROOM_ID}`);
  });

  client/src/network/P2PNetworkManager.js

  const DEFAULT_ROOM_ID = "global_lobby";
  const DEFAULT_SIGNALING_URL = "http://localhost:3000";

  const DEFAULT_RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  export const P2PEvents = Object.freeze({
    CONNECTED: "connected",
    DISCONNECTED: "disconnected",
    PEER_JOINED: "peer-joined",
    PEER_LEFT: "peer-left",
    PEER_CONNECTED: "peer-connected",
    PEER_DISCONNECTED: "peer-disconnected",
    PLAYER_STATE: "player-state",
    SHOOT: "shoot",
    MESSAGE: "message",
    ERROR: "error",
  });

  function nowMs() {
    return performance.now();
  }

  export class P2PNetworkManager extends EventTarget {
    constructor(options = {}) {
      super();

      this.signalingUrl = options.signalingUrl || DEFAULT_SIGNALING_URL;
      this.roomId = options.roomId || DEFAULT_ROOM_ID;
      this.rtcConfig = options.rtcConfig || DEFAULT_RTC_CONFIG;
      this.ioFactory = options.ioFactory || globalThis.io;

      this.socket = null;
      this.selfPeerId = null;
      this.peers = new Map();
      this.connections = new Map();
      this.channels = new Map();
      this.pendingCandidates = new Map();
      this.connected = false;
    }

    on(type, handler) {
      this.addEventListener(type, handler);
      return () => this.removeEventListener(type, handler);
    }

    emit(type, detail = {}) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    async connect() {
      if (!this.ioFactory) {
        throw new Error(
          "Socket.IO client is missing. Load /socket.io/socket.io.js or bundle socket.io-client."
        );
      }

      this.socket = this.ioFactory(this.signalingUrl, {
        transports: ["websocket", "polling"],
        reconnection: true,
      });

      this.bindSocket();

      await new Promise((resolve, reject) => {
        this.socket.once("connect", resolve);
        this.socket.once("connect_error", reject);
      });

      const joined = await this.joinRoom(this.roomId);
      this.selfPeerId = joined.selfPeerId;
      this.connected = true;

      for (const peer of joined.peers) {
        this.peers.set(peer.peerId, peer);
        await this.createPeerConnection(peer.peerId, {
          polite: false,
          createOffer: true,
        });
      }

      this.emit(P2PEvents.CONNECTED, {
        peerId: this.selfPeerId,
        roomId: this.roomId,
        peers: joined.peers,
      });
    }

    joinRoom(roomId) {
      return new Promise((resolve) => {
        this.socket.emit("join-room", { roomId }, resolve);
      });
    }

    bindSocket() {
      this.socket.on("peer-joined", async ({ peerId, joinedAt }) => {
        if (!peerId || peerId === this.selfPeerId) {
          return;
        }

        this.peers.set(peerId, { peerId, joinedAt });
        this.emit(P2PEvents.PEER_JOINED, { peerId, joinedAt });

        await this.createPeerConnection(peerId, {
          polite: true,
          createOffer: false,
        });
      });

      this.socket.on("peer-left", ({ peerId }) => {
        this.closePeer(peerId);
        this.peers.delete(peerId);
        this.emit(P2PEvents.PEER_LEFT, { peerId });
      });

      this.socket.on("signal", async ({ from, description, candidate }) => {
        try {
          await this.handleSignal(from, { description, candidate });
        } catch (error) {
          this.emit(P2PEvents.ERROR, {
            error,
            message: error.message,
            peerId: from,
            stage: "signal",
          });
        }
      });

      this.socket.on("disconnect", (reason) => {
        this.connected = false;
        this.emit(P2PEvents.DISCONNECTED, { reason });
      });
    }

    async createPeerConnection(peerId, { polite, createOffer }) {
      if (this.connections.has(peerId)) {
        return this.connections.get(peerId);
      }

      const pc = new RTCPeerConnection(this.rtcConfig);

      pc.__polite = polite;
      pc.__makingOffer = false;

      this.connections.set(peerId, pc);

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          return;
        }

        this.socket.emit("signal", {
          to: peerId,
          candidate,
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          this.emit(P2PEvents.PEER_CONNECTED, { peerId });
        }

        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          this.emit(P2PEvents.PEER_DISCONNECTED, {
            peerId,
            state: pc.connectionState,
          });
        }
      };

      pc.ondatachannel = ({ channel }) => {
        this.registerDataChannel(peerId, channel);
      };

      if (createOffer) {
        const channel = pc.createDataChannel("game", {
          ordered: false,
          maxRetransmits: 0,
        });

        this.registerDataChannel(peerId, channel);

        pc.__makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        pc.__makingOffer = false;

        this.socket.emit("signal", {
          to: peerId,
          description: pc.localDescription,
        });
      }

      return pc;
    }

    registerDataChannel(peerId, channel) {
      this.channels.set(peerId, channel);

      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        this.emit(P2PEvents.PEER_CONNECTED, {
          peerId,
          channel,
        });
      };

      channel.onclose = () => {
        if (this.channels.get(peerId) === channel) {
          this.channels.delete(peerId);
        }

        this.emit(P2PEvents.PEER_DISCONNECTED, {
          peerId,
        });
      };

      channel.onerror = (event) => {
        this.emit(P2PEvents.ERROR, {
          peerId,
          event,
          stage: "datachannel",
        });
      };

      channel.onmessage = (event) => {
        this.handlePeerMessage(peerId, event.data);
      };
    }

    async handleSignal(peerId, { description, candidate }) {
      const pc =
        this.connections.get(peerId) ||
        (await this.createPeerConnection(peerId, {
          polite: true,
          createOffer: false,
        }));

      if (description) {
        const offerCollision =
          description.type === "offer" &&
          (pc.__makingOffer || pc.signalingState !== "stable");

        if (offerCollision && !pc.__polite) {
          return;
        }

        await pc.setRemoteDescription(description);
        await this.flushPendingCandidates(peerId, pc);

        if (description.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());

          this.socket.emit("signal", {
            to: peerId,
            description: pc.localDescription,
          });
        }

        return;
      }

      if (candidate) {
        if (!pc.remoteDescription) {
          if (!this.pendingCandidates.has(peerId)) {
            this.pendingCandidates.set(peerId, []);
          }

          this.pendingCandidates.get(peerId).push(candidate);
          return;
        }

        await pc.addIceCandidate(candidate);
      }
    }

    async flushPendingCandidates(peerId, pc) {
      const candidates = this.pendingCandidates.get(peerId) || [];
      this.pendingCandidates.delete(peerId);

      for (const candidate of candidates) {
        await pc.addIceCandidate(candidate);
      }
    }

    handlePeerMessage(peerId, rawData) {
      let message = null;

      try {
        message = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      } catch (error) {
        this.emit(P2PEvents.ERROR, {
          peerId,
          error,
          message: "Failed to parse peer message.",
        });
        return;
      }

      if (!message || typeof message !== "object") {
        return;
      }

      switch (message.type) {
        case "PLAYER_STATE":
          this.emit(P2PEvents.PLAYER_STATE, {
            peerId,
            state: message.payload,
            sentAt: message.sentAt,
            receivedAt: nowMs(),
          });
          break;

        case "SHOOT":
          this.emit(P2PEvents.SHOOT, {
            peerId,
            event: message.payload,
            sentAt: message.sentAt,
            receivedAt: nowMs(),
          });
          break;

        default:
          this.emit(P2PEvents.MESSAGE, {
            peerId,
            message,
            receivedAt: nowMs(),
          });
          break;
      }
    }

    broadcast(type, payload, options = {}) {
      const message = JSON.stringify({
        type,
        payload,
        sentAt: nowMs(),
      });

      let sent = 0;

      for (const [peerId, channel] of this.channels) {
        if (channel.readyState !== "open") {
          continue;
        }

        if (options.skipPeerId && options.skipPeerId === peerId) {
          continue;
        }

        channel.send(message);
        sent += 1;
      }

      return sent;
    }

    sendPlayerState(state) {
      return this.broadcast("PLAYER_STATE", state);
    }

    sendShoot(event) {
      return this.broadcast("SHOOT", event);
    }

    closePeer(peerId) {
      const channel = this.channels.get(peerId);
      if (channel) {
        channel.close();
      }

      this.channels.delete(peerId);

      const pc = this.connections.get(peerId);
      if (pc) {
        pc.close();
      }

      this.connections.delete(peerId);
      this.pendingCandidates.delete(peerId);
    }

    disconnect() {
      for (const peerId of [...this.connections.keys()]) {
        this.closePeer(peerId);
      }

      this.socket?.emit("leave-room");
      this.socket?.disconnect();

      this.connected = false;
    }
  }
