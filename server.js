import express from "express";
import nodemailer from "nodemailer";
import crypto from "crypto";
import fs from "fs";

const {
  PORT = 3000, COMPANY_EMAIL, SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS,
  PAYSTACK_SECRET, BASE_URL = "http://localhost:3000", DELIVERY_FEE = 800,
} = process.env;
const FILE = process.env.DATA_FILE || "data.json";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: users will be signed out on every restart.");
const SECURE = BASE_URL.startsWith("https://");
const STAGES = ["Order received", "Preparing your food", "Rider picked it up", "Arriving at your door", "Delivered"];
const PAY_METHODS = ["Card", "Transfer", "Cash"];

/* ---------- storage (single JSON file, written atomically) ---------- */
let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
db.users ||= []; db.vendors ||= []; db.orders ||= []; db.seq ||= 1000;
const save = () => { fs.writeFileSync(FILE + ".tmp", JSON.stringify(db, null, 1)); fs.renameSync(FILE + ".tmp", FILE); };

/* ---------- helpers ---------- */
const ngn = n => "₦" + Math.round(n).toLocaleString("en-NG");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uid = () => crypto.randomUUID().slice(0, 8);
const COLORS = ["#e4572e", "#f3a712", "#2a9d8f", "#6a4c93", "#1982c4", "#8ac926", "#ef476f", "#ff7f50"];

