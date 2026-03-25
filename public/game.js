// ── ArcadeFace Client ─────────────────────────────────────────────
const socket = io({
  transports: ["polling", "websocket"], // start with polling, upgrade to WS
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 500,
  timeout: 20000
});

let myRole      = null;
let roomId      = null;
let gameState   = null;
let currentGame = null;
let localStream = null;
let peerConn    = null;
let animFrameId = null;
let currentUser = null;   // Supabase user object
let playMode    = "random"; // random | friend | group

// Rejoin room after socket reconnects
socket.on("reconnect", () => {
  if (roomId) socket.emit("rejoin_room", { roomId, role: myRole });
});

socket.on("disconnect", (reason) => {
});

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

  // Check if this is a password recovery redirect before doing anything else
  const hash = window.location.hash;
  const isRecovery = hash.includes("type=recovery") || hash.includes("type=signup");

  if (!isRecovery) {
    sbClient.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setUser(session.user);
        showScreen("screen-home");
        // Show join prompt if a friend code was detected on page load
        if (friendCode) showFriendJoinPrompt(friendCode);
        else setTimeout(loadSavedAvatar, 300);
      }
      // If no session and there's a friend code, it's stored in memory —
      // the join prompt will show after they sign in via onAuthStateChange
    });
  }

  sbClient.auth.onAuthStateChange((event, session) => {
    console.log("Auth event:", event, "user:", session?.user?.email || "none");
    if (event === "PASSWORD_RECOVERY") {
      history.replaceState({}, "", window.location.pathname);
      showScreen("screen-reset-password");
    } else if (event === "SIGNED_IN" && isRecovery) {
      showScreen("screen-reset-password");
    } else if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && !isRecovery) {
      setUser(session.user);
      setTimeout(loadSavedAvatar, 300);
      showScreen("screen-home");
      // Show join prompt if a friend code is waiting
      if (friendCode) showFriendJoinPrompt(friendCode);
    } else if (event === "SIGNED_OUT") {
      setUser(null);
    }
  });
}

// ── Reset password screen ─────────────────────────────────────────
document.getElementById("btn-set-password").addEventListener("click", async () => {
  const newPw  = document.getElementById("reset-password-new").value;
  const confPw = document.getElementById("reset-password-confirm").value;
  const errEl  = document.getElementById("reset-error");

  errEl.classList.add("hidden");

  if (newPw.length < 6) {
    errEl.textContent = "Password must be at least 6 characters";
    errEl.classList.remove("hidden");
    return;
  }
  if (newPw !== confPw) {
    errEl.textContent = "Passwords don't match";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("btn-set-password");
  btn.textContent = "SAVING...";
  btn.disabled = true;

  const { error } = await sbClient.auth.updateUser({ password: newPw });

  btn.textContent = "SET PASSWORD";
  btn.disabled = false;

  if (error) {
    errEl.textContent = error.message;
    errEl.classList.remove("hidden");
  } else {
    errEl.textContent = "✓ Password updated!";
    errEl.style.color = "var(--accent)";
    errEl.classList.remove("hidden");
    setTimeout(async () => {
      errEl.style.color = "";
      // Get the now-signed-in session and go home
      const { data: { session } } = await sbClient.auth.getSession();
      if (session) { setUser(session.user); setTimeout(loadSavedAvatar, 300); }
      showScreen("screen-home");
    }, 1500);
  }
});

function setUser(user) {
  currentUser = user;
  const guestEl    = document.getElementById("home-guest");
  const signedinEl = document.getElementById("home-signed-in");
  const usernameEl = document.getElementById("home-username");
  const avatarGuest  = document.getElementById("avatar-btn-home-guest");
  const avatarSignin = document.getElementById("avatar-btn-home");

  if (user) {
    const name = user.user_metadata?.username
      || user.email?.split("@")[0]?.toUpperCase()
      || "PLAYER";
    if (usernameEl) usernameEl.textContent = name;
    guestEl?.classList.add("hidden");
    signedinEl?.classList.remove("hidden");
    avatarGuest?.classList.add("hidden");
    avatarSignin?.classList.remove("hidden");
  } else {
    guestEl?.classList.remove("hidden");
    signedinEl?.classList.add("hidden");
    avatarGuest?.classList.remove("hidden");
    avatarSignin?.classList.add("hidden");
  }
}

// ── Logo click — return to home (except during game/lobby) ────────
const NO_LOGO_NAV = new Set(["screen-game","screen-friend-lobby","screen-faceoff"]);
document.querySelectorAll(".logo-link, .screen-logo a").forEach(el => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const active = document.querySelector(".screen.active");
    if (active && NO_LOGO_NAV.has(active.id)) return;
    showScreen("screen-home");
  });
});

// ── Sign in screen handlers ───────────────────────────────────────
let signinMode = "signin"; // "signin" | "create"

document.getElementById("btn-goto-signin").addEventListener("click", () => {
  showScreen("screen-signin");
});

document.getElementById("btn-back-home").addEventListener("click", () => {
  showScreen("screen-home");
});

function showSigninError(msg) {
  const el = document.getElementById("signin-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// Tab switching — changes mode and updates button label + hint
document.querySelectorAll(".signin-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".signin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    signinMode = tab.dataset.mode;
    const hint = document.getElementById("signin-mode-hint");
    const btn  = document.getElementById("btn-signin-submit");
    const pw   = document.getElementById("signin-password");
    const forgot = document.getElementById("btn-forgot-pw");
    if (signinMode === "create") {
      hint.textContent   = "New here? Create a free account";
      btn.textContent    = "CREATE ACCOUNT";
      pw.placeholder     = "choose a password (min 6 chars)";
      pw.autocomplete    = "new-password";
      forgot.style.display = "none";
    } else {
      hint.textContent   = "Welcome back — enter your details";
      btn.textContent    = "SIGN IN";
      pw.placeholder     = "password";
      pw.autocomplete    = "current-password";
      forgot.style.display = "block";
    }
    document.getElementById("signin-error").classList.add("hidden");
  });
});

// Single submit button — signs in or creates account based on mode
document.getElementById("btn-signin-submit").addEventListener("click", async () => {
  if (!sbClient) return;
  const email = document.getElementById("signin-email-pw").value.trim();
  const pw    = document.getElementById("signin-password").value;
  if (!email || !pw) { showSigninError("Enter your email and password"); return; }
  document.getElementById("signin-error").classList.add("hidden");

  if (signinMode === "create") {
    if (pw.length < 6) { showSigninError("Password must be at least 6 characters"); return; }
    const { error } = await sbClient.auth.signUp({
      email, password: pw,
      options: { emailRedirectTo: "https://www.arcadeface.com" }
    });
    if (error) showSigninError(error.message);
    else showSigninError("✓ Account created! Check your email to confirm, then sign in.");
  } else {
    const { error } = await sbClient.auth.signInWithPassword({ email, password: pw });
    if (error) {
      showSigninError(error.message);
    } else {
      // After sign in, go to lobby if there's a friend code in URL
      const friendParam = new URLSearchParams(window.location.search).get("friend");
      if (friendParam) {
        setTimeout(() => {
          getCamera().then(() => enterFriendLobby(friendParam));
        }, 300);
      }
      // Otherwise auth state change handles navigation
    }
  }
});

// Forgot password
document.getElementById("btn-forgot-pw").addEventListener("click", async () => {
  if (!sbClient) return;
  const email = document.getElementById("signin-email-pw").value.trim();
  if (!email) { showSigninError("Enter your email above first"); return; }
  const { error } = await sbClient.auth.resetPasswordForEmail(email, {
    redirectTo: "https://www.arcadeface.com"
  });
  if (error) showSigninError(error.message);
  else showSigninError("✓ Password reset email sent — check your inbox");
});

// Magic link
document.getElementById("btn-send-link").addEventListener("click", async () => {
  const email = document.getElementById("signin-email").value.trim();
  if (!email || !email.includes("@")) {
    document.getElementById("signin-email").style.borderColor = "var(--accent2)";
    return;
  }
  document.getElementById("signin-email").style.borderColor = "";
  if (!sbClient) { alert("Auth not configured."); return; }
  const btn = document.getElementById("btn-send-link");
  btn.textContent = "SENDING..."; btn.disabled = true;
  // Preserve friend code in redirect URL if present
  const currentFriend = new URLSearchParams(window.location.search).get("friend");
  const redirectTo = currentFriend
    ? `https://www.arcadeface.com?friend=${currentFriend}`
    : "https://www.arcadeface.com";
  const { error } = await sbClient.auth.signInWithOtp({
    email, options: { emailRedirectTo: redirectTo }
  });
  btn.textContent = "SEND MAGIC LINK"; btn.disabled = false;
  if (!error) {
    document.getElementById("signin-form-magic").classList.add("hidden");
    document.getElementById("signin-sent").classList.remove("hidden");
  } else {
    showSigninError(error.message);
  }
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
  // Reuse existing code if we stepped away from a room
  enterFriendLobby(friendCode || null);
});

document.getElementById("mode-group").addEventListener("click", () => {
  alert("Group rooms coming soon!");
});

// ── Friend Lobby ──────────────────────────────────────────────────
let friendCode = null;
let friendPeerConn = null;
let isLobbyOwner = false;

