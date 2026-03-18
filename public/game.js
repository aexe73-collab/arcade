// ── ArcadeFace Client ───────────────────────────────────────────
// Handles: screen navigation, matchmaking, WebRTC video,
//          Pong game rendering, keyboard/touch controls,
//          face-off countdown before game starts

const socket = io();

// ── State ───────────────────────────────────────────────────────
let myRole    = null;
let roomId    = null;
let gameState = null;
let localStream  = null;
let peerConn     = null;
let animFrameId  = null;

const canvas = document.getElementById("pong-canvas");
const ctx    = canvas.getContext("2d");
const keys   = {};

// ── Screen helpers ───────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function showOverlay(id)  { document.getElementById(id).classList.remove("hidden"); }
function hideOverlay(id)  { document.getElementById(id).classList.add("hidden"); }

// ── Camera ───────────────────────────────────────────────────────
async function getCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("video-local").srcObject       = localStream;
    document.getElementById("video-faceoff-local").srcObject = localStream;
    return true;
  } catch (e) {
    console.warn("Camera not available:", e.message);
    return false;
  }
}

// ── Countdown ────────────────────────────────────────────────────
function startCountdown(onComplete) {
  showScreen("screen-faceoff");
  let count = 3;
  const el = document.getElementById("countdown-number");

  el.textContent = count;

  const tick = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(tick);
      el.textContent = "GO!";
      el.style.color = "#ff3366";
      setTimeout(onComplete, 700);
    } else {
      el.textContent = count;
      // Re-trigger animation by removing and re-adding
      el.style.animation = "none";
      el.offsetHeight; // force reflow
      el.style.animation = "count-pulse 0.9s ease-out";
      el.style.color = count === 1 ? "#ff3366" : "#00ff88";
    }
  }, 1000);
}

// ── WebRTC setup ─────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject" }
  ]
};

async function startPeerConnection(isInitiator) {
  peerConn = new RTCPeerConnection(ICE_SERVERS);

  if (localStream) {
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  }

  peerConn.ontrack = (event) => {
    const remoteStream = event.streams[0];
    document.getElementById("video-remote").srcObject        = remoteStream;
    document.getElementById("video-faceoff-remote").srcObject = remoteStream;
  };

  peerConn.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc_ice", { roomId, candidate: event.candidate });
    }
  };

  if (isInitiator) {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit("webrtc_offer", { roomId, offer });
  }
}

// ── Pong rendering ────────────────────────────────────────────────
const W = 800;
const H = 400;
const PADDLE_W = 12;
const PADDLE_H = 80;
const BALL_SIZE = 10;

function drawGame(gs) {
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  ctx.setLineDash([8, 12]);
  ctx.strokeStyle = "#2a2a3e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#00ff88";
  ctx.fillRect(30, gs.paddles.left, PADDLE_W, PADDLE_H);

  ctx.fillStyle = "#ff3366";
  ctx.fillRect(W - 30 - PADDLE_W, gs.paddles.right, PADDLE_W, PADDLE_H);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(gs.ball.x, gs.ball.y, BALL_SIZE, BALL_SIZE);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(gs.ball.x - 4, gs.ball.y - 4, BALL_SIZE + 8, BALL_SIZE + 8);
}

function drawWaiting() {
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2a2a3e";
  ctx.font = "bold 14px 'DM Mono'";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for opponent...", W / 2, H / 2);
}

function startRenderLoop() {
  function loop() {
    if (gameState) drawGame(gameState);
    animFrameId = requestAnimationFrame(loop);
  }
  loop();
}

function stopRenderLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
}

// ── Score display ─────────────────────────────────────────────────
function updateScoreDisplay(scores) {
  const myScore   = myRole === "left" ? scores.left  : scores.right;
  const themScore = myRole === "left" ? scores.right : scores.left;

  // Mobile score bar
  document.getElementById("score-left").textContent  = myScore;
  document.getElementById("score-right").textContent = themScore;

  // Desktop side panels
  document.getElementById("panel-score-you").textContent  = myScore;
  document.getElementById("panel-score-them").textContent = themScore;

  // Desktop canvas score
  document.getElementById("ds-score-you").textContent  = myScore;
  document.getElementById("ds-score-them").textContent = themScore;
}

// ── Keyboard input ────────────────────────────────────────────────
document.addEventListener("keydown", e => { keys[e.key] = true; });
document.addEventListener("keyup",   e => { keys[e.key] = false; });

