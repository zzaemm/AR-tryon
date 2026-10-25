# AR Try-On — Build Plan

This plan is for Claude Code. It replaces the current MVP (a flat image pasted on the wrist) with a realistic 3D try-on for watches first, then rings and bracelets. The end goal is a service that Instagram-first brands can each run under their own name.

**Read all of this before writing code. Then execute ONE milestone at a time, in order.** After each milestone, stop: report what was built, what was tested, and what failed, and wait for approval before starting the next one.

---

## 0. Working rules for Claude Code

1. **One milestone per session.** No scaffolding for later milestones "while you're at it". Unused abstractions are a bug.
2. **Measured, not assumed.** Every acceptance criterion below must be checked: by a test, a recorded-session replay, or a named real-device check that the human performs and reports back. If a check needs a real phone, write down exactly what the human should do and what result to look for. Do not mark it done.
3. **No debug visuals in production builds.** The landmark skeleton, FPS counter and pose axes may only be compiled into dev builds (`import.meta.env.DEV`). A production build must contain none of that code. Add a test that checks this.
4. **Nothing personal leaves the device.** Camera frames, snapshots and landmarks are never uploaded. The only network calls are asset loading and the anonymous analytics events in §10.
5. **Self-host every runtime asset.** That covers the MediaPipe JS, the WASM files, the `.task` model, HDRIs and fonts. Use no CDNs at runtime, pin exact versions, and record versions in `THIRD_PARTY.md`.
6. **Small PRs.** One branch per milestone, conventional commits, and CI green before the milestone is reported done.
7. **When the plan is wrong, say so.** If something here turns out to be infeasible or clearly worse than an alternative, stop and explain. Do not silently deviate.

---

## 1. What we are building

A customer taps a link in a brand's Instagram bio, story or DM, or on its WhatsApp. The link opens a mobile web page, with no app install. The customer points their phone's back camera at their own wrist and sees a **3D watch on their wrist** that:

- sits on the top of the wrist at the right size;
- follows the wrist as it moves and rotates, with no visible jitter at rest;
- has its strap disappear correctly behind the wrist;
- shows metal reflections and a soft contact shadow, and roughly matches the room's brightness;
- turns away naturally when the wrist rotates. When the palm faces the camera, the watch face is hidden by the wrist itself.

The customer can then switch products, take a branded photo to share or send, and tap **Order on WhatsApp** (or DM on Instagram) with the product already written into the message.

### Success criteria (the bar for "realistic")
- **Arm's-length test.** Three people who haven't seen the project each look at a 10-second screen recording of the try-on on a real wrist. At least two of three say it "looks like a real watch on the wrist".
- **Stability.** With the wrist held still, the watch centre moves less than 2 px RMS (on a 720p frame) over 3 s.
- **Speed.** At least 24 fps on a mid-range Android phone (Redmi Note 12 / Galaxy A14 class), and at least 30 fps on an iPhone 12 or newer.
- **Usability.** A first-time user gets from link tap to watch on wrist in under 15 s on 4G, with no instructions beyond the on-screen coach.

### Non-goals (for now)
Clothing try-on, native apps, payments/checkout, user accounts for customers, and AR inside Instagram itself. Meta shut down third-party AR effects in January 2025, so the last one is not possible.

---

## 2. Key decisions and why

| Decision | Choice | Why |
|---|---|---|
| Rendering | **3D with three.js** (WebGL2) | Realistic strap wrap, occlusion, reflections and wrist roll can't be faked with a 2D image. |
| Hand tracking | **MediaPipe Hand Landmarker** (`@mediapipe/tasks-vision`), self-hosted | Runs in the browser at real-time speed, gives 21 image landmarks plus 3D world landmarks in metres, and has an Apache-2.0 licence. |
| Product 3D content | **Parametric watch generator** built from a JSON spec plus photos, with an optional hand-made `.glb` override per product | The bottleneck is content, not code. Most watches are round or square case + bezel + dial + strap, and the dial photo is what makes a watch recognisable. Brands can supply measurements and photos easily, but rarely 3D models. Hero products can get a commissioned `.glb`. |
| Occlusion | **Invisible wrist occluder**: an elliptical cylinder that writes depth only | This is the standard, cheap technique. It hides the back of the strap, and hides the watch face when the palm turns to the camera. |
| Language | **TypeScript**, strict | |
| Build | **Vite** | |
| Hosting | **Cloudflare Pages** | Free, deploys from a *private* GitHub repo (GitHub Pages needs a public repo on free plans), handles custom domains per brand, and analytics endpoints can live on Workers. |
| Tests | **Vitest** for unit tests, **Playwright** for end-to-end and visual tests via recorded-session replay | |

