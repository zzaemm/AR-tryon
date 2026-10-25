// CLERV try-on: MediaPipe hand tracking + a 2D product image pinned to the wrist or ring finger.
//
// Flow per camera frame:
//   video frame -> HandLandmarker (21 points) -> anchor pose (centre, angle, width)
//   -> One Euro smoothing -> draw frame + product onto one canvas.
// Drawing the exact frame we ran detection on keeps the product glued to the hand.

import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs";
import { STORE, PRODUCTS } from "./products.js";

// Pinned versions: a floating "latest" would let a CDN change what code runs on the page.
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// MediaPipe labels handedness as if the image were a mirrored selfie. We feed it raw
// frames, so its "Left" is the person's right hand. Verify on a real hand with ?debug=1.
const HANDEDNESS_SWAPPED = true;

// Landmark indices (MediaPipe hand model).
const WRIST = 0, INDEX_MCP = 5, MIDDLE_MCP = 9, RING_MCP = 13, RING_PIP = 14, PINKY_MCP = 17;

const TYPE_DEFAULTS = {
  // toward: which edge of the product image points at the fingers ("right" = watch crown side, "up" = top edge).
  // needsBack: hide the product when the palm faces the camera (a watch face on a palm looks wrong).
  watch:    { anchor: "wrist", toward: "right", fit: 1.25, push: 0.20, fade: 0.18, needsBack: true },
  bracelet: { anchor: "wrist", toward: "up",    fit: 1.20, push: 0.12, fade: 0.20, needsBack: false },
  ring:     { anchor: "ring",  toward: "up",    fit: 1.30, push: 0.40, fade: 0.22, needsBack: false },
};

const HOLD_MS = 250;      // keep drawing the last pose this long after the hand disappears
const FADE_MS = 250;      // then fade out over this long
const RESET_MS = 600;     // after this long without a hand, restart smoothing from scratch

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d");
const video = $("cam");
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
const IN_APP = /Instagram|FBAN|FBAV/i.test(navigator.userAgent);

const products = PRODUCTS.map((p) => {
  const d = TYPE_DEFAULTS[p.type];
  if (!d) throw new Error(`products.js: "${p.id}" has unknown type "${p.type}"`);
  return { ...d, rot: 0, ...p };
});

const state = {
  landmarker: null, lmMode: null, ready: null,
  mode: null,              // "camera" | "photo"
  stream: null, facing: "environment", mirror: false,
  product: null, sprite: null,
  photo: null, photoResult: null,
  raf: 0, lastVideoTime: -1, lastSeen: -Infinity,
  pose: null, filters: null, filterKey: "",
  backScore: 1, palmBlocked: false,
  fps: 0, fpsT: 0, fpsN: 0,
};

/* ---------- geometry ---------- */

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Normalised landmarks -> canvas pixels, mirrored when the view is mirrored.
function toPixels(lm, W, H, mirror) {
  return lm.map((q) => ({ x: (mirror ? 1 - q.x : q.x) * W, y: q.y * H }));
}

// Is the back of the hand towards the camera? The winding of wrist->index->pinky flips
// between palm and back, and between left and right hands, so we need handedness too.
function handFacing(P, label, mirror) {
  const a = sub(P[INDEX_MCP], P[WRIST]), b = sub(P[PINKY_MCP], P[WRIST]);
  let cross = a.x * b.y - a.y * b.x;
  if (mirror) cross = -cross;                       // undo the display mirror: work in raw-image terms
  const hand = HANDEDNESS_SWAPPED ? (label === "Left" ? "Right" : "Left") : label;
  return { hand, back: hand === "Right" ? cross > 0 : cross < 0 };
}

