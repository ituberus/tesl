/********************************
 * server.js
 ********************************/
const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const stripe = require('stripe');
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const crypto = require('crypto');

// ------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripeInstance = stripe(STRIPE_SECRET_KEY);

const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  // If needed, configure CORS properly here
  credentials: true,
  origin: true
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session here is still used for Admin auth,
// but NOT for fbclid/fbp/fbc storage:
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------
// SQLITE SETUP
// ------------------------------------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

const dbAll = promisify(db.all).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbRun = (...args) => {
  return new Promise((resolve, reject) => {
    db.run(...args, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
};

// Create / alter tables as needed
db.serialize(() => {
  // 1) donations table
  db.run(
    `CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_amount INTEGER,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      card_name TEXT,
      country TEXT,
      postal_code TEXT,
      order_complete_url TEXT,
      payment_intent_id TEXT,
      payment_intent_status TEXT,
      fbclid TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip_address TEXT,
      client_user_agent TEXT,
      event_id TEXT,
      fbp TEXT,
      fbc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // 2) admin_users table
  db.run(
    `CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )`
  );

  // 3) fb_conversion_logs table
  db.run(
    `CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_id INTEGER,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // 4) payment_failures table
  db.run(
    `CREATE TABLE IF NOT EXISTS payment_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      amount INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // 5) fb_data table (NEW) to store fbclid/fbp/fbc + landing page
  db.run(
    `CREATE TABLE IF NOT EXISTS fb_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fbclid TEXT UNIQUE,
      fbp TEXT,
      fbc TEXT,
      landing_page_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

  console.log(`[INFO] Preparing to send FB Conversion for donation ID: ${donationRow.id}`);

  // If donation doesn't have a Stripe payment_intent, skip
  if (!donationRow.payment_intent_id) {
    console.warn(
      `Skipping FB conversion for donation ID ${donationRow.id}: No Stripe payment intent.`
    );
    return { success: false, error: 'No Stripe payment intent ID' };
  }

  // Hashing helper
  function sha256(value) {
    return crypto
      .createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex');
  }

  // Prepare userData
  const userData = {};

  if (donationRow.email) {
    userData.em = sha256(donationRow.email);
  }
  if (donationRow.first_name) {
    userData.fn = sha256(donationRow.first_name);
  }
  if (donationRow.last_name) {
    userData.ln = sha256(donationRow.last_name);
  }
  if (donationRow.country) {
    userData.country = sha256(donationRow.country);
  }
  if (donationRow.postal_code) {
    userData.zp = sha256(donationRow.postal_code);
  }

  // If we have fbp/fbc, pass them un-hashed
  if (donationRow.fbp) {
    userData.fbp = donationRow.fbp;
  }
  if (donationRow.fbc) {
    userData.fbc = donationRow.fbc;
  }

  // IP + user agent for better matching
  if (donationRow.client_ip_address) {
    userData.client_ip_address = donationRow.client_ip_address;
  }
  if (donationRow.client_user_agent) {
    userData.client_user_agent = donationRow.client_user_agent;
  }

  // Use the domain or landing page URL if we have it
  // If none found, fallback to order_complete_url or a default
  const eventSourceUrl =
    donationRow.landing_page_url ||
    donationRow.orderCompleteUrl ||
    donationRow.order_complete_url ||
    'https://ituberus.github.io/tesl/thanks';

  // Use the same event_id from the front-end if available
  const finalEventId = donationRow.event_id || String(donationRow.id);

  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: finalEventId,
    event_source_url: eventSourceUrl,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
      currency: 'EUR',
    },
  };

  if (donationRow.fbclid) {
    eventData.custom_data.fbclid = donationRow.fbclid;
  }

  const payload = {
    data: [eventData],
  };

  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  console.log('[DEBUG] Final FB Conversion Payload:', JSON.stringify(payload, null, 2));

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[ERROR] FB API response (non-2xx): ${errorText}`);
    throw new Error(`FB API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('Facebook conversion result:', result);
  return { success: true, result };
}

// Exponential Backoff in attemptFacebookConversion
async function attemptFacebookConversion(donationRow) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donationRow);
      if (result.success) {
        return { success: true, result, attempts: attempt + 1 };
      }
      // If it returned success=false but didn't throw, handle that
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
    }

    attempt++;
    console.warn(
      `Attempt ${attempt} failed for donation ID ${donationRow.id}: ${lastError.message}`
    );
    // Exponential backoff: 2s, 4s, 8s...
    await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
  }
  return { success: false, error: lastError, attempts: attempt };
}

