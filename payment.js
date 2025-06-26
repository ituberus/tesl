
/**********************************************
 * Add your Railway link below
 **********************************************/
const API_DOMAIN = 'https://perfectbodyfunnl-production-37a1.up.railway.app';
const FACEBOOK_PIXEL_ID = '1325429335188157'; // your actual Pixel ID
// const API_DOMAIN = 'https://perfectbodyfunnl-production-37a1.up.railway.app';
/**********************************************
 * FACEBOOK PIXEL BASE CODE (commented out)
 **********************************************/
// (Same code you had; you can uncomment if needed)
// !(function(f,b,e,v,n,t,s){
//   if(f.fbq)return;
//   n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};
//   if(!f._fbq)f._fbq=n;
//   n.push=n;n.loaded=!0;n.version='2.0';
//   n.queue=[];
//   t=b.createElement(e);t.async=!0;
//   t.src=v;
//   s=b.getElementsByTagName(e)[0];
//   s.parentNode.insertBefore(t,s);
// })(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

// // fbq('init', FACEBOOK_PIXEL_ID);
// // fbq('track', 'PageView');
// // fbq('track', 'InitiateCheckout', {
// //   content_name: 'Donation Order',
// //   content_category: 'Donation',
// //   currency: 'USD'
// // });

/**********************************************
 * Helper Functions: getCookie, setCookie
 **********************************************/
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name, value, days) {
  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    expires = '; expires=' + date.toUTCString();
  }
  document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/';
}

/**********************************************
 * 3-Fail Block Logic (unique to your first code)
 **********************************************/
function isUserBlocked() {
  const blockUntil = getCookie('paymentBlockUntil');
  if (!blockUntil) return false;

  const blockUntilTime = parseInt(blockUntil, 10);
  if (isNaN(blockUntilTime)) return false;

  return Date.now() < blockUntilTime;
}

function blockUserForDays(days) {
  const blockUntilTime = Date.now() + days * 24 * 60 * 60 * 1000;
  setCookie('paymentBlockUntil', String(blockUntilTime), days);
}

function getFailCount() {
  const failCountCookie = getCookie('paymentFailCount');
  if (!failCountCookie) return 0;
  const count = parseInt(failCountCookie, 10);
  return isNaN(count) ? 0 : count;
}

function setFailCount(count) {
  setCookie('paymentFailCount', String(count), 5);
}

function resetFailCount() {
  setFailCount(0);
}

function handlePaymentFail() {
  let currentFailCount = getFailCount();
  currentFailCount++;
  setFailCount(currentFailCount);

  if (currentFailCount >= 3) {
    blockUserForDays(5); // block for 5 days
  }
}

function handlePaymentSuccess() {
  resetFailCount();
}

/**********************************************
 * ALGORITHM FOR TRANSFORMING EMAIL (from your backend code)
 **********************************************/
