import express from "express";
import nodemailer from "nodemailer";
import crypto from "crypto";
import fs from "fs";
import { Country, State, City } from "country-state-city";

const {
  PORT = 3000, COMPANY_EMAIL, SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS,
  PAYSTACK_SECRET, BASE_URL = "http://localhost:3000", DELIVERY_FEE = 800,
  COMMISSION_PCT = 20, SERVICE_FEE_PCT = 5.5, MIN_WITHDRAW = 1000, HOLD_HOURS = 24,
  DEMO_PAYMENTS, ADMIN_EMAIL, ADMIN_PASSWORD, GOOGLE_CLIENT_ID, CUSTOMER_APPROVAL = "1",
} = process.env;
const MIN_AGE = 17;
const NEED_CUSTOMER_OK = CUSTOMER_APPROVAL !== "0";
const FILE = process.env.DATA_FILE || "data.json";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: users will be signed out on every restart.");
const SECURE = BASE_URL.startsWith("https://");
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
const ID_DIR = process.env.ID_DIR || "private_ids"; // vendor ID photos: never served publicly
fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.mkdirSync(ID_DIR, { recursive: true });
const STAGES = ["Order received", "Preparing your food", "Rider picked it up", "Arriving at your door", "Delivered"];
const COMMISSION = +COMMISSION_PCT / 100, SERVICE = +SERVICE_FEE_PCT / 100;
// paystack = real payments, demo = fake "Pay now" button for testing only, off = checkout disabled
const PAY_MODE = PAYSTACK_SECRET ? "paystack" : DEMO_PAYMENTS === "1" ? "demo" : "off";
if (PAY_MODE === "demo") console.warn("DEMO_PAYMENTS is on: orders can be 'paid' without real money. Never use this with real customers.");

/* ---------- storage (single JSON file, written atomically) ---------- */
let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
db.users ||= []; db.vendors ||= []; db.orders ||= []; db.reviews ||= []; db.withdrawals ||= []; db.seq ||= 1000;
for (const u of db.users) u.status ||= "approved"; // accounts that existed before approvals are kept
const save = () => { fs.writeFileSync(FILE + ".tmp", JSON.stringify(db, null, 1)); fs.renameSync(FILE + ".tmp", FILE); };

/* ---------- helpers ---------- */
const ngn = n => "₦" + Math.round(n).toLocaleString("en-NG");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uid = () => crypto.randomUUID().slice(0, 8);
const sum = a => a.reduce((s, n) => s + n, 0);
/* photos: the browser shrinks every picture to a JPEG before upload; we check it really is one */
const okImage = v => (typeof v === "string" && /^\/uploads\/[a-f0-9]{16}\.jpg$/.test(v) ? v : "");
const hasImage = url => !!okImage(url) && fs.existsSync(UPLOAD_DIR + "/" + url.slice(9));
const dropImage = url => {
  if (!okImage(url) || db.vendors.some(v => v.cover === url || v.items.some(i => i.image === url))) return;
  fs.rm(UPLOAD_DIR + "/" + url.slice(9), { force: true }, () => {});
};
const COLORS = ["#e4572e", "#f3a712", "#2a9d8f", "#6a4c93", "#1982c4", "#8ac926", "#ef476f", "#ff7f50"];

/* ---------- places: country > state > area (dropdowns only, never typed) ---------- */
const byName = (a, b) => a.name.localeCompare(b.name);
const COUNTRIES = Country.getAllCountries().map(c => ({ code: c.isoCode, name: c.name })).sort(byName);
const countryByCode = new Map(COUNTRIES.map(c => [c.code, c]));
const statesCache = new Map();
const statesOf = cc => {
  if (!statesCache.has(cc)) statesCache.set(cc, State.getStatesOfCountry(cc).map(s => ({ code: s.isoCode, name: s.name })).sort(byName));
  return statesCache.get(cc);
};
// Nigeria: delivery areas are the 774 official local government areas (INEC list, kept in data/ng-lgas.json)
const NG_LGAS = new Map(Object.entries(JSON.parse(fs.readFileSync(new URL("./data/ng-lgas.json", import.meta.url), "utf8"))));
const areasCache = new Map();
const areasOf = (cc, sc) => {
  const k = cc + "|" + sc;
  if (!areasCache.has(k)) {
    let list;
    if (cc === "NG") list = NG_LGAS.get(sc) || [];
    else list = [...new Set((sc ? City.getCitiesOfState(cc, sc) : City.getCitiesOfCountry(cc) || []).map(c => c.name))].sort((a, b) => a.localeCompare(b));
    areasCache.set(k, list);
  }
  return areasCache.get(k);
};
const areaLabel = cc => (cc === "NG" ? "Local government area" : "City");
// returns a clean {country,state,city} or null. allowAll lets state/city be "*" (whole country / whole state)
function cleanLoc(l, allowAll = false) {
  if (!l || typeof l !== "object") return null;
  const country = str(l.country, 3).toUpperCase(), state = str(l.state, 12), city = str(l.city, 90);
  if (!countryByCode.has(country)) return null;
  if (allowAll && state === "*") return { country, state: "*", city: "*" };
  const ss = statesOf(country);
  if (ss.length ? !ss.some(s => s.code === state) : state !== "") return null;
  if (allowAll && city === "*") return { country, state, city: "*" };
  const aa = areasOf(country, state);
  if (aa.length ? !aa.includes(city) : city !== "") return null;
  return { country, state, city };
}
const locText = l => {
  if (!l) return "";
  const c = countryByCode.get(l.country)?.name || l.country;
  if (l.state === "*") return `All of ${c}`;
  const s = statesOf(l.country).find(x => x.code === l.state)?.name || "";
  if (l.city === "*") return `All of ${s}, ${c}`;
  return [l.city, s, c].filter(Boolean).join(", ");
};
const covers = (cov, loc) => cov.country === loc.country && (cov.state === "*" || (cov.state === loc.state && (cov.city === "*" || cov.city === loc.city)));
const vendorCovers = (v, loc) => !!loc && (v.coverage || []).some(c => covers(c, loc));
const listed = v => !!(v.loc && v.coverage?.length) && db.users.find(u => u.id === v.userId)?.status === "approved";