function updateLobbyOwnerUI() {
  const ownerEl = document.getElementById("friend-pick-owner");
  const guestEl = document.getElementById("friend-pick-guest");
  const label   = document.getElementById("friend-pick-label");
  if (isLobbyOwner) {
    if (ownerEl) ownerEl.style.display = "block";
    if (guestEl) guestEl.style.display = "none";
    if (label)   label.textContent = "Pick a game to start";
  } else {
    if (ownerEl) ownerEl.style.display = "none";
    if (guestEl) guestEl.style.display = "block";
    if (label)   label.textContent = "Waiting for host...";
  }
}

// ── Weekly friend code generation ────────────────────────────────
function getWeeklyCode() {
  // Week number: days since a fixed epoch ÷ 7, Monday-anchored
  const now  = new Date();
  // Shift so week starts Monday (JS getDay: 0=Sun, 1=Mon...6=Sat)
  const day  = (now.getUTCDay() + 6) % 7; // 0=Mon, 6=Sun
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  const weekNum = Math.floor(monday.getTime() / (7 * 24 * 60 * 60 * 1000));

  // Seed: user ID (signed in) or device fingerprint (guest)
  const seed = currentUser
    ? currentUser.id + "_" + weekNum
    : (sessionStorage.getItem("af_guest_seed") || (() => {
        const s = Math.random().toString(36).substring(2, 10);
        sessionStorage.setItem("af_guest_seed", s);
        return s;
      })()) + "_" + weekNum;

  // Deterministic hash → 6 uppercase alphanum chars
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) >>> 0;
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusables (0,O,I,1)
  let code = "";
  let h = hash;
  for (let i = 0; i < 6; i++) {
    code += chars[h % chars.length];
    h = Math.floor(h / chars.length) + (hash >>> (i * 4));
    h = (h ^ (hash * 1234567)) >>> 0;
  }
  return code;
}

function enterFriendLobby(code) {
  if (!code) {
    const params = new URLSearchParams(window.location.search);
    code = params.get("friend") || getWeeklyCode();
  }
  friendCode = code;
  // Creator is whoever has no ?friend= param when creating — tracked by server
  history.replaceState({}, "", `?friend=${code}`);

  const link = `https://www.arcadeface.com?friend=${code}`;
  document.getElementById("friend-lobby-code").textContent   = link;
  document.getElementById("friend-lobby-status").textContent = "Waiting for friend...";
  document.getElementById("friend-pick-label").textContent   = "Swipe & pick a game";

  // Show avatar immediately
  const myAvatarEl = document.getElementById("friend-avatar-you");
  if (myAvatarEl && myAvatar) drawAvatarOnCanvas(myAvatarEl, myAvatar);
  // Also populate the inline preview
  const prevEl = document.getElementById("friend-avatar-preview");
  if (prevEl && myAvatar) { drawAvatarOnCanvas(prevEl, myAvatar); window._friendPendingAvatar = myAvatar; }

  // Reset owner state until server confirms
  isLobbyOwner = false;
  updateLobbyOwnerUI();

  showScreen("screen-friend-lobby");
  document.getElementById("screen-friend-lobby").scrollTop = 0;
  socket.emit("friend_join", { code });

  // Get fresh camera for lobby (showScreen stops it if coming from non-camera screen)
  getCamera().then(() => {
    const lv = document.getElementById("video-friend-local");
    if (lv && localStream) lv.srcObject = localStream;
    startFriendPeerConnection();
  });
}

async function startFriendPeerConnection() {
  if (friendPeerConn) { friendPeerConn.close(); friendPeerConn = null; }
  friendPeerConn = new RTCPeerConnection(ICE_SERVERS);
  if (localStream) localStream.getTracks().forEach(t => friendPeerConn.addTrack(t, localStream));

  friendPeerConn.ontrack = (event) => {
    const el = document.getElementById("video-friend-remote");
    if (el) el.srcObject = event.streams[0];
    // Note: do NOT set window._remoteStream here — that's for the game peer connection only
  };

  friendPeerConn.onicecandidate = (e) => {
    if (e.candidate) socket.emit("friend_ice", { code: friendCode, candidate: e.candidate });
  };

  friendPeerConn.oniceconnectionstatechange = () => {
    console.log("[FRIEND ICE]", friendPeerConn.iceConnectionState);
  };
}

// Friend game cards (swipeable carousel)
document.querySelectorAll(".friend-game-card").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!friendCode) return;
    const game = btn.dataset.game;
    document.getElementById("friend-pick-label").textContent = "Starting " + game.toUpperCase() + "...";
    socket.emit("friend_pick_game", { code: friendCode, game });
  });
});

// Step away — room stays open, URL preserved so they can come back
document.getElementById("btn-friend-leave").addEventListener("click", () => {
  if (friendCode) socket.emit("friend_leave", { code: friendCode });
  if (friendPeerConn) { friendPeerConn.close(); friendPeerConn = null; }
  stopCamera();
  // Keep friendCode and URL — they can return via the link
  showScreen("screen-home");
});

// Close room permanently
document.getElementById("btn-friend-close").addEventListener("click", () => {
  if (!confirm("Close this room? Your friend will be disconnected and the room link will stop working.")) return;
  if (friendCode) socket.emit("friend_close", { code: friendCode });
  friendCode = null;
  clearPendingFriendCode();
  history.replaceState({}, "", "/");
  if (friendPeerConn) { friendPeerConn.close(); friendPeerConn = null; }
  stopCamera();
  showScreen("screen-home");
});

// Friend socket events
socket.on("friend_waiting", ({ code }) => {
  const link = `https://www.arcadeface.com?friend=${code}`;
  document.getElementById("friend-lobby-status").textContent = "Share your code with a friend \u2193";
  document.getElementById("friend-lobby-code").textContent   = link;
  navigator.clipboard?.writeText(link).catch(() => {});
  // Creator is waiting — they are the owner
  isLobbyOwner = true;
  updateLobbyOwnerUI();
});

// Copy button
document.getElementById("btn-friend-copy").addEventListener("click", () => {
  const link = document.getElementById("friend-lobby-code").textContent;
  navigator.clipboard?.writeText(link).then(() => {
    const btn = document.getElementById("btn-friend-copy");
    btn.textContent = "✓ COPIED";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "COPY"; btn.classList.remove("copied"); }, 2000);
  }).catch(() => {});
});

socket.on("friend_avatar", ({ avatar }) => {
  const el = document.getElementById("friend-avatar-them");
  if (el && avatar) drawAvatarOnCanvas(el, avatar);
});

socket.on("friend_connected", async ({ code, initiator }) => {
  document.getElementById("friend-lobby-status").textContent = initiator
    ? "Friend joined — pick a game!"
    : "Connected — waiting for host to pick a game";
  document.getElementById("friend-lobby-code").textContent = `Room: ${code}`;

  // initiator = player 1 = owner = can pick games
  isLobbyOwner = !!initiator;
  updateLobbyOwnerUI();

  // Show local video
  if (localStream) {
    const lv = document.getElementById("video-friend-local");
    if (lv) lv.srcObject = localStream;
  }

  // Show my avatar in lobby
  const myEl = document.getElementById("friend-avatar-you");
  if (myEl && myAvatar) drawAvatarOnCanvas(myEl, myAvatar);

  // Broadcast my avatar to friend
  if (myAvatar && friendCode) {
    socket.emit("friend_avatar", { code: friendCode, avatar: myAvatar });
  }

  // Only the initiator (player 1) creates the offer to avoid collision
  if (initiator && friendPeerConn) {
    const offer = await friendPeerConn.createOffer();
    await friendPeerConn.setLocalDescription(offer);
    socket.emit("friend_offer", { code, offer });
  }
});

socket.on("friend_offer", async ({ offer, code }) => {
  if (!friendPeerConn) await startFriendPeerConnection();
  await friendPeerConn.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await friendPeerConn.createAnswer();
  await friendPeerConn.setLocalDescription(answer);
  socket.emit("friend_answer", { code, answer });
});