// ------------------------------------------------------
// NEW ROUTE: /api/store-fb-data (DB-based, no session)
// Saves fbclid, fbp, fbc, and landing_page_url in fb_data table.
// If fbclid already exists, we update it. Otherwise we insert new row.
// ------------------------------------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc, landingPageUrl } = req.body;
    console.log('[INFO] /api/store-fb-data called with:', req.body);

    if (!fbclid) {
      return res.status(400).json({ error: 'fbclid is required for /api/store-fb-data' });
    }

    // If missing, you could generate fbp/fbc, but let's only do that if you truly want it
    // For now, if they are not provided, we just store whatever we get (null or empty).
    // If you want to ensure they exist, you could do so here.

    // If user gave us a full URL with query params, parse out just the domain or the "clean" URL
    // For demonstration, we store exactly what the user passes. Adjust as needed.
    // Example to parse if you want:
    // const urlObj = new URL(landingPageUrl);
    // landingPageUrl = urlObj.origin;  // just domain
    // or parse out whatever you need.

    // Upsert logic: check if fbclid row already exists
    const existing = await dbGet(
      `SELECT * FROM fb_data WHERE fbclid = ? LIMIT 1`,
      [fbclid]
    );

    if (!existing) {
      console.log('[INFO] Inserting new row into fb_data');
      await dbRun(
        `INSERT INTO fb_data (fbclid, fbp, fbc, landing_page_url)
         VALUES (?, ?, ?, ?)`,
        [fbclid, fbp || null, fbc || null, landingPageUrl || null]
      );
    } else {
      console.log('[INFO] Updating existing row in fb_data for fbclid:', fbclid);
      await dbRun(
        `UPDATE fb_data
         SET fbp = COALESCE(?, fbp),
             fbc = COALESCE(?, fbc),
             landing_page_url = COALESCE(?, landing_page_url)
         WHERE fbclid = ?`,
        [fbp || null, fbc || null, landingPageUrl || null, fbclid]
      );
    }

    return res.json({
      message: 'FB data stored in database (fb_data table).',
      fbclid,
      fbp,
      fbc,
      landingPageUrl
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// ------------------------------------------------------
// NEW ROUTE: /api/get-fb-data (DB-based lookup by fbclid)
// If you need to retrieve fb_data by fbclid to debug or for your front-end
// ------------------------------------------------------
app.get('/api/get-fb-data', async (req, res) => {
  try {
    const { fbclid } = req.query;
    if (!fbclid) {
      return res.status(400).json({ error: 'Missing fbclid in query params.' });
    }

    const row = await dbGet(`SELECT * FROM fb_data WHERE fbclid = ?`, [fbclid]);
    if (!row) {
      return res.status(404).json({ error: 'No data found for that fbclid.' });
    }

    console.log('[INFO] /api/get-fb-data retrieved row:', row);
    return res.json(row);
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ------------------------------------------------------
// ROUTE: /api/fb-conversion (Send Conversions to FB)
// Now uses fbclid from the request to lookup fbp/fbc from fb_data (if not provided).
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res, next) => {
  try {
    console.log('[INFO] /api/fb-conversion called with body:', req.body);

    let {
      event_name,
      event_time,
      event_id,
      email,
      amount,
      fbclid,
      fbp,
      fbc,
      user_data = {},
      orderCompleteUrl
    } = req.body;

    // We no longer rely on session or cookies for fbclid/fbp/fbc
    // They must come in via the request body. Or if missing, we look them up by fbclid in fb_data.
    if (!fbclid) {
      return res.status(400).json({ error: 'fbclid is required for /api/fb-conversion.' });
    }

    // Attempt to lookup fb_data if fbp/fbc are missing
    if (!fbp || !fbc) {
      const fbDataRow = await dbGet(`SELECT * FROM fb_data WHERE fbclid = ?`, [fbclid]);
      if (fbDataRow) {
        console.log('[INFO] Found fb_data row, merging into event data:', fbDataRow);
        if (!fbp && fbDataRow.fbp) {
          fbp = fbDataRow.fbp;
        }
        if (!fbc && fbDataRow.fbc) {
          fbc = fbDataRow.fbc;
        }
        // We might also want the landing_page_url stored for the donation's final event
        // We'll handle it below in the donation record so the event_source_url can use it.
      } else {
        console.warn('[WARNING] No fb_data found for fbclid:', fbclid);
      }
    }

    // Basic data from user_data
    const firstName = user_data.fn || null;
    const lastName = user_data.ln || null;
    const country = user_data.country || null;
    const postalCode = user_data.zp || null;

    // Validate
    if (!email || !amount) {
      return res.status(400).json({ error: 'Missing email or amount' });
    }

    const donationAmountCents = Math.round(Number(amount) * 100);

    console.log(`[INFO] Searching for recent donation by email=${email} and amount=${donationAmountCents}`);

    // 1) Check for existing donation within last 24 hours
    let row = await dbGet(
      `SELECT * FROM donations
       WHERE email = ?
         AND donation_amount = ?
         AND created_at >= datetime('now', '-1 day')
       LIMIT 1`,
      [email, donationAmountCents]
    );

    if (!row) {
      // 2) Create new donation if not found
      console.log('[INFO] No existing donation found; creating new donation record.');
      const insert = await dbRun(
        `INSERT INTO donations (
          donation_amount,
          email,
          first_name,
          last_name,
          country,
          postal_code,
          fbclid,
          fbp,
          fbc,
          event_id,
          order_complete_url,
          fb_conversion_sent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          donationAmountCents,
          email,
          firstName,
          lastName,
          country,
          postalCode,
          fbclid || null,
          fbp || null,
          fbc || null,
          event_id || null,
          orderCompleteUrl || null,
          0,
        ]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
    } else {
      // 3) Update existing donation
      console.log(`[INFO] Existing donation found (id=${row.id}); updating relevant fields.`);
      await dbRun(
        `UPDATE donations
         SET
           first_name = COALESCE(first_name, ?),
           last_name = COALESCE(last_name, ?),
           country = COALESCE(country, ?),
           postal_code = COALESCE(postal_code, ?),
           fbclid = COALESCE(fbclid, ?),
           fbp = COALESCE(fbp, ?),
           fbc = COALESCE(fbc, ?),
           event_id = COALESCE(event_id, ?),
           order_complete_url = COALESCE(order_complete_url, ?)
         WHERE id = ?`,
        [
          firstName,
          lastName,
          country,
          postalCode,
          fbclid || null,
          fbp || null,
          fbc || null,
          event_id || null,
          orderCompleteUrl || null,
          row.id,
        ]
      );
      // Reload
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    // Also store the landing_page_url from fb_data (if any) into the donation row for final usage
    const fbDataRow = await dbGet(`SELECT * FROM fb_data WHERE fbclid = ?`, [fbclid]);
    if (fbDataRow && fbDataRow.landing_page_url) {
      // We'll keep it in a temporary property, so our sendFacebookConversionEvent can use it
      row.landing_page_url = fbDataRow.landing_page_url;
    }

    // Ensure payment is successful
    if (!row.payment_intent_id) {
      console.warn('[WARN] Donation has no Stripe payment intent; aborting conversion.');
      return res
        .status(400)
        .json({ error: 'No Stripe payment intent associated with this donation.' });
    }
    const paymentIntent = await stripeInstance.paymentIntents.retrieve(row.payment_intent_id);
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      console.warn(`[WARN] PaymentIntent not succeeded (status=${paymentIntent && paymentIntent.status}); aborting conversion.`);
      return res.status(400).json({ error: 'Payment not successful, conversion event not sent.' });
    }

    // If we already sent the conversion
    if (row.fb_conversion_sent === 1) {
      console.log('[INFO] Conversion already sent for donation ID:', row.id);
      return res.json({ message: 'Already sent conversion for that donation.' });
    }

    // Update IP and user agent
    const clientIp =
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      '';
    const clientUserAgent = req.headers['user-agent'] || '';
    await dbRun(
      `UPDATE donations
       SET client_ip_address = ?, client_user_agent = ?
       WHERE id = ?`,
      [clientIp, clientUserAgent, row.id]
    );

    // Reload row with updated IP / user agent
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;
    row.orderCompleteUrl = orderCompleteUrl; // if provided

    // Log payload
    const rawPayload = JSON.stringify(req.body);
    const insertLogResult = await dbRun(
      `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
       VALUES (?, ?, ?, ?)`,
      [row.id, rawPayload, 0, 'pending']
    );
    const logId = insertLogResult.lastID;

    // Attempt FB conversion with retry
    const conversionResult = await attemptFacebookConversion(row);
    const now = new Date().toISOString();

    if (conversionResult.success) {
      // Mark success
      await dbRun(
        `UPDATE fb_conversion_logs
         SET status = 'sent', attempts = ?, last_attempt = ?
         WHERE id = ?`,
        [conversionResult.attempts, now, logId]
      );
      await dbRun(
        `UPDATE donations
         SET fb_conversion_sent = 1
         WHERE id = ?`,
        [row.id]
      );
      console.log(`[INFO] Conversion successfully sent for donation ID: ${row.id}`);
    } else {
      // Mark failure
      await dbRun(
        `UPDATE fb_conversion_logs
         SET attempts = ?, last_attempt = ?, error = ?
         WHERE id = ?`,
        [
          conversionResult.attempts,
          now,
          conversionResult.error ? conversionResult.error.message : '',
          logId,
        ]
      );
      console.error(`[ERROR] All FB conversion attempts failed for donation ID: ${row.id}`);
    }

    return res.json({ message: 'Conversion processing finished.' });
  } catch (err) {
    console.error('Error in /api/fb-conversion:', err);
    return res.status(500).json({ error: 'Internal error sending FB conversion.' });
  }
});

// ------------------------------------------------------
// CREATE-PAYMENT-INTENT (Stripe)
// ------------------------------------------------------
app.post('/create-payment-intent', async (req, res, next) => {
  let { donationAmount, email, firstName, lastName, cardName, country, postalCode } = req.body;

  console.log('[INFO] /create-payment-intent called with:', req.body);

  try {
    if (!donationAmount || !email) {
      return res.status(400).json({ error: 'Donation amount and email are required.' });
    }

    const amountCents = Math.round(Number(donationAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      receipt_email: email,
    });

    console.log('[INFO] Created paymentIntent:', paymentIntent.id);

    // Insert donation record as 'pending'
    const result = await dbRun(
      `INSERT INTO donations (
        donation_amount,
        email,
        first_name,
        last_name,
        card_name,
        country,
        postal_code,
        payment_intent_id,
        payment_intent_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        amountCents,
        email,
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        paymentIntent.id,
        'pending',
      ]
    );

    console.log('[INFO] Created donation record ID:', result.lastID);

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Error in /create-payment-intent:', err);
    // Log payment failure
    try {
      const amountCents = !isNaN(donationAmount) ? Math.round(Number(donationAmount) * 100) : 0;
      await dbRun(
        `INSERT INTO payment_failures (email, amount, error)
         VALUES (?, ?, ?)`,
        [email || '', amountCents, err.message]
      );
    } catch (logErr) {
      console.error('Failed to log payment failure:', logErr);
    }
    next(err);
  }
});

// ------------------------------------------------------
// ADMIN AUTH & ENDPOINTS
// ------------------------------------------------------
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.get('/admin-api/check-setup', async (req, res, next) => {
  try {
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
    res.json({ setup: row.count > 0 });
  } catch (err) {
    console.error('Error in /admin-api/check-setup:', err);
    next(err);
  }
});

app.post('/admin-api/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
    const isFirstUser = row.count === 0;
    if (!isFirstUser && !(req.session && req.session.user)) {
      return res.status(401).json({
        error: 'Unauthorized. Please log in as admin to add new users.',
      });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [
      username,
      hash,
    ]);
    res.json({ message: 'Admin user registered successfully.' });
  } catch (err) {
    console.error('Error in /admin-api/register:', err);
    next(err);
  }
});

app.post('/admin-api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      req.session.user = { id: user.id, username: user.username };
      res.json({ message: 'Login successful.' });
    } else {
      res.status(401).json({ error: 'Invalid credentials.' });
    }
  } catch (err) {
    console.error('Error in /admin-api/login:', err);
    next(err);
  }
});

