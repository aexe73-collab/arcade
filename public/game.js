// ── ArcadeFace Client ─────────────────────────────────────────────
const socket = io();

let myRole      = null;
let roomId      = null;
let gameState   = null;
let currentGame = null;
let localStream = null;
let peerConn    = null;
let animFrameId = null;
let currentUser = null;   // Supabase user object
let playMode    = "random"; // random | friend | group

const canvas = document.getElementById("pong-canvas");
const ctx    = canvas.getContext("2d");
const keys   = {};

// ── Supabase auth ─────────────────────────────────────────────────
const SUPABASE_URL = window.SUPABASE_URL || "";
const SUPABASE_KEY = window.SUPABASE_ANON_KEY || "";
let sbClient = null;

function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { detectSessionInUrl: true, persistSession: true }
  });

  sbClient.auth.getSession().then(({ data: { session } }) => {
    if (session) { setUser(session.user); showScreen("screen-home"); }
  });

  sbClient.auth.onAuthStateChange((event, session) => {
    console.log("Auth event:", event, "user:", session?.user?.email || "none");
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) {
      setUser(session.user);
      showScreen("screen-home");
    } else if (event === "SIGNED_OUT") {
      setUser(null);
    }
  });
}

function setUser(user) {
  currentUser = user;
  const guestEl    = document.getElementById("home-guest");
  const signedinEl = document.getElementById("home-signed-in");
  const usernameEl = document.getElementById("home-username");

  if (user) {
    const name = user.user_metadata?.username
      || user.email?.split("@")[0]?.toUpperCase()
      || "PLAYER";
    if (usernameEl) usernameEl.textContent = name;
    guestEl?.classList.add("hidden");
    signedinEl?.classList.remove("hidden");
  } else {
    guestEl?.classList.remove("hidden");
    signedinEl?.classList.add("hidden");
  }
}

// ── Sign in screen handlers ───────────────────────────────────────
document.getElementById("btn-goto-signin").addEventListener("click", () => {
  showScreen("screen-signin");
});

document.getElementById("btn-back-home").addEventListener("click", () => {
  showScreen("screen-home");
});

document.getElementById("btn-send-link").addEventListener("click", async () => {
  const email = document.getElementById("signin-email").value.trim();
  if (!email || !email.includes("@")) {
    document.getElementById("signin-email").style.borderColor = "var(--accent2)";
    return;
  }
  if (!sbClient) {
    alert("Auth not configured — add SUPABASE_URL and SUPABASE_ANON_KEY.");
    return;
  }

  const btn = document.getElementById("btn-send-link");
  btn.textContent = "SENDING...";
  btn.disabled = true;

  const { error } = await sbClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: "https://www.arcadeface.com" }
  });

  btn.textContent = "SEND MAGIC LINK";
  btn.disabled = false;

  if (error) {
    console.error("Magic link error:", error.message);
    alert("Error: " + error.message);
    return;
  }

  document.getElementById("signin-form").classList.add("hidden");
  document.getElementById("signin-sent").classList.remove("hidden");
});

// Google OAuth removed — magic link only for now

document.getElementById("btn-signout").addEventListener("click", async () => {
  if (sbClient) await sbClient.auth.signOut();
  setUser(null);
  showScreen("screen-home");
});

// ── Mode selector ─────────────────────────────────────────────────
document.getElementById("btn-picker-back").addEventListener("click", () => {
  currentUser ? showScreen("screen-mode") : showScreen("screen-home");
});

document.getElementById("btn-mode-back").addEventListener("click", () => {
  showScreen("screen-home");
});

document.getElementById("mode-stranger").addEventListener("click", () => {
  playMode = "random";
  showScreen("screen-picker");
});

document.getElementById("mode-friend").addEventListener("click", () => {
  playMode = "friend";
  showFriendChallenge();
});

document.getElementById("mode-group").addEventListener("click", () => {
  playMode = "group";
  // Groups coming soon — show nudge for now
  alert("Group rooms coming soon! You'll be able to create a private group and challenge your friends to a leaderboard.");
});

// ── Friend challenge ──────────────────────────────────────────────
function showFriendChallenge() {
  const challengeId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const link = `https://www.arcadeface.com?challenge=${challengeId}`;
  window._challengeId = challengeId;

  // Show branded modal
  document.getElementById("challenge-link-input").value = link;
  showOverlay("overlay-challenge");
  showScreen("screen-picker");
}

document.getElementById("btn-copy-link").addEventListener("click", () => {
  const input = document.getElementById("challenge-link-input");
  navigator.clipboard?.writeText(input.value).catch(() => {
    input.select();
    document.execCommand("copy");
  });
  const btn = document.getElementById("btn-copy-link");
  const copied = document.getElementById("challenge-copied");
  btn.textContent = "✓";
  copied.style.display = "block";
  setTimeout(() => { btn.textContent = "COPY"; copied.style.display = "none"; }, 2000);
});

document.getElementById("btn-challenge-close").addEventListener("click", () => {
  hideOverlay("overlay-challenge");
});

