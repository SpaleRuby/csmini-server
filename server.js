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

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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

    const existingPeers = serializePeers(room, socket.id);
    const payload = {
      roomId,
      selfPeerId: socket.id,
      peers: existingPeers,
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