app.post('/admin-api/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error during logout:', err);
      return next(err);
    }
    res.json({ message: 'Logged out.' });
  });
});

app.get('/admin-api/donations', isAuthenticated, async (req, res, next) => {
  try {
    let donations = await dbAll(`SELECT * FROM donations ORDER BY created_at DESC`);

    // Update pending donation statuses from Stripe
    for (let donation of donations) {
      if (donation.payment_intent_status === 'pending') {
        try {
          const paymentIntent = await stripeInstance.paymentIntents.retrieve(
            donation.payment_intent_id
          );
          if (paymentIntent.status !== donation.payment_intent_status) {
            await dbRun(
              `UPDATE donations SET payment_intent_status = ? WHERE id = ?`,
              [paymentIntent.status, donation.id]
            );
            donation.payment_intent_status = paymentIntent.status;
          }
        } catch (err) {
          console.error(
            `Error fetching PaymentIntent for donation id ${donation.id}:`,
            err
          );
        }
      }
    }
    res.json({ donations });
  } catch (err) {
    console.error('Error in /admin-api/donations:', err);
    next(err);
  }
});

app.post('/admin-api/users', isAuthenticated, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [
      username,
      hash,
    ]);
    res.json({ message: 'New admin user added successfully.' });
  } catch (err) {
    console.error('Error in /admin-api/users:', err);
    next(err);
  }
});