// Where the product goes: centre, rotation, how wide the wrist/finger is, and how far the wrist is rolled.
function anchorPose(P, prod) {
  let F, width, roll = 1, cx, cy;
  if (prod.anchor === "wrist") {
    const palm = dist(P[WRIST], P[MIDDLE_MCP]);     // stable when the wrist rolls
    const span = dist(P[INDEX_MCP], P[PINKY_MCP]);  // shrinks when the wrist rolls
    F = unit(sub(P[MIDDLE_MCP], P[WRIST]));         // points from wrist to fingers
    // Wrist is about 0.9x the knuckle span seen from above, and about 0.45x palm length seen side-on.
    width = Math.max(0.9 * span, 0.45 * palm);
    roll = clamp(span / (0.68 * palm), 0.35, 1);    // 1 = back of the hand square to the camera
    cx = P[WRIST].x - F.x * palm * prod.push;       // slide from the wrist joint towards the elbow
    cy = P[WRIST].y - F.y * palm * prod.push;
  } else {
    const a = P[RING_MCP], b = P[RING_PIP];
    F = unit(sub(b, a));
    width = 0.9 * (dist(P[MIDDLE_MCP], P[RING_MCP]) + dist(P[RING_MCP], P[PINKY_MCP])) / 2;
    cx = a.x + (b.x - a.x) * prod.push;
    cy = a.y + (b.y - a.y) * prod.push;
  }
  // Rotate so the chosen image edge points along F.
  const angle = prod.toward === "right" ? Math.atan2(F.y, F.x) : Math.atan2(F.x, -F.y);
  return { x: cx, y: cy, angle, width, roll };
}

/* ---------- smoothing: One Euro filter (smooth when still, responsive when moving) ---------- */

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.value = null; this.dx = 0; this.t = 0; }
  static alpha(dt, cutoff) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.value === null) { this.value = x; this.t = t; return x; }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const ad = OneEuro.alpha(dt, this.dCutoff);
    this.dx = ad * ((x - this.value) / dt) + (1 - ad) * this.dx;
    const a = OneEuro.alpha(dt, this.minCutoff + this.beta * Math.abs(this.dx));
    this.value = a * x + (1 - a) * this.value;
    return this.value;
  }
}

function smoothPose(raw, t, prod) {
  const key = `${prod.anchor}|${prod.toward}`;
  if (!state.filters || state.filterKey !== key) {
    state.filterKey = key;
    state.filters = {
      x: new OneEuro(1.5, 0.02), y: new OneEuro(1.5, 0.02),
      angle: new OneEuro(1.0, 0.4), width: new OneEuro(0.8, 0.004), roll: new OneEuro(0.8, 0.5),
    };
  }
  const f = state.filters;
  let a = raw.angle;                                 // unwrap so -179° -> 181° doesn't spin the watch
  if (f.angle.value !== null) {
    while (a - f.angle.value > Math.PI) a -= 2 * Math.PI;
    while (a - f.angle.value < -Math.PI) a += 2 * Math.PI;
  }
  return {
    x: f.x.filter(raw.x, t), y: f.y.filter(raw.y, t), angle: f.angle.filter(a, t),
    width: f.width.filter(raw.width, t), roll: f.roll.filter(raw.roll, t),
  };
}

/* ---------- product images ---------- */

const spriteCache = new Map();

// Pre-render each product once, with its band ends faded so it reads as curving round the wrist.
async function getSprite(prod) {
  if (spriteCache.has(prod.id)) return spriteCache.get(prod.id);
  const img = new Image();
  img.src = prod.img;
  await img.decode();
  const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  if (prod.fade > 0) {
    const vertical = prod.toward === "right";        // band runs top-to-bottom in watch photos
    const grad = vertical ? g.createLinearGradient(0, 0, 0, h) : g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(prod.fade, "#000");
    grad.addColorStop(1 - prod.fade, "#000");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  const sprite = { canvas: c, w, h, across: prod.toward === "right" ? h : w };
  spriteCache.set(prod.id, sprite);
  return sprite;
}

function drawProduct(sprite, pose, prod, alpha) {
  const s = (pose.width * prod.fit) / sprite.across;
  const squish = prod.anchor === "wrist" ? pose.roll : 1;   // narrow the band as the wrist turns side-on
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.angle + (prod.rot * Math.PI) / 180);
  if (prod.toward === "right") ctx.scale(s, s * squish); else ctx.scale(s * squish, s);
  ctx.shadowColor = "rgba(0,0,0,.45)";             // shadow units ignore the transform: plain pixels
  ctx.shadowBlur = pose.width * 0.06;
  ctx.shadowOffsetY = pose.width * 0.025;
  ctx.drawImage(sprite.canvas, -sprite.w / 2, -sprite.h / 2);
  ctx.restore();
}

