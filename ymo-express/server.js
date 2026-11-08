import express from "express";
import nodemailer from "nodemailer";
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { Country, State, City } from "country-state-city";

const {
  PORT = 3000, COMPANY_EMAIL, SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS,
  PAYSTACK_SECRET, BASE_URL = "http://localhost:3000", DELIVERY_BASE = 500, DELIVERY_PER_KM = 40, DELIVERY_MAX = 25000, RIDER_CUT_PCT = 10,
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
const DATABASE_URL = process.env.DATABASE_URL; // set this to keep data safe on free hosting (Neon, Supabase...)
if (!DATABASE_URL) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.mkdirSync(ID_DIR, { recursive: true }); }
const STAGES = ["Order received", "Packed, waiting for a rider", "Rider is on the way to the seller", "Out for delivery", "Delivered"];
const VEHICLES = ["Bicycle", "Motorbike", "Car", "Van"];
const MAX_JOBS = 3; // a rider can carry this many orders at once
const RIDER_MIN_AGE = 18;
const CATEGORIES = ["Phones & Tablets", "Electronics", "Computing", "Fashion", "Beauty & Health", "Home & Kitchen", "Groceries & Food", "Baby & Kids", "Sports & Fitness", "Automobile", "Books & Stationery", "Other"];
const RESERVE_MIN = +(process.env.RESERVE_MIN || 120); // unpaid orders give their stock back after this many minutes
const COMMISSION = +COMMISSION_PCT / 100, SERVICE = +SERVICE_FEE_PCT / 100, RIDER_CUT = +RIDER_CUT_PCT / 100;
// paystack = real payments, demo = fake "Pay now" button for testing only, off = checkout disabled
const PAY_MODE = PAYSTACK_SECRET ? "paystack" : DEMO_PAYMENTS === "1" ? "demo" : "off";
if (PAY_MODE === "demo") console.warn("DEMO_PAYMENTS is on: orders can be 'paid' without real money. Never use this with real customers.");

/* ---------- storage ----------
   With DATABASE_URL: everything (accounts, orders, wallets, photos, ID cards) lives in Postgres and survives restarts.
   Without it: a JSON file + folders, fine for testing on your own computer. */
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 20000 }) : null;
pool?.on("error", e => console.error("Database connection dropped (it will reconnect):", e.message)); // Neon closes idle connections
const fileNames = new Set(); // names of stored photos (data stays in the database until asked for)
let db;
if (pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL)");
  await pool.query("CREATE TABLE IF NOT EXISTS files (name text PRIMARY KEY, kind text NOT NULL, data bytea NOT NULL)");
  db = (await pool.query("SELECT v FROM kv WHERE k='db'")).rows[0]?.v;
  if (!db && fs.existsSync(FILE)) { db = JSON.parse(fs.readFileSync(FILE, "utf8")); console.log("Moved existing data.json into the database"); }
  for (const r of (await pool.query("SELECT name FROM files")).rows) fileNames.add(r.name);
  console.log("Database connected");
} else if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, "utf8"));
db ||= {};
db.users ||= []; db.vendors ||= []; db.riders ||= []; db.orders ||= []; db.reviews ||= []; db.withdrawals ||= []; db.seq ||= 1000;
for (const v of db.vendors) for (const i of v.items) { i.stock ??= 20; i.oldPrice ??= 0; i.brand ??= ""; i.sizes ??= []; i.colors ??= []; if (!CATEGORIES.includes(i.category)) i.category = "Other"; }
for (const u of db.users) u.status ||= "approved"; // accounts that existed before approvals are kept
let dirty = false, flushing = null;
const flush = async () => {
  if (flushing) return flushing;
  flushing = (async () => {
    while (dirty) {
      dirty = false;
      try { await pool.query("INSERT INTO kv (k, v) VALUES ('db', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(db)]); }
      catch (e) { dirty = true; console.error("Database save failed, retrying:", e.message); await new Promise(r => setTimeout(r, 2000)); }
    }
    flushing = null;
  })();
  return flushing;
};
const save = () => {
  if (pool) { dirty = true; setImmediate(flush); return; }
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(db, null, 1)); fs.renameSync(FILE + ".tmp", FILE);
};
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { if (pool) await flush(); process.exit(0); });
// photo storage: kind "photo" (public food/cover pictures) or "id" (private ID cards)
const putFile = async (name, kind, buf) => {
  if (pool) { await pool.query("INSERT INTO files (name, kind, data) VALUES ($1,$2,$3)", [name, kind, buf]); fileNames.add(name); }
  else await fs.promises.writeFile((kind === "id" ? ID_DIR : UPLOAD_DIR) + "/" + name, buf);
};
const getFile = async (name, kind) => {
  if (pool) return (await pool.query("SELECT data FROM files WHERE name=$1 AND kind=$2", [name, kind])).rows[0]?.data || null;
  try { return await fs.promises.readFile((kind === "id" ? ID_DIR : UPLOAD_DIR) + "/" + name); } catch { return null; }
};
const delFile = (name, kind) => {
  if (pool) { fileNames.delete(name); pool.query("DELETE FROM files WHERE name=$1", [name]).catch(() => {}); }
  else fs.rm((kind === "id" ? ID_DIR : UPLOAD_DIR) + "/" + name, { force: true }, () => {});
};