socket.on("friend_answer", async ({ answer }) => {
  if (friendPeerConn) await friendPeerConn.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("friend_ice", async ({ candidate }) => {
  try { if (friendPeerConn) await friendPeerConn.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch(e) {}
});

socket.on("friend_game_starting", ({ game }) => {
  currentGame = game;
  playMode = "friend";
  document.getElementById("waiting-sub").textContent = `Starting ${game.toUpperCase()} with friend...`;
  // Close friend lobby peer connection but keep localStream alive for the game
  if (friendPeerConn) { friendPeerConn.close(); friendPeerConn = null; }
  showScreen("screen-waiting");
  socket.emit("find_match", { game });
});

socket.on("friend_stepped_away", () => {
  document.getElementById("friend-lobby-status").textContent = "Friend stepped away — room still open";
  document.getElementById("friend-pick-label").textContent = "Waiting for friend to return...";
  const rv = document.getElementById("video-friend-remote");
  if (rv) rv.srcObject = null;
  const theirEl = document.getElementById("friend-avatar-them");
  if (theirEl) theirEl.getContext("2d").clearRect(0, 0, 16, 16);
});

socket.on("friend_room_closed", () => {
  friendCode = null;
  history.replaceState({}, "", "/");
  if (friendPeerConn) { friendPeerConn.close(); friendPeerConn = null; }
  stopCamera();
  showScreen("screen-home");
});

socket.on("friend_left", () => {
  // Legacy — treat same as stepped away
  document.getElementById("friend-lobby-status").textContent = "Friend stepped away — room still open";
  const rv = document.getElementById("video-friend-remote");
  if (rv) rv.srcObject = null;
});

socket.on("friend_room_full", () => {
  alert("This room is full — both players are active. Ask your friend to send you a new link, or wait for one of them to disconnect.");
  history.replaceState({}, "", "/");
  showScreen("screen-home");
});

// Check if arriving via friend link
function checkFriendLink() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("friend") || sessionStorage.getItem("af_pending_friend");
  if (code) {
    playMode = "friend";
    friendCode = code;
    // Persist in sessionStorage so magic link redirects don't lose it
    sessionStorage.setItem("af_pending_friend", code);
    // Strip from URL immediately — prevents autofill/sign-in prompts
    history.replaceState({}, "", "/");
  }
}

function clearPendingFriendCode() {
  sessionStorage.removeItem("af_pending_friend");
}

function showFriendJoinPrompt(code) {
  const prompt = document.getElementById("friend-join-prompt");
  const btn    = document.getElementById("btn-join-friend-room");
  const label  = document.getElementById("friend-join-code-label");
  if (!prompt || !btn) return;
  if (label) label.textContent = `Room: ${code}`;
  prompt.style.display = "flex";
  btn.onclick = () => {
    prompt.style.display = "none";
    clearPendingFriendCode();
    getCamera().then(() => enterFriendLobby(code));
  };
}

// ── Screen helpers ────────────────────────────────────────────────
// Screens that require an active camera
const CAMERA_SCREENS = new Set([
  "screen-waiting", "screen-faceoff", "screen-game", "screen-gameover", "screen-friend-lobby"
]);

function stopCamera() {
  if (!localStream) return;
  localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  // Only clear LOCAL video elements — never touch remote video
  ["video-local","video-faceoff-local","video-mobile-local",
   "video-postgame-local","video-friend-local"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.srcObject = null;
  });
  console.log("[CAM] camera stopped");
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  const onGame = id === "screen-game";
  const fixedGame = document.getElementById("banner-game-fixed");
  if (fixedGame) fixedGame.style.display = onGame ? "block" : "none";

  // Stop camera only when going to non-camera screens
  if (!CAMERA_SCREENS.has(id) && localStream) {
    stopCamera();
  }
}
function showOverlay(id) { document.getElementById(id).classList.remove("hidden"); }
function hideOverlay(id) { document.getElementById(id).classList.add("hidden"); }

// ── Camera ────────────────────────────────────────────────────────
async function getCamera() {
  if (localStream) return true; // already running
  // Try video+audio first, fall back to video-only, then audio-only.
  // This prevents a single denied permission killing the whole stream.
  const attempts = [
    { video: true, audio: true },
    { video: true, audio: false },
    { video: false, audio: true },
  ];
  for (const constraints of attempts) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      // Assign to all local video elements immediately
      ["video-local","video-faceoff-local","video-mobile-local","video-postgame-local","video-friend-local"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.srcObject = localStream; el.play().catch(() => {}); }
      });
      console.log("[CAM] acquired:", constraints);
      return true;
    } catch (e) {
      console.warn("[CAM] attempt failed:", JSON.stringify(constraints), e.message);
    }
  }
  console.warn("[CAM] all attempts failed — playing without camera");
  return false;
}

// ── Camera permission helper ──────────────────────────────────────
async function requestCameraThenProceed(destination) {
  // Show screen immediately — don't wait for camera
  showScreen(destination);
  // Request camera in background
  getCamera();
}

// ── Game picker (guest — home screen click) ───────────────────────
document.getElementById("btn-find-match").addEventListener("click", () => {
  requestCameraThenProceed("screen-picker");
});

// ── Play button (signed in) ───────────────────────────────────────
document.getElementById("btn-play-modes").addEventListener("click", () => {
  requestCameraThenProceed("screen-mode");
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

document.getElementById("pick-snake").addEventListener("click", () => {
  currentGame = "snake";
  document.getElementById("waiting-sub").textContent = "Finding a Snake match\u2026";
  socket.emit("find_match", { game: "snake" });
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
document.addEventListener("click",      resumeAudio, { once: false });
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
function startCountdown(onComplete, isRematch, onCameraReady) {
  showScreen("screen-faceoff");

  const el   = document.getElementById("countdown-number");
  const hint = document.querySelector(".faceoff-hint");
  const lv   = document.getElementById("video-faceoff-local");
  const rv   = document.getElementById("video-faceoff-remote");

  // Assign local stream immediately if available
  function tryAssignLocal() {
    if (localStream && lv && lv.srcObject !== localStream) {
      lv.srcObject = localStream;
      lv.play().catch(() => {});
    }
  }
  // Assign remote stream if available
  function tryAssignRemote() {
    if (window._remoteStream && rv && rv.srcObject !== window._remoteStream) {
      rv.srcObject = window._remoteStream;
      rv.play().catch(() => {});
    }
    if (rv && rv.srcObject && rv.paused) rv.play().catch(() => {});
  }

  tryAssignLocal();
  tryAssignRemote();

  // Poll continuously so neither stream is missed whenever it arrives
  const streamPoller = setInterval(() => {
    tryAssignLocal();
    tryAssignRemote();
  }, 250);

  function runCountdown() {
    if (hint) {
      hint.innerHTML = "Say hi. Trash talk.<br>Game starts in&hellip;";
    }
    let count = 10;
    el.textContent = count;
    el.style.color = "#00ff88";
    el.style.fontSize = "";

    const tick = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(tick);
        clearInterval(streamPoller);
        el.textContent = "GO!";
        el.style.color = "#ff3366";
        setTimeout(onComplete, 700);
      } else {
        el.textContent = count;
        el.style.animation = "none";
        el.offsetHeight; // force reflow to restart animation
        el.style.animation = "count-pulse 0.9s ease-out";
        el.style.color = count <= 3 ? "#ff3366" : "#00ff88";
      }
    }, 1000);
  }

  if (isRematch) {
    // Rematch — camera already running, peer connection reused — go straight to countdown
    runCountdown();
    return;
  }

  // First game — show init message while cameras connect, then start countdown
  el.textContent = "...";
  el.style.color = "var(--muted)";
  el.style.fontSize = "clamp(18px, 4vw, 32px)";
  if (hint) hint.innerHTML = "Connecting cameras&hellip;";

  // Dot-animation for the init phase
  let dots = 0;
  const dotTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    el.textContent = ".".repeat(dots + 1);
  }, 400);

  // Wait until local stream is ready (camera permission granted), then start countdown.
  // Remote stream arrives on its own time via ontrack — the countdown itself provides
  // the window for it to appear. 10s is plenty.
  const initPoller = setInterval(() => {
    if (!localStream) return; // still waiting for camera permission
    clearInterval(initPoller);
    clearInterval(dotTimer);
    tryAssignLocal();
    // Now camera is ready — send WebRTC offer if we're the initiator
    if (onCameraReady) onCameraReady();
    runCountdown();
  }, 200);

  // Safety valve — if camera never arrives after 12s, start anyway so the game isn't blocked
  setTimeout(() => {
    clearInterval(initPoller);
    clearInterval(dotTimer);
    const cdEl = document.getElementById("countdown-number");
    // Only fire if countdown hasn't started yet (still showing dots)
    if (cdEl && !/^\d+$|^GO/.test(cdEl.textContent)) {
      if (onCameraReady) onCameraReady();
      runCountdown();
    }
  }, 12000);
}

// ── WebRTC ────────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    // Metered TURN — UDP
    { urls: "turn:openrelay.metered.ca:80",   username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",  username: "openrelayproject", credential: "openrelayproject" },
    // Metered TURN — TCP fallback (works through strict firewalls)
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    // Cloudflare TURN
    { urls: "turn:turn.cloudflare.com:3478",  username: "openrelayproject", credential: "openrelayproject" },
    // Additional STUN servers
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "stun:stun.stunprotocol.org:3478" }
  ]
};

// remote stream assigned directly in ontrack

// Assign all remote video elements from a stream and force play.
// On iOS Safari, autoplay of non-muted video is restricted — we call play() explicitly
// and also mark elements with a data attribute so the video watchdog can retry them.
function assignRemoteStream(s) {
  if (!s) return;
  window._remoteStream = s;
  ["video-remote","video-faceoff-remote","video-mobile-remote","video-postgame-remote"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Only reassign if the stream has actually changed — avoids resetting playback position
    if (el.srcObject !== s) el.srcObject = s;
    el.play().catch(() => {
      // iOS blocks non-gesture play — mark for watchdog retry
      el.dataset.pendingPlay = "1";
    });
  });
}

// Wait for camera with a timeout — resolves true if camera arrives, false if timeout
function waitForCamera(timeoutMs) {
  if (localStream) return Promise.resolve(true);
  return new Promise(resolve => {
    const poll = setInterval(() => {
      if (localStream) { clearInterval(poll); clearTimeout(timer); resolve(true); }
    }, 200);
    const timer = setTimeout(() => { clearInterval(poll); resolve(false); }, timeoutMs);
  });
}

