import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import multer from "multer";

const WS_PORT = Number(process.env.PORT || 3001);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3002);
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const MAX_CHUNK_MB = Number(process.env.MAX_CHUNK_MB || 50);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- HTTP API ---------- */
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Zoomish Backend</title>
    <style>body{font-family:ui-sans-serif,system-ui; padding:24px; background:#0b1020; color:#e6eaf2}</style>
    </head><body>
      <h1>Backend running</h1>
      <p>WebSocket signaling: ws://localhost:${WS_PORT}</p>
      <p>Health: <a href="/health">/health</a></p>
    </body></html>
  `);
});
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { roomId, userId, sessionId } = req.body;
    const dir = path.join(UPLOAD_DIR, roomId || "room", userId || "user", sessionId || "session");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, _file, cb) => {
    const seq = String(req.body.seq ?? "0").padStart(6, "0");
    cb(null, `chunk-${seq}.bin`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_CHUNK_MB * 1024 * 1024 } });
app.post("/upload/chunk", upload.single("chunk"), (req, res) => res.status(200).json({ saved: true, at: Date.now() }));

app.listen(HTTP_PORT, () => {
  console.log(`HTTP API listening on http://localhost:${HTTP_PORT}`);
});

/* ---------- WebSocket Signaling ---------- */
const io = new Server(WS_PORT, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] }
});

const rooms = new Map(); // roomId -> Set(socketId)
const names = new Map(); // socketId -> display name

io.on("connection", socket => {
  socket.on("join", ({ roomId, name }) => {
    names.set(socket.id, name || socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
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

  socket.on("chat", ({ text, at }) => {
    if (!socket.roomId || !text) return;
    const from = names.get(socket.id) || socket.id;
    io.to(socket.roomId).emit("chat", { from, text, at: at || Date.now() });
  });

  socket.on("ping-time", t0 => socket.emit("pong-time", Date.now(), t0));

  // Whiteboard: broadcast actions to others in room
  socket.on("whiteboard", (payload) => {
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