---

## 3. Architecture

```
┌──────────────────────── browser (customer's phone) ───────────────────────┐
│                                                                           │
│  camera (getUserMedia, rear) ──► VideoSource ──► HandTracker (MediaPipe)  │
│                                     │                  │ 21 image pts     │
│                                     │                  │ 21 world pts (m) │
│                                     │                  ▼ handedness       │
│                                     │            PoseSolver               │
│                                     │       (wrist / finger 6-DoF pose)   │
│                                     │                  ▼                  │
│                                     │            PoseFilter (One Euro +   │
│                                     │             quaternion slerp)       │
│                                     ▼                  ▼                  │
│                    Renderer (three.js, one WebGL canvas)                  │
│                    • video as background texture (same frame as tracking) │
│                    • wrist occluder (depth only)                          │
│                    • product: parametric watch or .glb                    │
│                    • env map + light estimate + contact shadow            │
│                                     ▼                                     │
│   UI layer (DOM): coach, product strip, snapshot, CTA, errors             │
│   Analytics (anonymous events) ──────────────► /api/event (CF Worker)     │
└───────────────────────────────────────────────────────────────────────────┘
static assets: /brands/<slug>/brand.json, products/*.json, textures, .glb
```

Each frame is drawn **in the same render as the detection result for that frame**. That is why the video is a WebGL background texture and not a separate `<video>` element: it keeps the product locked to the wrist and makes snapshots trivial.

---

## 4. Repository layout

```
/
├─ PLAN.md                     this file
├─ CLAUDE.md                   short working rules (copy §0 into it)
├─ THIRD_PARTY.md              pinned third-party assets + licences
├─ apps/web/                   the customer-facing try-on (Vite + TS)
│  ├─ src/
│  │  ├─ main.ts               boot, routing (/:brand/:product)
│  │  ├─ camera/               VideoSource, permissions, in-app-browser detection
│  │  ├─ tracking/             HandTracker, PoseSolver, PoseFilter, types
│  │  ├─ render/               Renderer, Occluder, Lighting, ContactShadow
│  │  ├─ products/             schema (zod), ParametricWatch, Ring, Bracelet, GlbProduct
│  │  ├─ ui/                   Coach, ProductStrip, SnapshotSheet, Errors, i18n
│  │  ├─ analytics/            event queue + beacon
│  │  └─ dev/                  debug overlay, recorder (dev builds only)
│  ├─ public/vendor/mediapipe/ self-hosted wasm + .task model
│  └─ tests/                   unit + e2e
├─ brands/<slug>/              brand.json, products/*.json, assets/
├─ tools/
│  ├─ studio/                  (M6) internal product-onboarding page
│  └─ fixtures/                recorded sessions (landmarks JSON only in git)
└─ workers/analytics/          (M5) Cloudflare Worker
```

The current MVP code is reference only. Don't extend it. Port the ideas that still apply: product deep links, the WhatsApp message format, photo-mode fallback, and in-app browser messaging.

---

## 5. Tracking and pose (the core)

### 5.1 Inputs
MediaPipe Hand Landmarker runs in `VIDEO` mode with `numHands: 1`, using the GPU delegate and falling back to CPU. Per frame it gives:
- `landmarks[21]`: normalised image coordinates;
- `worldLandmarks[21]`: metres, origin near the hand centre;
- `handedness`.

**Handedness caveat:** MediaPipe labels handedness as if the image were a mirrored selfie. We feed it raw frames, so the label is expected to be swapped. Do not trust this until it has been verified with a recorded session of a known right hand. Expose it as a single constant with a test.

### 5.2 Wrist frame (orientation)
From world landmarks (W = wrist 0, I = index MCP 5, M = middle MCP 9, P = pinky MCP 17):
- `along = normalize(M − W)` points towards the fingers.
- `across = normalize(I − P)` runs from the pinky side to the index side.
- `normal = normalize(cross(across, along))`, flipped by handedness so that it always points **out of the back of the hand**.
- Re-orthogonalise: `across = cross(along, normal)`. Build a rotation matrix, then a quaternion.