setInterval(() => {
  if (!gameState || !roomId || !myRole) return;
  const paddle = myRole === "left" ? gameState.paddles.left : gameState.paddles.right;
  let newY = paddle;

  if (keys["w"] || keys["W"] || keys["ArrowUp"])   newY -= 8;
  if (keys["s"] || keys["S"] || keys["ArrowDown"])  newY += 8;

  newY = Math.max(0, Math.min(H - PADDLE_H, newY));

  if (newY !== paddle) {
    if (myRole === "left")  gameState.paddles.left  = newY;
    if (myRole === "right") gameState.paddles.right = newY;
    socket.emit("paddle_move", { roomId, role: myRole, y: newY });
  }
}, 1000 / 20);

// ── Touch / mouse controls ────────────────────────────────────────
canvas.addEventListener("touchmove", (e) => {
  if (!gameState || !myRole) return;
  e.preventDefault();
  const rect  = canvas.getBoundingClientRect();
  const scaleY = H / rect.height;
  const newY   = Math.max(0, Math.min(H - PADDLE_H,
    (e.touches[0].clientY - rect.top) * scaleY - PADDLE_H / 2));
  if (myRole === "left")  gameState.paddles.left  = newY;
  if (myRole === "right") gameState.paddles.right = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
}, { passive: false });

canvas.addEventListener("mousemove", (e) => {
  if (!gameState || !myRole) return;
  const rect  = canvas.getBoundingClientRect();
  const scaleY = H / rect.height;
  const newY   = Math.max(0, Math.min(H - PADDLE_H,
    (e.clientY - rect.top) * scaleY - PADDLE_H / 2));
  if (myRole === "left")  gameState.paddles.left  = newY;
  if (myRole === "right") gameState.paddles.right = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
});

// ── Socket events ─────────────────────────────────────────────────

socket.on("waiting", () => {
  showScreen("screen-waiting");
  drawWaiting();
});

socket.on("match_found", async ({ roomId: rid, role, opponentId }) => {
  roomId = rid;
  myRole = role;

  // Start WebRTC
  await startPeerConnection(role === "left");

  // Show countdown — when it ends, signal ready and show game
  startCountdown(() => {
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
  catch (e) { console.warn("ICE error:", e.message); }
});

socket.on("game_start", ({ gameState: gs }) => {
  gameState = gs;
  document.getElementById("game-status").textContent = "FIRST TO 5";
  updateScoreDisplay(gs.scores);
});

socket.on("game_state", ({ gameState: gs }) => {
  gameState = gs;
  updateScoreDisplay(gs.scores);
});

socket.on("game_over", ({ winner, scores }) => {
  stopRenderLoop();

  const iWon = winner === myRole;
  const badge = document.getElementById("result-badge");
  badge.textContent = iWon ? "YOU WIN!" : "YOU LOSE";
  badge.className   = "result-badge" + (iWon ? "" : " loss");

  const myScore   = myRole === "left" ? scores.left  : scores.right;
  const themScore = myRole === "left" ? scores.right : scores.left;
  document.getElementById("final-score").textContent = `${myScore} — ${themScore}`;
  document.getElementById("rematch-status").textContent = "";

  showScreen("screen-gameover");
});

socket.on("opponent_wants_rematch", () => {
  document.getElementById("rematch-status").textContent = "OPPONENT WANTS REMATCH...";
});

socket.on("opponent_left", () => {
  stopRenderLoop();
  showOverlay("overlay-left");
});

// ── UI button handlers ────────────────────────────────────────────

document.getElementById("btn-find-match").addEventListener("click", async () => {
  const hasCam = await getCamera();
  if (!hasCam) {
    showOverlay("overlay-camera");
  } else {
    socket.emit("find_match");
  }
});

document.getElementById("btn-allow-camera").addEventListener("click", async () => {
  hideOverlay("overlay-camera");
  await getCamera();
  socket.emit("find_match");
});

document.getElementById("btn-skip-camera").addEventListener("click", () => {
  hideOverlay("overlay-camera");
  socket.emit("find_match");
});

document.getElementById("btn-cancel-wait").addEventListener("click", () => {
  socket.disconnect();
  socket.connect();
  showScreen("screen-home");
});

document.getElementById("btn-rematch").addEventListener("click", () => {
  document.getElementById("rematch-status").textContent = "WAITING FOR OPPONENT...";
  socket.emit("request_rematch", { roomId });
  startRenderLoop();
  showScreen("screen-game");
});

document.getElementById("btn-next-stranger").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  socket.emit("find_match");
});

document.getElementById("btn-home").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-home");
});

document.getElementById("btn-left-home").addEventListener("click", () => {
  hideOverlay("overlay-left");
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-home");
  socket.emit("find_match");
});