/* ---------- auth helpers ---------- */
const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
const checkPw = (pw, u) => {
  if (!u.salt || !u.hash) return false;
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

/* ---------- age, ID cards, Google ---------- */
const ID_TYPES = { nin: "National ID (NIN)", drivers: "Driver's licence", voters: "Voter's card (PVC)", passport: "International passport" };
const cleanDob = v => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v, 10)); if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
};
const ageOf = dob => {
  const [y, m, d] = dob.split("-").map(Number), t = new Date();
  let a = t.getUTCFullYear() - y; if (t.getUTCMonth() + 1 < m || (t.getUTCMonth() + 1 === m && t.getUTCDate() < d)) a--;
  return a;
};
const cleanIdNo = (type, v) => {
  const n = str(v, 30).replace(/[\s-]/g, "").toUpperCase();
  return type === "nin" ? (/^\d{11}$/.test(n) ? n : "") : /^[0-9A-Z/]{6,25}$/.test(n) ? n : "";
};
const maskId = n => (n ? "•••• " + n.slice(-4) : "");
// Google: the browser gets a signed ID token from Google; we ask Google to confirm it is real and meant for our app
async function googleUser(credential) {
  if (!GOOGLE_CLIENT_ID) throw Object.assign(new Error("Google sign-in is not set up"), { code: 503 });
  let d;
  try { d = await (await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(str(credential, 4000)))).json(); } catch { d = null; }
  if (!d || d.aud !== GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(d.iss) || String(d.email_verified) !== "true" || !d.email)
    throw Object.assign(new Error("Google sign-in failed. Try again."), { code: 401 });
  return { sub: d.sub, email: String(d.email).toLowerCase(), name: str(d.name || d.email.split("@")[0], 80) };
}

// the admin account comes from environment variables only; nobody can sign up as admin
if (ADMIN_EMAIL && ADMIN_PASSWORD && ADMIN_PASSWORD.length >= 8) {
  const email = ADMIN_EMAIL.trim().toLowerCase(), u = db.users.find(x => x.email === email);
  if (!u) { db.users.push({ id: uid(), role: "admin", status: "approved", name: "Admin", email, phone: "", ...hashPw(ADMIN_PASSWORD), createdAt: new Date().toISOString() }); save(); console.log("Admin account created for " + email); }
  else if (u.role !== "admin") console.warn("ADMIN_EMAIL belongs to a normal account, so no admin was created. Use a different email.");
  else if (!checkPw(ADMIN_PASSWORD, u)) { Object.assign(u, hashPw(ADMIN_PASSWORD)); save(); console.log("Admin password updated"); }
}

const mailer = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
async function mail(to, subject, text) {
  if (!to) return;
  if (!mailer) return console.log(`[email skipped: SMTP not configured] to=${to} subject=${subject}`);
  try { await mailer.sendMail({ from: `Ymo Express <${SMTP_USER}>`, to, subject, text }); }
  catch (e) { console.error("Email failed:", e.message); }
}

/* ---------- money: fees, escrow, wallet ---------- */
// Customer pays: food + delivery + service fee. Vendor earns: food - commission + delivery. Platform keeps commission + service fee.
const priceOrder = subtotal => {
  const fee = Math.round(+DELIVERY_FEE), serviceFee = Math.round(subtotal * SERVICE), commission = Math.round(subtotal * COMMISSION);
  return { fee, serviceFee, commission, total: subtotal + fee + serviceFee, vendorNet: subtotal - commission + fee };
};
// money is released to the vendor once the order is delivered AND (the customer confirmed OR HOLD_HOURS passed)
const isCleared = o => o.paid && o.stage === STAGES.length - 1 &&
  (o.confirmed || Date.now() - Date.parse(o.deliveredAt || 0) >= +HOLD_HOURS * 3600e3);