/* ---------- render ---------- */

function render(source, result, now) {
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  ctx.setTransform(state.mirror ? -1 : 1, 0, 0, 1, state.mirror ? W : 0, 0);
  ctx.drawImage(source, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const prod = state.product;
  const lm = result?.landmarks?.[0];
  let P = null, facing = null;

  if (lm && prod) {
    P = toPixels(lm, W, H, state.mirror);
    facing = handFacing(P, result.handedness?.[0]?.[0]?.categoryName ?? "", state.mirror);
    const raw = anchorPose(P, prod);
    if (state.mode === "photo") {
      state.pose = raw;
      state.backScore = facing.back ? 1 : 0;
    } else {
      if (now - state.lastSeen > RESET_MS) { state.filters = null; state.backScore = facing.back ? 1 : 0; }
      state.pose = smoothPose(raw, now / 1000, prod);
      state.backScore = 0.7 * state.backScore + 0.3 * (facing.back ? 1 : 0);
    }
    state.lastSeen = now;
    // Hysteresis so the watch doesn't flicker when the wrist is edge-on.
    if (state.backScore < 0.35) state.palmBlocked = true;
    else if (state.backScore > 0.65) state.palmBlocked = false;
  }

  const since = now - state.lastSeen;
  const alpha = since <= HOLD_MS ? 1 : clamp(1 - (since - HOLD_MS) / FADE_MS, 0, 1);
  const blocked = prod?.needsBack && state.palmBlocked;
  if (state.pose && state.sprite && alpha > 0 && !blocked) drawProduct(state.sprite, state.pose, prod, alpha);

  let hint = "";
  if (!state.landmarker) hint = "Loading try-on…";
  else if (!lm) hint = state.mode === "photo"
    ? "No hand found. Try a brighter photo of your wrist."
    : prod?.anchor === "ring" ? "Show the back of your hand" : "Hold your wrist in view";
  else if (blocked) hint = "Turn your wrist: show the back of your hand";
  setHint(hint);

  if (DEBUG) drawDebug(P, facing, now);
}

function setHint(text) {
  const el = $("hint");
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

function drawDebug(P, facing, now) {
  state.fpsN++;
  if (now - state.fpsT > 1000) { state.fps = state.fpsN; state.fpsN = 0; state.fpsT = now; }
  const r = Math.max(3, canvas.width / 220);
  if (P) {
    ctx.strokeStyle = "rgba(0,255,170,.8)"; ctx.lineWidth = r / 1.5;
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.beginPath(); ctx.moveTo(P[start].x, P[start].y); ctx.lineTo(P[end].x, P[end].y); ctx.stroke();
    }
    ctx.fillStyle = "#ff3b6b";
    for (const p of P) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.fill(); }
  }
  const text = facing
    ? `${facing.hand} hand · ${facing.back ? "back" : "palm"} · ${state.fps} fps`
    : `no hand · ${state.fps} fps`;
  ctx.font = `600 ${Math.round(canvas.height / 34)}px system-ui`;
  ctx.textAlign = "center";                          // centred: the edges get cropped on phones
  ctx.fillStyle = "#0f0";
  ctx.fillText(text, canvas.width / 2, canvas.height * 0.16);
  ctx.textAlign = "start";
}

