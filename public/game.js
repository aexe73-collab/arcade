// ── ArcadeFace Client ─────────────────────────────────────────────
const socket = io();

let myRole      = null;
let roomId      = null;
let gameState   = null;
let currentGame = null;
let localStream = null;
let peerConn    = null;
let animFrameId = null;

const canvas = document.getElementById("pong-canvas");
const ctx    = canvas.getContext("2d");
const keys   = {};

// ── Screen helpers ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function showOverlay(id) { document.getElementById(id).classList.remove("hidden"); }
function hideOverlay(id) { document.getElementById(id).classList.add("hidden"); }

// ── Camera ────────────────────────────────────────────────────────
async function getCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    ["video-local","video-faceoff-local","video-mobile-local"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.srcObject = localStream;
    });
    return true;
  } catch (e) {
    console.warn("Camera unavailable:", e.message);
    return false;
  }
}

// ── Game picker (shown on home screen click) ──────────────────────
document.getElementById("btn-find-match").addEventListener("click", async () => {
  const hasCam = await getCamera();
  if (!hasCam) showOverlay("overlay-camera");
  else showScreen("screen-picker");
});

document.getElementById("btn-allow-camera").addEventListener("click", async () => {
  hideOverlay("overlay-camera");
  await getCamera();
  showScreen("screen-picker");
});

document.getElementById("btn-skip-camera").addEventListener("click", () => {
  hideOverlay("overlay-camera");
  showScreen("screen-picker");
});

document.getElementById("pick-pong").addEventListener("click", () => {
  currentGame = "pong";
  document.getElementById("waiting-sub").textContent = "Finding a Pong player\u2026";
  socket.emit("find_match", { game: "pong" });
  showScreen("screen-waiting");
});

document.getElementById("pick-snake").addEventListener("click", () => {
  currentGame = "snake";
  document.getElementById("waiting-sub").textContent = "Finding a Snake player\u2026";
  socket.emit("find_match", { game: "snake" });
  showScreen("screen-waiting");
});

// ── Countdown ─────────────────────────────────────────────────────
function startCountdown(onComplete) {
  showScreen("screen-faceoff");
  let count = 10;
  const el = document.getElementById("countdown-number");
  el.textContent = count;
  el.style.color = "#00ff88";

  const tick = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(tick);
      el.textContent = "GO!";
      el.style.color = "#ff3366";
      setTimeout(onComplete, 700);
    } else {
      el.textContent = count;
      el.style.animation = "none";
      el.offsetHeight;
      el.style.animation = "count-pulse 0.9s ease-out";
      el.style.color = count <= 3 ? "#ff3366" : "#00ff88";
    }
  }, 1000);
}

// ── WebRTC ────────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

async function startPeerConnection(isInitiator) {
  peerConn = new RTCPeerConnection(ICE_SERVERS);
  if (localStream) localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  peerConn.ontrack = (event) => {
    const s = event.streams[0];
    ["video-remote","video-faceoff-remote","video-mobile-remote"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.srcObject = s;
    });
  };

  peerConn.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc_ice", { roomId, candidate: e.candidate });
  };

  if (isInitiator) {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit("webrtc_offer", { roomId, offer });
  }
}

// ── Canvas / grid constants ───────────────────────────────────────
const W = 800, H = 400;
const PADDLE_W = 12, PADDLE_H = 80, BALL_SIZE = 10;
const CELL_W = W / 40, CELL_H = H / 20;

// ── Pong render ───────────────────────────────────────────────────
function drawPong(gs) {
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);
  ctx.setLineDash([8,12]);
  ctx.strokeStyle = "#2a2a3e";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#00ff88";
  ctx.fillRect(30, gs.paddles.left, PADDLE_W, PADDLE_H);
  ctx.fillStyle = "#ff3366";
  ctx.fillRect(W - 30 - PADDLE_W, gs.paddles.right, PADDLE_W, PADDLE_H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(gs.ball.x, gs.ball.y, BALL_SIZE, BALL_SIZE);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(gs.ball.x-4, gs.ball.y-4, BALL_SIZE+8, BALL_SIZE+8);
}