const walletOf = v => {
  const os = db.orders.filter(o => o.vendorId === v.id && o.paid);
  const cleared = os.filter(isCleared), pending = os.filter(o => !isCleared(o));
  const ws = db.withdrawals.filter(w => w.vendorId === v.id);
  const earned = sum(cleared.map(o => o.vendorNet));
  const locked = sum(ws.filter(w => w.status !== "rejected").map(w => w.amount));
  return {
    available: earned - locked, pending: sum(pending.map(o => o.vendorNet)), earned,
    requested: sum(ws.filter(w => w.status === "requested").map(w => w.amount)), withdrawn: sum(ws.filter(w => w.status === "paid").map(w => w.amount)),
    commissionPct: +COMMISSION_PCT, minWithdraw: +MIN_WITHDRAW, holdHours: +HOLD_HOURS, bank: v.bank || null,
    withdrawals: ws.slice().reverse().map(({ id, amount, status, createdAt, paidAt, note }) => ({ id, amount, status, createdAt, paidAt, note })),
    sales: os.slice().reverse().slice(0, 40).map(o => ({ id: o.id, at: o.paidAt || o.createdAt, subtotal: o.subtotal, commission: o.commission, fee: o.fee, net: o.vendorNet, status: isCleared(o) ? "Available" : o.stage === STAGES.length - 1 ? "Waiting for customer to confirm" : "Held until delivery" })),
  };
};

/* ---------- views ---------- */
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, statusNote: u.statusNote || "", google: !!u.google,
  ...(u.role === "vendor" ? (() => { const v = db.vendors.find(x => x.userId === u.id); return v ? { idSent: !!v.idPhoto, idType: ID_TYPES[v.idType] || "" } : {}; })() : {}) });
const ratingOf = vid => {
  const rs = db.reviews.filter(r => r.vendorId === vid);
  return { rating: rs.length ? Math.round(rs.reduce((s, r) => s + r.rating, 0) / rs.length * 10) / 10 : 0, reviewCount: rs.length };
};
const vendorCard = v => ({
  id: v.id, name: v.name, cuisine: v.cuisine, description: v.description, address: v.address, open: v.open, color: v.color, cover: v.cover || "",
  where: locText(v.loc),
  itemCount: v.items.filter(i => i.available && i.image).length,
  fromPrice: v.items.filter(i => i.available && i.image).reduce((m, i) => Math.min(m, i.price), Infinity),
  ...ratingOf(v.id),
});
const reviewView = r => ({ id: r.id, rating: r.rating, comment: r.comment, name: r.name, createdAt: r.createdAt });
const shortName = n => { const p = String(n).trim().split(/\s+/); return p[0] + (p[1] ? " " + p[1][0].toUpperCase() + "." : ""); };
// what a customer may see (never the commission or the vendor's earnings)
const orderView = o => ({
  id: o.id, stage: o.stage, stageName: STAGES[o.stage], paid: !!o.paid, items: o.items, subtotal: o.subtotal, fee: o.fee, serviceFee: o.serviceFee || 0,
  total: o.total, restaurant: o.restaurant, vendorId: o.vendorId, name: o.name, phone: o.phone, addr: o.addr, where: o.where || "", note: o.note, createdAt: o.createdAt,
  confirmed: !!o.confirmed,
});