/* ---------- helpers ---------- */
const ngn = n => "₦" + Math.round(n).toLocaleString("en-NG");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uid = () => crypto.randomUUID().slice(0, 8);
const sum = a => a.reduce((s, n) => s + n, 0);
/* photos: the browser shrinks every picture to a JPEG before upload; we check it really is one */
const okImage = v => (typeof v === "string" && /^\/uploads\/[a-f0-9]{16}\.jpg$/.test(v) ? v : "");
const hasImage = url => !!okImage(url) && (pool ? fileNames.has(url.slice(9)) : fs.existsSync(UPLOAD_DIR + "/" + url.slice(9)));
const dropImage = url => {
  if (!okImage(url) || db.vendors.some(v => v.cover === url || v.items.some(i => i.image === url))) return;
  delFile(url.slice(9), "photo");
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

/* ---------- delivery price and time: by distance ----------
   We find a point for each place (the matching city if there is one, otherwise the state centre), measure the
   straight line, add 35% for real roads, then price it: base + per-km. These are estimates by area, not GPS. */
const normName = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const coordCache = new Map();
function coordOf(loc) {
  const key = loc.country + "|" + loc.state + "|" + loc.city;
  if (coordCache.has(key)) return coordCache.get(key);
  let r = null;
  const st = loc.state && loc.state !== "*" ? State.getStateByCodeAndCountry(loc.state, loc.country) : null;
  if (st && loc.city && loc.city !== "*") {
    const names = [loc.city, loc.city.replace(/\s+(north|south|east|west|central|municipal|urban|rural)$/i, "")].map(normName);
    const c = City.getCitiesOfState(loc.country, loc.state).find(x => names.includes(normName(x.name)));
    if (c?.latitude) r = { lat: +c.latitude, lng: +c.longitude, exact: true };
  }
  if (!r && st?.latitude) r = { lat: +st.latitude, lng: +st.longitude, exact: false };
  if (!r) { const c = Country.getCountryByCode(loc.country); r = { lat: +c.latitude, lng: +c.longitude, exact: false }; }
  coordCache.set(key, r);
  return r;
}
const rad = d => d * Math.PI / 180;
function distanceKm(a, b) {
  if (a.country === b.country && a.state === b.state && a.city === b.city) return 3; // same area
  const p = coordOf(a), q = coordOf(b);
  const h = Math.sin(rad(q.lat - p.lat) / 2) ** 2 + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(rad(q.lng - p.lng) / 2) ** 2;
  const roads = 2 * 6371 * Math.asin(Math.sqrt(h)) * 1.35;
  const floor = a.country === b.country && a.state === b.state ? (p.exact && q.exact ? 4 : 12) : 25;
  return Math.round(Math.max(roads, floor) * 10) / 10;
}
const etaText = km => {
  const min = km <= 60 ? 25 + km * 2 : 240 + km / 50 * 60;
  if (min < 60) return `about ${Math.max(15, Math.round(min / 5) * 5)} min`;
  if (min < 720) { const h = Math.round(min / 60); return `about ${h} hr${h === 1 ? "" : "s"}`; }
  const d = Math.ceil(min / 1440); return `${d}-${d + 1} days`;
};
const quoteFor = (v, loc) => {
  const km = distanceKm(v.loc, loc);
  return { km, fee: Math.min(+DELIVERY_MAX, Math.round((+DELIVERY_BASE + km * +DELIVERY_PER_KM) / 50) * 50), eta: etaText(km) };
};

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
// Customer pays: items + delivery + service fee.
// Seller earns: items - commission. Rider earns: delivery fee - rider cut. Platform keeps commission + rider cut + service fee.
const priceOrder = (subtotal, fee) => {
  fee = Math.round(fee);
  const serviceFee = Math.round(subtotal * SERVICE), commission = Math.round(subtotal * COMMISSION), riderCut = Math.round(fee * RIDER_CUT);
  return { fee, serviceFee, commission, riderCut, total: subtotal + fee + serviceFee, vendorNet: subtotal - commission, riderNet: fee - riderCut };
};
// money is released once the order is delivered AND (the customer confirmed OR HOLD_HOURS passed)
const isCleared = o => o.paid && o.stage === STAGES.length - 1 &&
  (o.confirmed || Date.now() - Date.parse(o.deliveredAt || 0) >= +HOLD_HOURS * 3600e3);
const saleStatus = o => isCleared(o) ? "Available" : o.stage === STAGES.length - 1 ? "Waiting for customer to confirm" : "Held until delivery";
const walletCore = (os, net, ws, bank, sale) => {
  const cleared = os.filter(isCleared), pending = os.filter(o => !isCleared(o));
  const earned = sum(cleared.map(o => o[net])), locked = sum(ws.filter(w => w.status !== "rejected").map(w => w.amount));
  return {
    available: earned - locked, pending: sum(pending.map(o => o[net])), earned,
    requested: sum(ws.filter(w => w.status === "requested").map(w => w.amount)), withdrawn: sum(ws.filter(w => w.status === "paid").map(w => w.amount)),
    commissionPct: +COMMISSION_PCT, riderCutPct: +RIDER_CUT_PCT, minWithdraw: +MIN_WITHDRAW, holdHours: +HOLD_HOURS, bank: bank || null,
    withdrawals: ws.slice().reverse().map(({ id, amount, status, createdAt, paidAt, note }) => ({ id, amount, status, createdAt, paidAt, note })),
    sales: os.slice().reverse().slice(0, 40).map(sale),
  };
};
const walletOf = v => walletCore(db.orders.filter(o => o.vendorId === v.id && o.paid), "vendorNet", db.withdrawals.filter(w => w.vendorId === v.id), v.bank,
  o => ({ id: o.id, at: o.paidAt || o.createdAt, subtotal: o.subtotal, commission: o.commission, net: o.vendorNet, status: saleStatus(o) }));
const riderWalletOf = r => walletCore(db.orders.filter(o => o.riderId === r.id && o.paid), "riderNet", db.withdrawals.filter(w => w.riderId === r.id), r.bank,
  o => ({ id: o.id, at: o.deliveredAt || o.paidAt || o.createdAt, fee: o.fee, cut: o.riderCut, km: o.km, net: o.riderNet, status: saleStatus(o) }));

/* ---------- views ---------- */
const roleEntity = u => u.role === "vendor" ? db.vendors.find(x => x.userId === u.id) : u.role === "rider" ? db.riders.find(x => x.userId === u.id) : null;
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, statusNote: u.statusNote || "", google: !!u.google,
  ...(() => { const e = roleEntity(u); return e ? { idSent: !!e.idPhoto, idType: ID_TYPES[e.idType] || "" } : {}; })() });