const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
const checkPw = (pw, u) => {
  const a = Buffer.from(hashPw(pw, u.salt).hash, "hex"), b = Buffer.from(u.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const sign = p => { const d = Buffer.from(JSON.stringify(p)).toString("base64url"); return d + "." + crypto.createHmac("sha256", SECRET).update(d).digest("base64url"); };
const verify = t => {
  const [d, s] = String(t || "").split(".");
  if (!d || !s) return null;
  const good = crypto.createHmac("sha256", SECRET).update(d).digest("base64url");
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(d, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
};
const readCookie = (req, name) => (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === name)?.[1];
const setSession = (res, user) => res.setHeader("Set-Cookie",
  `ymo_session=${sign({ uid: user.id, exp: Date.now() + 14 * 864e5 })}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${SECURE ? "; Secure" : ""}`);

const mailer = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
async function mail(to, subject, text) {
  if (!to) return;
  if (!mailer) return console.log(`[email skipped: SMTP not configured] to=${to} subject=${subject}`);
  try { await mailer.sendMail({ from: `Ymo Express <${SMTP_USER}>`, to, subject, text }); }
  catch (e) { console.error("Email failed:", e.message); }
}

const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });
const vendorCard = v => ({
  id: v.id, name: v.name, cuisine: v.cuisine, description: v.description, address: v.address, open: v.open, color: v.color,
  itemCount: v.items.filter(i => i.available).length,
  fromPrice: v.items.filter(i => i.available).reduce((m, i) => Math.min(m, i.price), Infinity),
});
const orderView = o => ({
  id: o.id, stage: o.stage, stageName: STAGES[o.stage], paid: o.paid, pay: o.pay, items: o.items, subtotal: o.subtotal, fee: o.fee,
  total: o.total, restaurant: o.restaurant, vendorId: o.vendorId, name: o.name, phone: o.phone, addr: o.addr, note: o.note, createdAt: o.createdAt,
});

async function notify(o) {
  if (o.notified) return;
  o.notified = true; save();
  const vendor = db.vendors.find(v => v.id === o.vendorId), vUser = db.users.find(u => u.id === vendor?.userId), cUser = db.users.find(u => u.id === o.customerId);
  const lines = o.items.map(i => `${i.q} x ${i.n} (${ngn(i.p * i.q)})`).join("\n");
  const text = `Order ${o.id} from ${o.restaurant}\n\n${lines}\n\nDelivery: ${ngn(o.fee)}\nTotal: ${ngn(o.total)} (${o.paid ? "paid online by card" : o.pay})\nName: ${o.name}\nPhone: ${o.phone}\nAddress: ${o.addr}${o.note ? "\nNote: " + o.note : ""}`;
  await Promise.all([
    mail(vUser?.email, `New order ${o.id}`, text),
    COMPANY_EMAIL && COMPANY_EMAIL !== vUser?.email ? mail(COMPANY_EMAIL, `New order ${o.id} (${o.restaurant})`, text) : null,
    mail(cUser?.email, `Your Ymo Express order ${o.id}`, "Thank you for your order!\n\n" + text),
  ]);
}

/* ---------- app + auth middleware ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  const p = verify(readCookie(req, "ymo_session"));
  req.user = p ? db.users.find(u => u.id === p.uid) || null : null;
  next();
});
app.use(express.static("public"));

const need = role => (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Please sign in" })
    : role && req.user.role !== role ? res.status(403).json({ error: "Not allowed" }) : next();
const myVendor = req => db.vendors.find(v => v.userId === req.user.id);

const attempts = new Map();
const limited = (req, res) => {
  const k = req.ip, now = Date.now(), a = attempts.get(k);
  if (!a || a.reset < now) { attempts.set(k, { n: 1, reset: now + 15 * 60e3 }); return false; }
  if (++a.n > 15) { res.status(429).json({ error: "Too many attempts. Try again in a few minutes." }); return true; }
  return false;
};

/* ---------- auth ---------- */
app.get("/api/health", (q, s) => s.json({ ok: true }));
app.get("/api/config", (q, s) => s.json({ card: !!PAYSTACK_SECRET, deliveryFee: +DELIVERY_FEE, stages: STAGES }));

app.post("/api/auth/signup", (req, res) => {
  if (limited(req, res)) return;
  const b = req.body || {}, role = b.role === "vendor" ? "vendor" : "customer";
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30), password = typeof b.password === "string" ? b.password : "";
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter your name and a valid email" });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: "An account with this email already exists" });
  const rName = str(b.restaurantName, 80);
  if (role === "vendor" && !rName) return res.status(400).json({ error: "Enter your restaurant name" });
  const user = { id: uid(), role, name, email, phone, ...hashPw(password), createdAt: new Date().toISOString() };
  db.users.push(user);
  if (role === "vendor") db.vendors.push({
    id: uid(), userId: user.id, name: rName, cuisine: str(b.cuisine, 60), description: str(b.description, 300), address: str(b.address, 150),
    open: true, color: COLORS[db.vendors.length % COLORS.length], transferInfo: "", items: [],
  });
  save(); setSession(res, user);
  res.status(201).json(publicUser(user));
});