async function notify(o) {
  if (o.notified) return;
  o.notified = true; save();
  const vendor = db.vendors.find(v => v.id === o.vendorId), vUser = db.users.find(u => u.id === vendor?.userId), cUser = db.users.find(u => u.id === o.customerId);
  const lines = o.items.map(i => `${i.q} x ${i.n} (${ngn(i.p * i.q)})`).join("\n");
  const base = `Order ${o.id} from ${o.restaurant}\n\n${lines}\n\nFood: ${ngn(o.subtotal)}\nDelivery: ${ngn(o.fee)}\nService fee: ${ngn(o.serviceFee)}\nTotal paid: ${ngn(o.total)}\nName: ${o.name}\nPhone: ${o.phone}\nDeliver to: ${o.addr}, ${o.where}${o.note ? "\nNote: " + o.note : ""}`;
  await Promise.all([
    mail(vUser?.email, `New paid order ${o.id}`, base + `\n\nYou earn ${ngn(o.vendorNet)} (food ${ngn(o.subtotal)} minus ${COMMISSION_PCT}% fee ${ngn(o.commission)}, plus delivery ${ngn(o.fee)}). It reaches your wallet after the order is delivered.`),
    COMPANY_EMAIL && COMPANY_EMAIL !== vUser?.email ? mail(COMPANY_EMAIL, `New paid order ${o.id} (${o.restaurant})`, base + `\n\nOur fees: ${ngn(o.commission + o.serviceFee)}`) : null,
    mail(cUser?.email, `Your Ymo Express order ${o.id}`, "Thank you for your order! Your payment is held safely until your food is delivered.\n\n" + base),
  ]);
}
function markPaid(o) {
  if (o.paid) return Promise.resolve();
  o.paid = true; o.paidAt = new Date().toISOString(); save();
  return notify(o);
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
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d", index: false }));
app.use(express.static("public"));

// pending/rejected/suspended accounts can sign in and see their status, but can't use the marketplace
const need = (role, anyStatus = false) => (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Please sign in" })
    : role && req.user.role !== role ? res.status(403).json({ error: "Not allowed" })
      : !anyStatus && req.user.status !== "approved" ? res.status(403).json({ error: "Your account is not approved yet.", status: req.user.status }) : next();
const myVendor = req => db.vendors.find(v => v.userId === req.user.id);

const attempts = new Map();
const limited = (req, res) => {
  const k = req.ip, now = Date.now(), a = attempts.get(k);
  if (!a || a.reset < now) { attempts.set(k, { n: 1, reset: now + 15 * 60e3 }); return false; }
  if (++a.n > 15) { res.status(429).json({ error: "Too many attempts. Try again in a few minutes." }); return true; }
  return false;
};

/* ---------- config + places ---------- */
app.get("/api/health", (q, s) => s.json({ ok: true }));
app.get("/api/config", (q, s) => s.json({
  payMode: PAY_MODE, deliveryFee: Math.round(+DELIVERY_FEE), servicePct: +SERVICE_FEE_PCT, commissionPct: +COMMISSION_PCT,
  minWithdraw: +MIN_WITHDRAW, holdHours: +HOLD_HOURS, stages: STAGES,
  googleClientId: GOOGLE_CLIENT_ID || "", minAge: MIN_AGE, customerApproval: NEED_CUSTOMER_OK,
  idTypes: Object.entries(ID_TYPES).map(([code, name]) => ({ code, name })),
}));
app.get("/api/geo/countries", (q, s) => { s.setHeader("Cache-Control", "public, max-age=86400"); s.json(COUNTRIES); });
app.get("/api/geo/states", (req, res) => {
  const cc = str(req.query.country, 3).toUpperCase();
  if (!countryByCode.has(cc)) return res.status(400).json({ error: "Unknown country" });
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.json(statesOf(cc));
});
app.get("/api/geo/areas", (req, res) => {
  const cc = str(req.query.country, 3).toUpperCase(), sc = str(req.query.state, 12);
  if (!countryByCode.has(cc) || (statesOf(cc).length ? !statesOf(cc).some(s => s.code === sc) : sc !== "")) return res.status(400).json({ error: "Unknown place" });
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.json({ label: areaLabel(cc), areas: areasOf(cc, sc) });
});

/* ---------- auth ---------- */
app.post("/api/auth/signup", async (req, res) => {
  if (limited(req, res)) return;
  const b = req.body || {}, role = b.role === "vendor" ? "vendor" : "customer";
  let name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), g = null;
  const phone = str(b.phone, 30), password = typeof b.password === "string" ? b.password : "";
  if (b.googleCredential) {
    try { g = await googleUser(b.googleCredential); } catch (e) { return res.status(e.code || 401).json({ error: e.message }); }
    email = g.email; name = name || g.name;
  }
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter your name and a valid email" });
  if (!g && (password.length < 8 || password.length > 100)) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
  const dob = cleanDob(b.dob);
  if (!dob) return res.status(400).json({ error: "Enter your date of birth." });
  const age = ageOf(dob);
  if (age < MIN_AGE) return res.status(400).json({ error: `You must be at least ${MIN_AGE} years old to create an account.` });
  if (age > 110) return res.status(400).json({ error: "Check your date of birth." });
  if (!phone) return res.status(400).json({ error: "Enter your phone number" });
  const rName = str(b.restaurantName, 80);
  let loc = null, idType = "", idNumber = "";
  if (role === "vendor") {
    if (!rName) return res.status(400).json({ error: "Enter your restaurant name" });
    loc = cleanLoc(b.loc);
    if (!loc) return res.status(400).json({ error: "Choose where your restaurant is: country, state and area." });
    idType = ID_TYPES[b.idType] ? b.idType : "";
    if (!idType) return res.status(400).json({ error: "Choose which ID card you will upload." });
    idNumber = cleanIdNo(idType, b.idNumber);
    if (!idNumber) return res.status(400).json({ error: idType === "nin" ? "A NIN is 11 digits." : "Enter the number on your ID card." });
  }
  const user = { id: uid(), role, name, email, phone, dob, status: role === "customer" && !NEED_CUSTOMER_OK ? "approved" : "pending",
    ...(g ? { google: g.sub } : hashPw(password)), createdAt: new Date().toISOString() };
  db.users.push(user);
  if (role === "vendor") db.vendors.push({
    id: uid(), userId: user.id, name: rName, cuisine: str(b.cuisine, 60), description: str(b.description, 300), address: str(b.address, 150),
    loc, coverage: [{ ...loc }], open: true, color: COLORS[db.vendors.length % COLORS.length], bank: null, items: [], idType, idNumber, idPhoto: "",
  });
  save(); setSession(res, user);
  if (user.status === "pending") mail(COMPANY_EMAIL, `New ${role} waiting for approval: ${name}`, `${name} (${email}) just created a ${role} account. Open the admin page to review it.`);
  res.status(201).json(publicUser(user));
});

app.post("/api/auth/login", (req, res) => {
  if (limited(req, res)) return;
  const email = str(req.body?.email, 120).toLowerCase(), pw = typeof req.body?.password === "string" ? req.body.password : "";
  const u = db.users.find(x => x.email === email);
  if (u && !u.hash) return res.status(401).json({ error: "This account uses Google. Tap \"Continue with Google\"." });
  if (!u || !checkPw(pw, u)) return res.status(401).json({ error: "Wrong email or password" });
  setSession(res, u); res.json(publicUser(u));
});
// Google sign in: signs in an existing account, or tells the browser to finish sign-up (age, role, ID)
app.post("/api/auth/google", async (req, res) => {
  if (limited(req, res)) return;
  let g; try { g = await googleUser(req.body?.credential); } catch (e) { return res.status(e.code || 401).json({ error: e.message }); }
  const u = db.users.find(x => x.email === g.email);
  if (!u) return res.json({ needsSignup: true, name: g.name, email: g.email });
  if (u.role === "admin") return res.status(403).json({ error: "Admin accounts sign in with a password." });
  u.google ||= g.sub; save(); setSession(res, u); res.json(publicUser(u));
});
app.post("/api/auth/logout", (q, s) => { s.setHeader("Set-Cookie", "ymo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); s.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json(req.user ? publicUser(req.user) : null));

/* ---------- public browsing ---------- */
app.get("/api/vendors", (req, res) => {
  const loc = req.query.country ? cleanLoc({ country: req.query.country, state: req.query.state || "", city: req.query.city || "" }) : null;
  res.json(db.vendors.filter(listed).map(v => ({ ...vendorCard(v), ...(loc ? { covers: vendorCovers(v, loc) } : {}) })));
});
app.get("/api/vendors/:id", (req, res) => {
  const v = db.vendors.find(x => x.id === req.params.id);
  if (!v) return res.sendStatus(404);
  // items without a photo are never shown to customers
  res.json({
    ...vendorCard(v), coverage: (v.coverage || []).map(c => ({ ...c, text: locText(c) })),
    items: v.items.filter(i => i.image).map(({ id, name, desc, price, available, category, image }) => ({ id, name, desc, price, available, category, image })),
  });
});
app.get("/api/vendors/:id/reviews", (req, res) => {
  const v = db.vendors.find(x => x.id === req.params.id);
  if (!v) return res.sendStatus(404);
  res.json({ ...ratingOf(v.id), reviews: db.reviews.filter(r => r.vendorId === v.id).slice().reverse().slice(0, 50).map(reviewView) });
});

/* ---------- vendor: profile, location, menu ---------- */
const vendorSelf = ({ idNumber, idPhoto, ...v }) => ({ ...v, idMasked: maskId(idNumber), idSent: !!idPhoto, whereText: locText(v.loc), coverage: (v.coverage || []).map(c => ({ ...c, text: locText(c) })), areaLabel: v.loc ? areaLabel(v.loc.country) : "Area" });
app.get("/api/vendor/me", need("vendor", true), (req, res) => res.json(vendorSelf(myVendor(req))));
app.patch("/api/vendor/me", need("vendor"), (req, res) => {
  const v = myVendor(req), b = req.body || {};
  if ("loc" in b) { const loc = cleanLoc(b.loc); if (!loc) return res.status(400).json({ error: "Choose your restaurant's country, state and area." }); v.loc = loc; }
  if ("coverage" in b) {
    const list = Array.isArray(b.coverage) ? b.coverage.slice(0, 60).map(c => cleanLoc(c, true)) : [];
    if (!list.length || list.some(c => !c)) return res.status(400).json({ error: "Pick at least one place you deliver to, using the dropdowns." });
    v.coverage = [...new Map(list.map(c => [`${c.country}|${c.state}|${c.city}`, c])).values()];
  }
  if (typeof b.name === "string" && b.name.trim()) v.name = str(b.name, 80);
  for (const [k, n] of [["cuisine", 60], ["description", 300], ["address", 150]]) if (typeof b[k] === "string") v[k] = str(b[k], n);
  if (typeof b.open === "boolean") v.open = b.open;
  if ("cover" in b) { const old = v.cover; v.cover = okImage(b.cover); if (old !== v.cover) { save(); dropImage(old); } }
  save(); res.json(vendorSelf(v));
});

app.get("/api/vendor/reviews", need("vendor"), (req, res) => {
  const v = myVendor(req);
  res.json({ ...ratingOf(v.id), reviews: db.reviews.filter(r => r.vendorId === v.id).slice().reverse().map(reviewView) });
});

app.post("/api/vendor/upload", need("vendor"), express.raw({ type: "image/jpeg", limit: "1mb" }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
    return res.status(400).json({ error: "Choose a photo (JPG, PNG or WebP)" });
  const name = crypto.randomBytes(8).toString("hex") + ".jpg";
  fs.writeFile(UPLOAD_DIR + "/" + name, buf, err => err ? res.status(500).json({ error: "Could not save the photo. Try again." }) : res.status(201).json({ url: "/uploads/" + name }));
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
  const image = okImage(req.body.image);
  if (!hasImage(image)) return res.status(400).json({ error: "Add a photo of this item. A photo is required for every item." });
  const item = { id: uid(), available: true, image, ...it };
  v.items.push(item); save(); res.status(201).json(item);
});
app.patch("/api/vendor/items/:id", need("vendor"), (req, res) => {
  const item = myVendor(req).items.find(i => i.id === req.params.id);
  if (!item) return res.sendStatus(404);
  const b = req.body || {};
  if ("image" in b && !hasImage(okImage(b.image))) return res.status(400).json({ error: "Every item needs a photo. Choose a new photo instead of removing it." });
  if ("name" in b || "price" in b) { const it = readItem({ ...item, ...b }); if (!it) return res.status(400).json({ error: "Invalid item" }); Object.assign(item, it); }
  if (typeof b.desc === "string") item.desc = str(b.desc, 200);
  if (typeof b.available === "boolean") item.available = b.available;
  const oldImg = item.image;
  if ("image" in b) item.image = okImage(b.image);
  save(); if (oldImg !== item.image) dropImage(oldImg);
  res.json(item);
});
app.delete("/api/vendor/items/:id", need("vendor"), (req, res) => {
  const v = myVendor(req), n = v.items.length, gone = v.items.find(i => i.id === req.params.id);
  v.items = v.items.filter(i => i.id !== req.params.id);
  if (v.items.length === n) return res.sendStatus(404);
  save(); dropImage(gone?.image); res.json({ ok: true });
});

// ID card photo: stored in a private folder, only an admin can ever open it
app.post("/api/vendor/id-photo", need("vendor", true), express.raw({ type: "image/jpeg", limit: "3mb" }), (req, res) => {
  const v = myVendor(req), buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: "Choose a clear photo of your ID card (JPG, PNG or WebP)." });
  const name = crypto.randomBytes(12).toString("hex") + ".jpg", old = v.idPhoto;
  fs.writeFile(ID_DIR + "/" + name, buf, err => {
    if (err) return res.status(500).json({ error: "Could not save the photo. Try again." });
    v.idPhoto = name; if (req.user.status === "rejected") { req.user.status = "pending"; req.user.statusNote = ""; }
    save(); if (old) fs.rm(ID_DIR + "/" + old, { force: true }, () => {});
    mail(COMPANY_EMAIL, `Vendor ID uploaded: ${v.name}`, `${v.name} uploaded an ID card. Open the admin page to review it.`);
    res.status(201).json(publicUser(req.user));
  });
});

/* ---------- vendor: orders ---------- */
app.get("/api/vendor/orders", need("vendor"), (req, res) => {
  const v = myVendor(req);
  res.json(db.orders.filter(o => o.vendorId === v.id && o.paid).reverse().map(o => ({
    ...orderView(o), commission: o.commission, earn: o.vendorNet, cleared: isCleared(o),
    customerEmail: db.users.find(u => u.id === o.customerId)?.email,
  })));
});
app.patch("/api/orders/:id", need("vendor"), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.vendorId === myVendor(req).id);
  if (!o) return res.sendStatus(404);
  const st = req.body?.stage;
  if (!Number.isInteger(st) || st < 0 || st >= STAGES.length) return res.sendStatus(400);
  if (!o.paid) return res.status(409).json({ error: "The customer has not paid yet" });
  if (o.stage === STAGES.length - 1) return res.status(409).json({ error: "This order is already delivered" });
  if (st <= o.stage) return res.status(409).json({ error: "An order can only move forward" });
  o.stage = st;
  if (st === STAGES.length - 1) o.deliveredAt = new Date().toISOString();
  save(); res.json({ ok: true });
});

