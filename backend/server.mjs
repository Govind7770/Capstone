// server.mjs
import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Server } from "socket.io";

const ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const HTTP_PORT = Number(process.env.HTTP_PORT || 3002);
const WS_PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/zoomish";

// ---------- MongoDB ----------
await mongoose.connect(MONGO_URI, { dbName: "zoomish" });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true }
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

// ---------- HTTP API ----------
const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

// Signup
app.post("/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ message: "Missing fields" });
    const exists = await User.findOne({ email }).lean();
    if (exists) return res.status(409).json({ message: "User already exists" });
    const passwordHash = await bcrypt.hash(password, 10);
    const doc = await User.create({ name, email, passwordHash });
    const token = jwt.sign({ sub: doc._id.toString(), email, name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ user: { name: doc.name, email: doc.email }, token });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ message: "User already exists" });
    res.status(500).json({ message: "Signup failed" });
  }
});

// Login (identifier treated as email for demo)
app.post("/auth/login", async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    const email = (identifier || "").trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ sub: user._id.toString(), email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ user: { name: user.name, email: user.email }, token });
  } catch (e) {
    res.status(500).json({ message: "Login failed" });
  }
});

// Optional: health
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

app.listen(HTTP_PORT, () => {
  console.log(`HTTP API listening on http://localhost:${HTTP_PORT}`);
});
import multer from "multer";
import path from "path";
import fs from "fs";

const upload = multer({ dest: "uploads/" });
app.post("/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const target = path.join("uploads", `${Date.now()}-${file.originalname}`);
  fs.renameSync(file.path, target);
  res.json({ ok: true, file: target });
});

// ...keep your express/auth code above

// ---------- WebSocket Signaling ----------
const io = new Server(WS_PORT, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] }
});

const rooms = new Map(); // roomId -> Set(socketId)
const names = new Map(); // socketId -> name

io.on("connection", socket => {
  socket.on("join", ({ roomId, name }) => {
    if (!roomId) return;
    if (socket.roomId) socket.leave(socket.roomId);

    socket.join(roomId);
    socket.roomId = roomId;
    names.set(socket.id, name || socket.id);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const members = rooms.get(roomId);
    const peers = [...members];
    members.add(socket.id);

    socket.emit("joined", { selfId: socket.id, peers });
    socket.to(roomId).emit("signal", { type: "peer-join", from: socket.id, name });
  });

  socket.on("signal", msg => {
    const { to } = msg || {};
    if (!to) return;
    io.to(to).emit("signal", { ...msg, from: socket.id });
  });

  // CHAT: single broadcast to the room, sender included
  socket.on("chat", ({ text, at }) => {
    if (!socket.roomId || !text) return;
    const from = names.get(socket.id) || socket.id;
    io.to(socket.roomId).emit("chat", { from, text, at: at || Date.now() });
  });

  socket.on("whiteboard", payload => {
    if (socket.roomId) socket.to(socket.roomId).emit("whiteboard", payload);
  });

  socket.on("disconnect", () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const members = rooms.get(socket.roomId);
      members.delete(socket.id);
      socket.to(socket.roomId).emit("left", { peerId: socket.id });
      if (members.size === 0) rooms.delete(socket.roomId);
    }
    names.delete(socket.id);
  });
});

console.log(`WebSocket signaling on ws://localhost:${WS_PORT}`);
