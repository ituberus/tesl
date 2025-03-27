/********************************
 * server.js
 ********************************/
const express = require('express');
const path = require('path');
const session = require('express-session'); // we still use for admin login only
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

// UPDATED: Use '1200226101753260' as default
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '1200226101753260';
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
      payment_intent_id TEXT,
      payment_intent_status TEXT,
      fbclid TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip_address TEXT,
      client_user_agent TEXT,
      event_id TEXT,
      fbp TEXT,
      fbc TEXT,
      landing_page_url TEXT,            -- <--- ADDED: store cleaned domain/URL
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

  // 5) landing_data table (to store fbclid/fbp/fbc/domain)
  db.run(`
    CREATE TABLE IF NOT EXISTS landing_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      domain TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

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

  // Decide event source URL:
  //  1) If landing_page_url is present, use that
  //  2) else if orderCompleteUrl is present, use that
  //  3) else fallback
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

  // If we have fbclid, attach it
  if (donationRow.fbclid) {
    eventData.custom_data.fbclid = donationRow.fbclid;
  }

  const payload = {
    data: [eventData],
  };

  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  console.log('[FB CAPI] About to send the following payload to Facebook:');
  console.log(JSON.stringify(payload, null, 2));

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[FB CAPI] Error response from Facebook: ${response.status} - ${errorText}`);
    throw new Error(`FB API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('[FB CAPI] Facebook conversion result:', result);
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
        console.log(`[attemptFacebookConversion] Successfully sent FB event for donation ID ${donationRow.id} on attempt ${attempt + 1}`);
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
// NEW: /api/store-fb-data => Store landing data in SQLite
//     We'll store fbclid, fbp, fbc, domain
// ------------------------------------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc, domain } = req.body;
    console.log('[store-fb-data] Received data from frontend:', { fbclid, fbp, fbc, domain });
    // We will "clean" the domain to remove any query params
    let cleanedDomain = null;
    if (domain) {
      try {
        const urlObj = new URL(domain);
        cleanedDomain = urlObj.origin + urlObj.pathname;
        console.log('[store-fb-data] Cleaned domain from provided URL:', cleanedDomain);
      } catch (e) {
        // fallback to whatever was passed
        cleanedDomain = domain;
        console.warn('[store-fb-data] Unable to parse domain, using raw value:', domain);
      }
    }

    // Check if there's an existing row with that fbclid
    let row = null;
    if (fbclid) {
      row = await dbGet(
        `SELECT * FROM landing_data WHERE fbclid = ?`,
        [fbclid]
      );
    }

    if (!row) {
      // Insert new
      await dbRun(
        `INSERT INTO landing_data (fbclid, fbp, fbc, domain)
         VALUES (?, ?, ?, ?)`,
        [
          fbclid || null,
          fbp || null,
          fbc || null,
          cleanedDomain || null
        ]
      );
      console.log(`[store-fb-data] Inserted new landing_data row for fbclid=${fbclid} with data: { fbp: ${fbp || 'null'}, fbc: ${fbc || 'null'}, domain: ${cleanedDomain || 'null'} }`);
    } else {
      // Update existing
      await dbRun(
        `UPDATE landing_data
         SET fbp = COALESCE(?, fbp),
             fbc = COALESCE(?, fbc),
             domain = COALESCE(?, domain)
         WHERE fbclid = ?`,
        [
          fbp || null,
          fbc || null,
          cleanedDomain || null,
          fbclid
        ]
      );
      console.log(`[store-fb-data] Updated existing landing_data row for fbclid=${fbclid} with data: { fbp: ${fbp || 'null'}, fbc: ${fbc || 'null'}, domain: ${cleanedDomain || 'null'} }`);
    }

    return res.json({
      message: 'FB data stored in SQLite successfully',
      fbclid,
      fbp,
      fbc,
      domain: cleanedDomain
    });
  } catch (err) {
    console.error('[store-fb-data] Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// ------------------------------------------------------
// NEW: /api/get-fb-data => retrieve from DB by fbclid
// ------------------------------------------------------
app.get('/api/get-fb-data', async (req, res) => {
  try {
    let fbclid = req.query.fbclid || null;
    if (!fbclid) {
      console.warn('[get-fb-data] fbclid query parameter missing.');
      return res.status(400).json({ error: 'Missing fbclid query param' });
    }

    const row = await dbGet(
      `SELECT fbclid, fbp, fbc, domain
       FROM landing_data
       WHERE fbclid = ?`,
      [fbclid]
    );
    console.log('[get-fb-data] Retrieved landing_data for fbclid:', fbclid, row);
    if (!row) {
      return res.json({ fbclid: null, fbp: null, fbc: null, domain: null });
    }
    return res.json(row);
  } catch (err) {
    console.error('[get-fb-data] Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ------------------------------------------------------
// ROUTE: /api/fb-conversion (Server-Side Conversions)
// Modified to rely on the fbclid/fbp/fbc from DB
// plus the second domain sends us the fbclid. We will
// look up the landing data table, then store in donations
// so we can fire the event from there.
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res, next) => {
  try {
    let {
      event_name,
      event_time,
      event_id,
      email,
      amount,
      fbclid,  // from second domain
      // fbp,   // We don't rely on front-end for these anymore
      // fbc,
      user_data = {},
      orderCompleteUrl
    } = req.body;

    console.log('[fb-conversion] Incoming payload:', req.body);

    if (!email || !amount) {
      console.warn('[fb-conversion] Missing email or amount.');
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

    // We'll look up landing_data by fbclid to get domain, fbp, fbc
    let landingData = null;
    if (fbclid) {
      landingData = await dbGet(
        `SELECT * FROM landing_data WHERE fbclid = ?`,
        [fbclid]
      );
      console.log('[fb-conversion] Retrieved landing_data for fbclid:', fbclid, landingData);
    } else {
      console.warn('[fb-conversion] No fbclid provided in payload.');
    }

    // Basic data from user_data (from frontend if provided)
    const firstName  = user_data.fn || null;
    const lastName   = user_data.ln || null;
    const country    = user_data.country || null;
    const postalCode = user_data.zp || null;

    // Log whether values are coming from frontend or not
    console.log('[fb-conversion] User data details:', {
      firstName: firstName || 'Not provided from frontend',
      lastName: lastName || 'Not provided from frontend',
      country: country || 'Not provided from frontend',
      postalCode: postalCode || 'Not provided from frontend'
    });

    // If no existing donation, insert new "pending" row
    if (!row) {
      console.log('[fb-conversion] No recent donation row found. Creating new.');
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
          payment_intent_status,
          landing_page_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          'pending',
          landingData ? landingData.domain : null
        ]
      );
      console.log('[fb-conversion] Inserted new donation row with ID:', insert.lastID);
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
    } else {
      console.log('[fb-conversion] Found existing donation, updating it.');
      await dbRun(
        `UPDATE donations
         SET
           first_name          = COALESCE(first_name, ?),
           last_name           = COALESCE(last_name, ?),
           country             = COALESCE(country, ?),
           postal_code         = COALESCE(postal_code, ?),
           fbclid              = COALESCE(?, fbclid),
           fbp                 = COALESCE(?, fbp),
           fbc                 = COALESCE(?, fbc),
           event_id            = COALESCE(event_id, ?),
           order_complete_url  = COALESCE(order_complete_url, ?),
           landing_page_url    = COALESCE(landing_page_url, ?)
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
          landingData ? landingData.domain : null,
          row.id
        ]
      );
      console.log('[fb-conversion] Updated donation row with ID:', row.id);
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    // Check PaymentIntent
    if (!row.payment_intent_id) {
      const msg = 'No Stripe payment intent associated with this donation.';
      console.error(`[fb-conversion] ${msg}`);
      return res.status(400).json({ error: msg });
    }
    const paymentIntent = await stripeInstance.paymentIntents.retrieve(row.payment_intent_id);
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      const msg = 'Payment not successful, conversion event not sent.';
      console.error(`[fb-conversion] ${msg}`);
      return res.status(400).json({ error: msg });
    }

    // If we already sent the conversion
    if (row.fb_conversion_sent === 1) {
      console.log('[fb-conversion] Already sent conversion for that donation. No action.');
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
    console.log('[fb-conversion] Updated donation row with client IP and user agent:', { clientIp, clientUserAgent });

    // Reload row with updated IP / user agent
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;
    row.orderCompleteUrl = orderCompleteUrl; // if provided

    // Log payload details for conversion log
    const rawPayload = JSON.stringify(req.body);
    console.log('[fb-conversion] Logging payload for donation ID', row.id, rawPayload);
    const insertLogResult = await dbRun(
      `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
       VALUES (?, ?, ?, ?)`,
      [row.id, rawPayload, 0, 'pending']
    );
    const logId = insertLogResult.lastID;

    // Attempt FB conversion with retry
    console.log(`[fb-conversion] Attempting FB conversion for donation ${row.id} with the following data:`, {
      donationRow: row,
      paymentIntentStatus: paymentIntent.status
    });
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
      console.log(`[fb-conversion] FB conversion success for donation ${row.id}`);
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
      console.warn(`[fb-conversion] FB conversion failed for donation ${row.id}`);
    }

    return res.json({ message: 'Conversion processing complete.' });
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

  try {
    if (!donationAmount || !email) {
      console.warn('[create-payment-intent] Donation amount and email are required.');
      return res.status(400).json({ error: 'Donation amount and email are required.' });
    }

    const amountCents = Math.round(Number(donationAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      console.warn('[create-payment-intent] Invalid donation amount:', donationAmount);
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    console.log('[create-payment-intent] Creating PaymentIntent for', {
      email, amountCents
    });

    // Create Stripe PaymentIntent
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      receipt_email: email,
    });

    console.log('[create-payment-intent] PaymentIntent created:', paymentIntent.id);

    // Insert donation record as 'pending'
    await dbRun(
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
    console.log('[create-payment-intent] Donation row inserted successfully for email:', email);

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
      console.log('[create-payment-intent] Payment failure logged for email:', email);
    } catch (logErr) {
      console.error('Failed to log payment failure:', logErr);
    }
    next(err);
  }
});

