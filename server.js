const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_DB || process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-on-render";
const START_MS = 10 * 60 * 1000;
const INC_MS = 0;
const K_FACTOR = 32;

if (!MONGO_URI) console.warn("Missing MONGO_DB env. Accounts and ratings need MongoDB.");
mongoose.connect(MONGO_URI || "mongodb://127.0.0.1:27017/chessv2").catch(err => console.error("Mongo connect failed", err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, index: true },
  usernameLower: { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  rating: { type: Number, default: 1200 },
  games: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 }
}, { timestamps: true });

const gameSchema = new mongoose.Schema({
  white: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  black: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  whiteName: String,
  blackName: String,
  whiteRatingBefore: Number,
  blackRatingBefore: Number,
  whiteRatingAfter: Number,
  blackRatingAfter: Number,
  fen: String,
  pgn: String,
  moves: [Object],
  result: Object,
  timeControl: { initialMs: Number, incrementMs: Number },
  status: { type: String, default: "active" }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const GameRecord = mongoose.model("Game", gameSchema);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI || "mongodb://127.0.0.1:27017/chessv2" }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, sameSite: "lax" }
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));
io.engine.use(sessionMiddleware);

const queue = [];
const liveGames = new Map();
const userSockets = new Map();

function cleanUsername(v) {
  return String(v || "").trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 18);
}
function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function nextRating(rating, exp, score) { return Math.round(rating + K_FACTOR * (score - exp)); }
function id() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }
function publicUser(u) { return u ? { id: String(u._id), username: u.username, rating: u.rating, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws } : null; }
function removeFromQueue(userId) { const i = queue.findIndex(x => x.userId === userId); if (i >= 0) queue.splice(i, 1); }
function activeClock(g) { const now = Date.now(); const clocks = { ...g.clocks }; if (!g.result) clocks[g.chess.turn()] = Math.max(0, clocks[g.chess.turn()] - (now - g.lastTick)); return clocks; }
function captured(g) { const out = { w: [], b: [] }; for (const m of g.chess.history({ verbose: true })) if (m.captured) out[m.color].push(m.captured); return out; }