// ── Snake render ──────────────────────────────────────────────────
function drawSnake(gs) {
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  // Subtle grid dots
  ctx.fillStyle = "#1a1a26";
  for (let x = 0; x < 40; x++)
    for (let y = 0; y < 20; y++)
      ctx.fillRect(x*CELL_W + CELL_W/2-1, y*CELL_H + CELL_H/2-1, 2, 2);

  // Food
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(gs.food.x*CELL_W+2, gs.food.y*CELL_H+2, CELL_W-4, CELL_H-4);

  // Snakes — my snake is always green, opponent is pink
  const myColour   = "#00ff88";
  const themColour = "#ff3366";

  const myRole_    = myRole;
  const otherRole  = myRole_ === "left" ? "right" : "left";

  gs.snakes[myRole_].body.forEach((seg, i) => {
    ctx.fillStyle = gs.snakes[myRole_].alive
      ? (i === 0 ? myColour : myColour + "99")
      : "#333";
    ctx.fillRect(seg.x*CELL_W+1, seg.y*CELL_H+1, CELL_W-2, CELL_H-2);
  });

  gs.snakes[otherRole].body.forEach((seg, i) => {
    ctx.fillStyle = gs.snakes[otherRole].alive
      ? (i === 0 ? themColour : themColour + "99")
      : "#333";
    ctx.fillRect(seg.x*CELL_W+1, seg.y*CELL_H+1, CELL_W-2, CELL_H-2);
  });

  // Death flash
  if (!gs.snakes[myRole_].alive) {
    ctx.fillStyle = "rgba(255,51,102,0.12)";
    ctx.fillRect(0, 0, W, H);
  }
}

function drawWaiting() {
  ctx.fillStyle = "#0a0a0f"; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = "#2a2a3e"; ctx.font = "bold 14px 'DM Mono'"; ctx.textAlign = "center";
  ctx.fillText("Connecting...", W/2, H/2);
}

// ── Render loop ───────────────────────────────────────────────────
function startRenderLoop() {
  function loop() {
    if (gameState) {
      if (gameState.game === "snake") drawSnake(gameState);
      else drawPong(gameState);
    }
    animFrameId = requestAnimationFrame(loop);
  }
  loop();
}

function stopRenderLoop() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

// ── Game UI helpers ───────────────────────────────────────────────
function setupGameUI(game) {
  const hint  = document.getElementById("controls-hint");
  const dpad  = document.getElementById("dpad");
  const status = document.getElementById("game-status");

  if (game === "snake") {
    hint.innerHTML = '<span>Arrow keys / WASD &nbsp;&mdash;&nbsp; steer</span>';
    status.textContent = "FIRST TO 3 ROUNDS";
    dpad.style.display = "grid"; // shown on all screens for snake so mobile gets it
  } else {
    hint.innerHTML = '<span>W / S &nbsp;&mdash;&nbsp; move paddle</span><span class="hint-sep"> | </span><span>Or drag</span>';
    status.textContent = "FIRST TO 5";
    dpad.style.display = "none";
  }
}

function updateScoreDisplay(scores) {
  const my   = myRole === "left" ? scores.left  : scores.right;
  const them = myRole === "left" ? scores.right : scores.left;
  document.getElementById("score-left").textContent       = my;
  document.getElementById("score-right").textContent      = them;
  document.getElementById("panel-score-you").textContent  = my;
  document.getElementById("panel-score-them").textContent = them;
  document.getElementById("ds-score-you").textContent     = my;
  document.getElementById("ds-score-them").textContent    = them;
}

// ── Keyboard controls ─────────────────────────────────────────────
document.addEventListener("keydown", e => { keys[e.key] = true; });
document.addEventListener("keyup",   e => { keys[e.key] = false; });

// Pong paddle — interval
setInterval(() => {
  if (!gameState || gameState.game !== "pong" || !roomId || !myRole) return;
  const cur = myRole === "left" ? gameState.paddles.left : gameState.paddles.right;
  let newY = cur;
  if (keys["w"]||keys["W"]||keys["ArrowUp"])   newY -= 8;
  if (keys["s"]||keys["S"]||keys["ArrowDown"])  newY += 8;
  newY = Math.max(0, Math.min(H - PADDLE_H, newY));
  if (newY !== cur) {
    if (myRole === "left")  gameState.paddles.left  = newY;
    if (myRole === "right") gameState.paddles.right = newY;
    socket.emit("paddle_move", { roomId, role: myRole, y: newY });
  }
}, 1000/20);

// Snake direction — on keydown, prevent scroll
document.addEventListener("keydown", (e) => {
  if (!gameState || gameState.game !== "snake" || !roomId || !myRole) return;
  const map = {
    ArrowUp:{x:0,y:-1}, w:{x:0,y:-1}, W:{x:0,y:-1},
    ArrowDown:{x:0,y:1}, s:{x:0,y:1}, S:{x:0,y:1},
    ArrowLeft:{x:-1,y:0}, a:{x:-1,y:0}, A:{x:-1,y:0},
    ArrowRight:{x:1,y:0}, d:{x:1,y:0}, D:{x:1,y:0}
  };
  const dir = map[e.key];
  if (dir) { e.preventDefault(); socket.emit("snake_dir", { roomId, role: myRole, dir }); }
});

// ── D-pad (mobile Snake) ─────────────────────────────────────────
function sendSnakeDir(dir) {
  if (!gameState || gameState.game !== "snake" || !roomId || !myRole) return;
  socket.emit("snake_dir", { roomId, role: myRole, dir });
}