const ratingOf = vid => {
  const rs = db.reviews.filter(r => r.vendorId === vid);
  return { rating: rs.length ? Math.round(rs.reduce((s, r) => s + r.rating, 0) / rs.length * 10) / 10 : 0, reviewCount: rs.length };
};
// a product can be bought only if the seller switched it on, it has a photo and some stock
const sellable = i => !!(i.available && i.image && i.stock > 0);
const productCard = (v, i, loc) => ({
  id: i.id, vendorId: v.id, store: v.name, name: i.name, price: i.price, oldPrice: i.oldPrice > i.price ? i.oldPrice : 0,
  discount: i.oldPrice > i.price ? Math.round((1 - i.price / i.oldPrice) * 100) : 0,
  category: i.category, brand: i.brand || "", image: i.image, stock: i.stock, sellerOpen: !!v.open, ...ratingOf(v.id),
  ...(loc ? { covers: vendorCovers(v, loc) } : {}),
});
const findProduct = id => { for (const v of db.vendors) { const i = v.items.find(x => x.id === id); if (i) return { v, i }; } return null; };
// unpaid orders hold stock for a while, then give it back
function releaseStale() {
  let n = 0;
  for (const o of db.orders) if (!o.paid && !o.expired && Date.now() - Date.parse(o.createdAt) > RESERVE_MIN * 60e3) {
    const v = db.vendors.find(x => x.id === o.vendorId);
    for (const l of o.items) { const it = v?.items.find(x => x.id === l.pid); if (it) it.stock += l.q; }
    o.expired = true; n++;
  }
  if (n) save();
}
setInterval(releaseStale, 10 * 60e3).unref();
const vendorCard = v => ({
  id: v.id, name: v.name, cuisine: v.cuisine, description: v.description, address: v.address, open: v.open, color: v.color, cover: v.cover || "",
  where: locText(v.loc),
  itemCount: v.items.filter(sellable).length,
  fromPrice: v.items.filter(sellable).reduce((m, i) => Math.min(m, i.price), Infinity),
  ...ratingOf(v.id),
});
const reviewView = r => ({ id: r.id, rating: r.rating, comment: r.comment, name: r.name, createdAt: r.createdAt });
const shortName = n => { const p = String(n).trim().split(/\s+/); return p[0] + (p[1] ? " " + p[1][0].toUpperCase() + "." : ""); };
// what a customer may see (never the commission or the vendor's earnings)
const riderOf = o => (o.riderId ? db.riders.find(r => r.id === o.riderId) : null);
const orderView = o => { const r = riderOf(o), ru = r && db.users.find(u => u.id === r.userId); return {
  km: o.km || 0, eta: o.eta || "", rider: r && ru ? { name: shortName(ru.name), phone: ru.phone, vehicle: r.vehicle } : null,
  id: o.id, groupId: o.groupId || "", stage: o.stage, stageName: STAGES[o.stage], paid: !!o.paid, items: o.items, subtotal: o.subtotal, fee: o.fee, serviceFee: o.serviceFee || 0,
  total: o.total, restaurant: o.restaurant, vendorId: o.vendorId, name: o.name, phone: o.phone, addr: o.addr, where: o.where || "", note: o.note, createdAt: o.createdAt,
  confirmed: !!o.confirmed,
}; };
// only the customer sees the 4-digit code the rider must ask for at the door
const custView = o => ({ ...orderView(o), code: o.paid && o.stage < STAGES.length - 1 ? o.code || "" : "" });