/* ---------- vendor: wallet + withdrawals ---------- */
app.get("/api/vendor/wallet", need("vendor"), (req, res) => res.json(walletOf(myVendor(req))));
app.put("/api/vendor/bank", need("vendor"), (req, res) => {
  const v = myVendor(req), b = req.body || {};
  const bankName = str(b.bankName, 60), accountName = str(b.accountName, 80), accountNumber = str(b.accountNumber, 20).replace(/\s/g, "");
  const okNum = v.loc?.country === "NG" ? /^\d{10}$/.test(accountNumber) : /^[0-9A-Za-z]{6,20}$/.test(accountNumber);
  if (!bankName || !accountName || !okNum) return res.status(400).json({ error: v.loc?.country === "NG" ? "Enter the bank name, the account name and a 10-digit account number." : "Enter the bank name, the account name and the account number." });
  v.bank = { bankName, accountName, accountNumber }; save(); res.json(walletOf(v));
});
app.post("/api/vendor/withdraw", need("vendor"), (req, res) => {
  const v = myVendor(req), w = walletOf(v), amount = Math.round(Number(req.body?.amount));
  if (!v.bank) return res.status(400).json({ error: "Add your bank account first." });
  if (!Number.isFinite(amount) || amount < +MIN_WITHDRAW) return res.status(400).json({ error: `The smallest withdrawal is ${ngn(+MIN_WITHDRAW)}.` });
  if (amount > w.available) return res.status(400).json({ error: `You can withdraw up to ${ngn(w.available)} right now.` });
  const wd = { id: "WD-" + (++db.seq), vendorId: v.id, amount, status: "requested", bank: { ...v.bank }, createdAt: new Date().toISOString() };
  db.withdrawals.push(wd); save();
  mail(COMPANY_EMAIL, `Withdrawal request ${wd.id}: ${ngn(amount)}`, `${v.name} wants to withdraw ${ngn(amount)}.\n\n${v.bank.bankName}\n${v.bank.accountNumber}\n${v.bank.accountName}\n\nSend the money, then mark it as paid in the admin page.`);
  res.status(201).json(walletOf(v));
});

