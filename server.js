/********************************
 * server.js (Square version, updated to handle multiple FB configs)
 ********************************/
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session'); // Keep for admin login only
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { promisify } = require('util');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

// ---------------------------
// SQUARE SDK SETUP
// ---------------------------
const { Client, Environment, ApiError } = require('square');

const squareClient = new Client({
  environment: process.env.NODE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

const paymentsApi = squareClient.paymentsApi;
const locationId  = process.env.SQUARE_LOCATION_ID || ''; // Make sure it's set!

// ------------------------------------------------------
// ENVIRONMENT VARIABLES (FACEBOOK, ETC.)
// ------------------------------------------------------
const RAW_PIXEL_ID        = process.env.FACEBOOK_PIXEL_ID        || '4081709638819473';
const RAW_ACCESS_TOKEN    = process.env.FACEBOOK_ACCESS_TOKEN    || 'EAAYyRSgZBc5QBO6Wm6pOZCNXx6kUakBoGT18IYDDtFUXhUboXMeHSmy7MhGScxEQG3UY97jaOT6wZCYJTav6OCpuzIwwkhThYZBZCcBQdmew0lvWAWZCno58kZCMwN7C4Rlwhqp89EzBqkXmssn10oCZCWyldtjb0QmKQ0SLnPnSVp5CSB0Q9JcfjydlWYOQtwjAUwZDZD';
const RAW_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';
const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors({ credentials: true, origin: true }));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// We still keep session usage for admin login:
app.use(
  session({
    store : new SQLiteStore({ db: 'sessions.sqlite', dir: './' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge : 7 * 24 * 60 * 60 * 1000,           // 7 days
      secure : process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict'
    }
  })
);


// Serve static files
app.use(express.static('public'));

// ------------------------------------------------------
// SQLITE SETUP
// ------------------------------------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('[DB] Error opening database:', err);
  } else {
    console.log('[DB] Connected to SQLite database.');
  }
});

