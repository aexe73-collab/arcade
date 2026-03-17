const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

// --- Matchmaking queue ---
// Stores socket IDs of players waiting for a match
let waitingPlayer = null;

// --- Active game rooms ---
// Map of roomId -> { players: [socketId, socketId], gameState: {...} }
const rooms = new Map();

function createGameState() {
  return {
    ball: { x: 400, y: 200, vx: 4, vy: 3 },
    paddles: { left: 160, right: 160 },  // y positions
    scores: { left: 0, right: 0 },
    running: false,
    winner: null
  };
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 9);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // --- Player joins the matchmaking queue ---
  socket.on("find_match", () => {
    if (waitingPlayer && waitingPlayer !== socket.id) {
      // Pair this player with the waiting player
      const roomId = generateRoomId();
      const player1 = waitingPlayer;
      const player2 = socket.id;
      waitingPlayer = null;

      // Both players join the room
      io.sockets.sockets.get(player1)?.join(roomId);
      socket.join(roomId);

      const gameState = createGameState();
      rooms.set(roomId, {
        players: [player1, player2],
        gameState,
        gameLoop: null
      });

      // Tell each player their role (left / right paddle) and room
      io.to(player1).emit("match_found", { roomId, role: "left",  opponentId: player2 });
      io.to(player2).emit("match_found", { roomId, role: "right", opponentId: player1 });

      console.log(`Room ${roomId}: ${player1} vs ${player2}`);
    } else {
      // No one waiting — join the queue
      waitingPlayer = socket.id;
      socket.emit("waiting");
      console.log("Player waiting:", socket.id);
    }
  });

  // --- WebRTC signalling (offer / answer / ICE candidates) ---
  // These are just relayed between the two players in a room

  socket.on("webrtc_offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("webrtc_offer", { offer });
  });

  socket.on("webrtc_answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("webrtc_answer", { answer });
  });

  socket.on("webrtc_ice", ({ roomId, candidate }) => {
    socket.to(roomId).emit("webrtc_ice", { candidate });
  });

  // --- Game: player signals they're ready ---
  socket.on("player_ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (!room.readyCount) room.readyCount = 0;
    room.readyCount++;

    if (room.readyCount === 2) {
      // Both players ready — start the game loop on the server
      room.gameState.running = true;
      io.to(roomId).emit("game_start", { gameState: room.gameState });
      startGameLoop(roomId);
    }
  });

  // --- Game: paddle movement from client ---
  socket.on("paddle_move", ({ roomId, role, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (role === "left")  room.gameState.paddles.left  = y;
    if (role === "right") room.gameState.paddles.right = y;
  });

  // --- Rematch request ---
  socket.on("request_rematch", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (!room.rematchCount) room.rematchCount = 0;
    room.rematchCount++;

    if (room.rematchCount === 2) {
      // Both want a rematch — reset and restart
      room.rematchCount = 0;
      room.readyCount = 2;
      room.gameState = createGameState();
      room.gameState.running = true;
      io.to(roomId).emit("game_start", { gameState: room.gameState });
      startGameLoop(roomId);
    } else {
      // Tell the other player their opponent wants a rematch
      socket.to(roomId).emit("opponent_wants_rematch");
    }
  });

  // --- Player disconnects ---
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);

    // Remove from waiting queue if they were in it
    if (waitingPlayer === socket.id) waitingPlayer = null;

    // Notify opponent and clean up room
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        clearInterval(room.gameLoop);
        socket.to(roomId).emit("opponent_left");
        rooms.delete(roomId);
        break;
      }
    }
  });
});

// --- Server-side game loop ---
// Runs at ~60fps, calculates ball physics, syncs state to both clients
function startGameLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Clear any existing loop
  if (room.gameLoop) clearInterval(room.gameLoop);

  const CANVAS_W = 800;
  const CANVAS_H = 400;
  const PADDLE_H = 80;
  const BALL_SIZE = 10;
  const WIN_SCORE = 5;
  const SPEED_INCREMENT = 0.15;

  room.gameLoop = setInterval(() => {
    if (!room.gameState.running) return;

    const gs = room.gameState;
    const ball = gs.ball;

    // Move ball
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Top / bottom wall bounce
    if (ball.y <= 0 || ball.y >= CANVAS_H - BALL_SIZE) {
      ball.vy *= -1;
      ball.y = ball.y <= 0 ? 0 : CANVAS_H - BALL_SIZE;
    }

    // Left paddle collision (x ~= 30, width 12)
    if (ball.x <= 42 && ball.x >= 30 &&
        ball.y + BALL_SIZE >= gs.paddles.left &&
        ball.y <= gs.paddles.left + PADDLE_H) {
      ball.vx = Math.abs(ball.vx) + SPEED_INCREMENT;
      // Add angle based on where ball hits paddle
      const hitPos = (ball.y - gs.paddles.left) / PADDLE_H;
      ball.vy = (hitPos - 0.5) * 8;
    }

    // Right paddle collision (x ~= CANVAS_W - 42)
    if (ball.x >= CANVAS_W - 42 && ball.x <= CANVAS_W - 30 &&
        ball.y + BALL_SIZE >= gs.paddles.right &&
        ball.y <= gs.paddles.right + PADDLE_H) {
      ball.vx = -(Math.abs(ball.vx) + SPEED_INCREMENT);
      const hitPos = (ball.y - gs.paddles.right) / PADDLE_H;
      ball.vy = (hitPos - 0.5) * 8;
    }

    // Score: ball exits left side
    if (ball.x < 0) {
      gs.scores.right++;
      if (gs.scores.right >= WIN_SCORE) {
        endGame(roomId, "right");
        return;
      }
      resetBall(gs, 1);
    }

    // Score: ball exits right side
    if (ball.x > CANVAS_W) {
      gs.scores.left++;
      if (gs.scores.left >= WIN_SCORE) {
        endGame(roomId, "left");
        return;
      }
      resetBall(gs, -1);
    }

    // Broadcast state to both players
    io.to(roomId).emit("game_state", { gameState: gs });

  }, 1000 / 60);

  room.gameLoop = room.gameLoop;
}

function resetBall(gs, direction) {
  gs.ball = {
    x: 400,
    y: 200,
    vx: 4 * direction,
    vy: (Math.random() - 0.5) * 4
  };
}

function endGame(roomId, winner) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearInterval(room.gameLoop);
  room.gameState.running = false;
  room.gameState.winner = winner;
  io.to(roomId).emit("game_over", { winner, scores: room.gameState.scores });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Arcade server running on http://localhost:${PORT}`);
});