/* ---------- admin: revenue and payouts ---------- */
const vendorName = id => db.vendors.find(v => v.id === id)?.name || "Unknown";
app.get("/api/admin/summary", need("admin"), (req, res) => {
  const paid = db.orders.filter(o => o.paid), cleared = paid.filter(isCleared);
  const commission = sum(paid.map(o => o.commission || 0)), serviceFees = sum(paid.map(o => o.serviceFee || 0));
  res.json({
    payMode: PAY_MODE, orders: paid.length, taken: sum(paid.map(o => o.total)), commission, serviceFees, revenue: commission + serviceFees,
    heldForVendors: sum(paid.filter(o => !isCleared(o)).map(o => o.vendorNet)),
    owedToVendors: sum(cleared.map(o => o.vendorNet)) - sum(db.withdrawals.filter(w => w.status === "paid").map(w => w.amount)),
    withdrawalsWaiting: sum(db.withdrawals.filter(w => w.status === "requested").map(w => w.amount)),
    vendors: db.vendors.length, customers: db.users.filter(u => u.role === "customer").length,
  });
});
app.get("/api/admin/withdrawals", need("admin"), (req, res) =>
  res.json(db.withdrawals.slice().reverse().map(w => ({ ...w, vendor: vendorName(w.vendorId) }))));
