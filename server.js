// ====== TVOJ PÔVODNÝ KÓD (nezmenený) ======
import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import Database from "better-sqlite3";
import session from "express-session";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = new Database("nutrikurz.db");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    email TEXT PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS codes (
    email TEXT,
    code TEXT,
    expires_at INTEGER,
    used INTEGER DEFAULT 0
  );
`);

app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.use(session({
  name: "nutrikurz_session",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendCode(email) {
  const code = generateCode();
  const expiresAt = Date.now() + 30 * 60 * 1000;

  db.prepare(`
    INSERT INTO codes (email, code, expires_at, used)
    VALUES (?, ?, ?, 0)
  `).run(email, code, expiresAt);

  await transporter.sendMail({
    from: `"NutriKurz" <${process.env.SMTP_FROM}>`,
    to: email,
    subject: "Tvoj prihlasovací kód do NutriKurzu",
    html: `
      <h2>Tvoj kód</h2>
      <h1>${code}</h1>
      <p>Platí 30 minút.</p>
    `
  });
}

function requireLogin(req, res, next) {
  if (!req.session || !req.session.email) {
    return res.status(401).send("Najprv sa prihlás.");
  }

  const email = normalizeEmail(req.session.email);
  const customer = db.prepare(`
    SELECT * FROM customers WHERE email = ? AND paid = 1
  `).get(email);

  if (!customer) {
    return res.status(403).send("Kurz nie je zakúpený.");
  }

  next();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/me", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session && req.session.email),
    email: req.session?.email || null
  });
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    const sessionStripe = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: "NutriKurz" },
          unit_amount: 4999
        },
        quantity: 1
      }],
      success_url: `${process.env.FRONTEND_URL}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      metadata: { email }
    });

    res.json({ url: sessionStripe.url });
  } catch (err) {
    res.status(500).json({ error: "Stripe error" });
  }
});

app.post("/stripe-webhook", async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send("Webhook error");
  }

  if (event.type === "checkout.session.completed") {
    const sessionStripe = event.data.object;
    const email = normalizeEmail(sessionStripe.customer_email);

    db.prepare(`
      INSERT INTO customers (email, paid, created_at)
      VALUES (?, 1, ?)
      ON CONFLICT(email) DO UPDATE SET paid = 1
    `).run(email, Date.now());

    await sendCode(email);
  }

  res.json({ received: true });
});

app.post("/send-login-code", async (req, res) => {
  const email = normalizeEmail(req.body.email);

  const customer = db.prepare(`
    SELECT * FROM customers WHERE email = ? AND paid = 1
  `).get(email);

  if (!customer) {
    return res.status(403).json({ error: "Nezaplatil." });
  }

  await sendCode(email);
  res.json({ success: true });
});

app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = req.body.code;

  const row = db.prepare(`
    SELECT rowid,* FROM codes
    WHERE email=? AND code=? AND used=0
    ORDER BY expires_at DESC
    LIMIT 1
  `).get(email, code);

  if (!row || Date.now() > row.expires_at) {
    return res.status(400).json({ error: "Zlý kód" });
  }

  db.prepare(`UPDATE codes SET used=1 WHERE rowid=?`).run(row.rowid);

  req.session.email = email;
  res.json({ success: true });
});

// ====== ADMIN PANEL (UPGRADE) ======

app.get("/admin", (req, res) => {
  res.send(`
    <h2>Admin panel</h2>

    <input id="email" placeholder="email" />
    <button onclick="load()">Načítať</button>
    <button onclick="resend()">Znovu poslať kód</button>

    <pre id="out"></pre>

    <script>
      async function load() {
        const email = document.getElementById("email").value;

        const res = await fetch("/admin/data?email=" + encodeURIComponent(email));
        const data = await res.json();

        document.getElementById("out").textContent = JSON.stringify(data, null, 2);
      }

      async function resend() {
        const email = document.getElementById("email").value;

        if (!email) {
          alert("Zadaj email");
          return;
        }

        const res = await fetch("/admin/resend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });

        const data = await res.json();

        if (data.success) {
          alert("Kód bol znovu odoslaný");
        } else {
          alert(data.error || "Chyba");
        }
      }
    </script>
  `);
});

app.get("/admin/data", (req, res) => {
  const email = String(req.query.email || "").toLowerCase();

  const customer = db.prepare(`
    SELECT * FROM customers WHERE email = ?
  `).get(email);

  const codes = db.prepare(`
    SELECT * FROM codes
    WHERE email = ?
    ORDER BY expires_at DESC
    LIMIT 5
  `).all(email);

  res.json({ customer, codes });
});

app.post("/admin/resend", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase();

    const customer = db.prepare(`
      SELECT * FROM customers WHERE email = ? AND paid = 1
    `).get(email);

    if (!customer) {
      return res.json({ error: "Nezaplatil" });
    }

    await sendCode(email);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ error: "Chyba pri odosielaní" });
  }
});