async function startPeerConnection(isInitiator) {
  peerConn = new RTCPeerConnection(ICE_SERVERS);

  // Add all local tracks, deduplicating against existing senders
  function addLocalTracks() {
    if (!localStream) return;
    const senders = peerConn.getSenders();
    localStream.getTracks().forEach(track => {
      if (!senders.find(s => s.track === track)) peerConn.addTrack(track, localStream);
    });
  }

  peerConn.ontrack = (event) => {
    const s = event.streams[0];
    console.log("[WebRTC] ontrack fired, tracks:", s.getTracks().length);
    assignRemoteStream(s);
  };

  peerConn.oniceconnectionstatechange = () => {
    const state = peerConn.iceConnectionState;
    console.log("[WebRTC] ICE state:", state);
    if (state === "connected" || state === "completed") {
      if (window._remoteStream) {
        assignRemoteStream(window._remoteStream);
      } else {
        // ontrack may fire after ICE — give it a moment
        setTimeout(() => {
          if (window._remoteStream) assignRemoteStream(window._remoteStream);
        }, 800);
      }
    }
    // On failure, log clearly for debugging
    if (state === "failed" || state === "disconnected") {
      console.warn("[WebRTC] ICE", state, "— TURN server may be unreachable");
    }
  };

  peerConn.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc_ice", { roomId, candidate: e.candidate });
  };

  if (isInitiator) {
    // Camera wait happens in the countdown init phase (visible to user).
    // Add tracks if camera is already ready, otherwise tracks get added when
    // the offer is sent from the countdown init phase after camera is ready.
    addLocalTracks();
  } else {
    addLocalTracks();
  }
}

