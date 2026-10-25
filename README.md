# CLERV Try-On

A phone-browser try-on for watches, bracelets and rings. The customer taps a link from Instagram, points the camera at their wrist, sees the product on it, and taps **Order on WhatsApp** with the product name already in the message. There is no server: hand tracking runs inside the browser and the camera feed never leaves the phone.

## Files

| File | What it is |
|---|---|
| `products.js` | Store details (WhatsApp number, Instagram handle) and the product list. The only file the owner needs to edit. |
| `app.js` | Camera, hand tracking, placement, smoothing, snapshot, order links. |
| `index.html` | Layout and styles. |
| `products/` | Product images. The four SVGs are placeholders. |

## Run it on your laptop

```bash
cd clerv-tryon
python3 -m http.server 8000
```

Open <http://localhost:8000/?debug=1>. The camera works on `localhost`; anywhere else it needs HTTPS.

## Put it on your phone with GitHub Pages

Create an empty repo called `clerv-tryon` on github.com (no README), then:

```bash
cd clerv-tryon
git init
git add .
git commit -m "Try-on MVP"
git branch -M main
git remote add origin https://github.com/<your-username>/clerv-tryon.git
git push -u origin main
```

On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**. About a minute later it's live at `https://<your-username>.github.io/clerv-tryon/`.

After any change: `git add . && git commit -m "what changed" && git push`. Pages redeploys on its own.

## Add real products

1. **Photograph** each item on a plain background in good light. Watches face-on with the strap running top to bottom and the crown on the right, which is how most catalogue shots already look. Bracelets and rings from above, with the band running left to right.
2. **Remove the background:**
   ```bash
   pip install "rembg[cpu,cli]"
   rembg p raw-photos/ products/
   ```
   The first run downloads the cut-out model. Check each PNG and fix any edges it got wrong.
3. **Add a line to `products.js`**, e.g. `{ id: "fossil-gen5", name: "…", price: "₹…", type: "watch", img: "products/fossil-gen5.png" }`.
4. **Tune it on a real wrist** with `?p=fossil-gen5&debug=1`: `fit` for size, `push` for position, `rot` for odd angles.

Keep the images in this repo. An image served from another domain without CORS headers taints the canvas and breaks the snapshot button.

## Link it from Instagram

Each product has its own link: `https://<your-username>.github.io/clerv-tryon/?p=<id>`. Put it on a story link sticker, in the bio, or paste it in DM replies when someone asks "how will it look?".

## Test on real phones before showing the owner

- Android Chrome, iPhone Safari, and the **Instagram in-app browser** on both (open the link from a DM). If the in-app camera fails, the page tells people to "Open in external browser" and offers photo mode.
- **Handedness check:** with `?debug=1`, show the back of your *right* hand. The label should read "Right hand · back". If it reads "Left", set `HANDEDNESS_SWAPPED = false` in `app.js`. This decides when the watch hides because the palm is facing the camera.
- Dim light, darker skin tones, full sleeves, and a wrist that already has a band on it.

## How it works

MediaPipe's Hand Landmarker returns 21 points per hand for every video frame. For wrist items the code takes the wrist point and the middle knuckle to get the arm direction, uses the knuckle span to estimate wrist width, and slides the product a little towards the elbow. Rings sit between the ring finger's knuckle and middle joint. A One Euro filter smooths the jitter without adding lag when the hand moves fast. The product is a flat image with its band ends faded, so it reads as wrapping round the wrist. Each frame is drawn together with its own detection result, which keeps the product from trailing behind the hand.

## Security and privacy notes

- **No backend, no uploads.** Frames are processed in the browser. A snapshot only leaves the phone if the customer chooses to share it.
- **Third-party code.** The MediaPipe engine loads from jsDelivr and the hand model from Google's storage, both pinned to exact versions so they can't change underneath you. The stronger fix is to copy those files into this repo, so the page only runs code you serve.
- **Untrusted input.** The only input is `?p=`, used purely as a lookup key into `PRODUCTS`. Product names are written with `textContent`, never `innerHTML`.
- **WhatsApp number** is visible in the page source. That's unavoidable for a `wa.me` link, so use the business number.

## Known limits

- It's a 2D overlay, so nothing passes behind the wrist. The faded strap ends hide most of that.
- The first visit downloads the MediaPipe engine and hand model, which is several MB; later visits use the cache. Measure it on mobile data in DevTools → Network.
- Watches always point the crown at the fingers, which suits the left wrist. Flip them for the right wrist once the handedness check above is confirmed.
