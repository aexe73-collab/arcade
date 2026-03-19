const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const fs = require("fs");

app.use(express.json());

// Config endpoint — must be before static middleware
app.get("/config.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  const url = process.env.SUPABASE_URL || "https://hyukljrbaijdlcstrlhq.supabase.co";
  const key = process.env.SUPABASE_ANON_KEY || "";
  res.send(`window.SUPABASE_URL = "${url}";\nwindow.SUPABASE_ANON_KEY = "${key}";`);
});

// Temp debug endpoint — remove after fixing
app.get("/debug-env", (req, res) => {
  res.json({
    has_url: !!process.env.SUPABASE_URL,
    has_key: !!process.env.SUPABASE_ANON_KEY,
    url_preview: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.substring(0, 20) + "..." : "MISSING",
    node_env: process.env.NODE_ENV,
    port: process.env.PORT
  });
});

app.use(express.static(path.join(__dirname, "public")));

// ── Email subscription endpoint ───────────────────────────────────
app.post("/api/subscribe", (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }

  const file = path.join(__dirname, "subscribers.txt");
  const line = `${new Date().toISOString()} | ${email}\n`;

  fs.appendFile(file, line, (err) => {
    if (err) console.error("Email save error:", err.message);
  });

  console.log("New subscriber:", email);
  res.json({ ok: true });
});

// Separate waiting queues per game
const waitingQueues = { pong: null, snake: null, reaction: null, raid: null, fourdots: null };
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 9);
}

// ── 4 Dots state ──────────────────────────────────────────────────
const COLS = 7, ROWS = 6;

function createFourDotsState() {
  return {
    game: "fourdots",
    board: Array.from({ length: ROWS }, () => Array(COLS).fill(null)), // null | "left" | "right"
    turn: "left",
    winner: null,
    draw: false,
    phase: "playing"
  };
}

function dropPiece(board, col, role) {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (!board[row][col]) { board[row][col] = role; return row; }
  }
  return -1; // column full
}

function checkWinner(board) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p) continue;
      for (const [dr, dc] of dirs) {
        let count = 1, cells = [{r, c}];
        for (let i = 1; i < 4; i++) {
          const nr = r + dr*i, nc = c + dc*i;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc] !== p) break;
          count++; cells.push({r: nr, c: nc});
        }
        if (count === 4) return { winner: p, cells };
      }
    }
  }
  // Check draw
  if (board[0].every(c => c !== null)) return { winner: null, draw: true };
  return null;
}

// ── Raid (Battleship) state ───────────────────────────────────────
const RAID_SHIPS = [4, 3, 2, 2]; // ship sizes
const GRID = 8;

function createRaidState() {
  return {
    game: "raid",
    phase: "placement", // placement | combat | done
    boards: {
      left:  { ships: [], shots: [], sunk: 0 },
      right: { ships: [], shots: [], sunk: 0 }
    },
    turn: "left", // whose turn to fire
    readyCount: 0,
    turnTimer: null,
    winner: null
  };
}

function checkSunk(board) {
  // Count fully sunk ships
  let sunk = 0;
  for (const ship of board.ships) {
    const hits = ship.cells.filter(c => board.shots.some(s => s.x === c.x && s.y === c.y && s.hit));
    if (hits.length === ship.cells.length) sunk++;
  }
  return sunk;
}

// ── Pong state ────────────────────────────────────────────────────
function createPongState() {
  return {
    game: "pong",
    ball: { x: 400, y: 200, vx: 7, vy: 5 },
    paddles: { left: 160, right: 160 },
    scores: { left: 0, right: 0 },
    running: false,
    winner: null
  };
}

// ── Snake state ───────────────────────────────────────────────────
function createSnakeState() {
  return {
    game: "snake",
    snakes: {
      left:  { body: [{x:5,y:10},{x:4,y:10},{x:3,y:10}], dir: {x:1,y:0},  nextDir: {x:1,y:0},  alive: true },
      right: { body: [{x:34,y:10},{x:35,y:10},{x:36,y:10}], dir: {x:-1,y:0}, nextDir: {x:-1,y:0}, alive: true }
    },
    food: { x: 20, y: 10 },
    scores: { left: 0, right: 0 },
    running: false,
    winner: null
  };
}