async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  req.user = user;
  next();
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    if (username.length < 3) return res.status(400).json({ error: "Username must be 3+ chars, letters/numbers/_ only." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be 6+ chars." });
    const user = await User.create({ username, usernameLower: username.toLowerCase(), passwordHash: await bcrypt.hash(password, 10) });
    req.session.userId = String(user._id);
    res.json({ user: publicUser(user) });
  } catch {
    res.status(400).json({ error: "Username already taken." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const usernameLower = cleanUsername(req.body.username).toLowerCase();
  const user = await User.findOne({ usernameLower });
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.passwordHash))) return res.status(401).json({ error: "Wrong username or password." });
  req.session.userId = String(user._id);
  res.json({ user: publicUser(user) });
});
app.post("/api/auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get("/api/leaderboard", async (req, res) => res.json({ users: (await User.find().sort({ rating: -1 }).limit(25)).map(publicUser) }));
app.get("/api/history", requireAuth, async (req, res) => res.json({ games: await GameRecord.find({ $or: [{ white: req.user._id }, { black: req.user._id }] }).sort({ createdAt: -1 }).limit(20) }));

function gamePayload(g) {
  const clocks = activeClock(g);
  return { gameId: g.id, dbId: String(g.dbId), fen: g.chess.fen(), pgn: g.chess.pgn(), turn: g.chess.turn(), moveNumber: g.chess.moveNumber(), players: { white: g.players.w.public, black: g.players.b.public }, clocks, initialClockMs: START_MS, incrementMs: INC_MS, lastMove: g.lastMove, captured: captured(g), drawOfferBy: g.drawOfferBy, result: g.result, status: { isCheck: g.chess.isCheck(), result: g.result } };
}
function emitGame(g) { io.to(g.id).emit("game:update", gamePayload(g)); }
async function finishGame(g, result) {
  if (g.result) return;
  g.clocks = activeClock(g);
  g.result = result;
  let whiteScore = 0.5, blackScore = 0.5;
  if (result.winner === "w") { whiteScore = 1; blackScore = 0; }
  if (result.winner === "b") { whiteScore = 0; blackScore = 1; }
  const wr = g.players.w.ratingBefore, br = g.players.b.ratingBefore;
  const whiteAfter = nextRating(wr, expected(wr, br), whiteScore);
  const blackAfter = nextRating(br, expected(br, wr), blackScore);
  await User.updateOne({ _id: g.players.w.userId }, { $set: { rating: whiteAfter }, $inc: { games: 1, wins: whiteScore === 1 ? 1 : 0, losses: whiteScore === 0 ? 1 : 0, draws: whiteScore === 0.5 ? 1 : 0 } });
  await User.updateOne({ _id: g.players.b.userId }, { $set: { rating: blackAfter }, $inc: { games: 1, wins: blackScore === 1 ? 1 : 0, losses: blackScore === 0 ? 1 : 0, draws: blackScore === 0.5 ? 1 : 0 } });
  await GameRecord.updateOne({ _id: g.dbId }, { $set: { fen: g.chess.fen(), pgn: g.chess.pgn(), moves: g.moves, result, status: "finished", whiteRatingAfter: whiteAfter, blackRatingAfter: blackAfter } });
  g.players.w.public.rating = whiteAfter; g.players.b.public.rating = blackAfter;
  emitGame(g);
}
function checkRuleEnd(g) {
  const c = g.chess;
  if (c.isCheckmate()) return finishGame(g, { type: "checkmate", winner: c.turn() === "w" ? "b" : "w", reason: "Checkmate." });
  if (c.isStalemate()) return finishGame(g, { type: "draw", winner: null, reason: "Stalemate." });
  if (c.isThreefoldRepetition()) return finishGame(g, { type: "draw", winner: null, reason: "Threefold repetition." });
  if (c.isInsufficientMaterial()) return finishGame(g, { type: "draw", winner: null, reason: "Insufficient material." });
  if (c.isDraw()) return finishGame(g, { type: "draw", winner: null, reason: "Draw by 50-move or official draw rule." });
}
async function startGame(a, b) {
  const flip = Math.random() < 0.5; const white = flip ? a : b; const black = flip ? b : a;
  const rec = await GameRecord.create({ white: white.user._id, black: black.user._id, whiteName: white.user.username, blackName: black.user.username, whiteRatingBefore: white.user.rating, blackRatingBefore: black.user.rating, fen: new Chess().fen(), pgn: "", moves: [], timeControl: { initialMs: START_MS, incrementMs: INC_MS }, status: "active" });
  const game = { id: id(), dbId: rec._id, chess: new Chess(), players: { w: { userId: white.user._id, ratingBefore: white.user.rating, public: publicUser(white.user) }, b: { userId: black.user._id, ratingBefore: black.user.rating, public: publicUser(black.user) } }, clocks: { w: START_MS, b: START_MS }, lastTick: Date.now(), moves: [], lastMove: null, drawOfferBy: null, result: null };
  liveGames.set(game.id, game);
  for (const p of [{ side: "w", item: white }, { side: "b", item: black }]) {
    const s = io.sockets.sockets.get(p.item.socketId); if (!s) continue;
    s.data.gameId = game.id; s.data.color = p.side; s.join(game.id); s.emit("player:you", { color: p.side, user: publicUser(p.item.user), gameId: game.id });
  }
  emitGame(game);
}

setInterval(() => { for (const g of liveGames.values()) if (!g.result) { const c = activeClock(g); if (c.w <= 0) finishGame(g, { type: "timeout", winner: "b", reason: "White ran out of time." }); else if (c.b <= 0) finishGame(g, { type: "timeout", winner: "w", reason: "Black ran out of time." }); else emitGame(g); } }, 1000);

io.use(async (socket, next) => {
  const userId = socket.request.session?.userId;
  if (!userId) return next(new Error("Login required"));
  const user = await User.findById(userId);
  if (!user) return next(new Error("Login required"));
  socket.data.user = user;
  userSockets.set(String(user._id), socket.id);
  next();
});

io.on("connection", socket => {
  socket.emit("account", { user: publicUser(socket.data.user) });
  socket.on("match:join", async () => {
    const user = await User.findById(socket.data.user._id);
    removeFromQueue(String(user._id));
    const opponent = queue.shift();
    if (opponent && opponent.userId !== String(user._id) && io.sockets.sockets.has(opponent.socketId)) await startGame(opponent, { user, userId: String(user._id), socketId: socket.id });
    else { queue.push({ user, userId: String(user._id), socketId: socket.id, joinedAt: Date.now() }); socket.emit("match:waiting", { position: queue.length }); }
  });
  socket.on("match:cancel", () => { removeFromQueue(String(socket.data.user._id)); socket.emit("match:cancelled"); });
  socket.on("moves:legal", ({ square } = {}) => { const g = liveGames.get(socket.data.gameId); if (!g) return; socket.emit("moves:legal", { square, moves: g.chess.moves({ square, verbose: true }) }); });
  socket.on("move:make", async ({ from, to, promotion } = {}) => {
    const g = liveGames.get(socket.data.gameId); if (!g || g.result) return;
    const color = socket.data.color; if (g.chess.turn() !== color) return socket.emit("error:message", "It is not your turn.");
    const now = Date.now(); g.clocks[color] = Math.max(0, g.clocks[color] - (now - g.lastTick));
    if (g.clocks[color] <= 0) return finishGame(g, { type: "timeout", winner: color === "w" ? "b" : "w", reason: `${color === "w" ? "White" : "Black"} ran out of time.` });
    try {
      const move = g.chess.move({ from, to, promotion: promotion || "q" });
      if (!move) return socket.emit("error:message", "Illegal move.");
      g.clocks[color] += INC_MS; g.lastTick = Date.now(); g.drawOfferBy = null; g.lastMove = { from: move.from, to: move.to, san: move.san, color: move.color, flags: move.flags, captured: move.captured || null, promotion: move.promotion || null }; g.moves.push(g.lastMove);
      await GameRecord.updateOne({ _id: g.dbId }, { $set: { fen: g.chess.fen(), pgn: g.chess.pgn(), moves: g.moves } });
      await checkRuleEnd(g); if (!g.result) emitGame(g);
    } catch { socket.emit("error:message", "Illegal move."); }
  });
  socket.on("game:resign", () => { const g = liveGames.get(socket.data.gameId); if (g && !g.result) finishGame(g, { type: "resignation", winner: socket.data.color === "w" ? "b" : "w", reason: `${socket.data.color === "w" ? "White" : "Black"} resigned.` }); });
  socket.on("draw:offer", () => { const g = liveGames.get(socket.data.gameId); if (!g || g.result) return; if (g.drawOfferBy && g.drawOfferBy !== socket.data.color) finishGame(g, { type: "draw", winner: null, reason: "Draw agreed." }); else { g.drawOfferBy = socket.data.color; emitGame(g); } });
  socket.on("draw:decline", () => { const g = liveGames.get(socket.data.gameId); if (g && g.drawOfferBy && g.drawOfferBy !== socket.data.color) { g.drawOfferBy = null; emitGame(g); } });
  socket.on("disconnect", () => { removeFromQueue(String(socket.data.user?._id)); userSockets.delete(String(socket.data.user?._id)); });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, () => console.log("ChessV2 running on " + PORT));