async function notify(o) {
  if (o.notified) return;
  o.notified = true; save();
  const vendor = db.vendors.find(v => v.id === o.vendorId), vUser = db.users.find(u => u.id === vendor?.userId), cUser = db.users.find(u => u.id === o.customerId);
  const lines = o.items.map(i => `${i.q} x ${i.n} (${ngn(i.p * i.q)})`).join("\n");
  const base = `Order ${o.id} from ${o.restaurant}\n\n${lines}\n\nItems: ${ngn(o.subtotal)}\nDelivery: ${ngn(o.fee)}\nService fee: ${ngn(o.serviceFee)}\nTotal paid: ${ngn(o.total)}\nName: ${o.name}\nPhone: ${o.phone}\nDeliver to: ${o.addr}, ${o.where}${o.note ? "\nNote: " + o.note : ""}`;
  await Promise.all([
    mail(vUser?.email, `New paid order ${o.id}`, base + `\n\nYou earn ${ngn(o.vendorNet)} (items ${ngn(o.subtotal)} minus ${COMMISSION_PCT}% fee ${ngn(o.commission)}). It reaches your wallet after the order is delivered. Open your dashboard and mark the order as packed so a rider can collect it.`),
    COMPANY_EMAIL && COMPANY_EMAIL !== vUser?.email ? mail(COMPANY_EMAIL, `New paid order ${o.id} (${o.restaurant})`, base + `\n\nOur fees: ${ngn(o.commission + o.serviceFee)}`) : null,
    mail(cUser?.email, `Your Ymo Express order ${o.id}`, "Thank you for your order! Your payment is held safely until your order is delivered.\n\n" + base),
  ]);
}
function markPaid(o) {
  if (o.paid) return Promise.resolve();
  if (o.expired) { // paid after the hold ran out: take the stock again (best effort)
    const v = db.vendors.find(x => x.id === o.vendorId);
    for (const l of o.items) { const it = v?.items.find(x => x.id === l.pid); if (it) it.stock = Math.max(0, it.stock - l.q); }
    o.expired = false;
  }
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
app.get("/uploads/:name", async (req, res) => {
  if (!/^[a-f0-9]{16}\.jpg$/.test(req.params.name)) return res.sendStatus(404);
  const buf = await getFile(req.params.name, "photo").catch(() => null);
  if (!buf) return res.sendStatus(404);
  res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=604800, immutable"); res.send(buf);
});
app.use(express.static("public"));

// pending/rejected/suspended accounts can sign in and see their status, but can't use the marketplace
const need = (role, anyStatus = false) => (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Please sign in" })
    : role && req.user.role !== role ? res.status(403).json({ error: "Not allowed" })
      : !anyStatus && req.user.status !== "approved" ? res.status(403).json({ error: "Your account is not approved yet.", status: req.user.status }) : next();
const myVendor = req => db.vendors.find(v => v.userId === req.user.id);
const myRider = req => db.riders.find(r => r.userId === req.user.id);

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
  payMode: PAY_MODE, deliveryBase: +DELIVERY_BASE, deliveryPerKm: +DELIVERY_PER_KM, riderCutPct: +RIDER_CUT_PCT, vehicles: VEHICLES, riderMinAge: RIDER_MIN_AGE, maxJobs: MAX_JOBS, servicePct: +SERVICE_FEE_PCT, commissionPct: +COMMISSION_PCT,
  minWithdraw: +MIN_WITHDRAW, holdHours: +HOLD_HOURS, stages: STAGES, categories: CATEGORIES,
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
  const b = req.body || {}, role = ["vendor", "rider"].includes(b.role) ? b.role : "customer";
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
  const rName = str(b.storeName || b.restaurantName, 80);
  let loc = null, idType = "", idNumber = "", vehicle = "";
  if (role !== "customer") {
    if (role === "vendor" && !rName) return res.status(400).json({ error: "Enter your store name" });
    if (role === "rider") {
      if (age < RIDER_MIN_AGE) return res.status(400).json({ error: `Riders must be at least ${RIDER_MIN_AGE} years old.` });
      vehicle = VEHICLES.includes(b.vehicle) ? b.vehicle : "";
      if (!vehicle) return res.status(400).json({ error: "Choose the vehicle you deliver with." });
    }
    loc = cleanLoc(b.loc);
    if (!loc) return res.status(400).json({ error: role === "vendor" ? "Choose where your store is: country, state and area." : "Choose the area you ride in: country, state and area." });
    idType = ID_TYPES[b.idType] ? b.idType : "";
    if (!idType) return res.status(400).json({ error: "Choose which ID card you will upload." });
    idNumber = cleanIdNo(idType, b.idNumber);
    if (!idNumber) return res.status(400).json({ error: idType === "nin" ? "A NIN is 11 digits." : "Enter the number on your ID card." });
  }
  const user = { id: uid(), role, name, email, phone, dob, status: role === "customer" && !NEED_CUSTOMER_OK ? "approved" : "pending",
    ...(g ? { google: g.sub } : hashPw(password)), createdAt: new Date().toISOString() };
  db.users.push(user);
  if (role === "rider") db.riders.push({ id: uid(), userId: user.id, vehicle, loc, coverage: [{ country: loc.country, state: loc.state, city: "*" }], online: true, bank: null, idType, idNumber, idPhoto: "" });
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
app.get("/api/products", (req, res) => {
  releaseStale();
  const loc = req.query.country ? cleanLoc({ country: req.query.country, state: req.query.state || "", city: req.query.city || "" }) : null;
  const q = str(req.query.q, 60).toLowerCase().split(/\s+/).filter(Boolean), cat = CATEGORIES.includes(req.query.category) ? req.query.category : "", only = str(req.query.vendor, 20);
  const all = [];
  for (const v of db.vendors.filter(listed)) if (v.open && (!only || v.id === only)) for (const i of v.items.filter(sellable)) all.push({ v, i });
  const counts = {}; for (const { i } of all) counts[i.category] = (counts[i.category] || 0) + 1;
  let list = all.filter(({ v, i }) => (!cat || i.category === cat) && q.every(w => (i.name + " " + (i.brand || "") + " " + i.category + " " + v.name).toLowerCase().includes(w)))
    .map(({ v, i }) => ({ c: productCard(v, i, loc), t: i.createdAt || "" }));
  const sort = str(req.query.sort, 12);
  list.sort((a, b) => (b.c.covers !== false) - (a.c.covers !== false) || (sort === "price_asc" ? a.c.price - b.c.price : sort === "price_desc" ? b.c.price - a.c.price : sort === "discount" ? b.c.discount - a.c.discount : b.t.localeCompare(a.t)));
  res.json({ total: list.length, counts, products: list.slice(0, 200).map(x => x.c) });
});
app.get("/api/products/:id", (req, res) => {
  releaseStale();
  const f = findProduct(req.params.id);
  if (!f || !f.i.image || !listed(f.v)) return res.sendStatus(404);
  const { v, i } = f, loc = req.query.country ? cleanLoc({ country: req.query.country, state: req.query.state || "", city: req.query.city || "" }) : null;
  const similar = [];
  for (const w of db.vendors.filter(listed)) if (w.open) for (const j of w.items.filter(sellable)) if (j.id !== i.id && j.category === i.category && similar.length < 8) similar.push(productCard(w, j, loc));
  res.json({ ...productCard(v, i, loc), desc: i.desc || "", inStock: sellable(i), sizes: i.sizes || [], colors: i.colors || [], quote: loc && v.loc ? quoteFor(v, loc) : null, vendor: { ...vendorCard(v), coverage: (v.coverage || []).map(c => ({ ...c, text: locText(c) })) }, similar });
});
// delivery price and time from each seller to the shopper's place
app.post("/api/quote", (req, res) => {
  const loc = cleanLoc(req.body?.loc);
  if (!loc) return res.status(400).json({ error: "Choose your delivery place first." });
  const out = {};
  for (const id of (Array.isArray(req.body?.vendors) ? req.body.vendors : []).slice(0, 40)) {
    const v = db.vendors.find(x => x.id === String(id));
    if (v?.loc) out[v.id] = { ...quoteFor(v, loc), covers: vendorCovers(v, loc) };
  }
  res.json(out);
});
app.get("/api/vendors/:id", (req, res) => {
  const v = db.vendors.find(x => x.id === req.params.id);
  if (!v) return res.sendStatus(404);
  // items without a photo are never shown to customers
  res.json({
    ...vendorCard(v), coverage: (v.coverage || []).map(c => ({ ...c, text: locText(c) })),
    items: v.items.filter(i => i.image).map(i => ({ ...productCard(v, i), desc: i.desc, available: sellable(i) })),
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
  if ("loc" in b) { const loc = cleanLoc(b.loc); if (!loc) return res.status(400).json({ error: "Choose your store's country, state and area." }); v.loc = loc; }
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
  putFile(name, "photo", buf).then(() => res.status(201).json({ url: "/uploads/" + name }), () => res.status(500).json({ error: "Could not save the photo. Try again." }));
});

const list = (v, max) => [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map(x => str(String(x), 24)).filter(Boolean))].slice(0, max);
const readItem = b => {
  const name = str(b.name, 100), price = Number(b.price), old = Number(b.oldPrice || 0), stock = Number(b.stock);
  if (!name || !Number.isFinite(price) || price < 1 || price > 1e8) return { error: "Enter a product name and a price above zero" };
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return { error: "Enter how many you have in stock (a whole number)" };
  if (old && (!Number.isFinite(old) || old <= price || old > 1e8)) return { error: "The old price must be higher than the price" };
  const category = CATEGORIES.includes(b.category) ? b.category : "";
  if (!category) return { error: "Choose a category from the list" };
  return { it: { name, price: Math.round(price), oldPrice: old ? Math.round(old) : 0, stock, desc: str(b.desc, 600), brand: str(b.brand, 40), category, sizes: list(b.sizes, 20), colors: list(b.colors, 20) } };
};
app.post("/api/vendor/items", need("vendor"), (req, res) => {
  const v = myVendor(req), r = readItem(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  if (v.items.length >= 500) return res.status(400).json({ error: "You have reached the limit of 500 products" });
  const image = okImage(req.body.image);
  if (!hasImage(image)) return res.status(400).json({ error: "Add a photo of this product. A photo is required for every product." });
  const item = { id: uid(), available: true, image, createdAt: new Date().toISOString(), ...r.it };
  v.items.push(item); save(); res.status(201).json(item);
});
app.patch("/api/vendor/items/:id", need("vendor"), (req, res) => {
  const item = myVendor(req).items.find(i => i.id === req.params.id);
  if (!item) return res.sendStatus(404);
  const b = req.body || {};
  if ("image" in b && !hasImage(okImage(b.image))) return res.status(400).json({ error: "Every product needs a photo. Choose a new photo instead of removing it." });
  if (["name", "price", "oldPrice", "stock", "category", "desc", "brand", "sizes", "colors"].some(k => k in b)) {
    const r = readItem({ ...item, ...b }); if (r.error) return res.status(400).json({ error: r.error }); Object.assign(item, r.it);
  }
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

// ID card photo: stored in a private folder, only an admin can ever open it (sellers and riders both upload one)
for (const role of ["vendor", "rider"]) app.post(`/api/${role}/id-photo`, need(role, true), express.raw({ type: "image/jpeg", limit: "3mb" }), (req, res) => {
  const e = role === "vendor" ? myVendor(req) : myRider(req), buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: "Choose a clear photo of your ID card (JPG, PNG or WebP)." });
  const name = crypto.randomBytes(12).toString("hex") + ".jpg", old = e.idPhoto;
  putFile(name, "id", buf).then(() => {
    e.idPhoto = name; if (req.user.status === "rejected") { req.user.status = "pending"; req.user.statusNote = ""; }
    save(); if (old) delFile(old, "id");
    mail(COMPANY_EMAIL, `${role === "vendor" ? "Seller" : "Rider"} ID uploaded: ${e.name || req.user.name}`, `${e.name || req.user.name} uploaded an ID card. Open the admin page to review it.`);
    res.status(201).json(publicUser(req.user));
  }, () => res.status(500).json({ error: "Could not save the photo. Try again." }));
});

/* ---------- vendor: orders ---------- */
app.get("/api/vendor/orders", need("vendor"), (req, res) => {
  const v = myVendor(req);
  res.json(db.orders.filter(o => o.vendorId === v.id && o.paid).reverse().map(o => ({
    ...orderView(o), phone: "", addr: "", commission: o.commission, earn: o.vendorNet, cleared: isCleared(o), // sellers don't see the customer's phone or street: the rider delivers
  })));
});
// the seller only packs the order; a rider does the delivery
app.patch("/api/orders/:id", need("vendor"), (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.vendorId === myVendor(req).id);
  if (!o) return res.sendStatus(404);
  if (req.body?.stage !== 1) return res.sendStatus(400);
  if (!o.paid) return res.status(409).json({ error: "The customer has not paid yet" });
  if (o.stage !== 0) return res.status(409).json({ error: "This order is already packed. A rider takes it from here." });
  o.stage = 1; o.packedAt = new Date().toISOString(); save();
  const v = myVendor(req);
  for (const r of db.riders.filter(r => r.online && riderCovers(r, v.loc) && db.users.find(u => u.id === r.userId)?.status === "approved").slice(0, 20))
    mail(db.users.find(u => u.id === r.userId)?.email, "New delivery gig on Ymo Express", `${o.restaurant} has an order ready for pickup. You earn ${ngn(o.riderNet)}. Open the Gigs tab to take it.\n\n${BASE_URL}`);
  res.json({ ok: true });
});

/* ---------- vendor: wallet + withdrawals ---------- */
for (const role of ["vendor", "rider"]) {
  const own = req => (role === "vendor" ? myVendor(req) : myRider(req)), wal = o => (role === "vendor" ? walletOf(o) : riderWalletOf(o)), key = role === "vendor" ? "vendorId" : "riderId";
  app.get(`/api/${role}/wallet`, need(role), (req, res) => res.json(wal(own(req))));
  app.put(`/api/${role}/bank`, need(role), (req, res) => {
    const v = own(req), b = req.body || {};
    const bankName = str(b.bankName, 60), accountName = str(b.accountName, 80), accountNumber = str(b.accountNumber, 20).replace(/\s/g, "");
    const okNum = v.loc?.country === "NG" ? /^\d{10}$/.test(accountNumber) : /^[0-9A-Za-z]{6,20}$/.test(accountNumber);
    if (!bankName || !accountName || !okNum) return res.status(400).json({ error: v.loc?.country === "NG" ? "Enter the bank name, the account name and a 10-digit account number." : "Enter the bank name, the account name and the account number." });
    v.bank = { bankName, accountName, accountNumber }; save(); res.json(wal(v));
  });
  app.post(`/api/${role}/withdraw`, need(role), (req, res) => {
    const v = own(req), w = wal(v), amount = Math.round(Number(req.body?.amount));
    if (!v.bank) return res.status(400).json({ error: "Add your bank account first." });
    if (!Number.isFinite(amount) || amount < +MIN_WITHDRAW) return res.status(400).json({ error: `The smallest withdrawal is ${ngn(+MIN_WITHDRAW)}.` });
    if (amount > w.available) return res.status(400).json({ error: `You can withdraw up to ${ngn(w.available)} right now.` });
    const wd = { id: "WD-" + (++db.seq), [key]: v.id, amount, status: "requested", bank: { ...v.bank }, createdAt: new Date().toISOString() };
    db.withdrawals.push(wd); save();
    const who = v.name || req.user.name;
    mail(COMPANY_EMAIL, `Withdrawal request ${wd.id}: ${ngn(amount)}`, `${who} (${role}) wants to withdraw ${ngn(amount)}.\n\n${v.bank.bankName}\n${v.bank.accountNumber}\n${v.bank.accountName}\n\nSend the money, then mark it as paid in the admin page.`);
    res.status(201).json(wal(v));
  });
}

/* ---------- riders: profile, gig board, jobs ---------- */
const riderCovers = (r, loc) => !!loc && (r.coverage || []).some(c => covers(c, loc));
const riderSelf = ({ idNumber, idPhoto, ...r }) => ({ ...r, idMasked: maskId(idNumber), idSent: !!idPhoto, whereText: locText(r.loc), areaLabel: areaLabel(r.loc.country), coverage: (r.coverage || []).map(c => ({ ...c, text: locText(c) })) });
const activeJobs = r => db.orders.filter(o => o.riderId === r.id && o.paid && o.stage >= 2 && o.stage < STAGES.length - 1);
const gigView = o => {
  const v = db.vendors.find(x => x.id === o.vendorId);
  return { id: o.id, store: o.restaurant, pickup: locText(v?.loc), address: v?.address || "", drop: o.where, km: o.km || 0, eta: o.eta || "", earn: o.riderNet, items: sum(o.items.map(i => i.q)), at: o.packedAt || o.paidAt };
};
const jobView = o => {
  const v = db.vendors.find(x => x.id === o.vendorId), vu = db.users.find(u => u.id === v?.userId);
  return { ...gigView(o), stage: o.stage, stageName: STAGES[o.stage], storePhone: vu?.phone || "", customer: o.name, phone: o.phone, addr: o.addr, note: o.note || "",
    lines: o.items.map(i => ({ n: i.n, q: i.q, size: i.size || "", color: i.color || "" })), deliveredAt: o.deliveredAt || "", status: saleStatus(o), tries: o.codeTries || 0 };
};
app.get("/api/rider/me", need("rider", true), (req, res) => res.json(riderSelf(myRider(req))));
app.patch("/api/rider/me", need("rider"), (req, res) => {
  const r = myRider(req), b = req.body || {};
  if ("loc" in b) { const loc = cleanLoc(b.loc); if (!loc) return res.status(400).json({ error: "Choose your country, state and area." }); r.loc = loc; }
  if ("coverage" in b) {
    const l = Array.isArray(b.coverage) ? b.coverage.slice(0, 60).map(c => cleanLoc(c, true)) : [];
    if (!l.length || l.some(c => !c)) return res.status(400).json({ error: "Pick at least one place you ride in, using the dropdowns." });
    r.coverage = [...new Map(l.map(c => [`${c.country}|${c.state}|${c.city}`, c])).values()];
  }
  if (b.vehicle !== undefined) { if (!VEHICLES.includes(b.vehicle)) return res.status(400).json({ error: "Choose a vehicle from the list." }); r.vehicle = b.vehicle; }
  if (typeof b.online === "boolean") r.online = b.online;
  save(); res.json(riderSelf(r));
});
// open gigs: paid and packed orders nobody has taken yet, where the pickup is in the rider's area
app.get("/api/rider/gigs", need("rider"), (req, res) => {
  const r = myRider(req), active = activeJobs(r).length;
  if (!r.online) return res.json({ online: false, gigs: [], active, max: MAX_JOBS });
  const gigs = db.orders.filter(o => o.paid && o.stage === 1 && !o.riderId && riderCovers(r, db.vendors.find(v => v.id === o.vendorId)?.loc))
    .sort((a, b) => String(a.packedAt).localeCompare(String(b.packedAt))).map(gigView);
  res.json({ online: true, gigs, active, max: MAX_JOBS });
});
app.post("/api/rider/gigs/:id/accept", need("rider"), (req, res) => {
  const r = myRider(req), o = db.orders.find(x => x.id === req.params.id);
  if (!o || !o.paid) return res.sendStatus(404);
  if (!r.online) return res.status(409).json({ error: "Switch to Online to take gigs." });
  if (o.riderId || o.stage !== 1) return res.status(409).json({ error: "Sorry, another rider just took this one." });
  if (!riderCovers(r, db.vendors.find(v => v.id === o.vendorId)?.loc)) return res.status(403).json({ error: "This pickup is outside your area." });
  if (activeJobs(r).length >= MAX_JOBS) return res.status(409).json({ error: `You can carry ${MAX_JOBS} orders at a time. Finish one first.` });
  o.riderId = r.id; o.stage = 2; o.acceptedAt = new Date().toISOString(); save();
  res.json(jobView(o));
});
app.get("/api/rider/jobs", need("rider"), (req, res) => {
  const r = myRider(req);
  res.json(db.orders.filter(o => o.riderId === r.id && o.paid).reverse().map(jobView));
});
app.post("/api/rider/jobs/:id/:action", need("rider"), (req, res) => {
  const r = myRider(req), o = db.orders.find(x => x.id === req.params.id && x.riderId === r.id && x.paid);
  if (!o) return res.sendStatus(404);
  const a = req.params.action;
  if (a === "release") {
    if (o.stage !== 2) return res.status(409).json({ error: "You can only give a job back before you pick it up." });
    o.riderId = null; o.stage = 1; save(); return res.json({ ok: true });
  }
  if (a === "pickup") {
    if (o.stage !== 2) return res.status(409).json({ error: "This order is not waiting for pickup." });
    o.stage = 3; o.pickedAt = new Date().toISOString(); save(); return res.json(jobView(o));
  }
  if (a === "deliver") {
    if (o.stage !== 3) return res.status(409).json({ error: "Pick the order up first." });
    if ((o.codeTries || 0) >= 8) return res.status(429).json({ error: "Too many wrong codes. Contact Ymo Express support." });
    if (String(req.body?.code || "").trim() !== o.code) { o.codeTries = (o.codeTries || 0) + 1; save(); return res.status(400).json({ error: "That code is not right. Ask the customer for the 4-digit code on their order page." }); }
    o.stage = STAGES.length - 1; o.deliveredAt = new Date().toISOString(); save(); return res.json(jobView(o));
  }
  res.sendStatus(404);
});

/* ---------- admin: revenue and payouts ---------- */
const ownerUserOf = w => db.users.find(u => u.id === (w.vendorId ? db.vendors.find(x => x.id === w.vendorId) : db.riders.find(x => x.id === w.riderId))?.userId);
const vendorName = id => db.vendors.find(v => v.id === id)?.name || "Unknown";
app.get("/api/admin/summary", need("admin"), (req, res) => {
  const paid = db.orders.filter(o => o.paid), cleared = paid.filter(isCleared);
  const commission = sum(paid.map(o => o.commission || 0)), serviceFees = sum(paid.map(o => o.serviceFee || 0)), riderCuts = sum(paid.map(o => o.riderCut || 0));
  const paidOut = key => sum(db.withdrawals.filter(w => w.status === "paid" && w[key]).map(w => w.amount));
  res.json({
    payMode: PAY_MODE, orders: paid.length, taken: sum(paid.map(o => o.total)), commission, serviceFees, riderCuts, revenue: commission + serviceFees + riderCuts,
    heldForVendors: sum(paid.filter(o => !isCleared(o)).map(o => o.vendorNet)),
    owedToVendors: sum(cleared.map(o => o.vendorNet)) - paidOut("vendorId"),
    owedToRiders: sum(cleared.filter(o => o.riderId).map(o => o.riderNet)) - paidOut("riderId"),
    needRider: db.orders.filter(o => o.paid && o.stage === 1 && !o.riderId).length, riders: db.riders.length,
    withdrawalsWaiting: sum(db.withdrawals.filter(w => w.status === "requested").map(w => w.amount)),
    vendors: db.vendors.length, customers: db.users.filter(u => u.role === "customer").length,
  });
});
app.get("/api/admin/withdrawals", need("admin"), (req, res) =>
  res.json(db.withdrawals.slice().reverse().map(w => ({ ...w, vendor: w.vendorId ? vendorName(w.vendorId) : ownerUserOf(w)?.name || "Rider", kind: w.vendorId ? "Seller" : "Rider" }))));
app.post("/api/admin/withdrawals/:id", need("admin"), (req, res) => {
  const w = db.withdrawals.find(x => x.id === req.params.id);
  if (!w) return res.sendStatus(404);
  if (w.status !== "requested") return res.status(409).json({ error: "This request was already handled" });
  const action = req.body?.action;
  if (!["paid", "reject"].includes(action)) return res.sendStatus(400);
  w.status = action === "paid" ? "paid" : "rejected"; w.note = str(req.body?.note, 200); w.paidAt = new Date().toISOString(); save();
  mail(ownerUserOf(w)?.email, action === "paid" ? `Your withdrawal of ${ngn(w.amount)} was paid` : `Your withdrawal of ${ngn(w.amount)} was not paid`,
    action === "paid" ? `We sent ${ngn(w.amount)} to ${w.bank.bankName}, ${w.bank.accountNumber}.` : `Your withdrawal request was rejected and the money is back in your wallet.${w.note ? "\n\nReason: " + w.note : ""}`);
  res.json({ ok: true });
});
const adminUser = u => {
  const e = roleEntity(u);
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, dob: u.dob || "", age: u.dob ? ageOf(u.dob) : null, status: u.status, statusNote: u.statusNote || "", google: !!u.google, createdAt: u.createdAt,
    ...(e && u.role === "vendor" ? { vendorId: e.id, restaurant: e.name, where: locText(e.loc), idType: ID_TYPES[e.idType] || "Not provided", idNumber: e.idNumber || "", idPhoto: !!e.idPhoto, items: e.items.length } : {}),
    ...(e && u.role === "rider" ? { vehicle: e.vehicle, where: locText(e.loc), idType: ID_TYPES[e.idType] || "Not provided", idNumber: e.idNumber || "", idPhoto: !!e.idPhoto, jobs: db.orders.filter(o => o.riderId === e.id && o.stage === STAGES.length - 1).length } : {}),
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
app.get("/api/admin/id/:userId", need("admin"), async (req, res) => {
  const v = db.vendors.find(x => x.userId === req.params.userId) || db.riders.find(x => x.userId === req.params.userId);
  if (!v?.idPhoto || !/^[a-f0-9]{24}\.jpg$/.test(v.idPhoto)) return res.sendStatus(404);
  const buf = await getFile(v.idPhoto, "id").catch(() => null);
  if (!buf) return res.sendStatus(404);
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Content-Type", "image/jpeg"); res.send(buf);
});
app.post("/api/admin/users/:id", need("admin"), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id && x.role !== "admin");
  if (!u) return res.sendStatus(404);
  const action = req.body?.action, note = str(req.body?.note, 200);
  const next = { approve: "approved", reject: "rejected", suspend: "suspended", reactivate: "approved" }[action];
  if (!next) return res.sendStatus(400);
  const v = roleEntity(u);
  if (next === "approved" && v && !v.idPhoto) return res.status(409).json({ error: `This ${u.role === "rider" ? "rider" : "seller"} has not uploaded an ID card yet.` });
  u.status = next; u.statusNote = next === "approved" ? "" : note; save();
  const subj = { approved: "Your Ymo Express account is approved", rejected: "Your Ymo Express account was not approved", suspended: "Your Ymo Express account is suspended" }[next];
  mail(u.email, subj, next === "approved" ? `Hi ${u.name}, you can now ${u.role === "vendor" ? "list your products and receive orders" : u.role === "rider" ? "see delivery gigs and start earning" : "shop"}.\n\n${BASE_URL}`
    : `Hi ${u.name}, your account is ${next}.${note ? "\n\nReason: " + note : ""}${next === "rejected" && u.role !== "customer" ? "\n\nYou can sign in and upload a clearer ID card to be reviewed again." : ""}`);
  res.json(adminUser(u));
});
app.get("/api/admin/orders", need("admin"), (req, res) =>
  res.json(db.orders.filter(o => o.paid).slice().reverse().slice(0, 60).map(o => ({
    id: o.id, restaurant: o.restaurant, total: o.total, subtotal: o.subtotal, commission: o.commission, serviceFee: o.serviceFee, vendorNet: o.vendorNet,
    stageName: STAGES[o.stage], cleared: isCleared(o), at: o.paidAt || o.createdAt, where: o.where, fee: o.fee, riderCut: o.riderCut || 0, km: o.km || 0,
    rider: riderOf(o) ? db.users.find(u => u.id === riderOf(o).userId)?.name : "", needsRider: o.stage === 1 && !o.riderId,
  }))));
app.get("/api/admin/vendors", need("admin"), (req, res) =>
  res.json(db.vendors.map(v => ({ id: v.id, name: v.name, where: locText(v.loc), items: v.items.length, orders: db.orders.filter(o => o.vendorId === v.id && o.paid).length, available: walletOf(v).available }))));

/* ---------- customer: place + track orders ---------- */
app.post("/api/orders", need("customer"), async (req, res) => {
  const b = req.body || {};
  if (PAY_MODE === "off") return res.status(503).json({ error: "Payments are not set up yet, so orders can't be placed." });
  releaseStale();
  const name = str(b.name, 80), phone = str(b.phone, 30), addr = str(b.addr, 200);
  if (!name || !phone || !addr) return res.status(400).json({ error: "Enter your name, phone and delivery address" });
  const loc = cleanLoc(b.loc);
  if (!loc) return res.status(400).json({ error: "Choose your delivery country, state and area from the lists." });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) return res.status(400).json({ error: "Your cart is empty" });
  const byLine = new Map(), perProduct = new Map(), byVendor = new Map();
  for (const l of b.items) {
    const f = findProduct(String(l?.id));
    if (!f || !listed(f.v) || !f.v.open || !sellable(f.i)) return res.status(400).json({ error: "An item in your cart is no longer available. Remove it and try again." });
    if (!vendorCovers(f.v, loc)) return res.status(400).json({ error: `${f.v.name} does not deliver to ${locText(loc)}. Remove "${f.i.name}" or choose another place.` });
    const q = Math.max(1, Math.min(50, Math.floor(+l?.q) || 1));
    const size = f.i.sizes?.length ? str(l?.size, 24) : "", color = f.i.colors?.length ? str(l?.color, 24) : "";
    if (f.i.sizes?.length && !f.i.sizes.includes(size)) return res.status(400).json({ error: `Choose a size for "${f.i.name}".` });
    if (f.i.colors?.length && !f.i.colors.includes(color)) return res.status(400).json({ error: `Choose a colour for "${f.i.name}".` });
    const k = f.i.id + "|" + size + "|" + color, e = byLine.get(k) || { v: f.v, it: f.i, size, color, q: 0 };
    e.q = Math.min(50, e.q + q); byLine.set(k, e); perProduct.set(f.i.id, (perProduct.get(f.i.id) || 0) + q);
  }
  for (const e of byLine.values()) {
    if (perProduct.get(e.it.id) > e.it.stock) return res.status(400).json({ error: `Only ${e.it.stock} left of "${e.it.name}".` });
    if (!byVendor.has(e.v.id)) byVendor.set(e.v.id, { v: e.v, lines: [] });
    byVendor.get(e.v.id).lines.push(e);
  }
  const gid = "GRP-" + (++db.seq), now = new Date().toISOString(), made = [];
  for (const { v, lines } of byVendor.values()) {
    for (const { it, q } of lines) it.stock -= q;
    const items = lines.map(({ it, q, size, color }) => ({ pid: it.id, n: it.name, p: it.price, q, img: it.image, ...(size ? { size } : {}), ...(color ? { color } : {}) }));
    const subtotal = items.reduce((s, i) => s + i.p * i.q, 0), quote = quoteFor(v, loc);
    made.push({ id: "YMO-" + (++db.seq), groupId: gid, customerId: req.user.id, vendorId: v.id, restaurant: v.name, stage: 0, paid: false, items, subtotal, ...priceOrder(subtotal, quote.fee), km: quote.km, eta: quote.eta, code: String(crypto.randomInt(1000, 10000)),
      name, phone, addr, loc, where: locText(loc), note: str(b.note, 200), createdAt: now });
  }
  db.orders.push(...made); save();
  const total = sum(made.map(o => o.total));
  if (PAY_MODE === "paystack") {
    try {
      const r = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST", headers: { Authorization: "Bearer " + PAYSTACK_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ email: req.user.email, amount: Math.round(total * 100), currency: "NGN", reference: gid + "-" + Date.now(),
          channels: ["card", "bank", "ussd", "bank_transfer"], callback_url: `${BASE_URL}/?pay=${gid}` }),
      });
      const d = (await r.json()).data;
      if (!d?.authorization_url) throw new Error("initialize failed");
      for (const o of made) o.ref = d.reference; save();
      return res.status(201).json({ group: gid, orders: made.map(o => o.id), total, payUrl: d.authorization_url });
    } catch (e) { console.error("Paystack:", e.message); return res.status(502).json({ error: "Payment is unavailable right now. Try again in a moment." }); }
  }
  res.status(201).json({ group: gid, orders: made.map(o => o.id), total });
});