async function sendOffer() {} // no-op, kept for compatibility

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

  // The canvas always draws YOU on the RIGHT and OPPONENT on the LEFT.
  // Server coordinates: left player's goal is x=0, right player's goal is x=800.
  //
  // Paddle Y: already correctly mapped per role (your Y from your role's paddle).
  const myPaddleY   = myRole === "left" ? gs.paddles.left  : gs.paddles.right;
  const themPaddleY = myRole === "left" ? gs.paddles.right : gs.paddles.left;

  // Opponent paddle — left side, pink
  ctx.fillStyle = "#ff3366";
  ctx.fillRect(30, themPaddleY, PADDLE_W, PADDLE_H);
  // Your paddle — right side, green
  ctx.fillStyle = "#00ff88";
  ctx.fillRect(W - 30 - PADDLE_W, myPaddleY, PADDLE_W, PADDLE_H);

  // Court border
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Ball X: remap from server coordinates so it always moves toward the correct side.
  // role="right": server x=800 is your goal (right of canvas) — no change needed.
  // role="left":  server x=0 is your goal, but canvas right is your side — mirror X.
  const bx = myRole === "left" ? (W - gs.ball.x - BALL_SIZE) : gs.ball.x;
  const by = gs.ball.y;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx, by, BALL_SIZE, BALL_SIZE);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(bx-4, by-4, BALL_SIZE+8, BALL_SIZE+8);
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
      else if (gameState.game === "pong") {
        drawPong(gameState);
        // Sync vertical slider thumb position with paddle
        const track = document.getElementById("pong-slider-track");
        const thumb = document.getElementById("pong-slider-thumb");
        if (track && thumb && track.offsetHeight > 0) {
          const myY    = myRole === "left" ? gameState.paddles.left : gameState.paddles.right;
          const ratio  = myY / (H - PADDLE_H);
          const thumbH = thumb.offsetHeight;
          const trackH = track.offsetHeight;
          thumb.style.top = Math.round(ratio * (trackH - thumbH)) + "px";
        }
      }
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

  // Panels stay in fixed HTML order: panel-them LEFT, canvas MIDDLE, panel-you RIGHT
  // Pong canvas always draws YOUR paddle on the right to match your panel position

  if (game === "reaction") {
    canvas.style.display      = "none";
    reactionUI.style.display  = "flex";
    raidUI.style.display      = "none";
    fourdotsUI.style.display  = "none";
    hint.innerHTML    = '<span>Tap the circle when it turns green!</span>';
    status.textContent = "FIRST TO 3";
    dpad.style.display = "none";
    document.getElementById("pong-slider-wrap").style.display = "none";
    document.getElementById("panel-score-you").style.visibility  = "hidden";
    document.getElementById("panel-score-them").style.visibility = "hidden";
    document.getElementById("score-left").style.visibility  = "hidden";
    document.getElementById("score-right").style.visibility = "hidden";
  } else if (game === "raid") {
    canvas.style.display      = "none";
    reactionUI.style.display  = "none";
    raidUI.style.display      = "flex";
    fourdotsUI.style.display  = "none";
    hint.innerHTML    = '<span>Place buildings — then fire!</span>';
    status.textContent = "RAID ALL 4";
    dpad.style.display = "none";
    document.getElementById("pong-slider-wrap").style.display = "none";
    document.getElementById("panel-score-you").style.visibility  = "hidden";
    document.getElementById("panel-score-them").style.visibility = "hidden";
    document.getElementById("score-left").style.visibility  = "hidden";
    document.getElementById("score-right").style.visibility = "hidden";
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
    status.textContent = "4 DOTS";
    dpad.style.display = "none";
    document.getElementById("pong-slider-wrap").style.display = "none";
    // Hide scores — 4 Dots doesn't use a score counter
    document.getElementById("panel-score-you").style.visibility  = "hidden";
    document.getElementById("panel-score-them").style.visibility = "hidden";
    document.getElementById("score-left").style.visibility  = "hidden";
    document.getElementById("score-right").style.visibility = "hidden";
    buildFourDotsBoard();
    fdSetMyTurn(false);
  } else {
    canvas.style.display      = "block";
    reactionUI.style.display  = "none";
    raidUI.style.display      = "none";
    fourdotsUI.style.display  = "none";
    // Restore scores for canvas games
    document.getElementById("panel-score-you").style.visibility  = "visible";
    document.getElementById("panel-score-them").style.visibility = "visible";
    document.getElementById("score-left").style.visibility  = "visible";
    document.getElementById("score-right").style.visibility = "visible";
    if (game === "snake") {
      hint.innerHTML     = '<span>Arrow keys / WASD &nbsp;&mdash;&nbsp; steer</span>';
      status.textContent = "FIRST TO 3 ROUNDS";
      dpad.style.display = "grid";
      document.getElementById("pong-slider-wrap").style.display = "none";
    } else {
      hint.innerHTML     = '<span>W / S &nbsp;&mdash;&nbsp; move paddle</span>';
      status.textContent = "FIRST TO 5";
      dpad.style.display = "none";
      document.getElementById("pong-slider-wrap").style.display = "flex";
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

  // Mobile score bar — after canvas mirror, YOUR side is always on the right of the screen.
  // score-left = opponent side (left of screen), score-right = your side (right of screen).
  document.getElementById("score-left").textContent  = them;
  document.getElementById("score-right").textContent = my;

  // Desktop side panels
  document.getElementById("panel-score-you").textContent  = my;
  document.getElementById("panel-score-them").textContent = them;

  // Top branded banner
  document.getElementById("banner-score-you").textContent  = my;
  document.getElementById("banner-score-them").textContent = them;
}

// ── Share card generator ──────────────────────────────────────────
function generateShareCard(scores, winner) {
  const sc  = document.getElementById("share-canvas");
  sc.width  = 800;
  sc.height = 680;
  const ctx = sc.getContext("2d");
  const W = 800, H = 680;

  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ff3366"; ctx.fillRect(0, 0, W, 5);
  ctx.fillStyle = "#00ff88"; ctx.fillRect(0, H - 5, W, 5);

  // Faces
  const vidThem = document.getElementById("video-remote");
  const vidYou  = document.getElementById("video-local");
  const faceW = 180, faceH = 150, faceY = 18;
  ctx.fillStyle = "#1a1a26";
  ctx.fillRect(20, faceY, faceW, faceH);
  ctx.fillRect(W - 20 - faceW, faceY, faceW, faceH);
  try {
    if (vidThem && vidThem.readyState >= 2) {
      ctx.save(); ctx.beginPath(); ctx.rect(20, faceY, faceW, faceH); ctx.clip();
      ctx.drawImage(vidThem, 20, faceY, faceW, faceH); ctx.restore();
    }
    if (vidYou && vidYou.readyState >= 2) {
      ctx.save(); ctx.beginPath(); ctx.rect(W - 20 - faceW, faceY, faceW, faceH); ctx.clip();
      ctx.translate(W - 20 - faceW + faceW, faceY); ctx.scale(-1, 1);
      ctx.drawImage(vidYou, 0, 0, faceW, faceH); ctx.restore();
    }
  } catch(e) {}
  ctx.strokeStyle = "#ff3366"; ctx.lineWidth = 3;
  ctx.strokeRect(20, faceY, faceW, faceH);
  ctx.strokeStyle = "#00ff88";
  ctx.strokeRect(W - 20 - faceW, faceY, faceW, faceH);
  ctx.font = "bold 10px 'Courier New', monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#ff3366"; ctx.fillText("OPPONENT", 20 + faceW / 2, faceY + faceH + 16);
  ctx.fillStyle = "#00ff88"; ctx.fillText("YOU", W - 20 - faceW / 2, faceY + faceH + 16);

  // Score
  const myScore   = myRole === "left" ? scores.left  : scores.right;
  const themScore = myRole === "left" ? scores.right : scores.left;
  const resultText   = winner === "draw" ? "DRAW" : winner === myRole ? "WIN" : "LOSS";
  const resultColour = resultText === "WIN" ? "#00ff88" : resultText === "LOSS" ? "#ff3366" : "#ffffff";
  ctx.font = "bold 54px 'Courier New', monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#ff3366"; ctx.fillText(themScore, W / 2 - 42, faceY + faceH / 2 + 16);
  ctx.fillStyle = "#2a2a3e"; ctx.fillText(":", W / 2, faceY + faceH / 2 + 16);
  ctx.fillStyle = "#00ff88"; ctx.fillText(myScore,   W / 2 + 42, faceY + faceH / 2 + 16);
  ctx.font = "bold 20px 'Courier New', monospace";
  ctx.fillStyle = resultColour; ctx.fillText(resultText, W / 2, faceY + faceH / 2 + 44);
  ctx.font = "10px 'Courier New', monospace"; ctx.fillStyle = "#6666aa";
  ctx.fillText(currentGame ? currentGame.toUpperCase() : "", W / 2, faceY + faceH / 2 + 62);

  // Game snapshot
  const snapY = faceY + faceH + 36;
  const snapH = 240, snapW = W - 40, snapX = 20;
  ctx.fillStyle = "#12121a"; ctx.fillRect(snapX, snapY, snapW, snapH);
  ctx.strokeStyle = "#2a2a3e"; ctx.lineWidth = 2; ctx.strokeRect(snapX, snapY, snapW, snapH);
  ctx.font = "8px 'Courier New', monospace"; ctx.fillStyle = "#6666aa"; ctx.textAlign = "left";
  ctx.fillText("FINAL POSITION", snapX + 8, snapY + 14);
  const gameCanvas = document.getElementById("pong-canvas");
  try {
    if ((currentGame === "pong" || currentGame === "snake") && gameCanvas) {
      ctx.drawImage(gameCanvas, snapX + 2, snapY + 2, snapW - 4, snapH - 4);
    } else if (currentGame === "fourdots" && gameState && gameState.board) {
      const board = gameState.board;
      const rows = board.length, cols = board[0].length;
      const cs = Math.min((snapW - 20) / cols, (snapH - 24) / rows);
      const bx = snapX + (snapW - cs * cols) / 2;
      const by = snapY + 18 + (snapH - 18 - cs * rows) / 2;
      ctx.fillStyle = "#1a1a26"; ctx.fillRect(bx - 4, by - 4, cs * cols + 8, cs * rows + 8);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        ctx.fillStyle = board[r][c] === "left" ? "#ff3366" : board[r][c] === "right" ? "#00ff88" : "#0a0a0f";
        ctx.beginPath(); ctx.arc(bx + c * cs + cs / 2, by + r * cs + cs / 2, cs / 2 - 2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (currentGame === "raid" && gameState && gameState.boards) {
      const gs2 = 8;
      const cs = Math.min((snapW / 2 - 30) / gs2, (snapH - 30) / gs2);
      ["left","right"].forEach((side, i) => {
        const board = gameState.boards[side]; if (!board) return;
        const gx = snapX + 10 + i * (snapW / 2), gy = snapY + 20;
        ctx.font = "8px 'Courier New', monospace"; ctx.fillStyle = side === "left" ? "#ff3366" : "#00ff88"; ctx.textAlign = "center";
        ctx.fillText(side === "left" ? "OPPONENT" : "YOU", gx + (gs2 * cs) / 2, gy - 4);
        for (let r = 0; r < gs2; r++) for (let c = 0; c < gs2; c++) {
          const isHit = board.shots?.some(s => s.x === c && s.y === r && s.hit);
          const isShot = board.shots?.some(s => s.x === c && s.y === r);
          ctx.fillStyle = isHit ? "#ff3366" : isShot ? "#2a2a3e" : "#1a1a26";
          ctx.fillRect(gx + c * cs + 1, gy + r * cs + 1, cs - 2, cs - 2);
        }
      });
    } else {
      ctx.font = "bold 14px 'Courier New', monospace"; ctx.fillStyle = "#2a2a3e"; ctx.textAlign = "center";
      ctx.fillText("ARCADEFACE.COM", snapX + snapW / 2, snapY + snapH / 2);
    }
  } catch(e) {}

  // Branding
  const brandY = snapY + snapH + 22;
  ctx.font = "bold 18px 'Courier New', monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#e8e8f0"; ctx.fillText("ARCADE", W / 2 - 44, brandY);
  ctx.fillStyle = "#ff3366"; ctx.fillText("FACE", W / 2 + 44, brandY);
  ctx.font = "10px 'Courier New', monospace"; ctx.fillStyle = "#6666aa";
  ctx.fillText("#ArcadeFace  ·  arcadeface.com", W / 2, brandY + 20);
}


document.addEventListener("keydown", e => { keys[e.key] = true; });
document.addEventListener("keyup",   e => { keys[e.key] = false; });

// Local paddle Y — kept separate from server gameState for smooth rendering.
// We never write our local prediction back into gameState.paddles; the server is authoritative.
let localPaddleY = 160;
function resetLocalPaddle() { localPaddleY = 160; }

// Pong paddle — keyboard input at 20Hz
setInterval(() => {
  if (!gameState || gameState.game !== "pong" || !roomId || !myRole) return;
  let newY = localPaddleY;
  if (keys["w"]||keys["W"]||keys["ArrowUp"])   newY -= 8;
  if (keys["s"]||keys["S"]||keys["ArrowDown"])  newY += 8;
  newY = Math.max(0, Math.min(H - PADDLE_H, newY));
  if (newY !== localPaddleY) {
    localPaddleY = newY;
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
  localPaddleY = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
});

canvas.addEventListener("touchmove", (e) => {
  if (!gameState || gameState.game !== "pong" || !myRole) return;
  e.preventDefault();
  // On mobile, canvas touch is disabled — slider handles it
}, { passive: false });

// ── Pong mobile slider (vertical) ────────────────────────────────
const sliderTrack = document.getElementById("pong-slider-track");
const sliderThumb = document.getElementById("pong-slider-thumb");

function pongSliderMove(clientY) {
  if (!gameState || gameState.game !== "pong" || !myRole) return;
  const rect    = sliderTrack.getBoundingClientRect();
  const thumbH  = sliderThumb.offsetHeight;
  const trackH  = rect.height;
  const rawY    = clientY - rect.top - thumbH / 2;
  const clampY  = Math.max(0, Math.min(trackH - thumbH, rawY));
  const ratio   = clampY / (trackH - thumbH);
  sliderThumb.style.top = clampY + "px";
  const newY = Math.round(ratio * (H - PADDLE_H));
  localPaddleY = newY;
  socket.emit("paddle_move", { roomId, role: myRole, y: newY });
}

sliderTrack.addEventListener("touchstart", (e) => {
  e.preventDefault();
  pongSliderMove(e.touches[0].clientY);
}, { passive: false });

sliderTrack.addEventListener("touchmove", (e) => {
  e.preventDefault();
  pongSliderMove(e.touches[0].clientY);
}, { passive: false });

// ── Video watchdog — restart stalled videos and recover dead remote streams ──
setInterval(() => {
  // Local video elements
  ["video-local", "video-mobile-local", "video-faceoff-local"].forEach(id => {
    const el = document.getElementById(id);
    if (!el || !el.srcObject) return;
    if (el.paused) el.play().catch(() => {});
  });

  // Remote video elements — also attempt to reassign if stream went dead
  ["video-remote", "video-mobile-remote", "video-faceoff-remote", "video-postgame-remote"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    if (el.srcObject) {
      const tracks = el.srcObject.getTracks();
      const allEnded = tracks.length > 0 && tracks.every(t => t.readyState === "ended");
      if (allEnded) {
        // Stream is dead — try to reassign from _remoteStream or peer receivers
        el.srcObject = null;
        if (window._remoteStream) {
          const newTracks = window._remoteStream.getTracks();
          if (newTracks.some(t => t.readyState === "live")) {
            el.srcObject = window._remoteStream;
            el.play().catch(() => {});
          }
        }
      } else if (el.paused) {
        el.play().catch(() => {});
      }
    } else if (window._remoteStream) {
      // Element has no srcObject but we have a stream — assign it
      const tracks = window._remoteStream.getTracks();
      if (tracks.some(t => t.readyState === "live")) {
        el.srcObject = window._remoteStream;
        el.play().catch(() => {});
      }
    }
  });
}, 1500);

// ── Socket events ─────────────────────────────────────────────────
socket.on("waiting", () => { /* screen already shown */ });

socket.on("match_found", async ({ roomId: rid, role, game }) => {
  const isRematch = (rid === roomId); // same room = rematch
  roomId      = rid;
  myRole      = role;
  currentGame = game;
  clearChat();

  // Only create a new peer connection on first match — reuse on rematch
  let _sendOffer = null; // set below if we're the initiator on a fresh connection
  if (!isRematch || !peerConn || peerConn.connectionState === "closed" || peerConn.connectionState === "failed") {
    // Clear stale remote stream — new peer connection means a fresh ontrack will fire
    window._remoteStream = null;
    await startPeerConnection(role === "left");
    // If we're the initiator, defer the offer until camera is ready (done in countdown init)
    if (role === "left") {
      _sendOffer = async () => {
        const senders = peerConn.getSenders();
        if (localStream) {
          localStream.getTracks().forEach(track => {
            if (!senders.find(s => s.track === track)) peerConn.addTrack(track, localStream);
          });
        }
        const offer = await peerConn.createOffer();
        await peerConn.setLocalDescription(offer);
        socket.emit("webrtc_offer", { roomId, offer });
      };
    }
  }

  // Show my avatar on my panel
  if (myAvatar) {
    refreshMyAvatarCanvases();
    // Broadcast to opponent after a short delay (let WebRTC establish)
    setTimeout(() => socket.emit("player_avatar", { roomId, avatar: myAvatar }), 2000);
  }
  // Clear opponent avatar
  theirAvatar = null;
  ["panel-avatar-them", "mobile-avatar-them"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.getContext("2d").clearRect(0, 0, el.width, el.height);
  });
  // Reset scores and game name immediately — don't wait for setupGameUI.
  // Prevents previous game's state bleeding through during the 10s countdown.
  ["panel-score-you","panel-score-them"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = "0"; el.style.visibility = "hidden"; }
  });
  ["score-left","score-right"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = "0"; el.style.visibility = "hidden"; }
  });
  // Update game name label immediately so mobile banner is correct during countdown
  const _gameName = game === "snake" ? "SNAKE" : game === "reaction" ? "REFLEX" : game === "raid" ? "RAID" : game === "fourdots" ? "4 DOTS" : "PONG";
  const _bgf = document.getElementById("banner-game-fixed");
  const _bg  = document.getElementById("banner-game");
  if (_bgf) _bgf.textContent = _gameName;
  if (_bg)  _bg.textContent  = _gameName;

  startCountdown(() => {
    setupGameUI(currentGame);
    showScreen("screen-game");

    // Force-assign all streams every time game screen shows (handles first match + rematch).
    // Always unconditionally set srcObject — stale streams from previous games won't auto-update.
    if (localStream) {
      ["video-local", "video-mobile-local"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.srcObject = localStream; el.play().catch(() => {}); }
      });
    }
    // _remoteStream was cleared when the new peer connection started, so if it's
    // set here the new ontrack has already fired — assign it. Otherwise poll below.
    ["video-remote","video-mobile-remote"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.srcObject = null; // always clear so assignRemoteStream definitely reassigns
    });
    // Assign remote stream — try immediately, then poll until it arrives.
    // assignRemoteStream covers all remote video elements (game + faceoff + mobile + postgame).
    if (window._remoteStream) {
      assignRemoteStream(window._remoteStream);
    } else if (peerConn) {
      const rcv = peerConn.getReceivers().find(r => r.track && r.track.kind === "video");
      if (rcv) {
        assignRemoteStream(new MediaStream([rcv.track]));
      } else {
        const waitForRemote = setInterval(() => {
          if (window._remoteStream) {
            clearInterval(waitForRemote);
            assignRemoteStream(window._remoteStream);
          } else if (peerConn) {
            const rcv2 = peerConn.getReceivers().find(r => r.track && r.track.kind === "video");
            if (rcv2) {
              clearInterval(waitForRemote);
              assignRemoteStream(new MediaStream([rcv2.track]));
            }
          }
        }, 200);
        setTimeout(() => clearInterval(waitForRemote), 30000);
      }
    }

    if (currentGame !== "fourdots" && currentGame !== "raid" && currentGame !== "reaction") {
      startRenderLoop();
    }
    socket.emit("player_ready", { roomId });
  }, isRematch, _sendOffer);
});