app.post("/api/admin/withdrawals/:id", need("admin"), (req, res) => {
  const w = db.withdrawals.find(x => x.id === req.params.id);
  if (!w) return res.sendStatus(404);
  if (w.status !== "requested") return res.status(409).json({ error: "This request was already handled" });
  const action = req.body?.action;
  if (!["paid", "reject"].includes(action)) return res.sendStatus(400);
  w.status = action === "paid" ? "paid" : "rejected"; w.note = str(req.body?.note, 200); w.paidAt = new Date().toISOString(); save();
  const v = db.vendors.find(x => x.id === w.vendorId);
  mail(db.users.find(u => u.id === v?.userId)?.email, action === "paid" ? `Your withdrawal of ${ngn(w.amount)} was paid` : `Your withdrawal of ${ngn(w.amount)} was not paid`,
    action === "paid" ? `We sent ${ngn(w.amount)} to ${w.bank.bankName}, ${w.bank.accountNumber}.` : `Your withdrawal request was rejected and the money is back in your wallet.${w.note ? "\n\nReason: " + w.note : ""}`);
  res.json({ ok: true });
});
const adminUser = u => {
  const v = u.role === "vendor" ? db.vendors.find(x => x.userId === u.id) : null;
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, dob: u.dob || "", age: u.dob ? ageOf(u.dob) : null, status: u.status, statusNote: u.statusNote || "", google: !!u.google, createdAt: u.createdAt,
    ...(v ? { vendorId: v.id, restaurant: v.name, where: locText(v.loc), idType: ID_TYPES[v.idType] || "Not provided", idNumber: v.idNumber || "", idPhoto: !!v.idPhoto, items: v.items.length } : {}),
    ...(u.role === "customer" ? { orders: db.orders.filter(o => o.customerId === u.id && o.paid).length } : {}) };
};
app.get("/api/admin/users", need("admin"), (req, res) => {
  const role = str(req.query.role, 10), status = str(req.query.status, 10), q = str(req.query.q, 60).toLowerCase();
  res.json(db.users.filter(u => u.role !== "admin" && (!role || u.role === role) && (!status || u.status === status) &&
    (!q || (u.name + " " + u.email + " " + u.phone).toLowerCase().includes(q))).slice().reverse().slice(0, 300).map(adminUser));
});
app.get("/api/admin/counts", need("admin"), (req, res) => {
  const c = { pending: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const u of db.users) if (u.role !== "admin") c[u.status]++;
  res.json(c);
});
app.get("/api/admin/id/:userId", need("admin"), (req, res) => {
  const v = db.vendors.find(x => x.userId === req.params.userId);
  if (!v?.idPhoto || !/^[a-f0-9]{24}\.jpg$/.test(v.idPhoto)) return res.sendStatus(404);
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Content-Type", "image/jpeg");
  fs.createReadStream(ID_DIR + "/" + v.idPhoto).on("error", () => res.sendStatus(404)).pipe(res);
});
app.post("/api/admin/users/:id", need("admin"), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id && x.role !== "admin");
  if (!u) return res.sendStatus(404);
  const action = req.body?.action, note = str(req.body?.note, 200);
  const next = { approve: "approved", reject: "rejected", suspend: "suspended", reactivate: "approved" }[action];
  if (!next) return res.sendStatus(400);
  const v = u.role === "vendor" ? db.vendors.find(x => x.userId === u.id) : null;
  if (next === "approved" && v && !v.idPhoto) return res.status(409).json({ error: "This vendor has not uploaded an ID card yet." });
  u.status = next; u.statusNote = next === "approved" ? "" : note; save();
  const subj = { approved: "Your Ymo Express account is approved", rejected: "Your Ymo Express account was not approved", suspended: "Your Ymo Express account is suspended" }[next];
  mail(u.email, subj, next === "approved" ? `Hi ${u.name}, you can now ${u.role === "vendor" ? "list your food and receive orders" : "order food"}.\n\n${BASE_URL}`
    : `Hi ${u.name}, your account is ${next}.${note ? "\n\nReason: " + note : ""}${next === "rejected" && u.role === "vendor" ? "\n\nYou can sign in and upload a clearer ID card to be reviewed again." : ""}`);
  res.json(adminUser(u));
});
app.get("/api/admin/orders", need("admin"), (req, res) =>
  res.json(db.orders.filter(o => o.paid).slice().reverse().slice(0, 60).map(o => ({
    id: o.id, restaurant: o.restaurant, total: o.total, subtotal: o.subtotal, commission: o.commission, serviceFee: o.serviceFee, vendorNet: o.vendorNet,
    stageName: STAGES[o.stage], cleared: isCleared(o), at: o.paidAt || o.createdAt, where: o.where,
  }))));
app.get("/api/admin/vendors", need("admin"), (req, res) =>
  res.json(db.vendors.map(v => ({ id: v.id, name: v.name, where: locText(v.loc), items: v.items.length, orders: db.orders.filter(o => o.vendorId === v.id && o.paid).length, available: walletOf(v).available }))));

