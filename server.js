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
    created_at INTEGER,
    amount INTEGER DEFAULT 0,
    currency TEXT DEFAULT 'eur'
  );

  CREATE TABLE IF NOT EXISTS codes (
    email TEXT,
    code TEXT,
    expires_at INTEGER,
    used INTEGER DEFAULT 0
  );
`);

const customerColumns = db.prepare(`PRAGMA table_info(customers)`).all().map(c => c.name);

if (!customerColumns.includes("amount")) {
  db.exec(`ALTER TABLE customers ADD COLUMN amount INTEGER DEFAULT 0`);
}

if (!customerColumns.includes("currency")) {
  db.exec(`ALTER TABLE customers ADD COLUMN currency TEXT DEFAULT 'eur'`);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanupOldAdminRecords() {
  const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;

  db.prepare(`
    DELETE FROM codes
    WHERE expires_at < ?
  `).run(fifteenDaysAgo);

  db.prepare(`
    DELETE FROM customers
    WHERE created_at < ?
  `).run(fifteenDaysAgo);

  console.log("Old admin records cleaned");
}

cleanupOldAdminRecords();

setInterval(() => {
  cleanupOldAdminRecords();
}, 60 * 60 * 1000);

app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "nutrikurz_session",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
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

async function sendCode(email) {
  if (!email) {
    throw new Error("Email missing in sendCode()");
  }

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
    html: `<h1>${code}</h1>`
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

function checkAdmin(req, res, next) {
  if (req.query.password !== process.env.ADMIN_PASSWORD) {
    return res.send("Zlé heslo");
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
      return res.status(400).json({ error: "Email je povinný." });
    }

    const sessionStripe = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "NutriKurz" },
            unit_amount: 4999
          },
          quantity: 1
        }
      ],
      allow_promotion_codes: true,
      success_url: `${process.env.FRONTEND_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/?payment=cancelled`,
      metadata: { email }
    });

    res.json({ url: sessionStripe.url });
  } catch (err) {
    console.error("Checkout session error:", err);
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
    console.error("Stripe webhook signature error:", err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const sessionStripe = event.data.object;

      const email = normalizeEmail(
        sessionStripe.customer_details?.email ||
        sessionStripe.customer_email ||
        sessionStripe.metadata?.email
      );

      if (!email) {
        console.error("Webhook error: email missing", sessionStripe.id);
        return res.status(400).send("Email missing");
      }

      const amount = sessionStripe.amount_total || 0;
      const currency = sessionStripe.currency || "eur";

      db.prepare(`
        INSERT INTO customers (email, paid, created_at, amount, currency)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET 
          paid = 1,
          created_at = excluded.created_at,
          amount = excluded.amount,
          currency = excluded.currency
      `).run(email, Date.now(), amount, currency);

      await sendCode(email);

      console.log("Payment processed:", email, amount, currency);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).send("Webhook processing failed");
  }
});

app.post("/send-login-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    const customer = db.prepare(`
      SELECT * FROM customers WHERE email = ? AND paid = 1
    `).get(email);

    if (!customer) {
      return res.status(403).json({ error: "Nemá zakúpený kurz." });
    }

    await sendCode(email);

    res.json({ success: true });
  } catch (err) {
    console.error("Send login code error:", err);
    res.status(500).json({ error: "Nepodarilo sa odoslať kód." });
  }
});

app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || "").trim();

  const row = db.prepare(`
    SELECT rowid, * FROM codes
    WHERE email = ? AND code = ? AND used = 0
    ORDER BY expires_at DESC
    LIMIT 1
  `).get(email, code);

  if (!row) {
    return res.json({ error: "Zlý kód" });
  }

  if (Date.now() > row.expires_at) {
    return res.json({ error: "Expiroval" });
  }

  db.prepare(`
    UPDATE codes SET used = 1 WHERE rowid = ?
  `).run(row.rowid);

  req.session.email = email;

  res.json({ success: true });
});

app.get("/admin", checkAdmin, (req, res) => {
  const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT 
      codes.email,
      codes.code,
      codes.expires_at,
      codes.used,
      customers.amount,
      customers.currency,
      customers.created_at
    FROM codes
    LEFT JOIN customers ON customers.email = codes.email
    WHERE codes.expires_at >= ?
    ORDER BY codes.expires_at DESC
  `).all(fifteenDaysAgo);

  let html = `
    <h1>Admin panel</h1>
    <table border="1" cellpadding="10">
      <tr>
        <th>Email</th>
        <th>Kód</th>
        <th>Expirácia</th>
        <th>Použitý</th>
        <th>Suma</th>
        <th>Kúpené</th>
        <th>Akcia</th>
      </tr>
  `;

  rows.forEach(c => {
    const amountText = c.amount
      ? `${(c.amount / 100).toFixed(2)} ${(c.currency || "eur").toUpperCase()}`
      : "-";

    const boughtAt = c.created_at
      ? new Date(c.created_at).toLocaleString()
      : "-";

    html += `
      <tr>
        <td>${c.email}</td>
        <td>${c.code}</td>
        <td>${new Date(c.expires_at).toLocaleString()}</td>
        <td>${c.used}</td>
        <td>${amountText}</td>
        <td>${boughtAt}</td>
        <td>
          <form method="POST" action="/admin/resend?password=${process.env.ADMIN_PASSWORD}">
            <input type="hidden" name="email" value="${c.email}" />
            <button>Poslať znovu</button>
          </form>
        </td>
      </tr>
    `;
  });

  html += "</table>";

  res.send(html);
});

app.post("/admin/resend", checkAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).send("Email chýba");
    }

    await sendCode(email);

    res.send("Odoslané");
  } catch (err) {
    console.error("Admin resend error:", err);
    res.status(500).send("Nepodarilo sa odoslať");
  }
});

app.get("/video/:filename", requireLogin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const videoPath = path.join(__dirname, "private-videos", filename);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).send("Video neexistuje.");
  }

  fs.createReadStream(videoPath).pipe(res);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});