socket.on("webrtc_offer", async ({ offer }) => {
  if (!peerConn) await startPeerConnection(false);

  // Wait up to 8s for camera before answering — ensures tracks are included.
  // The initiator waited too, so both sides have tracks in the negotiation.
  await waitForCamera(8000);

  function addTracksForAnswer() {
    if (!localStream) return;
    const senders = peerConn.getSenders();
    localStream.getTracks().forEach(track => {
      if (!senders.find(s => s.track === track)) peerConn.addTrack(track, localStream);
    });
  }
  addTracksForAnswer();

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
  // Only update score display for games that show scores
  if (gs.scores && (gs.game === "pong" || gs.game === "snake" || gs.game === "reaction")) {
    updateScoreDisplay(gs.scores);
  }
  // Sync local paddle to server's initial position so we start in sync
  if (gs.game === "pong" && gs.paddles && myRole) {
    localPaddleY = myRole === "left" ? gs.paddles.left : gs.paddles.right;
  }
});

socket.on("game_state", ({ gameState: gs }) => {
  gameState = gs;
  // Only update score display for games that show scores
  if (gs.scores && (gs.game === "pong" || gs.game === "snake" || gs.game === "reaction")) {
    updateScoreDisplay(gs.scores);
  }
});

socket.on("game_over", ({ winner, scores }) => {
  stopRenderLoop();
  if (fdTimerInterval) clearInterval(fdTimerInterval);

  const iWon = winner === myRole;
  const isDraw = winner === "draw";
  const safeScores = scores || { left: 0, right: 0 };
  const myScore   = myRole === "left" ? safeScores.left  : safeScores.right;
  const themScore = myRole === "left" ? safeScores.right : safeScores.left;

  // Show result flash overlay on the game screen
  const overlay = document.getElementById("result-flash-overlay");
  const overlayText = document.getElementById("result-flash-text");
  if (overlay && overlayText) {
    overlayText.textContent = isDraw ? "DRAW!" : iWon ? "YOU WIN!" : "YOU LOSE";
    overlayText.style.color = isDraw ? "var(--text)" : iWon ? "var(--accent)" : "var(--accent2)";
    overlay.style.display = "flex";
  }

  // Capture game snapshot while still on game screen
  setTimeout(() => {
    // Generate share card while game screen still visible (captures final state)
    generateShareCard(safeScores, winner);

    // Now set up game-over screen
    const badge = document.getElementById("result-badge");
    if (isDraw) {
      badge.textContent = "DRAW!";
      badge.className   = "result-badge";
    } else {
      badge.textContent = iWon ? "YOU WIN!" : "YOU LOSE";
      badge.className   = "result-badge" + (iWon ? "" : " loss");
    }
    document.getElementById("gameover-score-you").textContent  = myScore;
    document.getElementById("gameover-score-them").textContent = themScore;
    document.getElementById("rematch-status").textContent = "";

    if (overlay) overlay.style.display = "none";

    if (playMode === "friend" && friendCode) {
      // Friend mode — return to lobby, not game-over screen
      showScreen("screen-friend-lobby");
      document.getElementById("friend-lobby-status").textContent = "Game over — pick another!";
      document.getElementById("friend-pick-label").textContent = "Pick a game to start";
      // Reassign friend lobby videos
      if (localStream) {
        const lv = document.getElementById("video-friend-local");
        if (lv) lv.srcObject = localStream;
      }
      if (window._remoteStream) {
        const rv = document.getElementById("video-friend-remote");
        if (rv) rv.srcObject = window._remoteStream;
      }
    } else {
      showScreen("screen-gameover");
    }
  }, 2500);
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
document.getElementById("btn-share-toggle").addEventListener("click", () => {
  const inner  = document.getElementById("share-card-inner");
  const toggle = document.getElementById("btn-share-toggle");
  const isOpen = inner.style.display !== "none";
  inner.style.display  = isOpen ? "none" : "flex";
  toggle.textContent   = isOpen ? "▼ SHOW MATCH CARD" : "▲ HIDE MATCH CARD";
  toggle.classList.toggle("open", !isOpen);
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
  if (peerConn) { peerConn.close(); peerConn = null; }
  window._remoteStream = null;
  gameState = null;
  showScreen("screen-picker");
});

socket.on("opponent_wants_rematch", () => {
  document.getElementById("rematch-status").textContent = "OPPONENT WANTS REMATCH...";
});

socket.on("opponent_left", () => { stopRenderLoop(); showOverlay("overlay-left"); });

// ── Buttons ───────────────────────────────────────────────────────
document.getElementById("btn-cancel-wait").addEventListener("click", () => {
  stopRenderLoop();
  window._remoteStream = null;
  socket.disconnect(); socket.connect();
  showScreen("screen-picker");
});

document.getElementById("btn-rematch").addEventListener("click", () => {
  document.getElementById("rematch-status").textContent = "WAITING FOR OPPONENT...";
  socket.emit("request_rematch", { roomId });
});

document.getElementById("btn-next-match").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  window._remoteStream = null;
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-picker");
});

document.getElementById("btn-home").addEventListener("click", () => {
  if (peerConn) { peerConn.close(); peerConn = null; }
  window._remoteStream = null;
  roomId = null; myRole = null; gameState = null;
  stopCamera();
  showScreen("screen-home");
});

document.getElementById("btn-left-home").addEventListener("click", () => {
  hideOverlay("overlay-left");
  if (peerConn) { peerConn.close(); peerConn = null; }
  window._remoteStream = null;
  roomId = null; myRole = null; gameState = null;
  showScreen("screen-picker");
});

// ── Init ──────────────────────────────────────────────────────────
// ── Avatar System ─────────────────────────────────────────────────
let myAvatar    = null; // 16x16 array of hex color strings
let theirAvatar = null;

const RANDOM_SUBJECTS = [
  "fire dragon","space robot","ninja cat","pixel wizard","zombie unicorn",
  "cyber shark","ghost samurai","electric fox","iron golem","neon frog",
  "lava bird","storm wolf","crystal bear","shadow panther","rocket penguin"
];