// ── State ───────────────────────────────────────────────────────
let myRole    = null;   // "left" or "right"
let roomId    = null;
let gameState = null;
let localStream  = null;
let peerConn     = null;
let animFrameId  = null;

// Canvas / context
const canvas = document.getElementById("pong-canvas");
const ctx    = canvas.getContext("2d");

// Input
const keys = {};

// ── Screen helpers ───────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function showOverlay(id)  { document.getElementById(id).classList.remove("hidden"); }
function hideOverlay(id)  { document.getElementById(id).classList.add("hidden"); }

// ── Camera ───────────────────────────────────────────────────────
async function getCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("video-local").srcObject = localStream;
    return true;
  } catch (e) {
    console.warn("Camera not available:", e.message);
    return false;
  }
}

// ── WebRTC setup ─────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

async function startPeerConnection(isInitiator) {
  peerConn = new RTCPeerConnection(ICE_SERVERS);

  // Add local tracks if we have camera
  if (localStream) {
    localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  }

  // Receive remote video
  peerConn.ontrack = (event) => {
    document.getElementById("video-remote").srcObject = event.streams[0];
  };

  // Send ICE candidates via server
  peerConn.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc_ice", { roomId, candidate: event.candidate });
    }
  };

  if (isInitiator) {
    // Left player creates offer
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit("webrtc_offer", { roomId, offer });
  }
}

// ── Pong rendering ────────────────────────────────────────────────
const W = 800;
const H = 400;
const PADDLE_W = 12;
const PADDLE_H = 80;
const BALL_SIZE = 10;

function drawGame(gs) {
  // Background
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  // Centre dashed line
  ctx.setLineDash([8, 12]);
  ctx.strokeStyle = "#2a2a3e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  // Paddles
  ctx.fillStyle = "#00ff88";
  ctx.fillRect(30, gs.paddles.left, PADDLE_W, PADDLE_H);

  ctx.fillStyle = "#ff3366";
  ctx.fillRect(W - 30 - PADDLE_W, gs.paddles.right, PADDLE_W, PADDLE_H);

  // Ball — pixel square with glow trail effect
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(gs.ball.x, gs.ball.y, BALL_SIZE, BALL_SIZE);

  // Subtle ball glow
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(gs.ball.x - 4, gs.ball.y - 4, BALL_SIZE + 8, BALL_SIZE + 8);
}

function drawWaiting() {
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2a2a3e";
  ctx.font = "bold 14px 'DM Mono'";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for opponent...", W / 2, H / 2);
}

// ── Game loop (client-side rendering only) ────────────────────────
function startRenderLoop() {
  function loop() {
    if (gameState) drawGame(gameState);
    animFrameId = requestAnimationFrame(loop);
  }
  loop();
}

function stopRenderLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
}

// ── Keyboard input ────────────────────────────────────────────────
document.addEventListener("keydown", e => { keys[e.key] = true; });
document.addEventListener("keyup",   e => { keys[e.key] = false; });

// Send paddle position to server at ~30fps
setInterval(() => {
  if (!gameState || !roomId || !myRole) return;
  const paddle = myRole === "left" ? gameState.paddles.left : gameState.paddles.right;
  let newY = paddle;

  if (keys["w"] || keys["W"] || keys["ArrowUp"])   newY -= 8;
  if (keys["s"] || keys["S"] || keys["ArrowDown"])  newY += 8;

  newY = Math.max(0, Math.min(H - PADDLE_H, newY));

  if (newY !== paddle) {
    if (myRole === "left")  gameState.paddles.left  = newY;
    if (myRole === "right") gameState.paddles.right = newY;
    socket.emit("paddle_move", { roomId, role: myRole, y: newY });
  }
}, 1000 / 20);

// ── Touch / mouse drag for mobile ────────────────────────────────
let isDragging = false;

canvas.addEventListener("touchstart", (e) => { isDragging = true; });
canvas.addEventListener("touchend",   () => { isDragging = false; });
canvas.addEventListener("touchmove",  (e) => {
  if (!isDragging || !gameState || !myRole) return;
  e.preventDefault();
  const rect  = canvas.getBoundingClientRect();
  const scaleY = H / rect.height;
  const touchY = (e.touches[0].clientY - rect.top) * scaleY;
  const newY   = Math.max(0, Math.min(H - PADDLE_H, touchY - PADDLE_H / 2));

  if (myRole === "left")  gameState.paddles.left  = newY;
  if (myRole === "right") gameState.paddles.right = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
}, { passive: false });

