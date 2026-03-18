const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

let waitingPlayer = null;
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 9);
}

// ── Pong state ────────────────────────────────────────────────────
function createPongState() {
  return {
    game: "pong",
    ball: { x: 400, y: 200, vx: 4, vy: 3 },
    paddles: { left: 160, right: 160 },
    scores: { left: 0, right: 0 },
    running: false,
    winner: null
  };
}

// ── Snake state ───────────────────────────────────────────────────
const GRID = 20;       // cells across and down
const CELL = 20;       // px per cell (800/20 = 40, 400/20 = 20)

function createSnakeState() {
  return {
    game: "snake",
    snakes: {
      left:  { body: [{x:5, y:10},{x:4,y:10},{x:3,y:10}], dir: {x:1,y:0}, alive: true },
      right: { body: [{x:35,y:10},{x:36,y:10},{x:37,y:10}], dir: {x:-1,y:0}, alive: true }
    },
    food: { x: 20, y: 10 },
    scores: { left: 0, right: 0 },
    running: false,
    winner: null
  };
}

function spawnFood(gs) {
  const occupied = new Set();
  [...gs.snakes.left.body, ...gs.snakes.right.body].forEach(s => occupied.add(`${s.x},${s.y}`));
  let x, y;
  do {
    x = Math.floor(Math.random() * 40);
    y = Math.floor(Math.random() * 20);
  } while (occupied.has(`${x},${y}`));
  gs.food = { x, y };
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("find_match", () => {
    if (waitingPlayer && waitingPlayer !== socket.id) {
      const roomId = generateRoomId();
      const player1 = waitingPlayer;
      const player2 = socket.id;
      waitingPlayer = null;

      io.sockets.sockets.get(player1)?.join(roomId);
      socket.join(roomId);

      rooms.set(roomId, {
        players: [player1, player2],
        gameState: null,
        gameLoop: null,
        readyCount: 0,
        rematchCount: 0,
        voteCounts: {}
      });

      io.to(player1).emit("match_found", { roomId, role: "left",  opponentId: player2 });
      io.to(player2).emit("match_found", { roomId, role: "right", opponentId: player1 });
      console.log(`Room ${roomId}: ${player1} vs ${player2}`);
    } else {
      waitingPlayer = socket.id;
      socket.emit("waiting");
    }
  });

  // WebRTC signalling
  socket.on("webrtc_offer",  ({ roomId, offer })     => socket.to(roomId).emit("webrtc_offer",  { offer }));
  socket.on("webrtc_answer", ({ roomId, answer })    => socket.to(roomId).emit("webrtc_answer", { answer }));
  socket.on("webrtc_ice",    ({ roomId, candidate }) => socket.to(roomId).emit("webrtc_ice",    { candidate }));

  // ── Game vote: both players pick a game, majority wins ──────────
  socket.on("vote_game", ({ roomId, game }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.voteCounts) room.voteCounts = {};
    room.voteCounts[socket.id] = game;

    const votes = Object.values(room.voteCounts);
    if (votes.length === 2) {
      // Pick the most voted; tie = pong
      const chosen = votes[0] === votes[1] ? votes[0] : "pong";
      room.gameState = chosen === "snake" ? createSnakeState() : createPongState();
      room.voteCounts = {};
      io.to(roomId).emit("game_chosen", { game: chosen });
    } else {
      socket.to(roomId).emit("opponent_voted");
    }
  });

  // ── Both ready → start ───────────────────────────────────────────
  socket.on("player_ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.readyCount++;
    if (room.readyCount === 2) {
      room.gameState.running = true;
      io.to(roomId).emit("game_start", { gameState: room.gameState });
      if (room.gameState.game === "snake") startSnakeLoop(roomId);
      else startPongLoop(roomId);
    }
  });

  // ── Pong: paddle move ────────────────────────────────────────────
  socket.on("paddle_move", ({ roomId, role, y }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    if (role === "left")  room.gameState.paddles.left  = y;
    if (role === "right") room.gameState.paddles.right = y;
  });

  // ── Snake: direction change ───────────────────────────────────────
  socket.on("snake_dir", ({ roomId, role, dir }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.game !== "snake") return;
    const snake = room.gameState.snakes[role];
    if (!snake || !snake.alive) return;
    // Prevent reversing
    if (dir.x !== -snake.dir.x || dir.y !== -snake.dir.y) {
      snake.dir = dir;
    }
  });

  // ── Rematch ───────────────────────────────────────────────────────
  socket.on("request_rematch", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.rematchCount++;
    if (room.rematchCount === 2) {
      room.rematchCount = 0;
      room.readyCount = 0;
      room.voteCounts = {};
      if (room.gameLoop) clearInterval(room.gameLoop);
      io.to(roomId).emit("show_game_picker");
    } else {
      socket.to(roomId).emit("opponent_wants_rematch");
    }
  });

  socket.on("disconnect", () => {
    if (waitingPlayer === socket.id) waitingPlayer = null;
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        if (room.gameLoop) clearInterval(room.gameLoop);
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

  const W = 800, H = 400, PADDLE_H = 80, BALL_SIZE = 10;
  const WIN_SCORE = 5, SPEED_INC = 0.15;

  room.gameLoop = setInterval(() => {
    if (!room.gameState.running) return;
    const gs = room.gameState;
    const ball = gs.ball;

    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.y <= 0 || ball.y >= H - BALL_SIZE) {
      ball.vy *= -1;
      ball.y = ball.y <= 0 ? 0 : H - BALL_SIZE;
    }
    if (ball.x <= 42 && ball.x >= 30 && ball.y + BALL_SIZE >= gs.paddles.left && ball.y <= gs.paddles.left + PADDLE_H) {
      ball.vx = Math.abs(ball.vx) + SPEED_INC;
      ball.vy = ((ball.y - gs.paddles.left) / PADDLE_H - 0.5) * 8;
    }
    if (ball.x >= W - 42 && ball.x <= W - 30 && ball.y + BALL_SIZE >= gs.paddles.right && ball.y <= gs.paddles.right + PADDLE_H) {
      ball.vx = -(Math.abs(ball.vx) + SPEED_INC);
      ball.vy = ((ball.y - gs.paddles.right) / PADDLE_H - 0.5) * 8;
    }
    if (ball.x < 0) {
      gs.scores.right++;
      if (gs.scores.right >= WIN_SCORE) { endGame(roomId, "right"); return; }
      gs.ball = { x: 400, y: 200, vx: 4, vy: (Math.random() - 0.5) * 4 };
    }
    if (ball.x > W) {
      gs.scores.left++;
      if (gs.scores.left >= WIN_SCORE) { endGame(roomId, "left"); return; }
      gs.ball = { x: 400, y: 200, vx: -4, vy: (Math.random() - 0.5) * 4 };
    }
    io.to(roomId).emit("game_state", { gameState: gs });
  }, 1000 / 30);
}