function drawAvatarOnCanvas(canvas, grid) {
  if (!canvas || !grid) return;
  const ctx  = canvas.getContext("2d");
  const size = canvas.width;
  const cell = size / 16;
  // Fill dark background first
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, size, size);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const color = grid[r]?.[c];
      if (color && color !== "#000000" && color !== "transparent") {
        ctx.fillStyle = color;
        ctx.fillRect(Math.floor(c * cell), Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}

function refreshMyAvatarCanvases() {
  const ids = ["avatar-canvas-guest", "avatar-canvas-signedin", "panel-avatar-you", "mobile-avatar-you"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) drawAvatarOnCanvas(el, myAvatar);
  });
  // Update labels
  const lGuest = document.getElementById("avatar-lbl-guest");
  const lSigned = document.getElementById("avatar-lbl-signedin");
  if (lGuest)  lGuest.textContent  = myAvatar ? "YOUR ICON" : "CREATE ICON";
  if (lSigned) lSigned.textContent = "YOUR ICON";
}

// ── Photo upload → pixel avatar ───────────────────────────────────
function imageToPixelGrid(imgEl, size = 16) {
  const offscreen = document.createElement("canvas");
  offscreen.width = offscreen.height = size;
  const ctx = offscreen.getContext("2d");
  ctx.drawImage(imgEl, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const grid = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const i = (r * size + c) * 4;
      const R = data[i], G = data[i+1], B = data[i+2], A = data[i+3];
      if (A < 30) { row.push("#000000"); continue; }
      // Quantize to retro palette by snapping to nearest 32
      const qr = Math.round(R / 32) * 32;
      const qg = Math.round(G / 32) * 32;
      const qb = Math.round(B / 32) * 32;
      row.push(`#${qr.toString(16).padStart(2,"0")}${qg.toString(16).padStart(2,"0")}${qb.toString(16).padStart(2,"0")}`);
    }
    grid.push(row);
  }
  return grid;
}

document.getElementById("avatar-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      // Crop to square from centre
      const min = Math.min(img.width, img.height);
      const offscreen = document.createElement("canvas");
      offscreen.width = offscreen.height = min;
      const ctx = offscreen.getContext("2d");
      ctx.drawImage(img,
        (img.width - min) / 2, (img.height - min) / 2, min, min,
        0, 0, min, min
      );
      const grid = imageToPixelGrid(offscreen, 16);
      showAvatarPreview(grid, "Photo pixelated!");
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

// ── Claude API generation ─────────────────────────────────────────
async function generateAvatar(description) {
  document.getElementById("avatar-generating").style.display = "flex";
  document.getElementById("avatar-gen-label").textContent    = "GENERATING...";
  document.getElementById("avatar-actions").style.display    = "none";

  try {
    const response = await fetch("/api/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description })
    });
    if (!response.ok) throw new Error("Server error " + response.status);
    const data = await response.json();
    if (!data.grid) throw new Error("No grid returned");
    showAvatarPreview(data.grid, `"${description}"`);
  } catch(e) {
    document.getElementById("avatar-preview-label").textContent = "Failed — try again";
    document.getElementById("avatar-generating").style.display  = "none";
    console.warn("Avatar gen error:", e);
    return;
  }
  document.getElementById("avatar-generating").style.display = "none";
}

function showAvatarPreview(grid, label) {
  window._pendingAvatar = grid;
  window._pendingLabel  = label;
  const preview = document.getElementById("avatar-preview-canvas");
  drawAvatarOnCanvas(preview, grid);
  document.getElementById("avatar-preview-label").textContent = label;
  document.getElementById("avatar-actions").style.display = "flex";
  document.getElementById("avatar-generating").style.display = "none";
  // Show save button only for signed-in users
  const saveBtn = document.getElementById("btn-save-avatar");
  if (saveBtn) saveBtn.style.display = currentUser ? "block" : "none";
}

// ── Avatar creator screen controls ───────────────────────────────
document.getElementById("btn-generate-avatar").addEventListener("click", () => {
  const input = document.getElementById("avatar-input").value.trim();
  if (!input) return;
  generateAvatar(input);
});

document.getElementById("avatar-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-generate-avatar").click();
});

document.getElementById("btn-random-avatar").addEventListener("click", () => {
  const subject = RANDOM_SUBJECTS[Math.floor(Math.random() * RANDOM_SUBJECTS.length)];
  document.getElementById("avatar-input").value = subject;
  generateAvatar(subject);
});

document.getElementById("btn-use-avatar").addEventListener("click", () => {
  if (!window._pendingAvatar) return;
  myAvatar = window._pendingAvatar;
  try { localStorage.setItem("arcadeface_avatar", JSON.stringify(myAvatar)); } catch(e) {}
  refreshMyAvatarCanvases();
  if (roomId) socket.emit("player_avatar", { roomId, avatar: myAvatar });
  afterAvatarSave();
});

document.getElementById("btn-save-avatar").addEventListener("click", async () => {
  if (!window._pendingAvatar || !currentUser) return;
  const btn = document.getElementById("btn-save-avatar");
  btn.textContent = "SAVING...";
  btn.disabled = true;
  const ok = await vaultSaveIcon(window._pendingAvatar, window._pendingLabel || "icon");
  btn.disabled = false;
  if (ok) {
    btn.textContent = "✓ SAVED";
    await vaultLoad();
    setTimeout(() => { btn.textContent = "▲ SAVE TO VAULT"; }, 1500);
  } else {
    btn.textContent = "▲ SAVE TO VAULT";
  }
});

document.getElementById("btn-regen-avatar").addEventListener("click", () => {
  const input = document.getElementById("avatar-input").value.trim();
  if (input) generateAvatar(input);
  else document.getElementById("btn-random-avatar").click();
});

document.getElementById("btn-skip-avatar").addEventListener("click", () => {
  afterAvatarSave();
});

// ── Avatar Vault (Supabase) ───────────────────────────────────────
// SQL to run in Supabase dashboard:
// create table if not exists player_icons (
//   id uuid default gen_random_uuid() primary key,
//   user_id uuid references auth.users not null,
//   label text,
//   grid jsonb not null,
//   created_at timestamptz default now()
// );
// alter table player_icons enable row level security;
// create policy "Users manage own icons" on player_icons
//   using (auth.uid() = user_id) with check (auth.uid() = user_id);

const VAULT_MAX = 3;
let vaultIcons = []; // [{ id, label, grid }]

async function vaultLoad() {
  if (!sbClient || !currentUser) return;
  const { data, error } = await sbClient
    .from("player_icons")
    .select("id, label, grid, created_at")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true });
  if (error) { console.warn("Vault load error:", error.message); return; }
  vaultIcons = data || [];
  vaultRender();
}

async function vaultSaveIcon(grid, label) {
  if (!sbClient || !currentUser) return false;
  if (vaultIcons.length >= VAULT_MAX) {
    document.getElementById("avatar-vault-hint").textContent =
      "Vault full — delete an icon first";
    return false;
  }
  const { error } = await sbClient.from("player_icons").insert({
    user_id: currentUser.id,
    label: label.replace(/"/g, "").substring(0, 40),
    grid
  });
  if (error) { console.warn("Vault save error:", error.message); return false; }
  return true;
}

async function vaultDeleteIcon(id) {
  if (!sbClient || !currentUser) return;
  const { error } = await sbClient
    .from("player_icons")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) { console.warn("Vault delete error:", error.message); return; }
  vaultIcons = vaultIcons.filter(ic => ic.id !== id);
  vaultRender();
}

function vaultRender() {
  const grid    = document.getElementById("avatar-vault-grid");
  const count   = document.getElementById("avatar-vault-count");
  const hint    = document.getElementById("avatar-vault-hint");
  const vault   = document.getElementById("avatar-vault");
  const saveBtn = document.getElementById("btn-save-avatar");

  if (!grid) return;
  vault.style.display = "block";
  count.textContent   = `${vaultIcons.length} / ${VAULT_MAX}`;

  const full = vaultIcons.length >= VAULT_MAX;
  hint.textContent = full ? "Vault full — delete an icon to create a new one" : "";
  if (saveBtn) saveBtn.style.display = currentUser && !full ? "block" : "none";

  grid.innerHTML = "";

  if (vaultIcons.length === 0) {
    grid.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--muted);padding:4px">No saved icons yet</div>';
    return;
  }

  vaultIcons.forEach(icon => {
    const item = document.createElement("div");
    item.className = "avatar-vault-item";
    if (myAvatar && JSON.stringify(myAvatar) === JSON.stringify(icon.grid)) {
      item.classList.add("active");
    }

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    drawAvatarOnCanvas(canvas, icon.grid);

    const label = document.createElement("div");
    label.className = "avatar-vault-item-label";
    label.textContent = icon.label || "icon";

    const del = document.createElement("button");
    del.className = "avatar-vault-delete";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("Delete this icon?")) vaultDeleteIcon(icon.id);
    });

    // Tap to select
    item.addEventListener("click", () => {
      myAvatar = icon.grid;
      try { localStorage.setItem("arcadeface_avatar", JSON.stringify(myAvatar)); } catch(e) {}
      refreshMyAvatarCanvases();
      if (roomId) socket.emit("player_avatar", { roomId, avatar: myAvatar });
      // Highlight active
      document.querySelectorAll(".avatar-vault-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      document.getElementById("avatar-preview-label").textContent = `Using: ${icon.label || "icon"}`;
      drawAvatarOnCanvas(document.getElementById("avatar-preview-canvas"), icon.grid);
      document.getElementById("avatar-actions").style.display = "flex";
      window._pendingAvatar = icon.grid;
    });

    item.appendChild(canvas);
    item.appendChild(label);
    item.appendChild(del);
    grid.appendChild(item);
  });
}