canvas.addEventListener("mousemove", (e) => {
  if (!gameState || !myRole) return;
  const rect  = canvas.getBoundingClientRect();
  const scaleY = H / rect.height;
  const mouseY = (e.clientY - rect.top) * scaleY;
  const newY   = Math.max(0, Math.min(H - PADDLE_H, mouseY - PADDLE_H / 2));

  if (myRole === "left")  gameState.paddles.left  = newY;
  if (myRole === "right") gameState.paddles.right = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
});

// ── Score display helper ──────────────────────────────────────────
function updateScoreDisplay(scores) {
  if (myRole === "left") {
    document.getElementById("score-left").textContent  = scores.left;
    document.getElementById("score-right").textContent = scores.right;
  } else {
    document.getElementById("score-left").textContent  = scores.right;
    document.getElementById("score-right").textContent = scores.left;
  }
}

// ── Socket events ─────────────────────────────────────────────────

// Server tells us we're in the queue
socket.on("waiting", () => {
  showScreen("screen-waiting");
  drawWaiting();
});

// Match found — set up WebRTC
socket.on("match_found", async ({ roomId: rid, role, opponentId }) => {
  roomId = rid;
  myRole = role;

  document.getElementById("game-status").textContent = "CONNECTING...";
  showScreen("screen-game");
  startRenderLoop();

  // Left player initiates the WebRTC offer
  await startPeerConnection(role === "left");

  // Tell server we're ready to start once connection is up
  // Give a short delay for signalling to complete
  setTimeout(() => {
    socket.emit("player_ready", { roomId });
  }, 2000);
});

// WebRTC signalling relay
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
  try {
    await peerConn.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn("ICE error:", e.message);
  }
});

// Game starts
socket.on("game_start", ({ gameState: gs }) => {
  gameState = gs;
  document.getElementById("game-status").textContent = "FIRST TO 5";
  updateScoreDisplay(gs.scores);
});

// Live game state from server
socket.on("game_state", ({ gameState: gs }) => {
  gameState = gs;
  updateScoreDisplay(gs.scores);
});

// Game over
socket.on("game_over", ({ winner, scores }) => {
  stopRenderLoop();

  const iWon = winner === myRole;
  const badge = document.getElementById("result-badge");
  badge.textContent = iWon ? "YOU WIN!" : "YOU LOSE";
  badge.className   = "result-badge" + (iWon ? "" : " loss");

  const leftScore  = myRole === "left" ? scores.left  : scores.right;
  const rightScore = myRole === "left" ? scores.right : scores.left;
  document.getElementById("final-score").textContent = `${leftScore} — ${rightScore}`;
  document.getElementById("rematch-status").textContent = "";

  showScreen("screen-gameover");
});

// Opponent wants a rematch
socket.on("opponent_wants_rematch", () => {
  document.getElementById("rematch-status").textContent = "OPPONENT WANTS REMATCH...";
});

// Opponent disconnected mid-game
socket.on("opponent_left", () => {
  stopRenderLoop();
  showOverlay("overlay-left");
});

// ── UI button handlers ────────────────────────────────────────────

// Home → Find match
document.getElementById("btn-find-match").addEventListener("click", async () => {
  const hasCam = await getCamera();
  if (!hasCam) {
    // Show camera overlay but let them continue without
    showOverlay("overlay-camera");
  } else {
    socket.emit("find_match");
  }
});

// Camera overlay
document.getElementById("btn-allow-camera").addEventListener("click", async () => {
  hideOverlay("overlay-camera");
  await getCamera();
  socket.emit("find_match");
});

document.getElementById("btn-skip-camera").addEventListener("click", () => {
  hideOverlay("overlay-camera");
  socket.emit("find_match");
});

// Cancel waiting
document.getElementById("btn-cancel-wait").addEventListener("click", () => {
  socket.disconnect();
  socket.connect();
  showScreen("screen-home");
});

// Rematch
document.getElementById("btn-rematch").addEventListener("click", () => {
  document.getElementById("rematch-status").textContent = "WAITING FOR OPPONENT...";
  socket.emit("request_rematch", { roomId });
  startRenderLoop();
  showScreen("screen-game");
});

// Next stranger
document.getElementById("btn-next-stranger").addEventListener("click", () => {
  // Clean up existing connection
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  socket.emit("find_match");
});

// Back to home
document.getElementById("btn-home").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-home");
});

// Opponent left overlay → back to home
document.getElementById("btn-left-home").addEventListener("click", () => {
  hideOverlay("overlay-left");
  if (peerConn) { peerConn.close(); peerConn = null; }
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-home");
  socket.emit("find_match");
});
