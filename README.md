# 🎬 YouTube Watch Party

Real-time synchronized YouTube watching with rooms, role-based access control, and a **request → approve** workflow.

**Live URL:** `https://<your-app>.onrender.com`  ← _replace after deploying_

## Features
- Create room (creator = **Host**) or join via room code / invite link (joiner = **Participant**)
- Synced play / pause / seek / change-video over **WebSockets (Socket.IO)**
- Roles: **Host**, **Moderator**, **Participant**, **Viewer** – assigned live by the Host
- Host can assign roles, remove participants, transfer host (auto-promotion if host leaves)
- **Approval workflow:** Participants/Viewers can *request* play/pause/seek/new video; Host/Moderator approve or reject
- Chat, emoji reactions, persistent room IDs (JSON file), drift correction (5s heartbeat)
- OOP server: `Participant`, `Room`, `RoomManager`, `MessageHandler`

## Run locally
```bash
npm install
npm start          # http://localhost:3000
```
Open two browsers/tabs: create a room in one, join with the code in the other.

## Permissions
| Action | Host | Moderator | Participant / Viewer |
|---|---|---|---|
| play / pause / seek / change video | ✅ | ✅ | ❌ (can **request**) |
| approve / reject requests | ✅ | ✅ | ❌ |
| assign roles, remove, transfer host | ✅ | ❌ | ❌ |

## Architecture
```
Browser (YouTube IFrame, controls hidden) ⇄ Socket.IO ⇄ Express server
                                                    └─ RoomManager → Room (state, members, requests, chat)
```
1. Client emits an event (`play`, `seek`, `request_action`, …).
2. `MessageHandler` checks `Participant.can(action)` against the `PERMISSIONS` map – **backend is the authority**; the UI only mirrors it.
3. `Room.applyAction` updates the single server-side state (`playState`, `currentTime`, `videoId`, timestamp). Live time is computed as `currentTime + elapsed` while playing.
4. Server broadcasts `sync_state` (plus `role_assigned`, `user_joined`, `participant_removed`, …) to the Socket.IO room; every client seeks if drift > 1.5s.
5. YouTube's native controls are disabled (`controls:0` + overlay) so all input goes through our permission-checked controls.

## Deploy on Render
1. Push this folder to GitHub.
2. Render → **New Web Service** → pick repo. Build: `npm install`, Start: `node server.js` (or use `render.yaml`). 
3. Render sets `PORT` automatically; WebSockets work out of the box. Paste the URL above.

## Trade-offs / notes
- Room state lives in server memory; only room ID + last video/time are persisted. Render's free disk is ephemeral, so use a DB (Postgres/SQLite on a disk) for durable rooms.
- Scaling: add `@socket.io/redis-adapter` + sticky sessions routed by room, and move `Room` state to Redis, to run multiple instances.
- Browsers block autoplay until the user interacts; joining via a click satisfies this.