This hand frame is close to the forearm frame but not identical when the wrist is bent. Add a configurable correction tilt (default 0°) and evaluate on recorded sessions. Pose landmarks for the elbow are a stretch goal only, because the elbow is usually off-screen.

### 5.3 Position and scale (no OpenCV)
- Camera intrinsics are assumed from the field of view: default horizontal FOV 65° for the rear camera and 75° for the front, configurable, with a calibration hook later. The three.js camera uses the same FOV, so 3D and 2D agree.
- Depth comes from known metric size: `z = f_px × |I−P|_world / |I−P|_image_px`, averaged with the same ratio for `|W−M|`, weighted by how foreshortened each one is.
- The wrist point in 3D is the image point of W unprojected at depth z.
- The watch centre is that point moved along `−along` by `wristOffset` (default 0.022 m, towards the elbow) and along `normal` by the wrist's half-thickness, so the case rests *on* the skin.

### 5.4 Wrist size
- Default wrist cross-section is an ellipse 0.060 m wide × 0.042 m thick, scaled by `|I−P|_world / 0.075`. Clamp the scale to [0.8, 1.25].
- In the UI, offer an optional "Fit" control (S / M / L, ±8%), remembered per device in `localStorage`.

### 5.5 Rings
The finger frame comes from ring MCP 13 → PIP 14 in world space. The ring sits 35–45% of the way along that segment, and the finger occluder is a cylinder of diameter `0.9 × mean(|9−13|, |13−17|)`. If the product gives a ring size, use the ring's real inner diameter and let the occluder scale to the finger.

### 5.6 Smoothing
- Position uses a One Euro filter per axis. Rotation uses adaptive slerp, where alpha comes from angular velocity, the same idea as One Euro.
- When the hand is lost: hold the last pose for 200 ms, fade out over 200 ms, and reset the filters after 600 ms.
- Expose tunables in one file. Tune them on recorded sessions: jitter at rest (target ≤ 2 px RMS) against lag on fast moves (target ≤ 1.5 frames of visible lag).

### 5.7 Tests (Vitest)
Unit tests with synthetic hands at known rotations must check:
- the solved quaternion is within 3° of ground truth;
- depth is within 10%;
- there are no NaNs on degenerate input (collinear points, zero-length vectors);
- the normal always points dorsal for both hands;
- angle wrap-around (±180°) causes no spin.

---

## 6. Rendering realism

1. **Video background.** A `VideoTexture` on a full-screen quad, drawn first. It is mirrored only for the front camera, and the mirroring is applied consistently to the 3D camera.
2. **Occluder.** A wrist elliptical cylinder about 0.12 m long, aligned with `along`, with `colorWrite: false`, `depthWrite: true` and `renderOrder: 0`. The product renders after it. Rings use a finger cylinder in the same way.
3. **Materials.** Use `MeshPhysicalMaterial`:
   - steel and gold: metalness 1, roughness 0.15–0.35;
   - crystal: a thin dome with clearcoat and low opacity, plus a faint reflection;
   - leather and rubber: roughness 0.6–0.9 with a normal map;
   - dial: the photo texture with sRGB colour space, slight roughness and no metalness.
4. **Environment.** One small neutral studio HDRI, under 1 MB, prefiltered with PMREM. This is what makes metal look like metal.
5. **Light estimation.** Every 500 ms, sample a 32×32 downscale of the video. Its mean luminance drives `toneMappingExposure` within a clamped range, and its mean chroma tints the key light. Smooth both changes.
6. **Contact shadow.** A soft dark ellipse decal on the occluder surface under the case. It uses multiply blending at around 35% opacity, and its size follows the case.
7. **Tone mapping and colour.** ACES Filmic, sRGB output. The video texture must not be tone-mapped twice.
8. **Antialiasing.** MSAA if available, otherwise FXAA. Device pixel ratio is capped at 2.

