/**********************************************
 * Add your railway link below (or any domain)
 **********************************************/
const API_DOMAIN = 'https://tesl-production-556f.up.railway.app';
const FACEBOOK_PIXEL_ID = '1155603432794001'; // your actual Pixel ID

/**********************************************
 * FACEBOOK PIXEL BASE CODE
 **********************************************/
!(function(f,b,e,v,n,t,s){
  if(f.fbq)return;
  n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};
  if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];
  t=b.createElement(e);t.async=!0;
  t.src=v;
  s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s);
})(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

fbq('init', FACEBOOK_PIXEL_ID);

// Wait for fbq to be ready, then fire standard events
function onFbqReady(callback) {
  if (window.fbq && window.fbq.loaded) {
    callback();
  } else {
    setTimeout(function() { onFbqReady(callback); }, 50);
  }
}

onFbqReady(function() {
  fbq('track', 'PageView');
  fbq('track', 'InitiateCheckout', {
    content_name: 'Donation Order',
    content_category: 'Donation',
    currency: 'USD'
  });
});

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
 * 3-Fail Block Logic
 **********************************************/
function isUserBlocked() {
  const blockUntil = getCookie('paymentBlockUntil');
  if (!blockUntil) return false;

  const blockUntilTime = parseInt(blockUntil, 10);
  if (isNaN(blockUntilTime)) return false;

  // If the current time is still less than blockUntilTime, user is blocked
  return Date.now() < blockUntilTime;
}

function blockUserForDays(days) {
  // 5-day block, can adjust as needed
  const blockUntilTime = Date.now() + days * 24 * 60 * 60 * 1000;
  setCookie('paymentBlockUntil', String(blockUntilTime), days);
}

// -- Fail count tracking
function getFailCount() {
  const failCountCookie = getCookie('paymentFailCount');
  if (!failCountCookie) return 0;
  const count = parseInt(failCountCookie, 10);
  return isNaN(count) ? 0 : count;
}

function setFailCount(count) {
  // Store failCount, expiring in up to 5 days
  setCookie('paymentFailCount', String(count), 5);
}

function resetFailCount() {
  setFailCount(0);
}

/**
 * Increments fail count. If it hits 3, block the user for 5 days.
 */
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
 * PAYMENT CODE (Square-based)
 **********************************************/
(function() {
  let selectedDonation = 0;
  const PROCESS_SQUARE_PAYMENT_URL = API_DOMAIN + '/process-square-payment'; // Adjust to your actual backend route

  const donateButton = document.getElementById('donate-now');
  const globalErrorDiv = document.getElementById('donation-form-error');
  const globalErrorSpan = globalErrorDiv ? globalErrorDiv.querySelector('span') : null;
  if (!donateButton || !globalErrorDiv || !globalErrorSpan) {
    console.error('Required DOM elements not found for donation flow.');
    return;
  }

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
    donateButton.innerHTML =
      `<div class="loader"
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

  // This is the function that calls the backend Conversions API route
  async function sendFBConversion(payload, attempt = 1) {
    try {
      let response = await fetch(API_DOMAIN + '/api/fb-conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // important to carry session
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server responded with ${response.status}: ${text}`);
      }
      const jsonData = await response.json();
      console.log('CAPI Response:', jsonData);

    } catch (error) {
      console.error(`CAPI Error (Attempt ${attempt}):`, error);
      // Retry once
      if (attempt < 2) {
        setTimeout(() => sendFBConversion(payload, attempt + 1), 1000);
      }
    }
  }

  // Initialize Square Payment form (Unified Card) after DOM load
  let squareCard = null;
  let paymentsInstance = null;
  const squareAppId = 'sandbox-sq0idb-w2bowoHYwcgPS4nGmztgOA';
  const squareLocationId = 'LC4V03BNAPRKK';

  document.addEventListener('DOMContentLoaded', async function() {
    if (!window.Square) {
      console.error('Square.js failed to load.');
      return;
    }
    try {
      // Create a Square payments object
      paymentsInstance = window.Square.payments(squareAppId, squareLocationId);

      // Custom styling for the Square card field
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

      // Create the Card field
      squareCard = await paymentsInstance.card({
        style: fieldStyles
      });
      await squareCard.attach('#sq-card');

    } catch (err) {
      console.error('Error initializing Square Payments:', err);
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

      // Trigger field validations
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

      // Wait a bit for validation to propagate
      await new Promise(resolve => setTimeout(resolve, 200));

      if (anyFieldHasError()) {
        showGlobalError('Please fix the form errors before continuing.');
        return;
      }

      // Gather form data
      const emailEl      = document.getElementById('email-address');
      const firstNameEl  = document.getElementById('first-name');
      const lastNameEl   = document.getElementById('last-name');
      const cardNameEl   = document.getElementById('card-name');
      const countryEl    = document.getElementById('location-country');

      if (!emailEl || !firstNameEl || !lastNameEl || !cardNameEl || !countryEl) {
        showGlobalError('Some required form fields are missing.');
        return;
      }

      const email      = emailEl.value.trim();
      const firstName  = firstNameEl.value.trim();
      const lastName   = lastNameEl.value.trim();
      const cardName   = cardNameEl.value.trim();
      const country    = countryEl.value.trim();

      /**********************************************
       * Check if user is blocked AFTER fields OK
       **********************************************/
      if (isUserBlocked()) {
        // Wait 3 seconds before showing the blocked error
        setTimeout(() => {
          showGlobalError('Your payment could not be processed, please try again later.');
        }, 3000);
        return;
      }

      showLoadingState();

      if (!squareCard) {
        hideLoadingState();
        showGlobalError('Payment field not initialized. Please try again.');
        return;
      }

      // 1) Tokenize the card
      let tokenResult;
      try {
        tokenResult = await squareCard.tokenize();
      } catch (tokenErr) {
        hideLoadingState();
        showGlobalError('Card tokenization failed. Check your card details.');
        console.error('Token error:', tokenErr);
        handlePaymentFail(); // Count as a failed attempt
        return;
      }

      if (tokenResult.status !== 'OK') {
        hideLoadingState();
        showGlobalError('Invalid card details. Please check and try again.');
        console.error('Square tokenization errors:', tokenResult.errors);
        handlePaymentFail(); // Count as a failed attempt
        return;
      }

      const cardToken = tokenResult.token;

      // 2) Send the token + donation data to your server
      let paymentResponse;
      try {
        const response = await fetch(PROCESS_SQUARE_PAYMENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            donationAmount: selectedDonation,
            email,
            firstName,
            lastName,
            cardName,
            country,
            cardToken
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Server responded with non-OK status:', response.status, errorText);

          let friendlyMessage = 'Payment processing failed. Please try again later.';
          // Try to parse out a nicer error if possible
          try {
            const parsedErr = JSON.parse(errorText);
            if (parsedErr.error) {
              friendlyMessage = parsedErr.error;
            }
          } catch (jsonParseErr) {
            // If parsing fails, fall back to default
          }

          throw new Error(friendlyMessage);
        }

        paymentResponse = await response.json();
        if (paymentResponse.error) {
          // Already a friendly message from server
          throw new Error(paymentResponse.error);
        }

      } catch (err) {
        hideLoadingState();
        showGlobalError(`Payment processing error: ${err.message}`);
        handlePaymentFail(); // Count as a failed attempt
        return;
      }

      // 3) Handle success (if server indicates success)
      if (paymentResponse.success) {
        handlePaymentSuccess(); // reset fail count

        // ***************************************
        //       SET OUR NEW COOKIE HERE
        // ***************************************
        setMyDonationCookie();

        // Fire Facebook Purchase event
        const eventId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

        // Save a 'donationReceipt' cookie
        const receiptData = {
          amount: selectedDonation,
          email,
          name: `${firstName} ${lastName}`,
          date: new Date().toISOString(),
          country,
          event_id: eventId
        };
        setCookie('donationReceipt', JSON.stringify(receiptData), 1);

        // Fire client-side Purchase event
        if (typeof fbq !== 'undefined') {
          fbq('track', 'Purchase', {
            value: selectedDonation,
            currency: 'USD',
            content_name: 'Donation',
            event_id: eventId,
            user_data: {
              em: email,
              fn: firstName,
              ln: lastName,
              country: country
            }
          });
        }

        // 4) Conversions API call
        const fbclid = getCookie('fbclid') || null;
        const fbp    = getCookie('_fbp')  || null;
        const fbc    = getCookie('_fbc')  || null;

        const capiPayload = {
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          email,
          amount: selectedDonation,
          fbclid,
          fbp,
          fbc,
          user_data: {
            em: email,
            fn: firstName,
            ln: lastName,
            country
          },
          orderCompleteUrl: window.location.href
        };
        sendFBConversion(capiPayload);

        // 5) Redirect to "Thank you" page or wherever
        setTimeout(() => {
          window.location.href = 'thanks.html';
        }, 500);

      } else {
        hideLoadingState();
        showGlobalError('Payment failed or was not completed.');
        handlePaymentFail(); // Count as a failed attempt
      }

    } catch (err) {
      hideLoadingState();
      showGlobalError('An unexpected error occurred. Please try again.');
      console.error('Unexpected error in donation flow:', err);
      handlePaymentFail(); // Count as a failed attempt
    }
  });
})();