/* ---------- hand tracker ---------- */

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO", numHands: 1,
  });
  try {
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("GPU delegate unavailable, falling back to CPU", e);
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
  state.lmMode = "VIDEO";
}

async function setMode(mode) {
  if (state.lmMode === mode) return;
  state.lmMode = null;                               // pause detection while switching
  await state.landmarker.setOptions({ runningMode: mode });
  state.lmMode = mode;
}

/* ---------- camera ---------- */

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

async function startCamera(facing) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("Camera API missing"), { name: "NoCameraApi" });
  }
  stopCamera();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  state.stream = stream;
  video.srcObject = stream;
  await video.play();
  const settings = stream.getVideoTracks()[0].getSettings();
  state.facing = settings.facingMode || facing;
  // Laptops don't report facingMode; their webcams face the user, so mirror those too.
  state.mirror = settings.facingMode ? settings.facingMode === "user" : true;
  state.mode = "camera";
  state.filters = null;
  state.lastVideoTime = -1;
  if (state.landmarker) await setMode("VIDEO");
  cancelAnimationFrame(state.raf);                   // flipping cameras must not start a second loop
  state.raf = requestAnimationFrame(loop);

  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  $("flip").hidden = cams.length < 2;
}

function loop() {
  if (state.mode !== "camera") return;
  state.raf = requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === state.lastVideoTime) return;   // no new frame yet
  state.lastVideoTime = video.currentTime;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;                 // also handles phone rotation
    canvas.height = video.videoHeight;
  }
  const now = performance.now();
  let result = null;
  if (state.landmarker && state.lmMode === "VIDEO") {
    try { result = state.landmarker.detectForVideo(video, now); }
    catch (e) { console.error(e); }
  }
  render(video, result, now);
}

function cameraErrorMessage(e) {
  const inApp = IN_APP ? " If you're inside Instagram, tap ⋯ at the top right and choose “Open in external browser”." : "";
  switch (e?.name) {
    case "NotAllowedError": return "Camera permission was blocked." + inApp + " You can also try on a photo.";
    case "NotFoundError": case "OverconstrainedError": return "No camera found on this device. Try on a photo instead.";
    case "NotReadableError": return "Your camera is busy in another app. Close it and try again.";
    case "NoCameraApi": return "This browser can't open the camera." + inApp + " You can also try on a photo.";
    default: return "Couldn't start the camera." + inApp + " You can also try on a photo.";
  }
}

/* ---------- photo mode (fallback when the camera is unavailable) ---------- */

