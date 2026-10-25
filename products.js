// Edit this file to change store details and the product list. No other file needs touching.

export const STORE = {
  name: "CLERV",
  // WhatsApp number with country code, digits only, e.g. "919876543210". Empty hides the button.
  whatsapp: "",
  // Instagram username for the DM button, without the @. Empty hides the button.
  instagram: "clerv.in",
};

// Required per product:
//   id    – used in links: https://<site>/?p=<id> opens the try-on with that product selected
//   name, price – shown to the customer
//   type  – "watch", "bracelet" or "ring"
//   img   – transparent PNG (or SVG) inside the products/ folder
//
// Image orientation the code expects:
//   watch    – shot face-on, strap running top to bottom, crown on the right (a normal catalogue photo)
//   bracelet – shot from above, band running left to right
//   ring     – shot from above, band running left to right, stone in the middle
//
// Optional fine-tuning (open the page with ?debug=1 while you adjust):
//   fit  – drawn width as a multiple of the wrist/finger width (bigger = wider)
//   push – wrist items: how far up the arm from the wrist joint; rings: 0 = knuckle, 1 = middle joint
//   rot  – extra rotation in degrees, for photos shot at an angle
//   fade – how much of each band end fades out (0–0.4), to fake the band curving round the wrist
//
// The four entries below are placeholders with made-up prices. Replace them with real stock.
export const PRODUCTS = [
  { id: "steel-classic", name: "Steel Classic", price: "₹2,499", type: "watch", img: "products/steel-classic.svg" },
  { id: "tan-chrono", name: "Tan Leather Chrono", price: "₹1,899", type: "watch", img: "products/tan-chrono.svg" },
  { id: "onyx-beads", name: "Onyx Bead Bracelet", price: "₹699", type: "bracelet", img: "products/onyx-beads.svg" },
  { id: "silver-solitaire", name: "Silver Solitaire Ring", price: "₹899", type: "ring", img: "products/silver-solitaire.svg" },
];
