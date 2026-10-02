// YouTube Watch Party – Express + Socket.IO, structured with OOP classes.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');

// ---- Role -> permission map (single source of truth for RBAC) ----
const PERMISSIONS = {
  host:        new Set(['play', 'pause', 'seek', 'change_video', 'assign_role', 'remove', 'transfer', 'approve']),
  moderator:   new Set(['play', 'pause', 'seek', 'change_video', 'approve']),
  participant: new Set(),
  viewer:      new Set(),
};
const CONTROL_ACTIONS = ['play', 'pause', 'seek', 'change_video'];
const EMOJIS = ['👍', '😂', '😮', '❤️', '🔥', '👏'];

const extractVideoId = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : null;
};

class Participant {
  constructor(id, username, role) { this.id = id; this.username = username; this.role = role; }
  can(action) { return PERMISSIONS[this.role].has(action); }
  toJSON() { return { userId: this.id, username: this.username, role: this.role }; }
}

class Room {
  constructor(id, saved = {}) {
    this.id = id;
    this.members = new Map();   // socketId -> Participant
    this.requests = new Map();  // requestId -> pending change request
    this.chat = [];
    this.seq = 0;
    this.state = {
      playState: 'paused',
      currentTime: saved.currentTime || 0,
      videoId: saved.videoId || 'jNQXAC9IVRw',
      at: Date.now(),
    };
  }
  // Live position: server is the single source of truth for time.
  get time() {
    const s = this.state;
    return s.playState === 'playing' ? s.currentTime + (Date.now() - s.at) / 1000 : s.currentTime;
  }
  snapshot() { return { playState: this.state.playState, currentTime: this.time, videoId: this.state.videoId }; }
  participants() { return [...this.members.values()].map((m) => m.toJSON()); }
  pendingRequests() { return [...this.requests.values()]; }
  applyAction(action, p = {}) {
    const s = this.state, t = this.time;
    if (action === 'play') { s.currentTime = t; s.playState = 'playing'; }
    else if (action === 'pause') { s.currentTime = t; s.playState = 'paused'; }
    else if (action === 'seek') { s.currentTime = Math.max(0, Number(p.time) || 0); }
    else if (action === 'change_video') {
      const id = extractVideoId(p.videoId);
      if (!id) return false;
      s.videoId = id; s.currentTime = 0; s.playState = 'playing';
    } else return false;
    s.at = Date.now();
    return true;
  }
}

// Persistent rooms: room id + last video/time are stored in a JSON file.
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.saved = {};
    try { this.saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
    this.timer = null;
  }
  generateId() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do { id = Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join(''); }
    while (this.rooms.has(id) || this.saved[id]);
    return id;
  }
  create() { const room = new Room(this.generateId()); this.rooms.set(room.id, room); this.persist(room); return room; }
  get(id) {
    if (this.rooms.has(id)) return this.rooms.get(id);
    if (this.saved[id]) { const r = new Room(id, this.saved[id]); this.rooms.set(id, r); return r; }
    return null;
  }
  persist(room) {
    this.saved[room.id] = { videoId: room.state.videoId, currentTime: room.time };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(this.saved)); }
      catch (e) { console.error('persist failed', e.message); }
    }, 500);
  }
}

class MessageHandler {
  constructor(io, manager) { this.io = io; this.manager = manager; }