// ------------------------------------------------------
// ADMIN AUTH & ENDPOINTS
// (unchanged, except logging as needed)
// ------------------------------------------------------
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  } else {
    console.warn('[admin] Unauthorized access attempt.');
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.get('/admin-api/check-setup', async (req, res, next) => {
  try {
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
    console.log('[admin-api/check-setup] Admin users count:', row.count);
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
      console.warn('[admin-api/register] Username and password are required.');
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
    const isFirstUser = row.count === 0;
    if (!isFirstUser && !(req.session && req.session.user)) {
      console.warn('[admin-api/register] Unauthorized attempt to register new admin.');
      return res.status(401).json({
        error: 'Unauthorized. Please log in as admin to add new users.',
      });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [
      username,
      hash,
    ]);
    console.log('[admin-api/register] New admin registered with username:', username);
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
      console.warn('[admin-api/login] Username and password are required.');
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [username]);
    if (!user) {
      console.warn('[admin-api/login] Invalid credentials for username:', username);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      req.session.user = { id: user.id, username: user.username };
      console.log('[admin-api/login] Login successful for username:', username);
      res.json({ message: 'Login successful.' });
    } else {
      console.warn('[admin-api/login] Invalid credentials (password mismatch) for username:', username);
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
    console.log('[admin-api/logout] User logged out successfully.');
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
            console.log(`[admin-api/donations] Updated donation ID ${donation.id} status to ${paymentIntent.status}`);
          }
        } catch (err) {
          console.error(
            `Error fetching PaymentIntent for donation id ${donation.id}:`,
            err
          );
        }
      }
    }
    console.log('[admin-api/donations] Retrieved donations:', donations.length);
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
      console.warn('[admin-api/users] Username and password are required.');
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [
      username,
      hash,
    ]);
    console.log('[admin-api/users] Added new admin user with username:', username);
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
      console.log(`[Background Worker] Retrying FB conversion for donation ID ${donationRow.id}`);
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
        console.log(`[Background Worker] Successfully retried FB conversion for donation ID ${donationRow.id}`);
      } else {
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [result.attempts, now, result.error ? result.error.message : '', log.id]
        );
        console.warn(`[Background Worker] Retry pending for donation ID ${donationRow.id}`);
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