/* ---------- customer: place + track orders ---------- */
app.post("/api/orders", need("customer"), async (req, res) => {
  const b = req.body || {};
  if (PAY_MODE === "off") return res.status(503).json({ error: "Payments are not set up yet, so orders can't be placed." });
  const vendor = db.vendors.find(v => v.id === b.vendorId);
  if (!vendor || !listed(vendor)) return res.status(400).json({ error: "Restaurant not found" });
  if (!vendor.open) return res.status(400).json({ error: `${vendor.name} is closed right now` });
  const name = str(b.name, 80), phone = str(b.phone, 30), addr = str(b.addr, 200);
  if (!name || !phone || !addr) return res.status(400).json({ error: "Enter your name, phone and delivery address" });
  const loc = cleanLoc(b.loc);
  if (!loc) return res.status(400).json({ error: "Choose your delivery country, state and area from the lists." });
  if (!vendorCovers(vendor, loc)) return res.status(400).json({ error: `${vendor.name} does not deliver to ${locText(loc)}.` });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return res.status(400).json({ error: "Your cart is empty" });

  const items = [];
  for (const line of b.items) {
    const it = vendor.items.find(i => i.id === line?.id);
    if (!it || !it.available || !it.image) return res.status(400).json({ error: "An item in your cart is no longer available" });
    items.push({ n: it.name, p: it.price, q: Math.max(1, Math.min(50, Math.floor(+line.q) || 1)) });
  }
  const subtotal = items.reduce((s, i) => s + i.p * i.q, 0);
  const o = {
    id: "YMO-" + (++db.seq), customerId: req.user.id, vendorId: vendor.id, restaurant: vendor.name,
    stage: 0, paid: false, items, subtotal, ...priceOrder(subtotal), name, phone, addr, loc, where: locText(loc), note: str(b.note, 200),
    createdAt: new Date().toISOString(),
  };
  db.orders.push(o); save();

  if (PAY_MODE === "paystack") {
    try {
      const r = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST", headers: { Authorization: "Bearer " + PAYSTACK_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ email: req.user.email, amount: Math.round(o.total * 100), currency: "NGN", reference: o.id + "-" + Date.now(),
          channels: ["card", "bank", "ussd", "bank_transfer"], callback_url: `${BASE_URL}/?order=${o.id}` }),
      });
      const d = (await r.json()).data;
      if (!d?.authorization_url) throw new Error("initialize failed");
      o.ref = d.reference; save();
      return res.status(201).json({ id: o.id, payUrl: d.authorization_url });
    } catch (e) { console.error("Paystack:", e.message); return res.status(502).json({ error: "Payment is unavailable right now. Try again in a moment." }); }
  }
  res.status(201).json({ id: o.id });
});

app.get("/api/my/orders", need("customer"), (req, res) =>
  res.json(db.orders.filter(o => o.customerId === req.user.id && (o.paid || Date.now() - Date.parse(o.createdAt) < 864e5)).reverse()
    .map(o => ({ ...orderView(o), reviewed: db.reviews.some(r => r.orderId === o.id) }))));

const myOrder = (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.customerId === req.user.id);
  if (!o) res.sendStatus(404);
  return o;
};
app.get("/api/orders/:id", need("customer"), (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  const rv = db.reviews.find(r => r.orderId === o.id);
  res.json({ ...orderView(o), payMode: PAY_MODE, stages: STAGES, review: rv ? reviewView(rv) : null });
});
app.post("/api/orders/:id/demo-pay", need("customer"), async (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (PAY_MODE !== "demo") return res.status(403).json({ error: "Demo payments are switched off" });
  await markPaid(o);
  res.json({ ok: true });
});
app.get("/api/orders/:id/verify", need("customer"), async (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (!o.paid && o.ref && PAY_MODE === "paystack") {
    try {
      const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(o.ref), { headers: { Authorization: "Bearer " + PAYSTACK_SECRET } });
      const d = (await r.json()).data;
      if (d?.status === "success" && d.amount === Math.round(o.total * 100)) await markPaid(o);
    } catch (e) { console.error("Verify:", e.message); }
  }
  res.json({ paid: !!o.paid, stage: o.stage });
});
// the customer says the food arrived: this releases the vendor's money straight away
app.post("/api/orders/:id/received", need("customer"), (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (!o.paid || o.stage < STAGES.length - 1) return res.status(409).json({ error: "You can confirm once the order is marked as delivered." });
  o.confirmed = true; save(); res.json({ ok: true });
});
app.post("/api/orders/:id/review", need("customer"), (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  if (o.stage < STAGES.length - 1) return res.status(409).json({ error: "You can review an order after it has been delivered." });
  if (db.reviews.some(r => r.orderId === o.id)) return res.status(409).json({ error: "You already reviewed this order." });
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Tap the stars to give a rating from 1 to 5." });
  const r = { id: uid(), orderId: o.id, vendorId: o.vendorId, customerId: req.user.id, name: shortName(o.name), rating, comment: str(req.body?.comment, 500), createdAt: new Date().toISOString() };
  db.reviews.push(r); save();
  res.status(201).json(reviewView(r));
});

app.use("/api", (q, s) => s.status(404).json({ error: "Not found" }));
app.listen(PORT, () => console.log("Ymo Express running on port " + PORT + " (payments: " + PAY_MODE + ")"));