// Check if arriving via challenge link
function checkChallengeLink() {
  const params = new URLSearchParams(window.location.search);
  const challenge = params.get("challenge");
  if (challenge) {
    window._challengeId = challenge;
    playMode = "friend";
    // Go straight to game picker
    setTimeout(() => showScreen("screen-picker"), 500);
  }
}

// ── Screen helpers ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  const onGame = id === "screen-game";
  const fixedGame = document.getElementById("banner-game-fixed");
  if (fixedGame) fixedGame.style.display = onGame ? "block" : "none";
}
function showOverlay(id) { document.getElementById(id).classList.remove("hidden"); }
function hideOverlay(id) { document.getElementById(id).classList.add("hidden"); }

// ── Camera ────────────────────────────────────────────────────────
async function getCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    ["video-local","video-faceoff-local","video-mobile-local","video-postgame-local"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.srcObject = localStream;
    });
    return true;
  } catch (e) {
    console.warn("Camera unavailable:", e.message);
    return false;
  }
}

// ── Camera permission helper ──────────────────────────────────────
async function requestCameraThenProceed(destination) {
  // Request camera silently — browser shows its own prompt if needed
  // Never show custom overlay — it flashes and confuses users
  await getCamera();
  showScreen(destination);
}

// ── Game picker (guest — home screen click) ───────────────────────
document.getElementById("btn-find-match").addEventListener("click", async () => {
  await requestCameraThenProceed("screen-picker");
});

// ── Play button (signed in) ───────────────────────────────────────
document.getElementById("btn-play-modes").addEventListener("click", async () => {
  await requestCameraThenProceed("screen-mode");
});

document.getElementById("btn-allow-camera").addEventListener("click", async () => {
  hideOverlay("overlay-camera");
  const hasCam = await getCamera();
  if (!hasCam) {
    alert("Camera still blocked. Click the camera icon in your browser address bar, allow access, then refresh.");
    return;
  }
  showScreen(window._cameraDestination || "screen-picker");
});

document.getElementById("btn-skip-camera").addEventListener("click", () => {
  hideOverlay("overlay-camera");
  showScreen(window._cameraDestination || "screen-picker");
});

document.getElementById("pick-pong").addEventListener("click", () => {
  currentGame = "pong";
  document.getElementById("waiting-sub").textContent = "Finding a Pong match\u2026";
  socket.emit("find_match", { game: "pong" });
  showScreen("screen-waiting");
});

document.getElementById("pick-raid").addEventListener("click", () => {
  currentGame = "raid";
  document.getElementById("waiting-sub").textContent = "Finding a Raid match\u2026";
  socket.emit("find_match", { game: "raid" });
  showScreen("screen-waiting");
});

// ── Sound effects ─────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Resume audio context on first user interaction (browser policy)
function resumeAudio() {
  if (audioCtx.state === "suspended") audioCtx.resume();
}
document.addEventListener("click",     resumeAudio, { once: false });
document.addEventListener("touchstart", resumeAudio, { once: false });

function playHitSound() {
  try {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(55, audioCtx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
  } catch(e) {}
}

function playMissSound() {
  try {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(330, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.start(); osc.stop(audioCtx.currentTime + 0.15);
  } catch(e) {}
}

function playSunkSound() {
  try {
    [0, 0.1, 0.2].forEach(delay => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = "square";
      osc.frequency.setValueAtTime(150 - delay * 200, audioCtx.currentTime + delay);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.2);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + 0.2);
    });
  } catch(e) {}
}
const RAID_SHIPS = [4, 3, 2, 2];
const GRID_SIZE  = 8;

let raidState = {
  myShips:      [],   // placed ships [{cells:[{x,y}]}]
  shipsToPlace: [...RAID_SHIPS],
  currentShipIdx: 0,
  orientation: "h",  // h | v
  myShots:      [],   // shots I've fired
  theirShots:   [],   // shots fired at me
  myTurn:       false,
  timerInterval: null
};

function buildRaidGrid(containerId, clickable, isEnemy) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = document.createElement("div");
      cell.className = "raid-cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (clickable) {
        cell.addEventListener("click",       () => isEnemy ? raidFire(x, y) : raidPlaceShip(x, y));
        cell.addEventListener("mouseenter",  () => !isEnemy && raidPreview(x, y, true));
        cell.addEventListener("mouseleave",  () => !isEnemy && raidClearPreview());
      }
      container.appendChild(cell);
    }
  }
}

function getRaidCell(containerId, x, y) {
  return document.querySelector(`#${containerId} [data-x="${x}"][data-y="${y}"]`);
}

function raidPreview(x, y, show) {
  raidClearPreview();
  if (!show) return;
  const size   = RAID_SHIPS[raidState.currentShipIdx];
  const orient = raidState.orientation;
  const cells  = getShipCells(x, y, size, orient);
  const valid  = cells && !collidesWithPlaced(cells);
  cells?.forEach(c => {
    const el = getRaidCell("raid-my-grid-place", c.x, c.y);
    if (el) el.classList.add(valid ? "preview" : "preview-invalid");
  });
}