// ── Snake loop ────────────────────────────────────────────────────
function startSnakeLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);

  const GRID_W = 40, GRID_H = 20;

  room.gameLoop = setInterval(() => {
    if (!room.gameState.running) return;
    const gs = room.gameState;
    const roles = ["left", "right"];

    // Move each snake
    for (const role of roles) {
      const snake = gs.snakes[role];
      if (!snake.alive) continue;

      const head = snake.body[0];
      const newHead = {
        x: (head.x + snake.dir.x + GRID_W) % GRID_W,
        y: (head.y + snake.dir.y + GRID_H) % GRID_H
      };

      // Self collision
      if (snake.body.some(s => s.x === newHead.x && s.y === newHead.y)) {
        snake.alive = false;
        continue;
      }

      snake.body.unshift(newHead);

      // Ate food?
      if (newHead.x === gs.food.x && newHead.y === gs.food.y) {
        gs.scores[role]++;
        spawnFood(gs);
      } else {
        snake.body.pop();
      }
    }

    // Head-on collision between snakes
    const lh = gs.snakes.left.body[0];
    const rh = gs.snakes.right.body[0];
    if (lh && rh && lh.x === rh.x && lh.y === rh.y) {
      gs.snakes.left.alive = false;
      gs.snakes.right.alive = false;
    }

    // Check if a snake hit the other snake's body
    for (const [role, other] of [["left","right"],["right","left"]]) {
      const myHead = gs.snakes[role].body[0];
      if (!myHead) continue;
      const otherBody = gs.snakes[other].body.slice(1);
      if (otherBody.some(s => s.x === myHead.x && s.y === myHead.y)) {
        gs.snakes[role].alive = false;
      }
    }

    io.to(roomId).emit("game_state", { gameState: gs });

    // Check win condition
    const leftAlive  = gs.snakes.left.alive;
    const rightAlive = gs.snakes.right.alive;

    if (!leftAlive && !rightAlive) { endGame(roomId, "draw");  return; }
    if (!leftAlive)                { endGame(roomId, "right"); return; }
    if (!rightAlive)               { endGame(roomId, "left");  return; }

  }, 1000 / 8); // Snake runs at 8 ticks/sec — feels right
}

function endGame(roomId, winner) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);
  room.gameState.running = false;
  room.gameState.winner = winner;
  const scores = room.gameState.scores || { left: 0, right: 0 };
  io.to(roomId).emit("game_over", { winner, scores });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Arcade server running on http://localhost:${PORT}`);
});
