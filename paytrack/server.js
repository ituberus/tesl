/********************************
 * server.js
 ********************************/
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

/*
  -------------
  SQUARE SDK SETUP (UPDATED FOR v42+)
  -------------
  Using the new Node SDK imports.
  Note: The Environment enum is no longer exported.
  Instead, pass the environment as a string ("sandbox" or "production").
*/
const { Client, ApiError } = require('square');

/*
  Use environment from your NODE_ENV.
*/
const isProd = process.env.NODE_ENV === 'production';

// Initialize the Square client properly by passing a string for environment.
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: isProd ? "production" : "sandbox",
});

// Now, from the new client, we can get the paymentsApi:
const paymentsApi = squareClient.paymentsApi;
const locationId = process.env.SQUARE_LOCATION_ID; // keep your location ID

// ------------------------------------------------------
// ENVIRONMENT VARIABLES (FACEBOOK, ETC.)
// ------------------------------------------------------
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    credentials: true,
    origin: true,
  })
);
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: isProd,
      httpOnly: true,
      sameSite: 'strict',
    },
  })
);

// 1) Serve static files
app.use(express.static('public'));

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
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_amount INTEGER,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      card_name TEXT,
      country TEXT,
      postal_code TEXT,
      order_complete_url TEXT,
      payment_id TEXT,
      payment_status TEXT,
      fbclid TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip_address TEXT,
      client_user_agent TEXT,
      event_id TEXT,
      fbp TEXT,
      fbc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2) admin_users table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  // 3) fb_conversion_logs table
  db.run(`
    CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_id INTEGER,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4) payment_failures table
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      amount INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

  if (!donationRow.payment_id) {
    console.warn(
      `Skipping FB conversion for donation ID ${donationRow.id}: No payment_id.`
    );
    return { success: false, error: 'No Square payment ID' };
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

  const eventSourceUrl =
    donationRow.orderCompleteUrl ||
    donationRow.order_complete_url ||
    'https://example.com/orderComplete';

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
      currency: 'USD',
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

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
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
// NEW ROUTE: /api/store-fb-data
// Stores fbclid, fbp, fbc in the session if available
// and generates them if missing, so we always have them
// in case cookies are blocked.
// ------------------------------------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc } = req.body;

    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }

    // Generate if missing
    // Note: fbp format: "fb.1.<timestamp>.<random>"
    const timestamp = Math.floor(Date.now() / 1000);
    if (!fbp) {
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
    }
    // fbc format: "fb.1.<timestamp>.<fbclid>"
    if (!fbc && fbclid) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
    }

    // Store in session
    req.session.fbp = fbp;
    req.session.fbc = fbc;
    req.session.fbclid = fbclid || null;

    return res.json({
      message: 'FB data stored in session',
      fbclid,
      fbp,
      fbc,
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// ------------------------------------------------------
// NEW ROUTE: /api/get-fb-data
// Retrieve the values from session (if needed in frontend).
// ------------------------------------------------------
app.get('/api/get-fb-data', (req, res) => {
  try {
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }
    const { fbp, fbc, fbclid } = req.session;
    return res.json({
      fbp: fbp || null,
      fbc: fbc || null,
      fbclid: fbclid || null,
    });
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ------------------------------------------------------
// ROUTE: /api/fb-conversion (Send Conversions to FB)
// Modified to fallback to session-based fbp/fbc/fbclid
// if the request doesn't include them.
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res, next) => {
  try {
    let {
      event_name,
      event_time,
      event_id,
      email,
      amount,
      fbp,
      fbc,
      user_data = {},
      orderCompleteUrl,
    } = req.body;

    // Fallback to cookies
    let fbclid = req.body.fbclid || req.cookies.fbclid || null;

    // Fallback to session if not provided
    if (req.session) {
      fbclid = fbclid || req.session.fbclid || null;
      fbp = fbp || req.session.fbp || null;
      fbc = fbc || req.session.fbc || null;
    }

    // If STILL missing, generate them as a last resort
    const timestamp = Math.floor(Date.now() / 1000);
    if (!fbp) {
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
    }
    if (!fbc && fbclid) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
    }

    const firstName = user_data.fn || null;
    const lastName = user_data.ln || null;
    const country = user_data.country || null;
    const postalCode = user_data.zp || null;

    if (!email || !amount) {
      return res.status(400).json({ error: 'Missing email or amount' });
    }

    const donationAmountCents = Math.round(Number(amount) * 100);

    // 1) Check for existing donation within last 24 hours
    let row = await dbGet(
      `
        SELECT * FROM donations
        WHERE email = ?
          AND donation_amount = ?
          AND created_at >= datetime('now', '-1 day')
        LIMIT 1
      `,
      [email, donationAmountCents]
    );

    if (!row) {
      // 2) Create new donation if not found
      const insert = await dbRun(
        `
          INSERT INTO donations (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
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
      await dbRun(
        `
          UPDATE donations
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
          WHERE id = ?
        `,
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
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    // Ensure payment is successful
    if (!row.payment_id) {
      return res
        .status(400)
        .json({ error: 'No Square payment_id associated with this donation.' });
    }

    // Retrieve the Square payment to ensure it's completed
    let paymentStatus = null;
    try {
      const { result } = await paymentsApi.getPayment(row.payment_id);
      if (result && result.payment && result.payment.status) {
        paymentStatus = result.payment.status; // e.g. "COMPLETED"
      }
    } catch (err) {
      console.error(`Error retrieving Square payment ${row.payment_id}:`, err);
      return res
        .status(400)
        .json({ error: 'Failed to confirm payment status with Square.' });
    }

    if (paymentStatus !== 'COMPLETED') {
      return res
        .status(400)
        .json({ error: 'Payment not successful, conversion event not sent.' });
    }

    // If we already sent the conversion
    if (row.fb_conversion_sent === 1) {
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
      `
        UPDATE donations
         SET client_ip_address = ?, client_user_agent = ?
         WHERE id = ?
      `,
      [clientIp, clientUserAgent, row.id]
    );

    // Reload row with updated IP / user agent
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;
    row.orderCompleteUrl = orderCompleteUrl;

    // Log payload
    const rawPayload = JSON.stringify(req.body);
    const insertLogResult = await dbRun(
      `
        INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
        VALUES (?, ?, ?, ?)
      `,
      [row.id, rawPayload, 0, 'pending']
    );
    const logId = insertLogResult.lastID;

    // Attempt FB conversion with retry
    const conversionResult = await attemptFacebookConversion(row);
    const now = new Date().toISOString();

    if (conversionResult.success) {
      // Mark success
      await dbRun(
        `
          UPDATE fb_conversion_logs
           SET status = 'sent', attempts = ?, last_attempt = ?
           WHERE id = ?
        `,
        [conversionResult.attempts, now, logId]
      );
      await dbRun(
        `
          UPDATE donations
           SET fb_conversion_sent = 1
           WHERE id = ?
        `,
        [row.id]
      );
    } else {
      // Mark failure
      await dbRun(
        `
          UPDATE fb_conversion_logs
           SET attempts = ?, last_attempt = ?, error = ?
           WHERE id = ?
        `,
        [
          conversionResult.attempts,
          now,
          conversionResult.error ? conversionResult.error.message : '',
          logId,
        ]
      );
    }

    return res.json({ message: 'Conversion processing initiated.' });
  } catch (err) {
    console.error('Error in /api/fb-conversion:', err);
    return res
      .status(500)
      .json({ error: 'Internal error sending FB conversion.' });
  }
});

