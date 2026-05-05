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
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Tvoj kód do NutriKurzu</h2>
        <p>Kód je:</p>
        <h1 style="letter-spacing: 3px;">${code}</h1>
        <p>Kód platí 30 minút a je jednorazový.</p>
      </div>
    `
  });
}

function requireLogin(req, res, next) {
  if (!req.session || !req.session.email) {
    return res.status(401).send("Najprv sa prihlás kódom.");
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

    if (!email) {
      return res.status(400).json({ error: "Chýba e-mail." });
    }

    const sessionStripe = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "NutriKurz"
            },
            unit_amount: 4999
          },
          quantity: 1
        }
      ],
      success_url: `${process.env.FRONTEND_URL}/?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL}/?payment=cancelled`,
      metadata: { email }
    });

    res.json({ url: sessionStripe.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chyba pri vytváraní platby." });
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
    console.error("Webhook chyba:", err.message);
    return res.status(400).send("Webhook error");
  }

  if (event.type === "checkout.session.completed") {
    const sessionStripe = event.data.object;
    const email = normalizeEmail(sessionStripe.customer_email || sessionStripe.metadata.email);

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
  try {
    const email = normalizeEmail(req.body.email);

    const customer = db.prepare(`
      SELECT * FROM customers WHERE email = ? AND paid = 1
    `).get(email);

    if (!customer) {
      return res.status(403).json({
        error: "Tento e-mail ešte nemá zakúpený kurz."
      });
    }

    await sendCode(email);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Nepodarilo sa odoslať kód." });
  }
});

app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || "").trim();

  const customer = db.prepare(`
    SELECT * FROM customers WHERE email = ? AND paid = 1
  `).get(email);

  if (!customer) {
    return res.status(403).json({ error: "Kurz nie je zakúpený pre tento e-mail." });
  }

  const row = db.prepare(`
    SELECT rowid, * FROM codes
    WHERE email = ?
      AND code = ?
      AND used = 0
    ORDER BY expires_at DESC
    LIMIT 1
  `).get(email, code);

  if (!row) {
    return res.status(400).json({ error: "Nesprávny kód." });
  }

  if (Date.now() > row.expires_at) {
    return res.status(400).json({ error: "Kód expiroval." });
  }

  db.prepare(`UPDATE codes SET used = 1 WHERE rowid = ?`).run(row.rowid);

  req.session.email = email;

  res.json({ success: true });
});

app.get("/video/:filename", requireLogin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const videoPath = path.join(__dirname, "private-videos", filename);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).send("Video neexistuje.");
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4"
    });
    fs.createReadStream(videoPath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": "video/mp4"
  });

  fs.createReadStream(videoPath, { start, end }).pipe(res);
});

app.listen(3000, () => {
  console.log("NutriKurz beží na http://localhost:3000");
});