// ── Reaction state ────────────────────────────────────────────────
function createReactionState() {
  return {
    game: "reaction",
    phase: "waiting",   // waiting | ready | tapped
    scores: { left: 0, right: 0 },
    round: 1,
    totalRounds: 5,
    flashTime: null,    // server timestamp when green flashed
    tapped: {},         // role -> timestamp
    running: false,
    winner: null
  };
}

function spawnFood(gs) {
  const occupied = new Set(
    [...gs.snakes.left.body, ...gs.snakes.right.body].map(s => `${s.x},${s.y}`)
  );
  let x, y;
  do {
    x = Math.floor(Math.random() * 40);
    y = Math.floor(Math.random() * 20);
  } while (occupied.has(`${x},${y}`));
  gs.food = { x, y };
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // Player selects a game and joins that queue
  socket.on("find_match", ({ game }) => {
    const queue = waitingQueues[game];

    if (queue && queue !== socket.id) {
      // Match found
      const roomId = generateRoomId();
      const player1 = queue;
      const player2 = socket.id;
      waitingQueues[game] = null;

      io.sockets.sockets.get(player1)?.join(roomId);
      socket.join(roomId);

      const gameState = game === "snake"     ? createSnakeState()
                      : game === "reaction"  ? createReactionState()
                      : game === "raid"      ? createRaidState()
                      : game === "fourdots"  ? createFourDotsState()
                      : createPongState();
      rooms.set(roomId, {
        players: [player1, player2],
        gameState,
        gameLoop: null,
        readyCount: 0,
        rematchCount: 0
      });

      io.to(player1).emit("match_found", { roomId, role: "left",  game });
      io.to(player2).emit("match_found", { roomId, role: "right", game });
      console.log(`Room ${roomId} [${game}]: ${player1} vs ${player2}`);
    } else {
      waitingQueues[game] = socket.id;
      socket.emit("waiting", { game });
    }
  });

  // WebRTC signalling
  socket.on("webrtc_offer",  ({ roomId, offer })     => socket.to(roomId).emit("webrtc_offer",  { offer }));
  socket.on("webrtc_answer", ({ roomId, answer })    => socket.to(roomId).emit("webrtc_answer", { answer }));
  socket.on("webrtc_ice",    ({ roomId, candidate }) => socket.to(roomId).emit("webrtc_ice",    { candidate }));

  // Both players ready — start
  socket.on("player_ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.readyCount++;
    if (room.readyCount === 2) {
      room.gameState.running = true;
      io.to(roomId).emit("game_start", { gameState: room.gameState });
      if (room.gameState.game === "snake")        startSnakeLoop(roomId);
      else if (room.gameState.game === "reaction")  startReactionRound(roomId);
      else if (room.gameState.game === "raid")       {} // waits for ship placement
      else if (room.gameState.game === "fourdots")   startFourDotsTimer(roomId);
      else startPongLoop(roomId);
    }
  });

  // Reaction: player tapped
  socket.on("reaction_tap", ({ roomId, role }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "reaction") return;
    const gs = room.gameState;

    // Ignore taps before green light or if already tapped
    if (gs.phase !== "ready") {
      // Early tap — penalty: flash red to this player
      io.to(roomId).emit("reaction_early", { role });
      return;
    }

    if (gs.tapped[role]) return; // already tapped this round

    const tapTime = Date.now();
    gs.tapped[role] = tapTime - gs.flashTime; // reaction time in ms

    // Check if both have tapped
    const roles = ["left", "right"];
    if (roles.every(r => gs.tapped[r])) {
      // Both tapped — faster one wins the round
      const roundWinner = gs.tapped.left < gs.tapped.right ? "left" : "right";
      gs.scores[roundWinner]++;
      gs.phase = "tapped";

      io.to(roomId).emit("reaction_round_result", {
        winner: roundWinner,
        times: gs.tapped,
        scores: gs.scores,
        round: gs.round
      });

      // Check match winner (first to 3)
      if (gs.scores.left >= 3 || gs.scores.right >= 3) {
        const matchWinner = gs.scores.left >= 3 ? "left" : "right";
        endGame(roomId, matchWinner);
      } else {
        // Next round after pause
        gs.round++;
        setTimeout(() => startReactionRound(roomId), 2500);
      }
    } else {
      // First to tap — tell both players
      io.to(roomId).emit("reaction_first_tap", { role, time: gs.tapped[role] });
    }
  });

  // Pong paddle
  socket.on("paddle_move", ({ roomId, role, y }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    if (role === "left")  room.gameState.paddles.left  = y;
    if (role === "right") room.gameState.paddles.right = y;
  });

  // Snake direction — queued as nextDir to apply on next tick
  socket.on("snake_dir", ({ roomId, role, dir }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "snake") return;
    const snake = room.gameState.snakes[role];
    if (!snake || !snake.alive) return;
    // Prevent 180 reversal
    if (dir.x !== -snake.dir.x || dir.y !== -snake.dir.y) {
      snake.nextDir = dir;
    }
  });

  // ── 4 Dots: player drops piece ────────────────────────────────
  socket.on("fourdots_drop", ({ roomId, role, col }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "fourdots") return;
    const gs = room.gameState;
    if (gs.phase !== "playing" || gs.turn !== role) return;
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    processDotsMove(roomId, role, col);
  });

  // Post-game chat relay
  socket.on("chat_msg", ({ roomId, text }) => {
    if (!text || text.trim().length === 0) return;
    const clean = text.trim().substring(0, 120);
    socket.to(roomId).emit("chat_msg", { text: clean });
  });

  // ── Raid: player places ships ─────────────────────────────────
  socket.on("raid_place_ships", ({ roomId, role, ships }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "raid") return;
    const gs = room.gameState;
    if (gs.phase !== "placement") return;

    gs.boards[role].ships = ships;
    gs.readyCount++;

    io.to(roomId).emit("raid_player_placed", { role });

    if (gs.readyCount >= 2) {
      gs.phase = "combat";
      gs.turn  = "left";
      io.to(roomId).emit("raid_combat_start", { turn: gs.turn });
      startRaidTurnTimer(roomId);
    }
  });

  // ── Raid: player fires ────────────────────────────────────────
  socket.on("raid_fire", ({ roomId, role, x, y }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "raid") return;
    const gs = room.gameState;

    if (gs.phase !== "combat") return;
    if (gs.turn !== role) return; // not your turn

    // Clear turn timer
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }

    // Target the opponent's board
    const targetRole  = role === "left" ? "right" : "left";
    const targetBoard = gs.boards[targetRole];

    // Already shot here?
    if (targetBoard.shots.some(s => s.x === x && s.y === y)) return;

    // Check hit
    let hit = false;
    let sunkShip = null;
    for (const ship of targetBoard.ships) {
      if (ship.cells.some(c => c.x === x && c.y === y)) {
        hit = true;
        // Check if this shot sinks the ship
        const hitCells = ship.cells.filter(c =>
          targetBoard.shots.some(s => s.x === c.x && s.y === c.y && s.hit) ||
          (c.x === x && c.y === y)
        );
        if (hitCells.length === ship.cells.length) sunkShip = ship;
        break;
      }
    }

    targetBoard.shots.push({ x, y, hit });

    // Recount all sunk ships fresh to avoid off-by-one
    if (hit) {
      let sunkCount = 0;
      for (const ship of targetBoard.ships) {
        const allHit = ship.cells.every(c =>
          targetBoard.shots.some(s => s.x === c.x && s.y === c.y && s.hit)
        );
        if (allHit) {
          sunkCount++;
          if (!ship.sunk) { ship.sunk = true; sunkShip = ship; }
        }
      }
      targetBoard.sunk = sunkCount;
    }

    io.to(roomId).emit("raid_shot_result", {
      role, x, y, hit,
      sunk: sunkShip || null,
      targetSunk: targetBoard.sunk
    });

    // Check win — all buildings destroyed
    if (targetBoard.sunk >= RAID_SHIPS.length) {
      gs.phase  = "done";
      gs.winner = role;
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      endGame(roomId, role);
      return;
    }

    // Switch turn
    gs.turn = targetRole;
    io.to(roomId).emit("raid_turn", { turn: gs.turn });
    startRaidTurnTimer(roomId);
  });
  socket.on("request_rematch", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.rematchCount++;
    if (room.rematchCount === 2) {
      room.rematchCount = 0;
      room.readyCount   = 0;
      room.cameraReady  = 0;
      if (room.gameLoop) clearInterval(room.gameLoop);
      io.to(roomId).emit("go_to_picker");
    } else {
      socket.to(roomId).emit("opponent_wants_rematch");
    }
  });

  socket.on("disconnect", () => {
    // Clear from any waiting queue
    for (const game of ["pong", "snake"]) {
      if (waitingQueues[game] === socket.id) waitingQueues[game] = null;
    }
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        if (room.gameLoop)      clearInterval(room.gameLoop);
        if (room.reactionTimer) clearTimeout(room.reactionTimer);
        if (room.turnTimer)     clearTimeout(room.turnTimer);
        socket.to(roomId).emit("opponent_left");
        rooms.delete(roomId);
        break;
      }
    }
  });
});