app.get("/api/my/orders", need("customer"), (req, res) =>
  res.json(db.orders.filter(o => o.customerId === req.user.id && (o.paid || (!o.expired && Date.now() - Date.parse(o.createdAt) < 864e5))).reverse()
    .map(o => ({ ...custView(o), reviewed: db.reviews.some(r => r.orderId === o.id) }))));

const myOrder = (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id && x.customerId === req.user.id);
  if (!o) res.sendStatus(404);
  return o;
};
app.get("/api/orders/:id", need("customer"), (req, res) => {
  const o = myOrder(req, res); if (!o) return;
  const rv = db.reviews.find(r => r.orderId === o.id);
  res.json({ ...custView(o), payMode: PAY_MODE, stages: STAGES, review: rv ? reviewView(rv) : null });
});
// one payment can cover orders from several sellers: they share a group id
const myGroup = (req, res) => {
  releaseStale();
  const os = db.orders.filter(o => o.groupId === req.params.id && o.customerId === req.user.id);
  if (!os.length) res.sendStatus(404);
  return os.length ? os : null;
};
const groupView = os => ({ id: os[0].groupId, paid: os.every(o => o.paid), expired: os.some(o => o.expired && !o.paid), total: sum(os.map(o => o.total)), payMode: PAY_MODE, orders: os.map(orderView) });
app.get("/api/groups/:id", need("customer"), (req, res) => { const os = myGroup(req, res); if (os) res.json(groupView(os)); });
app.post("/api/groups/:id/demo-pay", need("customer"), async (req, res) => {
  const os = myGroup(req, res); if (!os) return;
  if (PAY_MODE !== "demo") return res.status(403).json({ error: "Demo payments are switched off" });
  for (const o of os) await markPaid(o);
  res.json(groupView(os));
});
app.get("/api/groups/:id/verify", need("customer"), async (req, res) => {
  const os = myGroup(req, res); if (!os) return;
  if (!os.every(o => o.paid) && os[0].ref && PAY_MODE === "paystack") {
    try {
      const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(os[0].ref), { headers: { Authorization: "Bearer " + PAYSTACK_SECRET } });
      const d = (await r.json()).data;
      if (d?.status === "success" && d.amount === Math.round(sum(os.map(o => o.total)) * 100)) for (const o of os) await markPaid(o);
    } catch (e) { console.error("Verify:", e.message); }
  }
  res.json(groupView(os));
});
// the customer says the order arrived: this releases the vendor's money straight away
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