// ------------------------------------------------------
// BACKGROUND WORKER: Retry Pending FB Conversions
// ------------------------------------------------------
setInterval(async () => {
  try {
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent'");
    for (const log of logs) {
      const donationRow = await dbGet("SELECT * FROM donations WHERE id = ?", [log.donation_id]);
      if (!donationRow) continue;

      // Also see if we have a landing_page_url from fb_data
      if (donationRow.fbclid) {
        const fbDataRow = await dbGet(`SELECT * FROM fb_data WHERE fbclid = ?`, [donationRow.fbclid]);
        if (fbDataRow && fbDataRow.landing_page_url) {
          donationRow.landing_page_url = fbDataRow.landing_page_url;
        }
      }

      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();
      if (result.success) {
        await dbRun(
          "UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?",
          [result.attempts, now, log.id]
        );
        await dbRun(
          "UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?",
          [donationRow.id]
        );
        console.log(`Successfully retried FB conversion for donation id ${donationRow.id}`);
      } else {
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [result.attempts, now, result.error ? result.error.message : '', log.id]
        );
        console.warn(`Retry pending for donation id ${donationRow.id}`);
      }
    }
  } catch (err) {
    console.error("Error processing pending FB conversions:", err);
  }
}, 60000);

// ------------------------------------------------------
// ERROR HANDLING MIDDLEWARE
// ------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// ------------------------------------------------------
// GLOBAL PROCESS ERROR HANDLERS
// ------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ------------------------------------------------------
// START THE SERVER
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