document.getElementById("dpad-up").addEventListener("click",    () => sendSnakeDir({x:0,y:-1}));
document.getElementById("dpad-down").addEventListener("click",  () => sendSnakeDir({x:0,y:1}));
document.getElementById("dpad-left").addEventListener("click",  () => sendSnakeDir({x:-1,y:0}));
document.getElementById("dpad-right").addEventListener("click", () => sendSnakeDir({x:1,y:0}));

// Swipe detection on canvas for mobile Snake
let touchStartX = 0, touchStartY = 0;
canvas.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

canvas.addEventListener("touchend", (e) => {
  if (!gameState || gameState.game !== "snake") return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return; // too small
  if (Math.abs(dx) > Math.abs(dy)) {
    sendSnakeDir(dx > 0 ? {x:1,y:0} : {x:-1,y:0});
  } else {
    sendSnakeDir(dy > 0 ? {x:0,y:1} : {x:0,y:-1});
  }
});

// Pong mouse + touch
canvas.addEventListener("mousemove", (e) => {
  if (!gameState || gameState.game !== "pong" || !myRole) return;
  const rect = canvas.getBoundingClientRect();
  const newY = Math.max(0, Math.min(H-PADDLE_H, (e.clientY-rect.top)*(H/rect.height)-PADDLE_H/2));
  if (myRole==="left") gameState.paddles.left=newY; else gameState.paddles.right=newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
});

canvas.addEventListener("touchmove", (e) => {
  if (!gameState || gameState.game !== "pong" || !myRole) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const newY = Math.max(0, Math.min(H-PADDLE_H, (e.touches[0].clientY-rect.top)*(H/rect.height)-PADDLE_H/2));
  if (myRole==="left") gameState.paddles.left=newY; else gameState.paddles.right=newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
}, { passive: false });

// ── Socket events ─────────────────────────────────────────────────
socket.on("waiting", () => { /* screen already shown */ });

socket.on("match_found", async ({ roomId: rid, role, game }) => {
  roomId      = rid;
  myRole      = role;
  currentGame = game;
  await startPeerConnection(role === "left");
  startCountdown(() => {
    setupGameUI(game);
    showScreen("screen-game");
    startRenderLoop();
    socket.emit("player_ready", { roomId });
  });
});

socket.on("webrtc_offer", async ({ offer }) => {
  if (!peerConn) await startPeerConnection(false);
  await peerConn.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConn.createAnswer();
  await peerConn.setLocalDescription(answer);
  socket.emit("webrtc_answer", { roomId, answer });
});

socket.on("webrtc_answer", async ({ answer }) => {
  await peerConn.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("webrtc_ice", async ({ candidate }) => {
  try { await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch (e) { console.warn("ICE:", e.message); }
});

socket.on("game_start", ({ gameState: gs }) => {
  gameState = gs;
  updateScoreDisplay(gs.scores);
});

socket.on("game_state", ({ gameState: gs }) => {
  gameState = gs;
  updateScoreDisplay(gs.scores);
});

socket.on("game_over", ({ winner, scores }) => {
  stopRenderLoop();
  const badge = document.getElementById("result-badge");
  if (winner === "draw") {
    badge.textContent = "DRAW!";
    badge.className   = "result-badge";
  } else {
    const iWon = winner === myRole;
    badge.textContent = iWon ? "YOU WIN!" : "YOU LOSE";
    badge.className   = "result-badge" + (iWon ? "" : " loss");
  }
  const my   = myRole === "left" ? scores.left  : scores.right;
  const them = myRole === "left" ? scores.right : scores.left;
  document.getElementById("final-score").textContent     = `${my} \u2014 ${them}`;
  document.getElementById("rematch-status").textContent  = "";
  showScreen("screen-gameover");
});

socket.on("go_to_picker", () => {
  stopRenderLoop();
  gameState = null;
  showScreen("screen-picker");
});

socket.on("opponent_wants_rematch", () => {
  document.getElementById("rematch-status").textContent = "OPPONENT WANTS REMATCH...";
});

socket.on("opponent_left", () => { stopRenderLoop(); showOverlay("overlay-left"); });

// ── Buttons ───────────────────────────────────────────────────────
document.getElementById("btn-cancel-wait").addEventListener("click", () => {
  socket.disconnect(); socket.connect();
  showScreen("screen-picker");
});

document.getElementById("btn-rematch").addEventListener("click", () => {
  document.getElementById("rematch-status").textContent = "WAITING FOR OPPONENT...";
  socket.emit("request_rematch", { roomId });
});

document.getElementById("btn-next-stranger").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-picker");
});

document.getElementById("btn-home").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  roomId = null; myRole = null; gameState = null; localStream = null;
  showScreen("screen-home");
});

document.getElementById("btn-left-home").addEventListener("click", () => {
  hideOverlay("overlay-left");
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-picker");
});