// ── Pong loop ─────────────────────────────────────────────────────
function startPongLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);

  const W = 800, H = 400, PH = 80, BS = 10, WIN = 5, INC = 0.6, MAX_SPEED = 18;

  room.gameLoop = setInterval(() => {
    if (!room.gameState.running) return;
    const gs = room.gameState;
    const b  = gs.ball;

    b.x += b.vx; b.y += b.vy;

    if (b.y <= 0 || b.y >= H - BS) { b.vy *= -1; b.y = b.y <= 0 ? 0 : H - BS; }

    if (b.x <= 42 && b.x >= 30 && b.y + BS >= gs.paddles.left && b.y <= gs.paddles.left + PH) {
      b.vx = Math.min(Math.abs(b.vx) + INC, MAX_SPEED);
      b.vy = ((b.y - gs.paddles.left) / PH - 0.5) * 10;
    }
    if (b.x >= W-42 && b.x <= W-30 && b.y + BS >= gs.paddles.right && b.y <= gs.paddles.right + PH) {
      b.vx = -Math.min(Math.abs(b.vx) + INC, MAX_SPEED);
      b.vy = ((b.y - gs.paddles.right) / PH - 0.5) * 10;
    }
    if (b.x < 0) {
      gs.scores.right++;
      if (gs.scores.right >= WIN) { endGame(roomId, "right"); return; }
      gs.ball = { x:400, y:200, vx:7, vy:(Math.random()-0.5)*6 };
    }
    if (b.x > W) {
      gs.scores.left++;
      if (gs.scores.left >= WIN) { endGame(roomId, "left"); return; }
      gs.ball = { x:400, y:200, vx:-7, vy:(Math.random()-0.5)*6 };
    }
    io.to(roomId).emit("game_state", { gameState: gs });
  }, 1000 / 30);
}