Visual reference: commission or photograph one real watch on a real wrist under indoor light, and keep it in `tools/fixtures/reference/` (private, not committed if it's a real person). Compare renders against it.

---

## 7. Products

### 7.1 Parametric watch: JSON schema (validate with zod at build time)
```jsonc
{
  "id": "steel-classic-40",
  "type": "watch",
  "name": "Steel Classic 40",
  "price": { "amount": 2499, "currency": "INR" },
  "case": {
    "shape": "round",            // round | square | tonneau | octagon
    "diameterMm": 40,            // or widthMm/heightMm for non-round
    "thicknessMm": 11,
    "lugToLugMm": 47,
    "bezel": { "widthMm": 2.5, "material": "steel-polished" },
    "material": "steel-brushed", // preset id or { color, metalness, roughness }
    "crown": { "side": "right", "diameterMm": 6 }
  },
  "dial": {
    "texture": "dial.webp",      // straight-on photo, cropped to the dial circle
    "printedHands": true         // hands are part of the photo
  },
  "strap": {
    "kind": "bracelet-links",    // leather | rubber | mesh | bracelet-links | nato
    "widthMm": 20,
    "material": "steel-brushed",
    "texture": "strap.webp"      // optional tileable texture for leather/rubber/nato
  },
  "model": null,                 // optional "watch.glb" overrides everything above
  "variants": []                 // optional colourways: partial overrides of the same schema
}
```

### 7.2 Generator (runtime, three.js)
- **Case:** `LatheGeometry` for round cases and an extruded bevelled shape for the others. Lugs are separate bevelled boxes sized to the strap width.
- **Dial:** a disc with the dial texture, recessed under the crystal dome.
- **Strap:** a ribbon swept along the occluder ellipse (offset by 1.5 mm) from lug to lug, all the way round. Bracelet links are an `InstancedMesh` along the same path, and leather/rubber use the texture with a normal map.
- **Units:** millimetres from the spec, converted to metres in the scene. The real case diameter therefore gives real size on the wrist.

### 7.3 `.glb` override
A product can ship a `.glb` with named nodes (`case`, `dial`, `strap_top`, `strap_bottom`), compressed with meshopt and KTX2 textures, under 1.5 MB. The strap nodes are bent to the wrist ellipse with a simple vertex deform, or left as-is if the model already has a strap curve.

### 7.4 Rings and bracelets (M4)
- **Ring:** a parametric band (profile + width + inner diameter) with an optional head (solitaire / bezel / flat). Stones use a refractive-looking material with an env-map sparkle; they are not physically correct, but must look convincing.
- **Bracelets:** chain, bead or bangle, all generated along the wrist ellipse path the same way as watch bracelets.

---

## 8. Customer UX (production)

Mobile-first and portrait; it must also work on desktop. No debug UI anywhere.

1. **Landing.** The product rendered in 3D, slowly turning (also used as the no-camera fallback), with name and price, a primary **Try it on** button, and the line "Your camera stays on your phone. Nothing is uploaded." The tracking model downloads in the background with real progress (bytes), shown only if the user is waiting on it.
2. **Permission.** Ask for the camera only after the tap. Explain any failure with a next step:
   - denied: how to re-allow;
   - in an Instagram/Facebook in-app browser that blocks the camera: "Open in browser" instructions plus a copy-link button;
   - no camera: go to the 3D viewer and offer photo mode.
3. **Coach.** A faint wrist outline with "Hold your wrist here". It disappears when tracking is stable for 0.5 s and reappears after 2 s without a hand. Wording for rings: "Show the back of your hand".
4. **Live try-on.**
   - Bottom sheet: product strip with thumbnails rendered from the 3D model, then variant chips, then a **Fit** S/M/L control.
   - Top: brand logo and a close button.
   - A floating snapshot button.
   - Primary CTA: **Order on WhatsApp**, plus a secondary **DM on Instagram**.
5. **Snapshot sheet.** The captured frame with a subtle brand watermark, plus **Share**, **Save** and **Send on WhatsApp**. Use the Web Share API with files, falling back to download or long-press to save. Build the file without awaiting before `share()`, because Safari requires the share to come straight from the tap.
6. **Photo mode.** For when the camera is unavailable: run the tracker in `IMAGE` mode on an uploaded photo and render the same 3D product onto it.
7. **Language.** English and Malayalam to start, with strings in per-brand overridable JSON. No hard-coded copy.
8. **Accessibility.** All controls labelled, 44 px tap targets, respects reduced motion (no auto-spin), and contrast meets WCAG AA.

**WhatsApp message template** (per brand, i18n): `Hi {brand}! I tried on {product} ({variant}, {price}) and I'd like to order it. {productUrl}`. Use `wa.me/<number>?text=…`, and always `encodeURIComponent` it.

---

## 9. Multi-brand (M5)

- **`brands/<slug>/brand.json`:** name, logo (SVG), colours (primary, accent, background), font (self-hosted), WhatsApp number, Instagram handle, languages, CTA templates, watermark position, and the custom domain if any.
- **Routes:** `/<brand>/<product>` on the shared domain, plus a custom domain per brand mapped to its slug through Cloudflare Pages.
- **Build:** fully static. The build validates every brand and product JSON with zod and fails on any error, such as a missing texture or wrong units.
- **Isolation:** a brand's page loads only that brand's config and assets. There is no runtime fetch of other brands' data.

---

## 10. Analytics (M5) — anonymous, no cookies

- **Events:** `page_open`, `tryon_start`, `camera_granted`, `camera_failed{reason}`, `hand_tracked` (first time only), `product_view{id}`, `variant_select{id}`, `snapshot`, `share`, `cta_whatsapp{id}`, `cta_instagram{id}`.
- **Each event carries:** brand slug, product id, a coarse device class (`android`/`ios`/`desktop`, `in_app` true/false), and a timestamp. Nothing else: no IP storage, no fingerprinting, no user id.
- **Endpoint:** a Cloudflare Worker `/api/event` writing to Workers Analytics Engine. Batch events with `navigator.sendBeacon`.
- **Brand report:** for v1, a CSV per brand per month from a script: try-ons, CTA clicks per product, and the conversion funnel. This number is what sells the service.

---

## 11. Security and privacy

- **CSP**: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; style-src 'self'; frame-ancestors 'none'`. Verify that MediaPipe and three.js work under it on Chrome Android and iOS Safari. Only loosen a directive with a written reason.
- **Inputs:** URL params (`brand`, `product`, `variant`) are lookup keys only, checked against the built manifest. All copy is set via `textContent`; there is no `innerHTML` with data anywhere, and a lint rule enforces it.
- **Data:** no PII. Camera, landmarks and snapshots stay on the device, and recorded test fixtures (§12) are kept out of public repos. This keeps us clear of collecting personal data under India's DPDP Act. Have a lawyer confirm before signing brands.
- **Supply chain:** use a lockfile, run `npm audit` in CI, use Dependabot, and self-host all third-party runtime assets.
- **Admin/studio (M6):** behind Cloudflare Access (email allow-list). It is never deployed on brand domains.

---

## 12. Testing strategy

1. **Unit tests (Vitest):** pose solver, filters, schema validation, the WhatsApp link builder, and the parametric geometry (dimensions in = dimensions out, within 0.1 mm).
2. **Recorded sessions.** A dev-only `/dev/recorder` page saves the camera video and per-frame `{landmarks, worldLandmarks, handedness, timestamp}` locally.
   - The human records about 12 clips: left and right wrists, back and palm, slow roll, fast move, dim and bright light, and at least 3 different people (with their consent) covering different skin tones.
   - Landmark JSON goes in `tools/fixtures/`. Videos stay out of git.
3. **Replay e2e (Playwright).**
   - Convert a clip to `.y4m` for Chromium's fake camera.
   - Stub the tracker to replay the recorded landmarks frame by frame. This makes the test deterministic.
   - Assert jitter at rest, that the face is hidden in the palm-facing segments, and that there are no console errors. Take screenshots at fixed timestamps.
4. **Visual regression:** compare against approved screenshots, with tolerance for GPU differences.
5. **Production-build check:** grep the production bundle for debug-only identifiers and fail if any are found.
6. **Real-device matrix (human-run each milestone, results in `TESTING.md`):**
   - devices: Android Chrome mid-range, iPhone Safari;
   - in-app browsers: Instagram and WhatsApp on both;
   - a laptop webcam.

---

## 13. Performance budgets

- App JS (excluding MediaPipe and three.js) ≤ 150 KB gzipped. three.js is tree-shaken.
- Per product ≤ 1.5 MB, including textures (WebP/KTX2).
- First paint of the landing page with the 3D product ≤ 2.5 s on Fast-4G emulation.
- The tracking model and WASM are cached by a service worker after the first visit.
- Frame time ≤ 40 ms on a mid-range Android. If it's over budget, first lower the tracking input resolution, then lower the render resolution. Never drop the occluder.

---

## 14. Milestones

Each one must meet its acceptance criteria before the next starts.

### M0 — Foundation (≈1 day)
Vite + TS strict + ESLint + Prettier + Vitest + Playwright, self-hosted MediaPipe assets, Cloudflare Pages deploy from the private repo, CI on PRs.
**Done when:** CI is green, the deployed URL serves a page that opens the camera on a real phone, and THIRD_PARTY.md is filled in.

### M1 — Tracking core + recorder (≈2–3 days)
HandTracker, PoseSolver, PoseFilter, the dev recorder, the replay harness and a dev-only debug overlay.
**Done when:**
- §5.7 unit tests pass;
- the human has recorded the §12 clips;
- replay gives jitter at rest ≤ 2 px RMS;
- handedness and dorsal-normal direction are verified on recorded left and right hands.

### M2 — Realistic watch v1 (≈4–6 days) ← the make-or-break milestone
Renderer, occluder, parametric watch from JSON, environment + light estimation, contact shadow, and Fit S/M/L. Build it with 3 real products supplied by the human (§16).
**Done when:**
- the §1 arm's-length test passes;
- performance budget is met on the device matrix;
- the watch face is hidden by the wrist when the palm faces the camera, through occlusion with no special-case code;
- no debug code is in the production bundle.

**If M2 fails the arm's-length test, stop.** Report which of these looks wrong: size, placement, jitter, materials or strap wrap. Do not move to UX polish.

### M3 — Customer UX + fallbacks (≈3–4 days)
Everything in §8: landing, coach, product strip, snapshot sheet, WhatsApp/IG CTAs, photo mode, in-app browser handling, and i18n (EN + ML).
**Done when:** a first-time user on 4G goes from link to watch on wrist in under 15 s, and every error state has been seen and checked on a real device.

### M4 — Rings and bracelets (≈4–5 days)
**Done when:** the same arm's-length test passes for one ring and one bracelet supplied by the human.

### M5 — Multi-brand, analytics, domains (≈3–4 days)
§9 and §10, plus a second demo brand to prove isolation.
**Done when:** two brands deploy from one repo, each on its own route or domain, and the CSV report script produces correct counts from replayed events.

### M6 — Product studio (≈4–6 days)
Internal page: upload a dial photo, align the circle crop, enter measurements, pick materials with a live 3D preview, then export product JSON + compressed textures straight into `brands/<slug>/`.
**Done when:** the human onboards a new watch in under 10 minutes without editing JSON by hand.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Hand frame ≠ forearm frame when the wrist bends | Configurable tilt, tuned on recordings; coach asks for a relaxed wrist |
| Jitter on cheap phones | Tune One Euro on recorded clips; lower tracking resolution before render quality |
| Instagram in-app browser blocks the camera on some devices | Detect it, show "Open in browser" + copy link, offer photo mode and the 3D viewer |
| Dial photos with glare or perspective look fake | Photo spec (§16), plus a perspective-correct crop in the studio |
| First-load size (MediaPipe + model) | Show the 3D product immediately; download tracking in the background; service-worker cache |
| Handedness convention wrong | Verified in M1 with recorded known-hand clips |
| Commercial try-on SDKs already exist | Our edge is price for small sellers, a WhatsApp-native flow, Malayalam/regional UX, and onboarding a catalogue in minutes |

---

## 16. What the human supplies (start gathering now)

**For each watch (3 for M2):**
- Name, price, and any variants (colourways).
- Measurements in mm: case diameter (or width × height), case thickness, lug-to-lug, strap/lug width. Use a vernier caliper or the manufacturer spec.
- Case material and finish (polished/brushed steel, gold-tone, rose gold, black PVD…), strap type (leather, rubber, mesh, link bracelet, NATO) and colour.
- Photos, shot on a plain mid-grey background in soft daylight with no flash, using the phone's main camera from about 30 cm, without zoom:
  1. the dial dead straight-on, filling most of the frame, with no reflections (tilt a white card above it to kill glare);
  2. the side view showing the crown and case thickness;
  3. the strap top surface, laid flat;
  4. the clasp or buckle;
  5. the watch worn on a wrist from above, as a realism reference.
- Any official 3D model or product renders the brand has.

**For each ring (M4):** sizes available, band width and thickness in mm, stone size and shape, metal finish, plus top, side and worn photos.

**For each bracelet (M4):** inner circumference, bead or link size in mm, material, plus a flat top photo and a worn photo.

**For testing:** about 12 short clips of wrists from at least 3 consenting people (see §12), recorded with the dev recorder in M1.

**Brand details (M3/M5):** logo (SVG if possible), brand colours, WhatsApp business number, Instagram handle, and the preferred language mix.