const dbAll = promisify(db.all).bind(db);
const dbGet = promisify(db.get).bind(db);
function dbRun(...args) {
  return new Promise((resolve, reject) => {
    db.run(...args, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

// Create / alter tables as needed
db.serialize(() => {
  // 1) donations table
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_amount INTEGER,
      email TEXT,
      -- NEW: store original email separately
      original_email TEXT,

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
      landing_page_url TEXT,
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

  // 5) landing_data table (store fbclid, fbp, fbc, and domain)
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
// NEW: Multiple-FB setup
// ------------------------------------------------------
const pixelIds = RAW_PIXEL_ID.split(',').map(s => s.trim());
const accessTokens = RAW_ACCESS_TOKEN.split(',').map(s => s.trim());
const testEventCodes = RAW_TEST_EVENT_CODE.split(',').map(s => s.trim());

// Helper to pair them up
function getFacebookConfigs() {
  const maxLength = Math.min(pixelIds.length, accessTokens.length);
  const configs = [];
  for (let i = 0; i < maxLength; i++) {
    configs.push({
      pixelId: pixelIds[i],
      accessToken: accessTokens[i],
      testEventCode: testEventCodes[i] || ''  // can be empty => live mode
    });
  }
  return configs;
}

let facebookConfigs = getFacebookConfigs();
// If no valid config found, fallback to a single default
if (facebookConfigs.length === 0) {
  facebookConfigs = [{
    pixelId: pixelIds[0] || '1200226101753260',
    accessToken: accessTokens[0] || '',
    testEventCode: testEventCodes[0] || ''
  }];
}

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

  if (!donationRow.payment_id) {
    console.warn(`[FB CAPI] Skipping donation ID ${donationRow.id}: No Square payment_id.`);
    return { success: false, error: 'No Square payment ID' };
  }

  // Hash helper
  function sha256(value) {
    return crypto.createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex');
  }

  // IMPORTANT: Use original_email if present, else fallback to email
  const finalEmail = donationRow.original_email || donationRow.email;

  // Build user_data
  const userData = {};
  if (finalEmail)      userData.em = sha256(finalEmail);
  if (donationRow.first_name) userData.fn = sha256(donationRow.first_name);
  if (donationRow.last_name)  userData.ln = sha256(donationRow.last_name);
  if (donationRow.country)    userData.country = sha256(donationRow.country);
  if (donationRow.postal_code)userData.zp = sha256(donationRow.postal_code);

  // fbp/fbc go un-hashed
  if (donationRow.fbp) userData.fbp = donationRow.fbp;
  if (donationRow.fbc) userData.fbc = donationRow.fbc;

  // IP & user agent
  if (donationRow.client_ip_address) {
    userData.client_ip_address = donationRow.client_ip_address;
  }
  if (donationRow.client_user_agent) {
    userData.client_user_agent = donationRow.client_user_agent;
  }

  const eventSourceUrl =
    donationRow.landing_page_url ||
    donationRow.orderCompleteUrl ||
    donationRow.order_complete_url ||
    'https://perfectbodyme.co/thanks';

    // Remove tracking params (utm_source, etc.)
const cleanEventSourceUrl = eventSourceUrl.split('?')[0];


  // event_id
  const finalEventId = donationRow.event_id || String(donationRow.id);

  const baseEventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: finalEventId,
    event_source_url: cleanEventSourceUrl,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
      currency: 'USD'
    }
  };

  // Attach fbclid to custom_data if present
  if (donationRow.fbclid) {
    baseEventData.custom_data.fbclid = donationRow.fbclid;
  }

  // --- NEW: Send to each configured Pixel/Token ---
  for (let i = 0; i < facebookConfigs.length; i++) {
    const { pixelId, accessToken, testEventCode } = facebookConfigs[i];
    if (!pixelId || !accessToken) {
      console.warn(`[FB CAPI] Skipping config index ${i} => pixelId or accessToken missing.`);
      continue;
    }

    const payload = { data: [baseEventData] };
    if (testEventCode) {
      payload.test_event_code = testEventCode;
    }

    console.log(`[FB CAPI] Sending payload to pixelId: ${pixelId}:\n`, JSON.stringify(payload, null, 2));

    const url = `https://graph.facebook.com/v15.0/${pixelId}/events?access_token=${accessToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`FB API error (pixel: ${pixelId}): ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[FB CAPI] Successfully sent event to pixelId ${pixelId}. Facebook response:`, result);
  }

  // If we get here, all sends succeeded
  return { success: true };
}

async function attemptFacebookConversion(donationRow) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donationRow);
      if (result.success) {
        console.log(`[FB CAPI] Donation ID ${donationRow.id} conversion succeeded on attempt ${attempt+1}`);
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
    }

    attempt++;
    console.warn(`[FB CAPI] Attempt ${attempt} failed for donation ID ${donationRow.id}: ${lastError.message}`);
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  return { success: false, error: lastError, attempts: attempt };
}

// ------------------------------------------------------
// /api/store-fb-data
// ------------------------------------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc, domain } = req.body;
    console.log('[store-fb-data] Received data:', { fbclid, fbp, fbc, domain });

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

    // Clean domain if it's a full URL
    let cleanedDomain = null;
    if (domain) {
      try {
        const urlObj = new URL(domain);
        cleanedDomain = urlObj.origin + urlObj.pathname;
      } catch (err) {
        cleanedDomain = domain;
      }
    }

    // Check if row with this fbclid already exists
    let row = null;
    if (fbclid) {
      row = await dbGet(`SELECT * FROM landing_data WHERE fbclid = ?`, [fbclid]);
    }

    if (!row) {
      // Insert new
      await dbRun(
        `INSERT INTO landing_data (fbclid, fbp, fbc, domain)
         VALUES (?, ?, ?, ?)`,
        [ fbclid || null, fbp || null, fbc || null, cleanedDomain || null ]
      );
      console.log('[store-fb-data] Inserted new row in landing_data.');
    } else {
      // Update existing
      await dbRun(
        `UPDATE landing_data
         SET fbp   = COALESCE(?, fbp),
             fbc   = COALESCE(?, fbc),
             domain= COALESCE(?, domain)
         WHERE fbclid = ?`,
        [ fbp || null, fbc || null, cleanedDomain || null, fbclid ]
      );
      console.log('[store-fb-data] Updated existing row in landing_data.');
    }

    return res.json({
      message: 'FB data stored in SQLite successfully.',
      fbclid,
      fbp,
      fbc,
      domain: cleanedDomain
    });
  } catch (err) {
    console.error('[store-fb-data] Error:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// ------------------------------------------------------
// /api/get-fb-data
// ------------------------------------------------------
app.get('/api/get-fb-data', async (req, res) => {
  try {
    const fbclid = req.query.fbclid || null;
    if (!fbclid) {
      console.warn('[get-fb-data] No fbclid provided.');
      return res.status(400).json({ error: 'Missing fbclid query param' });
    }

    const row = await dbGet(
      `SELECT fbclid, fbp, fbc, domain FROM landing_data WHERE fbclid = ?`,
      [fbclid]
    );

    if (!row) {
      console.log('[get-fb-data] No matching fbclid in DB. Returning nulls.');
      return res.json({ fbclid: null, fbp: null, fbc: null, domain: null });
    }

    console.log('[get-fb-data] Found landing_data:', row);
    return res.json(row);
  } catch (err) {
    console.error('[get-fb-data] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ------------------------------------------------------
// /api/fb-conversion (Square version)
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res) => {
  try {
    const {
      event_name,
      event_time,
      event_id,
      email,            // <-- This is the ORIGINAL (old) email from frontend
      amount,
      fbclid,
      payment_id,
      user_data = {},
      orderCompleteUrl
    } = req.body;

    console.log('[fb-conversion] Incoming payload:', req.body);

    if (!email || !amount) {
      console.warn('[fb-conversion] Missing email or amount.');
      return res.status(400).json({ error: 'Missing email or amount' });
    }

    const donationAmountCents = Math.round(Number(amount) * 100);

// 1️⃣  Try the most reliable key: Square payment_id
    let row = null; 
    if (payment_id) { 
      row = await dbGet( 
        `SELECT * FROM donations WHERE payment_id = ?`, 
        [payment_id] 
      ); 
    } 
 
    // 2️⃣  Fallback – same search you already had 
    if (!row) { 
      row = await dbGet( 
        `SELECT * FROM donations 
          WHERE (original_email = ? OR email = ?) 
            AND donation_amount = ? 
            AND created_at >= datetime('now', '-1 day') 
          LIMIT 1`, 
        [email, email, donationAmountCents] 
      ); 
    }

    // Attempt to retrieve landing_data by fbclid
    let landingData = null;
    if (fbclid) {
      landingData = await dbGet(`SELECT * FROM landing_data WHERE fbclid = ?`, [fbclid]);
      console.log('[fb-conversion] landingData for fbclid:', fbclid, landingData);
    }

    // user_data from front-end
    const firstName  = user_data.fn || null;
    const lastName   = user_data.ln || null;
    const country    = user_data.country || null;
    const postalCode = user_data.zp || null;

    if (!row) {
      // No recent donation found => create new row,
      // storing the old email in original_email, and leaving email empty
      console.log('[fb-conversion] No recent donation found. Creating new row.');
      const insert = await dbRun(
        `INSERT INTO donations (
          donation_amount,
          email,
          original_email,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          donationAmountCents,
          '',               // email (new) is unknown here
          email,            // original_email is the old email
          firstName,
          lastName,
          country,
          postalCode,
          fbclid || null,
          landingData ? landingData.fbp   : null,
          landingData ? landingData.fbc   : null,
          event_id || null,
          orderCompleteUrl || null,
          payment_id || null,
          'PENDING',       // default
          landingData ? landingData.domain : null
        ]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
      console.log('[fb-conversion] Created new donation row with ID:', insert.lastID);
    } else {
      console.log('[fb-conversion] Found existing donation row. Updating...');
      // If we found a row but its original_email is empty, store the old email
      if (!row.original_email) {
        row.original_email = email;
      }

      await dbRun(
        `UPDATE donations
         SET first_name          = COALESCE(first_name, ?),
             last_name           = COALESCE(last_name, ?),
             country             = COALESCE(country, ?),
             postal_code         = COALESCE(postal_code, ?),
             fbclid              = COALESCE(fbclid, ?),
             fbp                 = COALESCE(fbp, ?),
             fbc                 = COALESCE(fbc, ?),
             event_id            = COALESCE(event_id, ?),
             order_complete_url  = COALESCE(order_complete_url, ?),
             landing_page_url    = COALESCE(landing_page_url, ?),
             original_email      = COALESCE(original_email, ?)
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
          row.original_email || email,
          row.id
        ]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
      console.log('[fb-conversion] Donation row updated:', row.id);
    }

    // We should confirm the donation actually has a valid Square payment
    if (!row.payment_id) {
      const msg = 'No Square payment_id associated with this donation.';
      console.error(`[fb-conversion] ${msg}`);
      return res.status(400).json({ error: msg });
    }

    // Check Square payment status
    let paymentStatus = null;
    try {
      const { result } = await paymentsApi.getPayment(row.payment_id);
      if (result && result.payment && result.payment.status) {
        paymentStatus = result.payment.status;
      }
    } catch (err) {
      console.error(`[fb-conversion] Error fetching Square payment ${row.payment_id}:`, err);
      return res.status(400).json({ error: 'Failed to confirm payment status with Square.' });
    }

    if (paymentStatus !== 'COMPLETED') {
      const msg = 'Payment not successful, conversion event not sent.';
      console.warn(`[fb-conversion] ${msg}`);
      return res.status(400).json({ error: msg });
    }

    // If we already sent the conversion
    if (row.fb_conversion_sent === 1) {
      console.log('[fb-conversion] Already sent conversion for that donation. Doing nothing.');
      return res.json({ message: 'Already sent conversion for that donation.' });
    }

    // Update IP and user agent
    const clientIp = req.headers['x-forwarded-for']
      || req.connection?.remoteAddress
      || req.socket?.remoteAddress
      || '';
    const clientUserAgent = req.headers['user-agent'] || '';
    await dbRun(
      `UPDATE donations
       SET client_ip_address = ?, client_user_agent = ?
       WHERE id = ?`,
      [clientIp, clientUserAgent, row.id]
    );

    row.client_ip_address    = clientIp;
    row.client_user_agent    = clientUserAgent;
    row.orderCompleteUrl     = orderCompleteUrl || row.orderCompleteUrl;

    // Log raw payload
    const rawPayload = JSON.stringify(req.body);
    const insertLog = await dbRun(
      `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
       VALUES (?, ?, ?, ?)`,
      [row.id, rawPayload, 0, 'pending']
    );
    const logId = insertLog.lastID;

    console.log('[fb-conversion] Attempting FB conversion for donation ID:', row.id);
    const conversionResult = await attemptFacebookConversion(row);
    const now = new Date().toISOString();

    if (conversionResult.success) {
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
      console.log('[fb-conversion] FB conversion success for donation:', row.id);
    } else {
      await dbRun(
        `UPDATE fb_conversion_logs
         SET attempts = ?, last_attempt = ?, error = ?
         WHERE id = ?`,
        [
          conversionResult.attempts,
          now,
          conversionResult.error ? conversionResult.error.message : '',
          logId
        ]
      );
      console.warn('[fb-conversion] FB conversion failed for donation:', row.id);
    }

    return res.json({ message: 'Conversion processing complete.' });
  } catch (err) {
    console.error('Error in /api/fb-conversion:', err);
    return res.status(500).json({ error: 'Internal error sending FB conversion.' });
  }
});

// ------------------------------------------------------
// PROCESS SQUARE PAYMENT
// ------------------------------------------------------
app.post('/process-square-payment', async (req, res) => {
  try {
    const {
      cardToken,
      donationAmount,
      email,        // <-- This is now the TRANSFORMED email from the frontend
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
      amount = 50.0; // fallback or handle error
    }
    const amountInCents = Math.round(amount * 100);
    const idempotencyKey = randomUUID();

    console.log('[Square] Creating payment with amountInCents:', amountInCents);

    // Build payment request
    const paymentRequest = {
      idempotencyKey,
      locationId,
      sourceId: cardToken,
      amountMoney: {
        amount: amountInCents,
        currency: 'USD'
      },
      verificationDetails: {
        billingPostalCode: postalCode || ''
      }
    };

    // Create the payment
    const { result } = await paymentsApi.createPayment(paymentRequest);
    const payment = result.payment;
    console.log('[Square] Payment created. ID:', payment.id, 'Status:', payment.status);

    // Insert donation record
    // email => the transformed email
    // original_email => we'll leave it null here (the user typed email is not passed to this route)
    await dbRun(
      `INSERT INTO donations (
        donation_amount,
        email,
        original_email,
        first_name,
        last_name,
        card_name,
        country,
        postal_code,
        payment_id,
        payment_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        amountInCents,
        email || '',
        null,         // we don't have the old email here
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        payment.id,
        payment.status
      ]
    );
    console.log('[Square] Donation row inserted for (new) email:', email);

    // Return JSON success
    return res.json({
      success: true,
      paymentId: payment.id,
      status: payment.status
    });

  } catch (error) {
    console.error('[Square] Payment Error:', error);

    // If it's a Square API error, log details
    if (error instanceof ApiError) {
      console.error('[Square] Square API Errors:', error.result);
    }

    // Log payment failure
    try {
      const { email, donationAmount } = req.body;
      const amountCents = !isNaN(donationAmount)
        ? Math.round(Number(donationAmount) * 100)
        : 0;
      await dbRun(
        `INSERT INTO payment_failures (email, amount, error) VALUES (?, ?, ?)`,
        [email || '', amountCents, error.message]
      );
      console.log('[Square] Logged payment failure for email:', email);
    } catch (logErr) {
      console.error('[Square] Failed to log payment failure:', logErr);
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
    console.warn('[Admin] Unauthorized access attempt.');
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
    await dbRun(
      `INSERT INTO admin_users (username, password) VALUES (?, ?)`,
      [username, hash]
    );
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

    // Attempt to update any incomplete Square payments
    for (let donation of donations) {
      if (donation.payment_status && donation.payment_status !== 'COMPLETED') {
        if (donation.payment_id) {
          try {
            const { result } = await paymentsApi.getPayment(donation.payment_id);
            const sqPayment  = (result && result.payment) ? result.payment : null;
            if (sqPayment && sqPayment.status && sqPayment.status !== donation.payment_status) {
              await dbRun(
                `UPDATE donations SET payment_status = ? WHERE id = ?`,
                [sqPayment.status, donation.id]
              );
              donation.payment_status = sqPayment.status;
              console.log(`[Admin] Updated donation ID ${donation.id} status to ${sqPayment.status}.`);
            }
          } catch (err) {
            console.error(
              `[Admin] Error fetching Square Payment for donation ID ${donation.id}:`,
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
    await dbRun(
      `INSERT INTO admin_users (username, password) VALUES (?, ?)`,
      [username, hash]
    );
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
    const logs = await dbAll(`SELECT * FROM fb_conversion_logs WHERE status != 'sent'`);
    for (const log of logs) {
      const donationRow = await dbGet(`SELECT * FROM donations WHERE id = ?`, [log.donation_id]);
      if (!donationRow) continue;

      console.log(`[Worker] Retrying FB conversion for donation ID: ${donationRow.id}`);
      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();

      if (result.success) {
        await dbRun(
          `UPDATE fb_conversion_logs
             SET status = 'sent', attempts = ?, last_attempt = ?
             WHERE id = ?`,
          [result.attempts, now, log.id]
        );
        await dbRun(
          `UPDATE donations
             SET fb_conversion_sent = 1
             WHERE id = ?`,
          [donationRow.id]
        );
        console.log(`[Worker] Successfully retried FB conversion for donation ID ${donationRow.id}`);
      } else {
        await dbRun(
          `UPDATE fb_conversion_logs
             SET attempts = ?, last_attempt = ?, error = ?
             WHERE id = ?`,
          [
            result.attempts,
            now,
            result.error ? result.error.message : '',
            log.id
          ]
        );
        console.warn(`[Worker] Still pending. Donation ID: ${donationRow.id}`);
      }
    }
  } catch (err) {
    console.error("[Worker] Error processing pending FB conversions:", err);
  }
}, 60000);

// ------------------------------------------------------
// ERROR HANDLING MIDDLEWARE
// ------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[Global] Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// ------------------------------------------------------
// GLOBAL PROCESS ERROR HANDLERS
// ------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[Global] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Global] Uncaught Exception:', err);
});

// ------------------------------------------------------
// START THE SERVER (with added error handling so it won't crash)
// ------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('[Server] Error encountered:', err);
  // We do not exit the process, so the app remains running.
});