function raidClearPreview() {
  document.querySelectorAll("#raid-my-grid-place .preview, #raid-my-grid-place .preview-invalid")
    .forEach(el => { el.classList.remove("preview", "preview-invalid"); });
}

function getShipCells(x, y, size, orient) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const cx = orient === "h" ? x + i : x;
    const cy = orient === "v" ? y + i : y;
    if (cx >= GRID_SIZE || cy >= GRID_SIZE) return null;
    cells.push({ x: cx, y: cy });
  }
  return cells;
}

function collidesWithPlaced(cells) {
  for (const ship of raidState.myShips) {
    for (const c of cells) {
      if (ship.cells.some(sc => sc.x === c.x && sc.y === c.y)) return true;
    }
  }
  return false;
}

function raidPlaceShip(x, y) {
  if (raidState.currentShipIdx >= RAID_SHIPS.length) return;
  const size  = RAID_SHIPS[raidState.currentShipIdx];
  const cells = getShipCells(x, y, size, raidState.orientation);
  if (!cells || collidesWithPlaced(cells)) return;

  raidState.myShips.push({ cells, size });

  // Mark cells on grid
  cells.forEach(c => {
    const el = getRaidCell("raid-my-grid-place", c.x, c.y);
    if (el) { el.classList.remove("preview", "preview-invalid"); el.classList.add("ship"); }
  });

  // Mark ship as placed in UI
  const btns = document.querySelectorAll(".raid-ship-btn");
  btns[raidState.currentShipIdx].classList.remove("active");
  btns[raidState.currentShipIdx].classList.add("placed");
  raidState.currentShipIdx++;

  if (raidState.currentShipIdx < RAID_SHIPS.length) {
    btns[raidState.currentShipIdx].classList.add("active");
    const remaining = RAID_SHIPS.length - raidState.currentShipIdx;
    document.getElementById("raid-placement-status").textContent = `${remaining} building${remaining > 1 ? "s" : ""} left to place`;
  } else {
    document.getElementById("raid-placement-status").textContent = "All buildings placed — ready to battle!";
    document.getElementById("raid-ready-btn").style.display = "block";
  }
}

function raidFire(x, y) {
  if (!raidState.myTurn) return;
  if (raidState.myShots.some(s => s.x === x && s.y === y)) return;
  socket.emit("raid_fire", { roomId, role: myRole, x, y });
}

function raidUpdateMyGrid() {
  // Show their shots on my grid
  raidState.theirShots.forEach(shot => {
    const el = getRaidCell("raid-my-grid-combat", shot.x, shot.y);
    if (!el) return;
    el.classList.add(shot.hit ? "hit" : "miss");
    el.classList.add("no-click");
  });
  // Show my ships on my grid
  raidState.myShips.forEach(ship => {
    ship.cells.forEach(c => {
      const el = getRaidCell("raid-my-grid-combat", c.x, c.y);
      if (el && !el.classList.contains("hit")) el.classList.add("ship");
    });
  });
}

function raidUpdateEnemyGrid() {
  raidState.myShots.forEach(shot => {
    const el = getRaidCell("raid-enemy-grid", shot.x, shot.y);
    if (!el) return;
    el.classList.add(shot.hit ? "hit" : "miss");
    el.classList.add("no-click");
  });
}

function raidStartTimer(seconds) {
  if (raidState.timerInterval) clearInterval(raidState.timerInterval);
  const fill = document.getElementById("raid-timer-fill");
  if (!fill) return;
  fill.style.transition = "none";
  fill.style.width = "100%";
  fill.classList.remove("urgent");
  let remaining = seconds;
  setTimeout(() => {
    fill.style.transition = `width ${seconds}s linear`;
    fill.style.width = "0%";
  }, 50);
  raidState.timerInterval = setInterval(() => {
    remaining--;
    if (remaining <= 5) fill.classList.add("urgent");
    if (remaining <= 0) clearInterval(raidState.timerInterval);
  }, 1000);
}

// Raid socket events
socket.on("raid_player_placed", ({ role }) => {
  if (role !== myRole) {
    // Opponent placed their ships — notify me
    const status = document.getElementById("raid-placement-status");
    const waiting = document.getElementById("raid-waiting-msg");
    if (status) status.textContent = "Opponent is ready — place your buildings!";
    // If I've already clicked ready, update my waiting message
    if (waiting && !waiting.classList.contains("hidden")) {
      waiting.textContent = "Both ready — starting battle!";
    }
  }
});

socket.on("raid_combat_start", ({ turn }) => {
  document.getElementById("raid-placement").classList.add("hidden");
  document.getElementById("raid-combat").classList.remove("hidden");
  buildRaidGrid("raid-my-grid-combat",  false, false);
  buildRaidGrid("raid-enemy-grid",      true,  true);
  raidUpdateMyGrid();
  raidState.myTurn = turn === myRole;
  const label = document.getElementById("raid-turn-label");
  label.textContent = raidState.myTurn ? "YOUR TURN — FIRE!" : "THEIR TURN";
  label.className = "raid-turn-label" + (raidState.myTurn ? "" : " their-turn");
  raidStartTimer(15);
});