// ── Snake loop ────────────────────────────────────────────────────
function startSnakeLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);

  const GW = 40, GH = 20;

  room.gameLoop = setInterval(() => {
    if (!room.gameState.running) return;
    const gs = room.gameState;

    for (const role of ["left", "right"]) {
      const snake = gs.snakes[role];
      if (!snake.alive) continue;

      // Apply queued direction
      snake.dir = snake.nextDir;

      const head = snake.body[0];
      const newHead = {
        x: (head.x + snake.dir.x + GW) % GW,
        y: (head.y + snake.dir.y + GH) % GH
      };

      // Self collision
      if (snake.body.some(s => s.x === newHead.x && s.y === newHead.y)) {
        snake.alive = false; continue;
      }

      snake.body.unshift(newHead);

      if (newHead.x === gs.food.x && newHead.y === gs.food.y) {
        gs.scores[role]++;
        spawnFood(gs);
      } else {
        snake.body.pop();
      }
    }

    // Cross-collision: did a head land on the other snake's body?
    for (const [r, other] of [["left","right"],["right","left"]]) {
      const h = gs.snakes[r].body[0];
      if (!h) continue;
      if (gs.snakes[other].body.some(s => s.x === h.x && s.y === h.y)) {
        gs.snakes[r].alive = false;
      }
    }

    // Head-on
    const lh = gs.snakes.left.body[0];
    const rh = gs.snakes.right.body[0];
    if (lh && rh && lh.x === rh.x && lh.y === rh.y) {
      gs.snakes.left.alive = false;
      gs.snakes.right.alive = false;
    }

    io.to(roomId).emit("game_state", { gameState: gs });

    const la = gs.snakes.left.alive, ra = gs.snakes.right.alive;
    if (!la && !ra) { endGame(roomId, "draw");  return; }
    if (!la)        { endGame(roomId, "right"); return; }
    if (!ra)        { endGame(roomId, "left");  return; }

  }, 1000 / 8);
}