app.post("/api/auth/login", (req, res) => {
  if (limited(req, res)) return;
  const email = str(req.body?.email, 120).toLowerCase(), pw = typeof req.body?.password === "string" ? req.body.password : "";
  const u = db.users.find(x => x.email === email);
  if (!u || !checkPw(pw, u)) return res.status(401).json({ error: "Wrong email or password" });
  setSession(res, u); res.json(publicUser(u));
});
app.post("/api/auth/logout", (q, s) => { s.setHeader("Set-Cookie", "ymo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); s.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json(req.user ? publicUser(req.user) : null));

/* ---------- public browsing ---------- */
app.get("/api/vendors", (q, s) => s.json(db.vendors.map(vendorCard)));
app.get("/api/vendors/:id", (req, res) => {
  const v = db.vendors.find(x => x.id === req.params.id);
  if (!v) return res.sendStatus(404);
  res.json({ ...vendorCard(v), items: v.items.map(({ id, name, desc, price, available, category }) => ({ id, name, desc, price, available, category })) });
});

/* ---------- vendor: profile, menu, orders ---------- */
app.get("/api/vendor/me", need("vendor"), (req, res) => res.json(myVendor(req)));
app.patch("/api/vendor/me", need("vendor"), (req, res) => {
  const v = myVendor(req), b = req.body || {};
  if (typeof b.name === "string" && b.name.trim()) v.name = str(b.name, 80);
  for (const [k, n] of [["cuisine", 60], ["description", 300], ["address", 150], ["transferInfo", 200]]) if (typeof b[k] === "string") v[k] = str(b[k], n);
  if (typeof b.open === "boolean") v.open = b.open;
  save(); res.json(v);
});

const readItem = b => {
  const name = str(b.name, 80), price = Number(b.price);
  if (!name || !Number.isFinite(price) || price < 0 || price > 1e7) return null;
  return { name, price: Math.round(price), desc: str(b.desc, 200), category: str(b.category, 40) || "Mains" };
};
app.post("/api/vendor/items", need("vendor"), (req, res) => {
  const v = myVendor(req), it = readItem(req.body || {});
  if (!it) return res.status(400).json({ error: "Enter an item name and a valid price" });
  if (v.items.length >= 200) return res.status(400).json({ error: "Menu is full" });
  const item = { id: uid(), available: true, ...it };
  v.items.push(item); save(); res.status(201).json(item);
});
app.patch("/api/vendor/items/:id", need("vendor"), (req, res) => {
  const item = myVendor(req).items.find(i => i.id === req.params.id);
  if (!item) return res.sendStatus(404);
  const b = req.body || {};
  if ("name" in b || "price" in b) { const it = readItem({ ...item, ...b }); if (!it) return res.status(400).json({ error: "Invalid item" }); Object.assign(item, it); }
  if (typeof b.desc === "string") item.desc = str(b.desc, 200);
  if (typeof b.available === "boolean") item.available = b.available;
  save(); res.json(item);
});
app.delete("/api/vendor/items/:id", need("vendor"), (req, res) => {
  const v = myVendor(req), n = v.items.length;
  v.items = v.items.filter(i => i.id !== req.params.id);
  if (v.items.length === n) return res.sendStatus(404);
  save(); res.json({ ok: true });
});

app.get("/api/vendor/orders", need("vendor"), (req, res) => {
  const v = myVendor(req);
  res.json(db.orders.filter(o => o.vendorId === v.id && (o.paid || o.pay !== "Card")).reverse()
    .map(o => ({ ...orderView(o), claimed: !!o.sent, customerEmail: db.users.find(u => u.id === o.customerId)?.email })));
});
const vendorOrder = (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.vendorId === myVendor(req).id);
  if (!o) res.sendStatus(404);
  return o;
};
app.patch("/api/orders/:id", need("vendor"), (req, res) => {
  const o = vendorOrder(req, res); if (!o) return;
  const st = req.body?.stage;
  if (!Number.isInteger(st) || st < 0 || st >= STAGES.length) return res.sendStatus(400);
  if (!o.paid && o.pay !== "Cash") return res.status(409).json({ error: "Confirm payment first" });
  o.stage = st; save(); res.json({ ok: true });
});
app.post("/api/orders/:id/confirm", need("vendor"), async (req, res) => {
  const o = vendorOrder(req, res); if (!o) return;
  if (o.pay !== "Transfer") return res.status(400).json({ error: "Only transfer orders need confirming" });
  o.paid = true; save();
  mail(db.users.find(u => u.id === o.customerId)?.email, `Payment received for ${o.id}`,
    `Hi ${o.name}, ${o.restaurant} has received your payment of ${ngn(o.total)}. Your order is being prepared. Thank you!`);
  res.json({ ok: true });
});

/* ---------- customer: place + track orders ---------- */
app.post("/api/orders", need("customer"), async (req, res) => {
  const b = req.body || {};
  const vendor = db.vendors.find(v => v.id === b.vendorId);
  if (!vendor) return res.status(400).json({ error: "Restaurant not found" });
  if (!vendor.open) return res.status(400).json({ error: `${vendor.name} is closed right now` });
  const name = str(b.name, 80), phone = str(b.phone, 30), addr = str(b.addr, 200), pay = b.pay;
  if (!name || !phone || !addr) return res.status(400).json({ error: "Enter your name, phone and delivery address" });
  if (!PAY_METHODS.includes(pay)) return res.status(400).json({ error: "Choose a payment method" });
  if (pay === "Card" && !PAYSTACK_SECRET) return res.status(503).json({ error: "Card payment is not set up yet" });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return res.status(400).json({ error: "Your cart is empty" });

  const items = [];
  for (const line of b.items) {
    const it = vendor.items.find(i => i.id === line?.id);
    if (!it || !it.available) return res.status(400).json({ error: "An item in your cart is no longer available" });
    items.push({ n: it.name, p: it.price, q: Math.max(1, Math.min(50, Math.floor(+line.q) || 1)) });
  }
  const subtotal = items.reduce((s, i) => s + i.p * i.q, 0), fee = +DELIVERY_FEE;
  const o = {
    id: "YMO-" + (++db.seq), customerId: req.user.id, vendorId: vendor.id, restaurant: vendor.name,
    stage: 0, paid: false, pay, items, subtotal, fee, total: subtotal + fee, name, phone, addr, note: str(b.note, 200),
    createdAt: new Date().toISOString(),
  };
  db.orders.push(o); save();

  if (pay === "Card") {
    try {
      const r = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST", headers: { Authorization: "Bearer " + PAYSTACK_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ email: req.user.email, amount: Math.round(o.total * 100), currency: "NGN", reference: o.id + "-" + Date.now(), callback_url: `${BASE_URL}/?order=${o.id}` }),
      });
      const d = (await r.json()).data;
      if (!d?.authorization_url) throw new Error("initialize failed");
      o.ref = d.reference; save();
      return res.status(201).json({ id: o.id, payUrl: d.authorization_url });
    } catch (e) { console.error("Paystack:", e.message); return res.status(502).json({ error: "Payment unavailable. Try again or pick another method." }); }
  }
  await notify(o);
  res.status(201).json({ id: o.id });
});