socket.on("raid_shot_result", ({ role, x, y, hit, sunk, targetSunk }) => {
  const iMyShot = role === myRole;

  // Play sound
  if (sunk) playSunkSound();
  else if (hit) playHitSound();
  else playMissSound();

  if (iMyShot) {
    raidState.myShots.push({ x, y, hit });
    raidUpdateEnemyGrid();
    if (sunk) {
      sunk.cells.forEach(c => {
        const el = getRaidCell("raid-enemy-grid", c.x, c.y);
        if (el) el.classList.add("sunk");
      });
    }
    document.getElementById("raid-their-sunk").textContent = targetSunk;
  } else {
    raidState.theirShots.push({ x, y, hit });
    raidUpdateMyGrid();
    if (sunk) {
      sunk.cells.forEach(c => {
        const el = getRaidCell("raid-my-grid-combat", c.x, c.y);
        if (el) el.classList.add("sunk");
      });
    }
    document.getElementById("raid-my-sunk").textContent = targetSunk;
  }
});

socket.on("raid_turn", ({ turn }) => {
  raidState.myTurn = turn === myRole;
  const label = document.getElementById("raid-turn-label");
  label.textContent = raidState.myTurn ? "YOUR TURN — FIRE!" : "THEIR TURN";
  label.className = "raid-turn-label" + (raidState.myTurn ? "" : " their-turn");
  raidStartTimer(15);
});

socket.on("raid_timeout", ({ role }) => {
  if (raidState.timerInterval) clearInterval(raidState.timerInterval);
  const label = document.getElementById("raid-turn-label");
  if (role === myRole) {
    label.textContent = "TIME UP — YOU LOSE!";
    label.style.color = "var(--accent2)";
  } else {
    label.textContent = "TIME UP — YOU WIN!";
    label.style.color = "var(--accent)";
  }
});

// Raid orientation toggle
document.getElementById("raid-orient-h").addEventListener("click", () => {
  raidState.orientation = "h";
  document.getElementById("raid-orient-h").classList.add("active");
  document.getElementById("raid-orient-v").classList.remove("active");
});

document.getElementById("raid-orient-v").addEventListener("click", () => {
  raidState.orientation = "v";
  document.getElementById("raid-orient-v").classList.add("active");
  document.getElementById("raid-orient-h").classList.remove("active");
});

// Raid ready button
document.getElementById("raid-ready-btn").addEventListener("click", () => {
  socket.emit("raid_place_ships", { roomId, role: myRole, ships: raidState.myShips });
  document.getElementById("raid-ready-btn").style.display = "none";
  document.getElementById("raid-waiting-msg").classList.remove("hidden");
  document.getElementById("raid-placement-status").textContent = "Waiting for opponent to place buildings...";
  document.querySelectorAll("#raid-my-grid-place .raid-cell").forEach(el => el.style.cursor = "default");
});

document.getElementById("pick-fourdots").addEventListener("click", () => {
  currentGame = "fourdots";
  document.getElementById("waiting-sub").textContent = "Finding a 4 Dots match\u2026";
  socket.emit("find_match", { game: "fourdots" });
  showScreen("screen-waiting");
});

// ── 4 Dots game logic ─────────────────────────────────────────────
const FD_COLS = 7, FD_ROWS = 6;
let fdTimerInterval = null;

function buildFourDotsBoard() {
  const board  = document.getElementById("fourdots-board");
  const colBtns = document.getElementById("fourdots-col-btns");
  board.innerHTML = "";
  colBtns.innerHTML = "";

  for (let c = 0; c < FD_COLS; c++) {
    const btn = document.createElement("button");
    btn.className = "fourdots-col-btn";
    btn.innerHTML = "&#9660;";
    btn.dataset.col = c;
    btn.addEventListener("click", () => fdDropPiece(c));
    colBtns.appendChild(btn);
  }

  for (let r = 0; r < FD_ROWS; r++) {
    for (let c = 0; c < FD_COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "fourdots-cell";
      cell.id = `fd-${r}-${c}`;
      board.appendChild(cell);
    }
  }
}

function fdDropPiece(col) {
  if (!gameState || gameState.game !== "fourdots") return;
  socket.emit("fourdots_drop", { roomId, role: myRole, col });
}

function fdRenderBoard(board) {
  for (let r = 0; r < FD_ROWS; r++) {
    for (let c = 0; c < FD_COLS; c++) {
      const cell = document.getElementById(`fd-${r}-${c}`);
      if (!cell) continue;
      cell.className = "fourdots-cell";
      if (board[r][c]) cell.classList.add(board[r][c]);
    }
  }
}

