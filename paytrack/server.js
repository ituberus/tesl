/********************************
 * server.js (MODIFIED)
 ********************************/
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session'); // Keep for admin login only
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

// ---------------------------
// SQUARE SDK SETUP
// ---------------------------
const { Client, Environment, ApiError } = require('square');

const squareClient = new Client({
  environment:
    process.env.NODE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

const paymentsApi = squareClient.paymentsApi;
const locationId = process.env.SQUARE_LOCATION_ID;

// ------------------------------------------------------
// ENVIRONMENT VARIABLES (FACEBOOK, ETC.)
// ------------------------------------------------------
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

// We still keep session usage for admin login:
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
  //    We store Square payment info now in payment_id / payment_status
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
      payment_id TEXT,
      payment_status TEXT,
      fbclid TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip_address TEXT,
      client_user_agent TEXT,
      event_id TEXT,
      fbp TEXT,
      fbc TEXT,
      landing_page_url TEXT, -- <---- We'll store the "page_url" or "domain" here
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

  // 5) NEW TABLE: landing_data to store fbclid, fbp, fbc, and the page_url
  db.run(
    `CREATE TABLE IF NOT EXISTS landing_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      page_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
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

  // The event source URL can be the donationRow.landing_page_url if available,
  // otherwise fallback to order_complete_url or a default.
  const eventSourceUrl =
    donationRow.landing_page_url ||
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
// Instead of storing in session, now we store in "landing_data" table.
// We'll store: fbclid, fbp, fbc, and page_url
// ------------------------------------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc, pageUrl } = req.body;

    console.log('[store-fb-data] Received:', { fbclid, fbp, fbc, pageUrl });

    // Generate fbp if missing
    if (!fbp) {
      const timestamp = Math.floor(Date.now() / 1000);
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
      console.log('[store-fb-data] Generated new fbp:', fbp);
    }

    // Generate fbc if missing but fbclid is present
    if (!fbc && fbclid) {
      const timestamp = Math.floor(Date.now() / 1000);
      fbc = `fb.1.${timestamp}.${fbclid}`;
      console.log('[store-fb-data] Generated new fbc:', fbc);
    }

    // We'll "clean" the pageUrl if needed (just remove query params or keep it raw).
    // For demonstration, let's parse it. If parsing fails, we just store it raw.
    let cleanedUrl = null;
    if (pageUrl) {
      try {
        const urlObj = new URL(pageUrl);
        // store just origin + path (with slug)
        cleanedUrl = urlObj.origin + urlObj.pathname;
      } catch (e) {
        cleanedUrl = pageUrl;
      }
    }

    // See if we already have a row for this fbclid
    // If fbclid is missing, we can just insert a new row anyway.
    let row = null;
    if (fbclid) {
      row = await dbGet(`SELECT * FROM landing_data WHERE fbclid = ?`, [fbclid]);
    }

    if (!row) {
      // Insert new
      await dbRun(
        `INSERT INTO landing_data (fbclid, fbp, fbc, page_url)
         VALUES (?, ?, ?, ?)`,
        [
          fbclid || null,
          fbp || null,
          fbc || null,
          cleanedUrl || null
        ]
      );
      console.log('[store-fb-data] Inserted new landing_data row.');
    } else {
      // Update existing
      await dbRun(
        `UPDATE landing_data
         SET fbp = COALESCE(?, fbp),
             fbc = COALESCE(?, fbc),
             page_url = COALESCE(?, page_url)
         WHERE fbclid = ?`,
        [
          fbp || null,
          fbc || null,
          cleanedUrl || null,
          fbclid
        ]
      );
      console.log('[store-fb-data] Updated existing landing_data row.');
    }

    return res.json({
      message: 'FB data stored in SQLite.',
      fbclid: fbclid || null,
      fbp,
      fbc,
      pageUrl: cleanedUrl
    });
  } catch (err) {
    console.error('[store-fb-data] Error:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// ------------------------------------------------------
// NEW ROUTE: /api/get-fb-data
// We retrieve by ?fbclid=xxx from the query string
// ------------------------------------------------------
app.get('/api/get-fb-data', async (req, res) => {
  try {
    const fbclid = req.query.fbclid || null;
    if (!fbclid) {
      return res.status(400).json({ error: 'Missing fbclid query param' });
    }

    const row = await dbGet(
      `SELECT fbclid, fbp, fbc, page_url
       FROM landing_data
       WHERE fbclid = ?`,
      [fbclid]
    );

    if (!row) {
      // Not found => return nulls
      return res.json({ fbclid: null, fbp: null, fbc: null, page_url: null });
    }

    return res.json(row);
  } catch (err) {
    console.error('[get-fb-data] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ------------------------------------------------------
// ROUTE: /api/fb-conversion (Send Conversions to FB)
// Now we rely on the fbclid from the second domain call,
// and we look up fbp/fbc from landing_data table. Then
// we do the same logic as before, but no session usage.
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res, next) => {
  try {
    let {
      event_name,
      event_time,
      event_id,
      email,
      amount,
      fbclid,        // from the second domain
      user_data = {},
      orderCompleteUrl
    } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ error: 'Missing email or amount' });
    }

    const donationAmountCents = Math.round(Number(amount) * 100);

    // 1) Check for existing donation within last 24 hours
    let row = await dbGet(
      `SELECT * FROM donations
       WHERE email = ?
         AND donation_amount = ?
         AND created_at >= datetime('now', '-1 day')
       LIMIT 1`,
      [email, donationAmountCents]
    );

    // Attempt to get the relevant fb data from landing_data by fbclid
    let landingData = null;
    if (fbclid) {
      landingData = await dbGet(`SELECT * FROM landing_data WHERE fbclid = ?`, [fbclid]);
    }

    const firstName  = user_data.fn || null;
    const lastName   = user_data.ln || null;
    const country    = user_data.country || null;
    const postalCode = user_data.zp || null;

    // If donation row doesn't exist, create it
    if (!row) {
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
          payment_id,
          payment_status,
          landing_page_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          donationAmountCents,
          email,
          firstName,
          lastName,
          country,
          postalCode,
          fbclid || null,
          landingData ? landingData.fbp : null,
          landingData ? landingData.fbc : null,
          event_id || null,
          orderCompleteUrl || null,
          null,              // payment_id (Square) is not known yet
          'PENDING',         // or some default status
          landingData ? landingData.page_url : null
        ]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
    } else {
      // Update the existing row with any new info
      await dbRun(
        `UPDATE donations
         SET first_name = COALESCE(first_name, ?),
             last_name = COALESCE(last_name, ?),
             country = COALESCE(country, ?),
             postal_code = COALESCE(postal_code, ?),
             fbclid = COALESCE(fbclid, ?),
             fbp = COALESCE(fbp, ?),
             fbc = COALESCE(fbc, ?),
             event_id = COALESCE(event_id, ?),
             order_complete_url = COALESCE(order_complete_url, ?),
             landing_page_url = COALESCE(landing_page_url, ?)
         WHERE id = ?`,
        [
          firstName,
          lastName,
          country,
          postalCode,
          fbclid || null,
          landingData ? landingData.fbp : null,
          landingData ? landingData.fbc : null,
          event_id || null,
          orderCompleteUrl || null,
          landingData ? landingData.page_url : null,
          row.id
        ]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    // We check if there's a valid Square payment ID and if it's completed
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
      return res.status(400).json({ error: 'Failed to confirm payment status with Square.' });
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
      `UPDATE donations
       SET client_ip_address = ?, client_user_agent = ?
       WHERE id = ?`,
      [clientIp, clientUserAgent, row.id]
    );

    // Reload row with updated IP / user agent
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;
    row.orderCompleteUrl = orderCompleteUrl;

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
    }

    return res.json({ message: 'Conversion processing initiated.' });
  } catch (err) {
    console.error('Error in /api/fb-conversion:', err);
    return res.status(500).json({ error: 'Internal error sending FB conversion.' });
  }
});

// ------------------------------------------------------
// PROCESS SQUARE PAYMENT
// This remains the same; it just creates a donation row
// with payment_id and status. The fbclid/fbp/fbc is handled
// separately in /api/fb-conversion as above.
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
      postalCode
    } = req.body;

    if (!cardToken) {
      return res.status(400).json({ error: 'Missing card token (nonce).' });
    }

    let amount = parseFloat(donationAmount);
    if (isNaN(amount) || amount <= 0) {
      amount = 50.0; // fallback, or handle error as you prefer
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
      `INSERT INTO donations (
        donation_amount,
        email,
        first_name,
        last_name,
        card_name,
        country,
        postal_code,
        payment_id,
        payment_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        amountInCents,
        email || '',
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        payment.id,
        payment.status  // e.g. "COMPLETED", "APPROVED", etc.
      ]
    );

    // Return JSON success
    return res.json({
      success: true,
      paymentId: payment.id,
      status: payment.status
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
      const amountCents = !isNaN(donationAmount) ? Math.round(Number(donationAmount) * 100) : 0;
      await dbRun(
        `INSERT INTO payment_failures (email, amount, error)
         VALUES (?, ?, ?)`,
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
// (Session usage remains for admin login only)
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

// Example: Show all donations
app.get('/admin-api/donations', isAuthenticated, async (req, res, next) => {
  try {
    let donations = await dbAll(`SELECT * FROM donations ORDER BY created_at DESC`);

    // Update "pending" or incomplete donations from Square
    for (let donation of donations) {
      // If it's not COMPLETED, let's try to update from Square
      if (donation.payment_status && donation.payment_status !== 'COMPLETED') {
        if (donation.payment_id) {
          try {
            const { result } = await paymentsApi.getPayment(donation.payment_id);
            const sqPayment = result && result.payment ? result.payment : null;
            if (sqPayment && sqPayment.status && sqPayment.status !== donation.payment_status) {
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
          [
            result.attempts,
            now,
            result.error ? result.error.message : '',
            log.id
          ]
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
