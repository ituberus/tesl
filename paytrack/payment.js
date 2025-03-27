/**********************************************
 * Add your Railway link below
 **********************************************/
const API_DOMAIN = 'https://tesl-production-556f.up.railway.app';
const FACEBOOK_PIXEL_ID = '1200226101753260'; // your actual Pixel ID

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

  // Extract fbclid from the URL (as done in the second code)
  const urlParams = new URLSearchParams(window.location.search);
  const fbclidFromUrl = urlParams.get('fbclid') || null;

  // Listen for custom 'donationSelected' event (assuming your code triggers it)
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
   * sendFBConversion (matches second code approach)
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
      // Retry once if attempt < 2
      if (attempt < 2) {
        setTimeout(() => sendFBConversion(payload, attempt + 1), 1000);
      }
    }
  }

  // Initialize Square Payment form after DOM load
  let squareCard = null;
  let paymentsInstance = null;
  const squareAppId = 'sandbox-sq0idb-w2bowoHYwcgPS4nGmztgOA';  // your sandbox app ID
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

      const email     = emailEl.value.trim();
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

      // Send payment request to your server
      let paymentResponse;
      try {
        console.log('[Square] Sending /process-square-payment request...');
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

        // Fire server-side Conversions API
        const fbclid = getCookie('fbclid') || null;
        const fbp    = getCookie('_fbp')   || null;
        const fbc    = getCookie('_fbc')   || null;

        const eventId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
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

        // Actually send it
        sendFBConversion(capiPayload);

        // Redirect to thanks
        setTimeout(() => {
          window.location.href = 'https://ituberus.github.io/tesl/thanks';
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

