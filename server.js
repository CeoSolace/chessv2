const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function guest() {
  return "Guest-" + Math.floor(1000 + Math.random() * 9000);
}

function code() {
  let c;
  do c = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (rooms.has(c));
  return c;
}

function payload(roomCode) {
  const r = rooms.get(roomCode);
  return {
    roomCode,
    fen: r.game.fen(),
    turn: r.game.turn(),
    pgn: r.game.pgn(),
    players: {
      white: r.players.white ? { id: r.players.white.id, name: r.players.white.name } : null,
      black: r.players.black ? { id: r.players.black.id, name: r.players.black.name } : null
    },
    spectators: r.spectators.size,
    lastMove: r.lastMove,
    status: {
      isGameOver: r.game.isGameOver(),
      isCheck: r.game.isCheck(),
      isCheckmate: r.game.isCheckmate(),
      isDraw: r.game.isDraw(),
      isStalemate: r.game.isStalemate()
    }
  };
}

function emitRoom(roomCode) {
  io.to(roomCode).emit("room:update", payload(roomCode));
}

function join(socket, roomCode, name) {
  roomCode = String(roomCode || "").trim().toUpperCase();
  if (!rooms.has(roomCode)) return socket.emit("error:message", "Room not found.");

  const r = rooms.get(roomCode);
  name = String(name || "").trim().slice(0, 18) || guest();

  socket.join(roomCode);
  socket.data.roomCode = roomCode;
  socket.data.name = name;

  if (!r.players.white) {
    r.players.white = { id: socket.id, name };
    socket.data.color = "w";
  } else if (!r.players.black) {
    r.players.black = { id: socket.id, name };
    socket.data.color = "b";
  } else {
    r.spectators.add(socket.id);
    socket.data.color = "spectator";
  }

  socket.emit("player:you", {
    id: socket.id,
    name,
    color: socket.data.color,
    roomCode
  });

  emitRoom(roomCode);
}

io.on("connection", socket => {
  socket.on("room:create", ({ name } = {}) => {
    const roomCode = code();
    rooms.set(roomCode, {
      game: new Chess(),
      players: { white: null, black: null },
      spectators: new Set(),
      lastMove: null
    });
    join(socket, roomCode, name);
  });

  socket.on("room:join", ({ roomCode, name } = {}) => {
    join(socket, roomCode, name);
  });

  socket.on("move:make", ({ from, to, promotion } = {}) => {
    const roomCode = socket.data.roomCode;
    const r = rooms.get(roomCode);
    if (!r) return;

    const color = socket.data.color;
    if (color !== "w" && color !== "b") return socket.emit("error:message", "Spectators cannot move.");
    if (r.game.turn() !== color) return socket.emit("error:message", "It is not your turn.");

    try {
      const move = r.game.move({ from, to, promotion: promotion || "q" });
      if (!move) return socket.emit("error:message", "Illegal move.");
      r.lastMove = { from: move.from, to: move.to, san: move.san };
      emitRoom(roomCode);
    } catch {
      socket.emit("error:message", "Illegal move.");
    }
  });

  socket.on("game:reset", () => {
    const roomCode = socket.data.roomCode;
    const r = rooms.get(roomCode);
    if (!r) return;
    if (socket.data.color !== "w" && socket.data.color !== "b") return;
    r.game = new Chess();
    r.lastMove = null;
    emitRoom(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const r = rooms.get(roomCode);
    if (!r) return;

    if (r.players.white?.id === socket.id) r.players.white = null;
    if (r.players.black?.id === socket.id) r.players.black = null;
    r.spectators.delete(socket.id);

    if (!r.players.white && !r.players.black && r.spectators.size === 0) {
      rooms.delete(roomCode);
    } else {
      emitRoom(roomCode);
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => console.log("ChessV2 running on " + PORT));