function fdSetMyTurn(isMyTurn) {
  const label   = document.getElementById("fourdots-turn-label");
  const colBtns = document.querySelectorAll(".fourdots-col-btn");
  label.textContent = isMyTurn ? "YOUR TURN — DROP!" : "THEIR TURN";
  label.className   = "fourdots-turn-label" + (isMyTurn ? "" : " their-turn");
  colBtns.forEach(btn => {
    btn.classList.toggle("disabled", !isMyTurn);
  });
}

function fdStartTimer(seconds) {
  if (fdTimerInterval) clearInterval(fdTimerInterval);
  const fill = document.getElementById("fourdots-timer-fill");
  if (!fill) return;
  fill.style.transition = "none";
  fill.style.width      = "100%";
  fill.classList.remove("urgent");
  setTimeout(() => {
    fill.style.transition = `width ${seconds}s linear`;
    fill.style.width      = "0%";
  }, 30);
  let remaining = seconds;
  fdTimerInterval = setInterval(() => {
    remaining--;
    if (remaining <= 2) fill.classList.add("urgent");
    if (remaining <= 0) clearInterval(fdTimerInterval);
  }, 1000);
}

// 4 Dots socket events
socket.on("fourdots_turn", ({ turn, board }) => {
  fdRenderBoard(board);
  const isMyTurn = turn === myRole;
  fdSetMyTurn(isMyTurn);
  fdStartTimer(5);
});

socket.on("fourdots_drop", ({ col, row, role, board, result }) => {
  fdRenderBoard(board);

  // Play sound
  if (result?.winner) playSunkSound();
  else playHitSound();

  if (result?.cells) {
    // Highlight winning cells
    result.cells.forEach(({ r, c }) => {
      const cell = document.getElementById(`fd-${r}-${c}`);
      if (cell) cell.classList.add("win");
    });
  }
});

socket.on("fourdots_timeout", ({ role }) => {
  const label = document.getElementById("fourdots-turn-label");
  if (role === myRole) {
    label.textContent = "TIME UP — SKIPPED!";
    label.style.color = "var(--accent2)";
  } else {
    label.textContent = "THEY RAN OUT OF TIME";
    label.style.color = "var(--muted)";
  }
});

document.getElementById("pick-reaction").addEventListener("click", () => {
  currentGame = "reaction";
  document.getElementById("waiting-sub").textContent = "Finding a Reflex match\u2026";
  socket.emit("find_match", { game: "reaction" });
  showScreen("screen-waiting");
});