  bind(socket) {
    const ctx = () => {
      const room = this.manager.rooms.get(socket.data.roomId);
      const me = room && room.members.get(socket.id);
      return me ? { room, me } : {};
    };
    const err = (message) => socket.emit('error_msg', { message });
    const sync = (room) => { this.io.to(room.id).emit('sync_state', room.snapshot()); this.manager.persist(room); };
    const pushRequests = (room) => this.io.to(room.id).emit('requests_update', { requests: room.pendingRequests() });

    socket.on('join_room', ({ roomId, username, create } = {}) => {
      const name = String(username || '').trim().slice(0, 24);
      if (!name) return err('Please enter a name');
      this.leave(socket);
      const room = create ? this.manager.create() : this.manager.get(String(roomId || '').trim().toUpperCase());
      if (!room) return err('Room not found');
      const role = room.members.size === 0 ? 'host' : 'participant';
      const me = new Participant(socket.id, name, role);
      room.members.set(socket.id, me);
      socket.data.roomId = room.id;
      socket.join(room.id);
      socket.emit('joined', { roomId: room.id, userId: socket.id, role, participants: room.participants(),
        requests: room.pendingRequests(), chat: room.chat, state: room.snapshot() });
      socket.to(room.id).emit('user_joined', { username: name, userId: socket.id, role, participants: room.participants() });
    });

    socket.on('leave_room', () => this.leave(socket));
    socket.on('disconnect', () => this.leave(socket));

    // Direct controls: backend validates permission before doing anything.
    CONTROL_ACTIONS.forEach((action) => socket.on(action, (payload) => {
      const { room, me } = ctx();
      if (!room) return;
      if (!me.can(action)) return err(`Permission denied: your role (${me.role}) cannot ${action}`);
      if (!room.applyAction(action, payload)) return err('Invalid request');
      sync(room);
    }));

    // Participants ask for a change; Host/Moderator approve or reject.
    socket.on('request_action', ({ action, payload } = {}) => {
      const { room, me } = ctx();
      if (!room || !CONTROL_ACTIONS.includes(action)) return;
      if (me.can(action)) { room.applyAction(action, payload); return sync(room); }
      if (action === 'change_video' && !extractVideoId(payload && payload.videoId)) return err('Invalid YouTube link');
      for (const r of room.requests.values()) if (r.userId === me.id) room.requests.delete(r.id); // 1 pending per user
      const id = String(++room.seq);
      room.requests.set(id, { id, userId: me.id, username: me.username, action, payload: payload || {} });
      pushRequests(room);
    });

    socket.on('resolve_request', ({ requestId, approve } = {}) => {
      const { room, me } = ctx();
      if (!room) return;
      if (!me.can('approve')) return err('Permission denied: only Host/Moderator can approve');
      const req = room.requests.get(String(requestId));
      if (!req) return;
      room.requests.delete(req.id);
      if (approve) { room.applyAction(req.action, req.payload); sync(room); }
      this.io.to(room.id).emit('request_resolved', { id: req.id, username: req.username, action: req.action, approved: !!approve, by: me.username });
      pushRequests(room);
    });

    socket.on('assign_role', ({ userId, role } = {}) => {
      const { room, me } = ctx();
      if (!room) return;
      if (!me.can('assign_role')) return err('Permission denied: only the Host can assign roles');
      const target = room.members.get(userId);
      if (!target || target.id === me.id || !['moderator', 'participant', 'viewer'].includes(role)) return err('Invalid role change');
      target.role = role;
      this.io.to(room.id).emit('role_assigned', { userId, username: target.username, role, participants: room.participants() });
    });

    socket.on('remove_participant', ({ userId } = {}) => {
      const { room, me } = ctx();
      if (!room) return;
      if (!me.can('remove')) return err('Permission denied: only the Host can remove participants');
      const target = room.members.get(userId);
      if (!target || target.id === me.id) return;
      room.members.delete(userId);
      const ts = this.io.sockets.sockets.get(userId);
      if (ts) { ts.emit('removed', { message: 'You were removed by the host' }); ts.leave(room.id); ts.data.roomId = null; }
      for (const r of room.requests.values()) if (r.userId === userId) room.requests.delete(r.id);
      this.io.to(room.id).emit('participant_removed', { userId, participants: room.participants() });
      pushRequests(room);
    });

    socket.on('transfer_host', ({ userId } = {}) => {
      const { room, me } = ctx();
      if (!room) return;
      if (!me.can('transfer')) return err('Permission denied: only the Host can transfer host');
      const target = room.members.get(userId);
      if (!target || target.id === me.id) return;
      target.role = 'host'; me.role = 'moderator';
      this.io.to(room.id).emit('host_transferred', { from: me.username, to: target.username, participants: room.participants() });
    });

    socket.on('chat_message', ({ text } = {}) => {
      const { room, me } = ctx();
      const t = String(text || '').trim().slice(0, 300);
      if (!room || !t) return;
      const msg = { username: me.username, text: t, ts: Date.now() };
      room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
      this.io.to(room.id).emit('chat_message', msg);
    });

    socket.on('reaction', ({ emoji } = {}) => {
      const { room, me } = ctx();
      if (room && EMOJIS.includes(emoji)) this.io.to(room.id).emit('reaction', { username: me.username, emoji });
    });
  }

  leave(socket) {
    const room = this.manager.rooms.get(socket.data.roomId);
    const me = room && room.members.get(socket.id);
    if (!me) return;
    room.members.delete(socket.id);
    socket.leave(room.id);
    socket.data.roomId = null;
    for (const r of room.requests.values()) if (r.userId === me.id) room.requests.delete(r.id);
    if (room.members.size === 0) { this.manager.persist(room); this.manager.rooms.delete(room.id); return; }
    this.io.to(room.id).emit('user_left', { username: me.username, userId: me.id, participants: room.participants() });
    if (me.role === 'host') { // auto-promote: first moderator, else longest-present member
      const list = [...room.members.values()];
      const next = list.find((m) => m.role === 'moderator') || list[0];
      next.role = 'host';
      this.io.to(room.id).emit('host_transferred', { from: me.username, to: next.username, participants: room.participants() });
    }
    this.io.to(room.id).emit('requests_update', { requests: room.pendingRequests() });
  }
}

// ---- bootstrap ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const manager = new RoomManager();
const handler = new MessageHandler(io, manager);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
io.on('connection', (socket) => handler.bind(socket));

// Heartbeat: re-broadcast state of playing rooms so late/laggy clients correct drift.
setInterval(() => {
  for (const room of manager.rooms.values()) if (room.state.playState === 'playing') io.to(room.id).emit('sync_state', room.snapshot());
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Watch Party running on :${PORT}`));