// ------------------------------------------------------
// PROCESS SQUARE PAYMENT
// ------------------------------------------------------
app.post('/process-square-payment', async (req, res) => {
  try {
    // Data from the front-end
    const {
      cardToken,
      donationAmount,
      email,
      firstName,
      lastName,
      cardName,
      country,
      postalCode,
    } = req.body;

    if (!cardToken) {
      return res.status(400).json({ error: 'Missing card token (nonce).' });
    }

    let amount = parseFloat(donationAmount);
    if (isNaN(amount) || amount <= 0) {
      amount = 50.0; // fallback, or handle as you wish
    }
    const amountInCents = Math.round(amount * 100);
    const idempotencyKey = randomUUID();

    // Build payment request
    const paymentRequest = {
      idempotencyKey,
      locationId,
      sourceId: cardToken,
      amountMoney: {
        amount: amountInCents,
        currency: 'USD',
      },
      // Optional: pass postalCode for Address Verification
      verificationDetails: {
        billingPostalCode: postalCode || '',
      },
    };

    // Create the payment
    const { result } = await paymentsApi.createPayment(paymentRequest);
    const payment = result.payment;

    // Insert donation record
    await dbRun(
      `
        INSERT INTO donations (
          donation_amount,
          email,
          first_name,
          last_name,
          card_name,
          country,
          postal_code,
          payment_id,
          payment_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        amountInCents,
        email || '',
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        payment.id,
        payment.status // e.g. "COMPLETED", "APPROVED", etc.
      ]
    );

    // Return JSON success
    return res.json({
      success: true,
      paymentId: payment.id,
      status: payment.status,
    });
  } catch (error) {
    console.error('Payment Error:', error);

    // If it's a Square API error, log details
    if (error instanceof ApiError) {
      console.error('Square API Errors:', error.result);
    }

    // Log payment failure
    try {
      const { email, donationAmount } = req.body;
      const amountCents = !isNaN(donationAmount)
        ? Math.round(Number(donationAmount) * 100)
        : 0;
      await dbRun(
        `
          INSERT INTO payment_failures (email, amount, error)
          VALUES (?, ?, ?)
        `,
        [email || '', amountCents, error.message]
      );
    } catch (logErr) {
      console.error('Failed to log payment failure:', logErr);
    }

    return res
      .status(500)
      .json({ error: 'Payment processing failed. Please try again later.' });
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
      return res
        .status(400)
        .json({ error: 'Username and password are required.' });
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
      return res
        .status(400)
        .json({ error: 'Username and password are required.' });
    }
    const user = await dbGet(
      `SELECT * FROM admin_users WHERE username = ?`,
      [username]
    );
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

// Example: Show all donations
app.get('/admin-api/donations', isAuthenticated, async (req, res, next) => {
  try {
    let donations = await dbAll(
      `SELECT * FROM donations ORDER BY created_at DESC`
    );

    // Update "pending" or incomplete donations from Square
    for (let donation of donations) {
      // If it's not COMPLETED, let's try to update from Square
      if (donation.payment_status && donation.payment_status !== 'COMPLETED') {
        if (donation.payment_id) {
          try {
            const { result } = await paymentsApi.getPayment(donation.payment_id);
            const sqPayment = result && result.payment ? result.payment : null;
            if (
              sqPayment &&
              sqPayment.status &&
              sqPayment.status !== donation.payment_status
            ) {
              await dbRun(
                `UPDATE donations SET payment_status = ? WHERE id = ?`,
                [sqPayment.status, donation.id]
              );
              donation.payment_status = sqPayment.status;
            }
          } catch (err) {
            console.error(
              `Error fetching Square Payment for donation id ${donation.id}:`,
              err
            );
          }
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
      return res
        .status(400)
        .json({ error: 'Username and password are required.' });
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
    const logs = await dbAll(
      "SELECT * FROM fb_conversion_logs WHERE status != 'sent'"
    );
    for (const log of logs) {
      const donationRow = await dbGet(
        'SELECT * FROM donations WHERE id = ?',
        [log.donation_id]
      );
      if (!donationRow) continue;

      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();
      if (result.success) {
        await dbRun(
          "UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?",
          [result.attempts, now, log.id]
        );
        await dbRun(
          'UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?',
          [donationRow.id]
        );
        console.log(
          `Successfully retried FB conversion for donation id ${donationRow.id}`
        );
      } else {
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [
            result.attempts,
            now,
            result.error ? result.error.message : '',
            log.id,
          ]
        );
        console.warn(`Retry pending for donation id ${donationRow.id}`);
      }
    }
  } catch (err) {
    console.error('Error processing pending FB conversions:', err);
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
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log(`Server running on port ${PORT}`);
});