// ── Countdown ─────────────────────────────────────────────────────
function startCountdown(onComplete) {
  showScreen("screen-faceoff");

  // Assign streams to faceoff screen
  if (localStream) {
    const el = document.getElementById("video-faceoff-local");
    if (el) el.srcObject = localStream;
  }
  if (window._remoteStream) {
    const el = document.getElementById("video-faceoff-remote");
    if (el) { el.srcObject = window._remoteStream; el.play().catch(() => {}); }
  }

  let count = 10;
  const el = document.getElementById("countdown-number");
  el.textContent = count;
  el.style.color = "#00ff88";

  const tick = setInterval(() => {
    // Keep trying to show remote video during countdown
    if (window._remoteStream) {
      const fr = document.getElementById("video-faceoff-remote");
      if (fr && !fr.srcObject) { fr.srcObject = window._remoteStream; fr.play().catch(() => {}); }
    }
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
    window._remoteStream = s;
    ["video-remote","video-faceoff-remote","video-mobile-remote","video-postgame-remote"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.srcObject = s; el.muted = false; el.volume = 1.0; el.play().catch(() => {}); }
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
  const hint           = document.getElementById("controls-hint");
  const dpad           = document.getElementById("dpad");
  const status         = document.getElementById("game-status");
  const bannerGame     = document.getElementById("banner-game");
  const bannerGameFixed= document.getElementById("banner-game-fixed");
  const canvas         = document.getElementById("pong-canvas");
  const reactionUI     = document.getElementById("reaction-ui");
  const raidUI         = document.getElementById("raid-ui");
  const fourdotsUI     = document.getElementById("fourdots-ui");
  const gameName = game === "snake" ? "SNAKE" : game === "reaction" ? "REFLEX" : game === "raid" ? "RAID" : game === "fourdots" ? "4 DOTS" : "PONG";
  if (bannerGame)      bannerGame.textContent      = gameName;
  if (bannerGameFixed) bannerGameFixed.textContent = gameName;

  if (game === "reaction") {
    canvas.style.display      = "none";
    reactionUI.style.display  = "flex";
    raidUI.style.display      = "none";
    fourdotsUI.style.display  = "none";
    hint.innerHTML    = '<span>Tap the circle when it turns green!</span>';
    status.textContent = "FIRST TO 3";
    dpad.style.display = "none";
  } else if (game === "raid") {
    canvas.style.display      = "none";
    reactionUI.style.display  = "none";
    raidUI.style.display      = "flex";
    fourdotsUI.style.display  = "none";
    hint.innerHTML    = '<span>Place buildings — then fire!</span>';
    status.textContent = "RAID ALL 4";
    dpad.style.display = "none";
    // Init raid state
    raidState = {
      myShips: [], shipsToPlace: [...RAID_SHIPS], currentShipIdx: 0,
      orientation: "h", myShots: [], theirShots: [], myTurn: false, timerInterval: null
    };
    document.getElementById("raid-placement").classList.remove("hidden");
    document.getElementById("raid-combat").classList.add("hidden");
    document.getElementById("raid-ready-btn").style.display = "none";
    document.getElementById("raid-ready-btn").disabled = false;
    document.getElementById("raid-ready-btn").innerHTML = "&#9654; READY — START BATTLE";
    document.getElementById("raid-waiting-msg").classList.add("hidden");
    document.getElementById("raid-placement-status").textContent = "Place all 4 buildings to continue";
    document.querySelectorAll(".raid-ship-btn").forEach((b, i) => {
      b.classList.remove("active", "placed");
      if (i === 0) b.classList.add("active");
    });
    document.getElementById("raid-orient-h").classList.add("active");
    document.getElementById("raid-orient-v").classList.remove("active");
    buildRaidGrid("raid-my-grid-place", true, false);
  } else if (game === "fourdots") {
    canvas.style.display      = "none";
    reactionUI.style.display  = "none";
    raidUI.style.display      = "none";
    fourdotsUI.style.display  = "flex";
    hint.innerHTML    = '<span>Click a column to drop your dot</span>';
    status.textContent = "CONNECT 4";
    dpad.style.display = "none";
    buildFourDotsBoard();
    fdSetMyTurn(false);
  } else {
    canvas.style.display      = "block";
    reactionUI.style.display  = "none";
    raidUI.style.display      = "none";
    fourdotsUI.style.display  = "none";
    if (game === "snake") {
      hint.innerHTML     = '<span>Arrow keys / WASD &nbsp;&mdash;&nbsp; steer</span>';
      status.textContent = "FIRST TO 3 ROUNDS";
      dpad.style.display = "grid";
    } else {
      hint.innerHTML     = '<span>W / S &nbsp;&mdash;&nbsp; move paddle</span><span class="hint-sep"> | </span><span>Or drag</span>';
      status.textContent = "FIRST TO 5";
      dpad.style.display = "none";
    }
  }
}

// ── Reaction game UI helpers ──────────────────────────────────────
let reactionArmed = false;

function setReactionLight(state) {
  const light = document.getElementById("reaction-light");
  const label = document.getElementById("reaction-light-label");
  light.className = "reaction-light " + (state || "");
  if (state === "green") {
    label.textContent = "TAP!";
    reactionArmed = true;
    document.getElementById("reaction-instruction").textContent = "TAP THE CIRCLE!";
  } else if (state === "red") {
    label.textContent = "EARLY!";
    reactionArmed = false;
  } else {
    label.textContent = "WAIT";
    reactionArmed = false;
    document.getElementById("reaction-instruction").textContent = "Wait for green — tap the circle!";
  }
}

function updateReactionScores(scores) {
  const my   = myRole === "left" ? scores.left  : scores.right;
  const them = myRole === "left" ? scores.right : scores.left;
  document.getElementById("reaction-score-you").textContent  = my;
  document.getElementById("reaction-score-them").textContent = them;
  document.getElementById("banner-score-you").textContent    = my;
  document.getElementById("banner-score-them").textContent   = them;
}

// Circle is the tap target
document.getElementById("reaction-light").addEventListener("click", () => {
  if (!gameState || gameState.game !== "reaction" || !roomId) return;
  socket.emit("reaction_tap", { roomId, role: myRole });
});

// Spacebar / Enter also works
document.addEventListener("keydown", (e) => {
  if (!gameState || gameState.game !== "reaction") return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    socket.emit("reaction_tap", { roomId, role: myRole });
  }
});

// ── Reaction socket events ────────────────────────────────────────
socket.on("reaction_waiting", ({ round, totalRounds, scores }) => {
  setReactionLight("");
  updateReactionScores(scores);
  document.getElementById("reaction-round").textContent       = `ROUND ${round} OF ${totalRounds}`;
  document.getElementById("reaction-instruction").textContent = "Wait for green — tap the circle!";
  document.getElementById("reaction-result").textContent      = "";
  document.getElementById("reaction-result").style.color      = "";
});

socket.on("reaction_go", () => {
  setReactionLight("green");
});

socket.on("reaction_early", ({ role }) => {
  if (role === myRole) {
    setReactionLight("red");
    document.getElementById("reaction-instruction").textContent = "Too early! Wait for green.";
    setTimeout(() => setReactionLight(""), 800);
  }
});

socket.on("reaction_first_tap", ({ role, time }) => {
  const isMe = role === myRole;
  const res  = document.getElementById("reaction-result");
  if (isMe) {
    // Show your own time instantly — don't wait for opponent
    res.textContent = `Your time: ${time}ms — waiting for opponent...`;
    res.style.color = "#6666aa";
    setReactionLight("");
    document.getElementById("reaction-instruction").textContent = "Waiting for opponent to place buildings...";
  } else {
    res.textContent = `Opponent tapped first — tap now!`;
    res.style.color = "#ff3366";
  }
});

socket.on("reaction_round_result", ({ winner, times, scores, round }) => {
  const iWon     = winner === myRole;
  const myTime   = myRole === "left" ? times.left  : times.right;
  const themTime = myRole === "left" ? times.right : times.left;

  setReactionLight(iWon ? "green" : "red");
  updateReactionScores(scores);

  const res = document.getElementById("reaction-result");
  res.textContent = iWon
    ? `You win! ${myTime}ms vs ${themTime}ms`
    : `They win. ${themTime}ms vs ${myTime}ms`;
  res.style.color = iWon ? "#00ff88" : "#ff3366";

  document.getElementById("reaction-instruction").textContent = iWon ? "Nice reflexes!" : "Too slow!";
});

function updateScoreDisplay(scores) {
  const my   = myRole === "left" ? scores.left  : scores.right;
  const them = myRole === "left" ? scores.right : scores.left;

  // Mobile score bar
  document.getElementById("score-left").textContent  = my;
  document.getElementById("score-right").textContent = them;

  // Desktop side panels
  document.getElementById("panel-score-you").textContent  = my;
  document.getElementById("panel-score-them").textContent = them;

  // Desktop canvas score
  document.getElementById("ds-score-you").textContent  = my;
  document.getElementById("ds-score-them").textContent = them;

  // Top branded banner
  document.getElementById("banner-score-you").textContent  = my;
  document.getElementById("banner-score-them").textContent = them;
}

// ── Share card generator ──────────────────────────────────────────
function generateShareCard(scores, winner) {
  const sc  = document.getElementById("share-canvas");
  const ctx = sc.getContext("2d");
  const W   = 800, H = 420;

  // Background
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  // Top banner strip
  ctx.fillStyle = "#ff3366";
  ctx.fillRect(0, 0, W, 6);

  // Bottom banner strip
  ctx.fillStyle = "#00ff88";
  ctx.fillRect(0, H - 6, W, 6);

  // Draw video frames if available — them on left, you on right
  const vidThem = document.getElementById("video-remote");
  const vidYou  = document.getElementById("video-local");
  const faceW   = 240, faceH = 200, faceY = 50;

  // Face frame backgrounds
  ctx.fillStyle = "#1a1a26";
  ctx.fillRect(40, faceY, faceW, faceH);
  ctx.fillRect(W - 40 - faceW, faceY, faceW, faceH);

  // Draw video frames (if stream is live)
  try {
    if (vidThem && vidThem.readyState >= 2) {
      ctx.save();
      ctx.rect(40, faceY, faceW, faceH);
      ctx.clip();
      ctx.drawImage(vidThem, 40, faceY, faceW, faceH);
      ctx.restore();
    }
    if (vidYou && vidYou.readyState >= 2) {
      ctx.save();
      ctx.rect(W - 40 - faceW, faceY, faceW, faceH);
      ctx.clip();
      // Mirror local video
      ctx.translate(W - 40 - faceW + faceW, faceY);
      ctx.scale(-1, 1);
      ctx.drawImage(vidYou, 0, 0, faceW, faceH);
      ctx.restore();
    }
  } catch (e) {
    console.warn("Share card video draw:", e.message);
  }

  // Face borders
  ctx.strokeStyle = "#ff3366";
  ctx.lineWidth = 3;
  ctx.strokeRect(40, faceY, faceW, faceH);
  ctx.strokeStyle = "#00ff88";
  ctx.strokeRect(W - 40 - faceW, faceY, faceW, faceH);

  // OPPONENT / YOU labels under faces
  ctx.font = "bold 11px 'Courier New', monospace";
  ctx.fillStyle = "#ff3366";
  ctx.textAlign = "center";
  ctx.fillText("OPPONENT", 40 + faceW / 2, faceY + faceH + 22);
  ctx.fillStyle = "#00ff88";
  ctx.fillText("YOU", W - 40 - faceW / 2, faceY + faceH + 22);

  // Centre score
  const myScore   = myRole === "left" ? scores.left  : scores.right;
  const themScore = myRole === "left" ? scores.right : scores.left;

  ctx.font = "bold 64px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ff3366";
  ctx.fillText(themScore, W / 2 - 50, faceY + faceH / 2 + 20);
  ctx.fillStyle = "#2a2a3e";
  ctx.fillText(":", W / 2, faceY + faceH / 2 + 20);
  ctx.fillStyle = "#00ff88";
  ctx.fillText(myScore, W / 2 + 50, faceY + faceH / 2 + 20);

  // Result text
  const resultText = winner === "draw" ? "DRAW" : winner === myRole ? "WIN" : "LOSS";
  const resultColour = resultText === "WIN" ? "#00ff88" : resultText === "LOSS" ? "#ff3366" : "#ffffff";
  ctx.font = "bold 28px 'Courier New', monospace";
  ctx.fillStyle = resultColour;
  ctx.fillText(resultText, W / 2, faceY + faceH / 2 + 58);

  // Game type label
  ctx.font = "12px 'Courier New', monospace";
  ctx.fillStyle = "#6666aa";
  ctx.fillText(currentGame ? currentGame.toUpperCase() : "PONG", W / 2, faceY + faceH / 2 + 82);

  // ARCADEFACE branding — bottom centre
  ctx.font = "bold 18px 'Courier New', monospace";
  ctx.fillStyle = "#e8e8f0";
  ctx.fillText("ARCADE", W / 2 - 46, H - 22);
  ctx.fillStyle = "#ff3366";
  ctx.fillText("FACE", W / 2 + 46, H - 22);

  // Hashtag
  ctx.font = "11px 'Courier New', monospace";
  ctx.fillStyle = "#6666aa";
  ctx.fillText("#ArcadeFace", W / 2 + 120, H - 22);
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
  clearChat();
  window._remoteStream = null;
  await startPeerConnection(role === "left");

  // If camera not yet acquired, try now
  if (!localStream) {
    const hasCam = await getCamera();
    if (!hasCam) {
      // Show overlay and wait for user to decide
      window._cameraDestination = null; // don't navigate away
      showOverlay("overlay-camera");
      await new Promise(resolve => {
        const onDecide = async () => {
          hideOverlay("overlay-camera");
          if (!localStream) await getCamera(); // try once more if they clicked allow
          document.getElementById("btn-allow-camera").removeEventListener("click", onDecide);
          document.getElementById("btn-skip-camera").removeEventListener("click", onDecide);
          resolve();
        };
        document.getElementById("btn-allow-camera").addEventListener("click", onDecide, { once: true });
        document.getElementById("btn-skip-camera").addEventListener("click", onDecide, { once: true });
      });
    }
  }

  // Signal server we're ready
  socket.emit("camera_ready", { roomId });
});