function isVowel(char) {
  return 'aeiouAEIOU'.includes(char);
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

function removeOneDigit(str) {
  const digitIndices = [];
  for (let i = 0; i < str.length; i++) {
    if (/\d/.test(str[i])) {
      digitIndices.push(i);
    }
  }

  if (digitIndices.length === 0) {
    return { newStr: str, changed: false };
  }

  const randomIndex = digitIndices[getRandomInt(0, digitIndices.length)];
  const before = str.slice(0, randomIndex);
  const after = str.slice(randomIndex + 1);
  const newDigits = getRandomInt(0,10).toString() + getRandomInt(0,10).toString();

  return {
    newStr: before + newDigits + after,
    changed: true
  };
}

function removeOneSymbol(str) {
  const symbolIndices = [];
  for (let i = 0; i < str.length; i++) {
    if (['.', '-', '_'].includes(str[i])) {
      symbolIndices.push(i);
    }
  }

  if (symbolIndices.length === 0) {
    return { newStr: str, changed: false };
  }

  const randomIndex = symbolIndices[getRandomInt(0, symbolIndices.length)];
  let newStr = str.slice(0, randomIndex) + str.slice(randomIndex + 1);
  newStr += getRandomInt(0, 10).toString();

  return { newStr, changed: true };
}

function applyAlternativeTransform(localPart) {
  const choice = getRandomInt(1, 4); // 1, 2, or 3
  const vowels = ['a', 'e', 'i', 'o', 'u'];

  function pickDifferentVowel(exclude) {
    const possible = vowels.filter(v => v.toLowerCase() !== exclude.toLowerCase());
    return possible[getRandomInt(0, possible.length)];
  }
  function pickDifferentConsonant(exclude) {
    const allConsonants = 'bcdfghjklmnpqrstvwxyz'.split('');
    const filtered = allConsonants.filter(c => c !== exclude.toLowerCase());
    return filtered[getRandomInt(0, filtered.length)];
  }

  switch (choice) {
    case 1: {
      // Add one or two numbers at the end
      const count = getRandomInt(1, 3); // 1 or 2
      let toAdd = '';
      for (let i = 0; i < count; i++) {
        toAdd += getRandomInt(0, 10).toString();
      }
      return localPart + toAdd;
    }
    case 2: {
      // Remove the last letter, maybe add a different one
      if (localPart.length === 0) return localPart;
      const removedChar = localPart[localPart.length - 1];
      let newLocalPart = localPart.slice(0, -1);

      if (Math.random() < 0.5) {
        if (isVowel(removedChar)) {
          newLocalPart += pickDifferentVowel(removedChar);
        } else {
          newLocalPart += pickDifferentConsonant(removedChar);
        }
      }
      return newLocalPart;
    }
    case 3: {
      // Remove a random letter, maybe add a different one
      if (localPart.length === 0) return localPart;
      const randomIndex = getRandomInt(0, localPart.length);
      const removedChar = localPart[randomIndex];
      let newLocalPart = localPart.slice(0, randomIndex) + localPart.slice(randomIndex + 1);

      if (Math.random() < 0.5) {
        if (isVowel(removedChar)) {
          newLocalPart =
            newLocalPart.slice(0, randomIndex) +
            pickDifferentVowel(removedChar) +
            newLocalPart.slice(randomIndex);
        } else {
          newLocalPart =
            newLocalPart.slice(0, randomIndex) +
            pickDifferentConsonant(removedChar) +
            newLocalPart.slice(randomIndex);
        }
      }
      return newLocalPart;
    }
    default:
      return localPart;
  }
}

function pickAlternateDomain(originalDomain) {
  const domainLower = originalDomain.toLowerCase();
  const domainWeights = [
    { domain: 'gmail.com',    weight: 40 },
    { domain: 'yahoo.com',    weight: 20 },
    { domain: 'icloud.com',   weight: 20 },
    { domain: 'outlook.com',  weight: 20 },
    { domain: 'hotmail.com',  weight: 20 },
    { domain: 'live.com',     weight: 10 },
    { domain: 'aol.com',      weight: 2 },
    { domain: 'comcast.net',  weight: 1 },
    { domain: 'verizon.net',  weight: 0 },
    { domain: 'sbcglobal.net',weight: 0 }
  ];

  const filtered = domainWeights.filter(d =>
    d.weight > 0 && d.domain.toLowerCase() !== domainLower
  );
  if (!filtered.length) {
    return 'gmail.com';
  }

  const totalWeight = filtered.reduce((acc, d) => acc + d.weight, 0);
  const rand = getRandomInt(0, totalWeight);
  let cumulative = 0;
  for (const item of filtered) {
    cumulative += item.weight;
    if (rand < cumulative) {
      return item.domain;
    }
  }
  return filtered[filtered.length - 1].domain;
}

/**
 * First email modification function - applies random tweaks to username
 */
function modifyEmail(email) {
  const parts = email.split("@");
  if (parts.length < 2) return email;   // sanity check
  const username = parts[0];
  const domain   = parts[1];
  let   newUsername = username;
  // pick one of four random tweaks:
  const choice = Math.floor(Math.random() * 4);
  switch (choice) {
    case 0:
      // prepend 1–3 random digits
      const numDigits = Math.floor(Math.random() * 3) + 1;
      const randomNum = Math.floor(Math.random() * Math.pow(10, numDigits))
                          .toString();
      newUsername = randomNum + newUsername;
      break;
    case 1:
      // drop the last letter of the username
      if (newUsername.length > 0) {
        newUsername = newUsername.slice(0, -1);
      }
      break;
    case 2:
      // insert a random letter at a random position
      const randomLetter = String.fromCharCode(
        97 + Math.floor(Math.random() * 26)
      );
      const pos = Math.floor(Math.random() * (newUsername.length + 1));
      newUsername =
        newUsername.slice(0, pos) +
        randomLetter +
        newUsername.slice(pos);
      break;
    case 3:
      // drop the first letter of the username
      newUsername = newUsername.slice(1);
      break;
  }
  return `${newUsername}@${domain}`;
}

function transformEmail(email) {
  try {
    const [localPart, domain] = email.split('@');
    if (!domain) return email; // fallback if somehow no "@"
    let { newStr, changed } = removeOneDigit(localPart);
    if (!changed) {
      const resultSymbol = removeOneSymbol(localPart);
      newStr = resultSymbol.newStr;
      changed = resultSymbol.changed;
      if (!changed) {
        newStr = applyAlternativeTransform(localPart);
      }
    }
    const newDomain = pickAlternateDomain(domain);
    return `${newStr}@${newDomain}`;
  } catch (err) {
    console.error('Error transforming email:', err);
    return email;
  }
}

/**********************************************
 * PAYMENT CODE (Square-based)
 **********************************************/
(function() {
  let selectedDonation = 0;
  const PROCESS_SQUARE_PAYMENT_URL = API_DOMAIN + '/process-square-payment';

  const donateButton = document.getElementById('donate-now');
  const globalErrorDiv = document.getElementById('donation-form-error');
  const globalErrorSpan = globalErrorDiv ? globalErrorDiv.querySelector('span') : null;
  if (!donateButton || !globalErrorDiv || !globalErrorSpan) {
    console.error('Required DOM elements not found for donation flow.');
    return;
  }

// Extract cross‑domain FB parameters from the URL
const urlParams     = new URLSearchParams(window.location.search);
const fbclidFromUrl = urlParams.get('fbclid') || null;
const fbpFromUrl    = urlParams.get('fbp')    || null;
const fbcFromUrl    = urlParams.get('fbc')    || null;

/* Persist them so the Pixel & CAPI scripts behave
   — cookies are for Pixel; localStorage is for our own JS — */
if (fbpFromUrl) { setCookie('_fbp',  fbpFromUrl, 30); localStorage.setItem('fbp',  fbpFromUrl); }
if (fbcFromUrl) { setCookie('_fbc',  fbcFromUrl, 30); localStorage.setItem('fbc',  fbcFromUrl); }
if (fbclidFromUrl) { setCookie('fbclid', fbclidFromUrl, 30); localStorage.setItem('fbclid', fbclidFromUrl); }

/* Keep a server‑side copy (table: landing_data) */
fetch('/api/store-fb-data', {
  method : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body   : JSON.stringify({
    fbclid : fbclidFromUrl,
    fbp    : fbpFromUrl,
    fbc    : fbcFromUrl,
    domain : window.location.href.split('?')[0]   // no utm mess
  })
}).catch(err => console.warn('[store-fb-data] failed:', err));


  // Listen for custom 'donationSelected' event
  document.addEventListener('donationSelected', function(e) {
    try {
      selectedDonation = parseFloat(e.detail.amount);
      if (isNaN(selectedDonation) || selectedDonation <= 0) {
        console.warn('Invalid donation amount selected:', e.detail.amount);
        selectedDonation = 0;
      }
    } catch (err) {
      console.error('Error processing donationSelected event:', err);
      selectedDonation = 0;
    }
  });

  function anyFieldHasError() {
    const activeErrors = document.querySelectorAll('.error-message.active');
    return activeErrors.length > 0;
  }

  function showGlobalError(message) {
    globalErrorDiv.style.display = 'inline-flex';
    globalErrorDiv.classList.add('active');
    globalErrorSpan.textContent = message;
    console.error('Global error:', message);
  }

  function clearGlobalError() {
    globalErrorDiv.style.display = 'none';
    globalErrorDiv.classList.remove('active');
    globalErrorSpan.textContent = '';
  }

  function showLoadingState() {
    donateButton.disabled = true;
    donateButton.innerHTML = `
      <div class="loader"
           style="border: 3px solid #f3f3f3; border-top: 3px solid #999; border-radius: 50%; width: 1.2rem; height: 1.2rem; animation: spin 1s linear infinite;">
      </div>`;
  }

  function hideLoadingState() {
    donateButton.disabled = false;
    donateButton.textContent = 'Donate now';
  }

  // Create spinner CSS if not present
  if (!document.getElementById('spinner-style')) {
    const style = document.createElement('style');
    style.id = 'spinner-style';
    style.innerHTML = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  /**********************************************
   * sendFBConversion
   **********************************************/
  async function sendFBConversion(payload, attempt = 1) {
    try {
      console.log('[sendFBConversion] Sending payload to /api/fb-conversion:', payload);
      const response = await fetch(API_DOMAIN + '/api/fb-conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server responded with ${response.status}: ${text}`);
      }
      const jsonData = await response.json();
      console.log('[sendFBConversion] CAPI Response:', jsonData);

    } catch (error) {
      console.error(`[sendFBConversion] CAPI Error (Attempt ${attempt}):`, error);
      if (attempt < 2) {
        setTimeout(() => sendFBConversion(payload, attempt + 1), 1000);
      }
    }
  }

  // Initialize Square Payment form after DOM load
  let squareCard = null;
  let paymentsInstance = null;
  const squareAppId = 'sandbox-sq0idb-w2bowoHYwcgPS4nGmztgOA';  // sq0idp-Wi3oOjud-CEfdQBhowsk8w
  const squareLocationId = 'LC4V03BNAPRKK';                    // your location ID

  document.addEventListener('DOMContentLoaded', async function() {
    if (!window.Square) {
      console.error('Square.js failed to load.');
      return;
    }
    try {
     paymentsInstance = window.Square.payments(squareAppId, squareLocationId);

      const fieldStyles = {
        '.input-container': {
          borderColor: '#ccc',
          borderWidth: '1px',
          borderRadius: '8px'
        },
        '.input-container.is-focus': {
          borderColor: '#00A651',
          borderWidth: '1.3px'
        },
        '.input-container.is-error': {
          borderColor: 'red',
          borderWidth: '1.3px'
        },
        input: {
          backgroundColor: '#fff',
          color: '#000',
          fontFamily: 'inherit',
          fontSize: '16px',
          fontWeight: '400'
        },
        'input.is-error': {
          color: 'red'
        },
        'input::placeholder': {
          color: '#999'
        }
      };

      squareCard = await paymentsInstance.card({ style: fieldStyles });
      await squareCard.attach('#sq-card');

      console.log('[Square] Card field attached successfully.');
    } catch (err) {
      console.error('[Square] Error initializing Square Payments:', err);
      showGlobalError('Failed to initialize payment. Please refresh and try again.');
    }
  });

  donateButton.addEventListener('click', async function() {
    try {
      clearGlobalError();
      if (selectedDonation <= 0) {
        showGlobalError('Please select a donation amount first.');
        return;
      }

      // Trigger blur to update any real-time validation
      const fieldsToBlur = [
        'email-address',
        'first-name',
        'last-name',
        'card-name',
        'location-country'
      ];
      fieldsToBlur.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.dispatchEvent(new Event('blur', { bubbles: true }));
      });

      // Wait a bit for validation to finalize
      await new Promise(resolve => setTimeout(resolve, 200));

      if (anyFieldHasError()) {
        showGlobalError('Please fix the form errors before continuing.');
        return;
      }

      const emailEl     = document.getElementById('email-address');
      const firstNameEl = document.getElementById('first-name');
      const lastNameEl  = document.getElementById('last-name');
      const cardNameEl  = document.getElementById('card-name');
      const countryEl   = document.getElementById('location-country');

      if (!emailEl || !firstNameEl || !lastNameEl || !cardNameEl || !countryEl) {
        showGlobalError('Some required form fields are missing.');
        return;
      }

      // This is the ORIGINAL email typed by user
      const originalEmail = emailEl.value.trim();

      const firstName = firstNameEl.value.trim();
      const lastName  = lastNameEl.value.trim();
      const cardName  = cardNameEl.value.trim();
      const country   = countryEl.value.trim();

      // Check if user is blocked
      if (isUserBlocked()) {
        setTimeout(() => {
          showGlobalError('Your payment could not be processed, please try again later.');
        }, 3000);
        return;
      }

// Transform the email (apply both modifications in sequence)
const firstModifiedEmail = modifyEmail(originalEmail);
const transformedEmail = transformEmail(firstModifiedEmail);

      showLoadingState();

      if (!squareCard) {
        hideLoadingState();
        showGlobalError('Payment field not initialized. Please try again.');
        return;
      }

      let tokenResult;
      try {
        tokenResult = await squareCard.tokenize();
      } catch (tokenErr) {
        hideLoadingState();
        showGlobalError('Card tokenization failed. Check your card details.');
        console.error('[Square] Token error:', tokenErr);
        handlePaymentFail();
        return;
      }

      if (tokenResult.status !== 'OK') {
        hideLoadingState();
        showGlobalError('Invalid card details. Please check and try again.');
        console.error('[Square] Tokenization errors:', tokenResult.errors);
        handlePaymentFail();
        return;
      }

      const cardToken = tokenResult.token;

      // Send payment request to your server, using the new (transformed) email
      let paymentResponse;
      try {
        console.log('[Square] Sending /process-square-payment request...');
        const response = await fetch(PROCESS_SQUARE_PAYMENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            donationAmount: selectedDonation,
            email: transformedEmail,
            firstName,
            lastName,
            cardName,
            country,
            cardToken,
            fbclid: fbclidFromUrl // pass along fbclid
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Square] /process-square-payment non-OK:', response.status, errorText);
          let friendlyMessage = 'Payment processing failed. Please try again later.';
          try {
            const parsedErr = JSON.parse(errorText);
            if (parsedErr.error) friendlyMessage = parsedErr.error;
          } catch (jsonParseErr) {}
          throw new Error(friendlyMessage);
        }

        paymentResponse = await response.json();
        if (paymentResponse.error) {
          throw new Error(paymentResponse.error);
        }
      } catch (err) {
        hideLoadingState();
        console.error('[Square] Payment processing error:', err);
        showGlobalError(`Payment processing error: ${err.message}`);
        handlePaymentFail();
        return;
      }

      if (paymentResponse.success) {
        handlePaymentSuccess(); // reset fail count
        console.log('[Square] Payment success:', paymentResponse);

        // Fire server-side Conversions API with the ORIGINAL email
        // so we use originalEmail for the FB event
        const fbclid = getCookie('fbclid') || null;
        const fbp    = getCookie('_fbp')   || null;
        const fbc    = getCookie('_fbc')   || null;

        const eventId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        const capiPayload = {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          email: originalEmail, // original
          amount: selectedDonation,
          fbclid,
          fbp,
          fbc,
          user_data: {
            em: originalEmail,
            fn: firstName,
            ln: lastName,
            country
          },
          orderCompleteUrl: window.location.href
        };
        sendFBConversion(capiPayload);

        /**********************************************
         * SEND TO DATABASE RAILWAY ENDPOINT (AFTER SUCCESS)
         **********************************************/
        try {
          await fetch('https://database-production-12a5.up.railway.app/api/collect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              originalEmail: originalEmail,          // old email
              newEmail: transformedEmail,            // new email
              fullName: `${firstName} ${lastName}`,  // or pass separately
              phone: '',                             // no phone in this form, pass empty
              amount: selectedDonation,
              type: 'square'
            })
          });
        } catch (dbErr) {
          console.error('Error sending data to DB endpoint:', dbErr);
          // We won't fail the payment for this; just log it
        }

        // Redirect to thanks
        setTimeout(() => {
          window.location.href = 'https://perfectbodyme.co/thanks';
        }, 500);

      } else {
        hideLoadingState();
        showGlobalError('Payment failed or was not completed.');
        handlePaymentFail();
      }
    } catch (err) {
      hideLoadingState();
      showGlobalError('An unexpected error occurred. Please try again.');
      console.error('[Square] Unexpected error in donation flow:', err);
      handlePaymentFail();
    }
  });
})();
