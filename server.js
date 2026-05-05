require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ⚠️ TODO: v produkcii použi Redis (toto je len warning fix neskôr)
app.use(session({
  secret: process.env.SESSION_SECRET || 'tajny_secret',
  resave: false,
  saveUninitialized: true
}));

// ==== "DB" (JSON súbor) ====
const DB_FILE = './codes.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ==== EMAIL ====
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ==== GENEROVANIE KÓDU ====
function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ==== STRIPE WEBHOOK ====
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const email = session.customer_details.email;
    const code = generateCode();

    const db = loadDB();

    db.push({
      email,
      code,
      date: new Date().toISOString(),
      used: false
    });

    saveDB(db);

    // ==== POSLANIE EMAILU ====
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Tvoj prístupový kód',
      html: `
        <h2>Ďakujeme za nákup</h2>
        <p>Tvoj kód je:</p>
        <h1>${code}</h1>
      `
    });

    console.log("Kód odoslaný:", code, email);
  }

  res.json({ received: true });
});

// ==== OVERENIE KÓDU ====
app.post('/verify-code', (req, res) => {
  const { code } = req.body;

  const db = loadDB();
  const record = db.find(c => c.code === code && !c.used);

  if (!record) {
    return res.json({ success: false });
  }

  record.used = true;
  saveDB(db);

  res.json({ success: true });
});

// ==== ADMIN PANEL ====
app.get('/admin', (req, res) => {
  const db = loadDB();

  let html = `
    <h1>Admin panel</h1>
    <table border="1" cellpadding="10">
      <tr>
        <th>Email</th>
        <th>Kód</th>
        <th>Dátum</th>
        <th>Použitý</th>
      </tr>
  `;

  db.forEach(item => {
    html += `
      <tr>
        <td>${item.email}</td>
        <td>${item.code}</td>
        <td>${item.date}</td>
        <td>${item.used}</td>
      </tr>
    `;
  });

  html += '</table>';

  res.send(html);
});

// ==== MANUAL RESEND KÓDU ====
app.post('/admin/resend', async (req, res) => {
  const { email } = req.body;

  const db = loadDB();
  const record = db.find(c => c.email === email);

  if (!record) {
    return res.send("Email nenájdený");
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Tvoj kód (znovu)',
    html: `<h1>${record.code}</h1>`
  });

  res.send("Kód znovu odoslaný");
});

// ==== TEST ROUTE ====
app.get('/', (req, res) => {
  res.send("Server beží 🚀");
});

// ==== START ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server beží na porte", PORT));