// Server tells us both players are camera-ready — start countdown
socket.on("both_camera_ready", () => {
  startCountdown(() => {
    setupGameUI(currentGame);
    showScreen("screen-game");
    if (currentGame !== "fourdots" && currentGame !== "raid" && currentGame !== "reaction") {
      startRenderLoop();
    }
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
  if (gs.scores) updateScoreDisplay(gs.scores);
});

socket.on("game_state", ({ gameState: gs }) => {
  gameState = gs;
  if (gs.scores) updateScoreDisplay(gs.scores);
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

  // Scores — opponent left, you right
  const myScore   = myRole === "left" ? scores.left  : scores.right;
  const themScore = myRole === "left" ? scores.right : scores.left;
  document.getElementById("gameover-score-you").textContent  = myScore;
  document.getElementById("gameover-score-them").textContent = themScore;

  // Keep final-score for share card compatibility
  document.getElementById("rematch-status").textContent = "";

  setTimeout(() => generateShareCard(scores, winner), 200);
  showScreen("screen-gameover");
});

// ── Post-game chat ────────────────────────────────────────────────
function clearChat() {
  const box = document.getElementById("postgame-messages");
  box.innerHTML = '<div class="postgame-empty">No messages yet — say something!</div>';
}

function appendChatMsg(who, text) {
  const box = document.getElementById("postgame-messages");
  const empty = box.querySelector(".postgame-empty");
  if (empty) empty.remove();
  const msg = document.createElement("div");
  msg.className = "postgame-msg";
  msg.innerHTML = `<span class="postgame-msg-who ${who}">${who === "you" ? "YOU" : "THEM"}</span><span class="postgame-msg-text">${text.replace(/</g,"&lt;")}</span>`;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
}

function sendChatMsg() {
  const input = document.getElementById("postgame-input");
  const text  = input.value.trim();
  if (!text || !roomId) return;
  input.value = "";
  appendChatMsg("you", text);
  socket.emit("chat_msg", { roomId, text });
}

document.getElementById("postgame-send").addEventListener("click", sendChatMsg);
document.getElementById("postgame-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); sendChatMsg(); }
});

socket.on("chat_msg", ({ text }) => { appendChatMsg("them", text); });

// ── Email capture ─────────────────────────────────────────────────
document.getElementById("btn-email").addEventListener("click", async () => {
  const input = document.getElementById("email-input");
  const email = input.value.trim();
  if (!email || !email.includes("@")) {
    input.style.borderColor = "var(--accent2)";
    return;
  }
  input.style.borderColor = "";

  try {
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
  } catch (e) {
    console.warn("Email submit:", e.message);
  }

  // Show confirmation regardless — don't make users feel bad if it fails
  document.getElementById("email-capture").querySelector(".email-capture-row").classList.add("hidden");
  document.getElementById("email-done").classList.remove("hidden");
});
document.getElementById("btn-share").addEventListener("click", () => {
  const sc = document.getElementById("share-canvas");
  const link = document.createElement("a");
  link.download = "arcadeface-result.png";
  link.href = sc.toDataURL("image/png");
  link.click();
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

document.getElementById("btn-next-match").addEventListener("click", () => {
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

// ── Init ──────────────────────────────────────────────────────────
initSupabase();
checkChallengeLink();