// ── Inline avatar creator in friend lobby ────────────────────────
document.getElementById("btn-friend-generate").addEventListener("click", async () => {
  const input = document.getElementById("friend-avatar-input").value.trim();
  if (!input) return;
  const status = document.getElementById("friend-avatar-gen-status");
  status.textContent = "generating...";
  try {
    const res  = await fetch("/api/avatar", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({description:input}) });
    const data = await res.json();
    if (data.grid) {
      drawAvatarOnCanvas(document.getElementById("friend-avatar-preview"), data.grid);
      window._friendPendingAvatar = data.grid;
      window._friendPendingLabel  = input;
      document.getElementById("btn-friend-use-icon").classList.remove("hidden");
      status.textContent = `"${input}"`;
    }
  } catch(e) { status.textContent = "failed — try again"; }
});

document.getElementById("friend-avatar-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-friend-generate").click();
});

document.getElementById("btn-friend-random-icon").addEventListener("click", () => {
  const subject = RANDOM_SUBJECTS[Math.floor(Math.random() * RANDOM_SUBJECTS.length)];
  document.getElementById("friend-avatar-input").value = subject;
  document.getElementById("btn-friend-generate").click();
});

document.getElementById("friend-avatar-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const min = Math.min(img.width, img.height);
      const off = document.createElement("canvas");
      off.width = off.height = min;
      off.getContext("2d").drawImage(img, (img.width-min)/2, (img.height-min)/2, min, min, 0, 0, min, min);
      const grid = imageToPixelGrid(off, 16);
      drawAvatarOnCanvas(document.getElementById("friend-avatar-preview"), grid);
      window._friendPendingAvatar = grid;
      window._friendPendingLabel  = "photo";
      document.getElementById("btn-friend-use-icon").classList.remove("hidden");
      document.getElementById("friend-avatar-gen-status").textContent = "Photo ready";
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-friend-use-icon").addEventListener("click", () => {
  if (!window._friendPendingAvatar) return;
  myAvatar = window._friendPendingAvatar;
  try { localStorage.setItem("arcadeface_avatar", JSON.stringify(myAvatar)); } catch(e) {}
  refreshMyAvatarCanvases();
  // Update lobby avatar pip
  const el = document.getElementById("friend-avatar-you");
  if (el) drawAvatarOnCanvas(el, myAvatar);
  // Broadcast to friend
  if (friendCode) socket.emit("friend_avatar", { code: friendCode, avatar: myAvatar });
  document.getElementById("friend-avatar-gen-status").textContent = "✓ Icon updated!";
  document.getElementById("btn-friend-use-icon").classList.add("hidden");
});

// When USE THIS ICON is tapped, return to wherever we came from
function afterAvatarSave() {
  const returnTo = window._avatarReturnTo || "screen-home";
  window._avatarReturnTo = null;
  showScreen(returnTo);
  // If returning to friend lobby, broadcast the new avatar
  if (returnTo === "screen-friend-lobby" && friendCode) {
    socket.emit("friend_avatar", { code: friendCode, avatar: myAvatar });
    // Refresh lobby avatar display
    const el = document.getElementById("friend-avatar-you");
    if (el && myAvatar) drawAvatarOnCanvas(el, myAvatar);
  }
}

function openAvatarCreator() {
  document.getElementById("avatar-input").value = "";
  document.getElementById("avatar-actions").style.display    = "none";
  document.getElementById("avatar-generating").style.display = "none";
  document.getElementById("avatar-preview-label").textContent = "Choose an option below";
  const prev = document.getElementById("avatar-preview-canvas");
  if (prev) {
    prev.getContext("2d").clearRect(0, 0, 128, 128);
    if (myAvatar) {
      drawAvatarOnCanvas(prev, myAvatar);
      document.getElementById("avatar-preview-label").textContent = "Current icon — make a new one below";
      document.getElementById("avatar-actions").style.display = "flex";
      window._pendingAvatar = myAvatar;
    }
  }
  // Gate photo upload to signed-in users
  const isSignedIn = !!currentUser;
  const uploadLabel = document.getElementById("avatar-upload-label");
  const photoBadge  = document.getElementById("avatar-photo-badge");
  const photoSub    = document.getElementById("avatar-photo-sub");
  if (uploadLabel) {
    if (isSignedIn) {
      uploadLabel.classList.remove("disabled");
      if (photoBadge) {
        photoBadge.textContent = "FREE";
        photoBadge.style.color = "var(--accent)";
        photoBadge.style.borderColor = "var(--accent)";
        photoBadge.style.cursor = "default";
        photoBadge.onclick = null;
      }
      if (photoSub) photoSub.textContent = "Pixelate a selfie or any image";
    } else {
      uploadLabel.classList.add("disabled");
      if (photoBadge) {
        photoBadge.textContent = "SIGN IN →";
        photoBadge.style.color = "var(--accent2)";
        photoBadge.style.borderColor = "var(--accent2)";
        photoBadge.style.cursor = "pointer";
        photoBadge.onclick = () => showScreen("screen-signin");
      }
      if (photoSub) photoSub.textContent = "Sign in free to unlock — tap SIGN IN →";
    }
  }

  showScreen("screen-avatar");
  if (currentUser) vaultLoad();
  else document.getElementById("avatar-vault").style.display = "none";
}

// ── Friend code entry on home screen ─────────────────────────────
document.getElementById("btn-join-code").addEventListener("click", () => {
  const code = document.getElementById("friend-code-input").value.trim().toUpperCase();
  if (code.length < 4) return;
  getCamera().then(() => enterFriendLobby(code));
});

document.getElementById("friend-code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join-code").click();
});

document.getElementById("friend-code-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

// Open avatar creator — home screen buttons
document.getElementById("avatar-btn-home").addEventListener("click", openAvatarCreator);
document.getElementById("avatar-btn-home-guest").addEventListener("click", openAvatarCreator);

// Load saved avatar on startup
async function loadSavedAvatar() {
  // Try Supabase first (signed-in users)
  if (sbClient && currentUser) {
    const { data } = await sbClient
      .from("player_icons")
      .select("id, label, grid, created_at")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) {
      myAvatar = data[0].grid;
      try { localStorage.setItem("arcadeface_avatar", JSON.stringify(myAvatar)); } catch(e) {}
      refreshMyAvatarCanvases();
      return;
    }
  }
  // Fall back to localStorage
  try {
    const saved = localStorage.getItem("arcadeface_avatar");
    if (saved) {
      myAvatar = JSON.parse(saved);
      refreshMyAvatarCanvases();
      return;
    }
  } catch(e) {}
  // Draw branded default icon
  drawDefaultIcon();
}

function drawDefaultIcon() {
  const G = "#00ff88", P = "#ff3366", W = "#e8e8f0", B = "#000000", D = "#1a1a26";
  const defaultGrid = [
    [B,B,B,B,B,B,B,B,B,B,B,B,B,B,B,B],
    [B,B,B,B,B,B,B,B,B,B,B,B,B,B,B,B],
    [B,B,P,P,B,B,G,G,G,B,B,P,P,B,B,B],
    [B,B,P,P,B,B,G,B,B,B,B,P,B,P,B,B],
    [B,B,P,P,B,B,G,G,B,B,B,P,P,B,B,B],
    [B,B,P,P,B,B,G,B,B,B,B,P,B,P,B,B],
    [B,B,P,P,P,B,G,G,G,B,B,P,B,P,B,B],
    [B,B,B,B,B,B,B,B,B,B,B,B,B,B,B,B],
    [B,B,B,B,B,W,W,W,W,W,B,B,B,B,B,B],
    [B,B,B,B,W,W,W,W,W,W,W,B,B,B,B,B],
    [B,B,B,W,W,D,W,W,W,D,W,W,B,B,B,B],
    [B,B,B,W,W,W,W,W,W,W,W,W,B,B,B,B],
    [B,B,B,B,W,W,W,W,W,W,W,B,B,B,B,B],
    [B,B,B,B,B,B,W,W,W,B,B,B,B,B,B,B],
    [B,B,B,B,B,B,D,D,D,B,B,B,B,B,B,B],
    [B,B,B,B,B,B,B,B,B,B,B,B,B,B,B,B],
  ];
  ["avatar-canvas-guest","avatar-canvas-signedin"].forEach(id => {
    const el = document.getElementById(id);
    if (el) drawAvatarOnCanvas(el, defaultGrid);
  });
  window._defaultIcon = defaultGrid;
}

// Avatar socket events
socket.on("player_avatar", ({ avatar }) => {
  theirAvatar = avatar;
  ["panel-avatar-them", "mobile-avatar-them"].forEach(id => {
    const el = document.getElementById(id);
    if (el) drawAvatarOnCanvas(el, avatar);
  });
});

initSupabase();
checkFriendLink();
// Draw default icon after DOM settles
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { drawDefaultIcon(); loadSavedAvatar(); });
} else {
  drawDefaultIcon();
  loadSavedAvatar();
}
