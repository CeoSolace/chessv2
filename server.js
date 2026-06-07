const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const START_MS = 10 * 60 * 1000;
const INC_MS = 0;

app.use(express.static(path.join(__dirname, "public")));

const queue = [];
const games = new Map();

function guest() {
  return "Guest-" + Math.floor(1000 + Math.random() * 9000);
}

function id() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function cleanName(name) {
  return String(name || "").trim().slice(0, 18) || guest();
}

function publicPlayer(p) {
  return p ? { id: p.id, name: p.name } : null;
}

function activeClock(game) {
  const turn = game.chess.turn();
  const now = Date.now();
  const clocks = { ...game.clocks };
  if (!game.result && game.startedAt) clocks[turn] = Math.max(0, clocks[turn] - (now - game.lastTick));
  return clocks;
}

function capturedFromHistory(game) {
  const out = { w: [], b: [] };
  for (const m of game.chess.history({ verbose: true })) {
    if (m.captured) out[m.color].push(m.captured);
  }
  return out;
}

function legalMoves(game, square) {
  if (!square) return [];
  return game.chess.moves({ square, verbose: true }).map(m => ({ from: m.from, to: m.to, san: m.san, flags: m.flags, promotion: m.promotion || null }));
}

function status(game) {
  const c = game.chess;
  const clocks = activeClock(game);
  let result = game.result;

  if (!result) {
    if (clocks.w <= 0) result = { type: "timeout", winner: "b", reason: "White ran out of time." };
    else if (clocks.b <= 0) result = { type: "timeout", winner: "w", reason: "Black ran out of time." };
    else if (c.isCheckmate()) result = { type: "checkmate", winner: c.turn() === "w" ? "b" : "w", reason: "Checkmate." };
    else if (c.isStalemate()) result = { type: "draw", winner: null, reason: "Stalemate." };
    else if (c.isThreefoldRepetition()) result = { type: "draw", winner: null, reason: "Threefold repetition." };
    else if (c.isInsufficientMaterial()) result = { type: "draw", winner: null, reason: "Insufficient material." };
    else if (c.isDraw()) result = { type: "draw", winner: null, reason: "Draw by chess rules." };
  }

  return { clocks, result, isCheck: c.isCheck(), turn: c.turn() };
}

function payload(game) {
  const s = status(game);
  if (s.result && !game.result) game.result = s.result;
  return {
    gameId: game.id,
    fen: game.chess.fen(),
    pgn: game.chess.pgn(),
    turn: game.chess.turn(),
    moveNumber: game.chess.moveNumber(),
    players: { white: publicPlayer(game.players.w), black: publicPlayer(game.players.b) },
    lastMove: game.lastMove,
    captured: capturedFromHistory(game),
    clocks: s.clocks,
    initialClockMs: START_MS,
    incrementMs: INC_MS,
    drawOfferBy: game.drawOfferBy,
    result: game.result,
    status: { isCheck: s.isCheck, result: game.result }
  };
}

function emitGame(game) {
  io.to(game.id).emit("game:update", payload(game));
}

function removeFromQueue(socketId) {
  const i = queue.findIndex(x => x.id === socketId);
  if (i >= 0) queue.splice(i, 1);
}

function startGame(a, b) {
  const gameId = id();
  const flip = Math.random() < 0.5;
  const white = flip ? a : b;
  const black = flip ? b : a;
  const game = {
    id: gameId,
    chess: new Chess(),
    players: { w: { id: white.id, name: white.name }, b: { id: black.id, name: black.name } },
    clocks: { w: START_MS, b: START_MS },
    lastTick: Date.now(),
    startedAt: Date.now(),
    lastMove: null,
    drawOfferBy: null,
    result: null
  };
  games.set(gameId, game);

  for (const p of [white, black]) {
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    s.data.gameId = gameId;
    s.data.color = p.id === white.id ? "w" : "b";
    s.join(gameId);
    s.emit("player:you", { id: s.id, name: p.name, color: s.data.color, gameId });
  }

  emitGame(game);
}

setInterval(() => {
  for (const game of games.values()) {
    if (!game.result) emitGame(game);
  }
}, 1000);

io.on("connection", socket => {
  socket.on("match:join", ({ name } = {}) => {
    removeFromQueue(socket.id);
    socket.data.name = cleanName(name);
    socket.data.color = null;
    socket.data.gameId = null;

    const opponent = queue.shift();
    if (opponent && io.sockets.sockets.has(opponent.id)) {
      startGame(opponent, { id: socket.id, name: socket.data.name });
    } else {
      queue.push({ id: socket.id, name: socket.data.name, joinedAt: Date.now() });
      socket.emit("match:waiting", { position: queue.length });
    }
  });

  socket.on("match:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("match:cancelled");
  });

  socket.on("moves:legal", ({ square } = {}) => {
    const game = games.get(socket.data.gameId);
    if (!game) return;
    socket.emit("moves:legal", { square, moves: legalMoves(game, square) });
  });

  socket.on("move:make", ({ from, to, promotion } = {}) => {
    const game = games.get(socket.data.gameId);
    if (!game || game.result) return;
    const color = socket.data.color;
    if (color !== "w" && color !== "b") return socket.emit("error:message", "You are not a player.");
    if (game.chess.turn() !== color) return socket.emit("error:message", "It is not your turn.");

    const now = Date.now();
    game.clocks[color] = Math.max(0, game.clocks[color] - (now - game.lastTick));
    if (game.clocks[color] <= 0) {
      game.result = { type: "timeout", winner: color === "w" ? "b" : "w", reason: `${color === "w" ? "White" : "Black"} ran out of time.` };
      emitGame(game);
      return;
    }

    try {
      const move = game.chess.move({ from, to, promotion: promotion || "q" });
      if (!move) return socket.emit("error:message", "Illegal move.");
      game.clocks[color] += INC_MS;
      game.lastTick = Date.now();
      game.drawOfferBy = null;
      game.lastMove = { from: move.from, to: move.to, san: move.san, color: move.color, flags: move.flags, captured: move.captured || null, promotion: move.promotion || null };
      status(game);
      emitGame(game);
    } catch {
      socket.emit("error:message", "Illegal move.");
    }
  });

  socket.on("game:resign", () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.result) return;
    const color = socket.data.color;
    if (color !== "w" && color !== "b") return;
    game.result = { type: "resignation", winner: color === "w" ? "b" : "w", reason: `${color === "w" ? "White" : "Black"} resigned.` };
    emitGame(game);
  });

  socket.on("draw:offer", () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.result) return;
    const color = socket.data.color;
    if (color !== "w" && color !== "b") return;
    if (game.drawOfferBy && game.drawOfferBy !== color) {
      game.result = { type: "draw", winner: null, reason: "Draw agreed." };
    } else {
      game.drawOfferBy = color;
    }
    emitGame(game);
  });

  socket.on("draw:decline", () => {
    const game = games.get(socket.data.gameId);
    if (!game || game.result) return;
    if (game.drawOfferBy && game.drawOfferBy !== socket.data.color) game.drawOfferBy = null;
    emitGame(game);
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    const game = games.get(socket.data.gameId);
    if (!game || game.result) return;
    const color = socket.data.color;
    if (color === "w" || color === "b") {
      game.result = { type: "disconnect", winner: color === "w" ? "b" : "w", reason: `${color === "w" ? "White" : "Black"} disconnected.` };
      emitGame(game);
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => console.log("ChessV2 running on " + PORT));