// ── Reaction round ────────────────────────────────────────────────
function startReactionRound(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  gs.phase = "waiting";
  gs.tapped = {};
  gs.flashTime = null;

  io.to(roomId).emit("reaction_waiting", {
    round: gs.round,
    totalRounds: gs.totalRounds,
    scores: gs.scores
  });

  // Random delay 1.5–5 seconds before green light
  const delay = 1500 + Math.random() * 3500;
  room.reactionTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.gameState.phase = "ready";
    r.gameState.flashTime = Date.now();
    io.to(roomId).emit("reaction_go");
  }, delay);
}

// ── 4 Dots timer and handlers ─────────────────────────────────────
function startFourDotsTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState || room.gameState.game !== "fourdots") return;
  const gs = room.gameState;
  if (gs.phase !== "playing") return;

  if (room.turnTimer) clearTimeout(room.turnTimer);
  io.to(roomId).emit("fourdots_turn", { turn: gs.turn, board: gs.board });

  room.turnTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || !r.gameState || r.gameState.game !== "fourdots") return;
    const gs = r.gameState;
    if (gs.phase !== "playing") return;

    // Time up — find a valid random column
    const validCols = [];
    for (let c = 0; c < COLS; c++) if (!gs.board[0][c]) validCols.push(c);
    if (validCols.length === 0) return;
    const col = validCols[Math.floor(Math.random() * validCols.length)];

    io.to(roomId).emit("fourdots_timeout", { role: gs.turn });
    processDotsMove(roomId, gs.turn, col);
  }, 5000);
}

function processDotsMove(roomId, role, col) {
  const room = rooms.get(roomId);
  if (!room || !room.gameState) return;
  const gs = room.gameState;

  const row = dropPiece(gs.board, col, role);
  if (row === -1) return; // column full — ignore

  const result = checkWinner(gs.board);

  io.to(roomId).emit("fourdots_drop", {
    col, row, role,
    board: gs.board,
    result: result || null
  });

  if (result) {
    gs.phase = "done";
    if (room.turnTimer) clearTimeout(room.turnTimer);
    if (result.draw) {
      endGame(roomId, "draw");
    } else {
      endGame(roomId, result.winner);
    }
    return;
  }

  // Switch turn
  gs.turn = role === "left" ? "right" : "left";
  startFourDotsTimer(roomId);
}

io.on("connection_fourdots_placeholder", () => {}); // placeholder — handlers added in main io.on block
function startRaidTurnTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.turnTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || !r.gameState || r.gameState.game !== "raid") return;
    const gs = r.gameState;
    if (gs.phase !== "combat") return;

    // Time up — the player whose turn it was loses
    const loser  = gs.turn;
    const winner = loser === "left" ? "right" : "left";

    io.to(roomId).emit("raid_timeout", { role: loser });
    gs.phase  = "done";
    gs.winner = winner;
    endGame(roomId, winner);
  }, 15000);
}

function endGame(roomId, winner) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.gameState.running = false;
  room.gameState.winner  = winner;

  // Build scores for game_over event — raid uses sunk counts
  let scores = room.gameState.scores;
  if (room.gameState.game === "raid") {
    scores = {
      left:  room.gameState.boards.left.sunk,
      right: room.gameState.boards.right.sunk
    };
  }
  io.to(roomId).emit("game_over", { winner, scores });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Arcade server running on http://localhost:${PORT}`));