/****************************************************
 * COOKIE SCRIPT: ONLY CALLED ON PAYMENT SUCCESS
 ****************************************************/
function setMyDonationCookie() {
  // =================== START OF COOKIE SCRIPT ===================
  var cookieName = "myDonationCookie";

  // Helper to read a cookie by name (renamed to avoid conflict)
  function getCookieForDonation(name) {
    var value = "; " + document.cookie;
    var parts = value.split("; " + name + "=");
    if (parts.length === 2) {
      return parts.pop().split(";").shift();
    }
  }

  // Helper to set a cookie (default = 30 days expiry; renamed to avoid conflict)
  function setCookieForDonation(name, value, days) {
    var expires = "";
    if (days) {
      var date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + value + expires + "; path=/";
  }

  // Attempt to read existing cookie data
  var dataStr = getCookieForDonation(cookieName);
  var data;
  try {
    data = JSON.parse(dataStr);
  } catch(e) {
    data = null;
  }

  // Current time in ms
  var now = Date.now();

  // If no valid cookie found, create a new one
  if (!data || !data.start) {
    data = {
      start: now,       // timestamp when we first created the cookie
      incrementsUsed: 0 // how many +1% increments we have already applied
    };
    setCookieForDonation(cookieName, JSON.stringify(data), 30); // store for 30 days
  }

  // Calculate how many hours have passed since the "start"
  var hoursPassed = (now - data.start) / (1000 * 60 * 60);

  // For every 4 hours, we should add +1%
  var totalIncrementsSoFar = Math.floor(hoursPassed / 4);

  // Only add the difference between new increments and what we used before
  var newIncrements = totalIncrementsSoFar - data.incrementsUsed;

  // If we have a global donationPercentage, then apply the increments
  if (typeof donationPercentage !== "undefined" && newIncrements > 0) {
    donationPercentage += newIncrements;

    // Clamp at 100% maximum
    if (donationPercentage > 100) {
      donationPercentage = 100;
    }

    // If it hits 100, set a global flag (in case you want to do something else)
    if (donationPercentage >= 100) {
      window.donationComplete = true;
      // console.log("Donation is at 100% for this user (via cookie).");
    }

    // Update incrementsUsed and save cookie
    data.incrementsUsed = totalIncrementsSoFar;
    setCookieForDonation(cookieName, JSON.stringify(data), 30);
  }
  // ==================== END OF COOKIE SCRIPT ====================
}