app.get("/api/my/orders", need("customer"), (req, res) =>
  res.json(db.orders.filter(o => o.customerId === req.user.id && (o.paid || o.pay !== "Card" || o.ref)).reverse().map(orderView)));

const myOrder = (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.customerId === req.user.id);
  if (!o) res.sendStatus(404);
  return o;
};
app.get("/api/orders/:id", need("customer"), (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  res.json({ ...orderView(o), transferInfo: o.pay === "Transfer" ? db.vendors.find(v => v.id === o.vendorId)?.transferInfo : undefined, sent: !!o.sent, stages: STAGES });
});
app.get("/api/orders/:id/verify", need("customer"), async (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (!o.paid && o.ref && PAYSTACK_SECRET) {
    try {
      const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(o.ref), { headers: { Authorization: "Bearer " + PAYSTACK_SECRET } });
      const d = (await r.json()).data;
      if (d?.status === "success" && d.amount === Math.round(o.total * 100)) { o.paid = true; save(); await notify(o); }
    } catch (e) { console.error("Verify:", e.message); }
  }
  res.json({ paid: !!o.paid, stage: o.stage });
});
app.post("/api/orders/:id/sent", need("customer"), async (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (o.pay !== "Transfer") return res.sendStatus(400);
  if (!o.sent) {
    o.sent = true; save();
    const v = db.vendors.find(x => x.id === o.vendorId);
    mail(db.users.find(u => u.id === v?.userId)?.email, `Payment claimed for ${o.id}`,
      `${o.name} says they sent ${ngn(o.total)} by transfer for order ${o.id}.\nPhone: ${o.phone}\n\nCheck your bank app, then open your Ymo Express dashboard and tap "Confirm payment".`);
  }
  res.json({ ok: true });
});

app.use("/api", (q, s) => s.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log("Ymo Express running on port " + PORT));