async function usePhoto(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const src = document.createElement("canvas");
    src.width = Math.round(img.naturalWidth * k);
    src.height = Math.round(img.naturalHeight * k);
    src.getContext("2d").drawImage(img, 0, 0, src.width, src.height);

    stopCamera();
    state.mode = "photo";
    state.mirror = false;
    state.photo = src;
    canvas.width = src.width;
    canvas.height = src.height;
    $("start").hidden = true;
    $("flip").hidden = true;
    state.photoResult = null;
    redrawPhoto();                                   // show the photo straight away
    await state.ready;
    if (!state.landmarker) { showError("The try-on couldn't load. Check your connection and reload."); return; }
    await setMode("IMAGE");
    state.photoResult = state.landmarker.detect(src);
    redrawPhoto();
  } catch (e) {
    console.error(e);
    showError("Couldn't read that photo. Try a different one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function redrawPhoto() {
  if (state.mode !== "photo" || !state.photo) return;
  const now = performance.now();
  state.pose = null;
  if (!state.photoResult?.landmarks?.length) state.lastSeen = -Infinity;
  render(state.photo, state.photoResult, now);
}

/* ---------- products, links, snapshot ---------- */

function waLink(prod) {
  const page = new URL(location.href);
  page.search = `?p=${encodeURIComponent(prod.id)}`;
  const text = `Hi ${STORE.name}! I tried on "${prod.name}" (${prod.price}) and I'd like to order it.\n${page}`;
  return `https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(text)}`;
}

async function selectProduct(prod, { updateUrl = true } = {}) {
  state.product = prod;
  state.sprite = null;
  state.filters = null;
  for (const b of $("strip").children) b.setAttribute("aria-pressed", String(b.dataset.id === prod.id));
  $("p-name").textContent = prod.name;
  $("p-price").textContent = prod.price;
  $("hero").src = prod.img;
  $("headline").textContent = prod.anchor === "ring" ? "See it on your finger" : "See it on your wrist";
  $("eyebrow").textContent = `${prod.name} · ${prod.price}`;
  if (STORE.whatsapp) $("wa").href = waLink(prod);
  if (updateUrl) {
    const u = new URL(location.href);
    u.searchParams.set("p", prod.id);
    history.replaceState(null, "", u);
  }
  try {
    const sprite = await getSprite(prod);
    if (state.product === prod) state.sprite = sprite;   // ignore if the user already picked another
  } catch (e) {
    console.error(`Couldn't load ${prod.img}`, e);
  }
  redrawPhoto();
}

function buildStrip() {
  const strip = $("strip");
  for (const p of products) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    b.dataset.id = p.id;
    const img = document.createElement("img");
    img.src = p.img;
    img.alt = "";
    const name = document.createElement("span");
    name.className = "n";
    name.textContent = p.name;                        // textContent, never innerHTML: names are data
    const price = document.createElement("span");
    price.className = "pr";
    price.textContent = p.price;
    b.append(img, name, price);
    b.addEventListener("click", () => selectProduct(p));
    strip.append(b);
  }
}

async function snapshot() {
  if (!canvas.width) return;
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const o = out.getContext("2d");
  o.drawImage(canvas, 0, 0);
  const pad = Math.round(out.height * 0.03);
  o.font = `600 ${Math.round(out.height * 0.026)}px system-ui, sans-serif`;
  o.fillStyle = "rgba(255,255,255,.92)";
  o.shadowColor = "rgba(0,0,0,.6)";
  o.shadowBlur = 8;
  o.fillText(`${STORE.name} · ${state.product.name}`, pad, out.height - pad);
  // Build the file synchronously: Safari only allows share() close to the tap, so no awaits before it.
  const bin = atob(out.toDataURL("image/jpeg", 0.9).split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], `${STORE.name}-${state.product.id}.jpg`, { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showError(msg) {
  $("start").hidden = false;
  $("err").textContent = msg;
  $("err").hidden = false;
}

/* ---------- boot ---------- */

function boot() {
  $("brand").textContent = STORE.name;
  document.title = `${STORE.name} Try-On`;
  $("wa").hidden = !STORE.whatsapp;
  if (STORE.instagram) {
    $("dm").href = `https://ig.me/m/${encodeURIComponent(STORE.instagram)}`;
    $("dm").hidden = false;
  }
  buildStrip();
  // ?p= is only used as a lookup key into our own list; unknown ids fall back to the first product.
  const initial = products.find((p) => p.id === params.get("p")) ?? products[0];
  selectProduct(initial, { updateUrl: false });

  state.ready = initLandmarker()
    .then(() => { $("status").textContent = "Ready"; })
    .catch((e) => {
      console.error(e);
      $("status").textContent = "Couldn't load the try-on. Check your connection and reload.";
    });

  $("go").addEventListener("click", async () => {
    $("err").hidden = true;
    try {
      await startCamera(state.facing);
      $("start").hidden = true;
    } catch (e) {
      console.error(e);
      showError(cameraErrorMessage(e));
    }
  });
  $("flip").addEventListener("click", () =>
    startCamera(state.facing === "user" ? "environment" : "user").catch((e) => showError(cameraErrorMessage(e))));
  $("snap").addEventListener("click", () => snapshot().catch(console.error));
  for (const input of document.querySelectorAll("input[data-photo]")) {
    input.addEventListener("change", () => { usePhoto(input.files[0]); input.value = ""; });
  }
}

boot();
