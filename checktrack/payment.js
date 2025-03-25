<script>
/**********************************************
 * Add your railway link below
 **********************************************/
const API_DOMAIN = 'https://tesl-production-523c.up.railway.app';
const FACEBOOK_PIXEL_ID = '1155603432794001'; // your actual Pixel ID

/**********************************************
 * FACEBOOK PIXEL BASE CODE
 **********************************************/
!function(f,b,e,v,n,t,s){
  if(f.fbq)return;
  n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];
  t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s);
}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

// Initialize pixel
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
 * Cookie script: only called on successful payment
 **********************************************/
function setDonationCookieOnce() {
  // =================== START OF COOKIE SCRIPT ===================
  (function() {
    // Name of the cookie to use
    var cookieName = "myDonationCookie";

    // Helper to read a cookie by name
    function localGetCookie(name) {
      var value = "; " + document.cookie;
      var parts = value.split("; " + name + "=");
      if (parts.length === 2) {
        return parts.pop().split(";").shift();
      }
    }

    // Helper to set a cookie (default = 30 days expiry)
    function localSetCookie(name, value, days) {
      var expires = "";
      if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      document.cookie = name + "=" + value + expires + "; path=/";
    }

    // Attempt to read existing cookie data
    var dataStr = localGetCookie(cookieName);
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
        start: now,           // timestamp when we first created the cookie
        incrementsUsed: 0     // how many +1% increments we have already applied
      };
      localSetCookie(cookieName, JSON.stringify(data), 30); // store for 30 days
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
      }

      // Update incrementsUsed and save cookie
      data.incrementsUsed = totalIncrementsSoFar;
      localSetCookie(cookieName, JSON.stringify(data), 30);
    }
  })();
  // ==================== END OF COOKIE SCRIPT ====================
}

/**********************************************
 * PAYMENT CODE
 **********************************************/
(function() {
  let selectedDonation = 0;
  const CREATE_PAYMENT_INTENT_URL = API_DOMAIN + '/create-payment-intent';

  const donateButton = document.getElementById('donate-now');
  const globalErrorDiv = document.getElementById('donation-form-error');
  const globalErrorSpan = globalErrorDiv ? globalErrorDiv.querySelector('span') : null;
  if (!donateButton || !globalErrorDiv || !globalErrorSpan) {
    console.error('Required DOM elements not found.');
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

  /**********************************************
   * ***** NEW BLOCK FEATURE *****
   * We track consecutive failures and block user
   * after 3 consecutive failures for 5 days.
   **********************************************/

  // Use existing getCookie / setCookie from above

  function getAttemptCount() {
    const data = getCookie('paymentAttemptsCookie');
    if (data) {
      try {
        return parseInt(data, 10) || 0;
      } catch (e) {
        return 0;
      }
    }
    return 0;
  }

  function setAttemptCount(count) {
    // store attempt count for 30 days just to be safe
    setCookie('paymentAttemptsCookie', count.toString(), 30);
  }

  function resetAttemptCount() {
    setAttemptCount(0);
  }

  function isUserBlocked() {
    // if cookie doesn't exist, not blocked
    const blockData = getCookie('paymentBlockCookie');
    if (!blockData) return false;

    // blockData = { blockUntil: <timestamp in ms> }
    try {
      const parsed = JSON.parse(blockData);
      const now = Date.now();
      if (now < parsed.blockUntil) {
        // still blocked
        return true;
      } else {
        // block has expired, remove the cookie
        setCookie('paymentBlockCookie', '', -1);
        return false;
      }
    } catch (err) {
      // if parse fails, remove invalid cookie
      setCookie('paymentBlockCookie', '', -1);
      return false;
    }
  }

  function blockUserFor5Days() {
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    const blockUntil = Date.now() + fiveDaysMs;
    const data = { blockUntil };
    setCookie('paymentBlockCookie', JSON.stringify(data), 5);
  }
  // ***** END OF NEW BLOCK FEATURE *****

  donateButton.addEventListener('click', async function() {
    try {
      clearGlobalError();

      // ***** NEW BLOCK FEATURE: check if user is blocked *****
      if (isUserBlocked()) {
        showGlobalError('Your payment cannot be processed at this time. Please try again later.');
        return;
      }
      // ***** END *****

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
        'location-country',
        'location-postal-code'
      ];
      fieldsToBlur.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      const countrySelect = document.getElementById('location-country');
      if (countrySelect) {
        countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
      }

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
      const postalCodeEl = document.getElementById('location-postal-code');

      if (!emailEl || !firstNameEl || !lastNameEl || !cardNameEl || !countryEl || !postalCodeEl) {
        showGlobalError('Some required form fields are missing.');
        return;
      }

      const email      = emailEl.value.trim();
      const firstName  = firstNameEl.value.trim();
      const lastName   = lastNameEl.value.trim();
      const cardName   = cardNameEl.value.trim();
      const country    = countryEl.value.trim();
      const postalCode = postalCodeEl.value.trim();

      showLoadingState();

      // 1) Create PaymentIntent
      let clientSecret;
      try {
        const response = await fetch(CREATE_PAYMENT_INTENT_URL, {
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
            postalCode
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Server responded with status ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        if (data.error) {
          throw new Error(data.error);
        }
        clientSecret = data.clientSecret;
        if (!clientSecret) {
          throw new Error('No client secret returned from server.');
        }
      } catch (err) {
        hideLoadingState();
        showGlobalError(`Error creating PaymentIntent: ${err.message}`);
        return;
      }

      // 2) Confirm the card payment with Stripe
      if (!window.stripe || !window.cardNumberElement) {
        hideLoadingState();
        showGlobalError('Payment processing components are not available.');
        return;
      }

      try {
        const { paymentIntent, error } = await window.stripe.confirmCardPayment(clientSecret, {
          payment_method: {
            card: window.cardNumberElement,
            billing_details: {
              name: cardName,
              email: email,
              address: {
                country: country,
                postal_code: postalCode
              }
            }
          }
        });

        if (error) {
          throw new Error(error.message);
        }

        // 3) If PaymentIntent is successful
        if (paymentIntent && paymentIntent.status === 'succeeded') {

          // ***** NEW BLOCK FEATURE: Reset attempt count on success *****
          resetAttemptCount();
          // Optionally, if you want to remove block cookie immediately on success:
          // setCookie('paymentBlockCookie', '', -1);
          // ***** END *****

          // Generate unique event_id
          const eventId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

          // Save receipt cookie
          const receiptData = {
            amount: selectedDonation,
            email,
            name: `${firstName} ${lastName}`,
            date: new Date().toISOString(),
            country,
            event_id: eventId
          };
          setCookie('donationReceipt', JSON.stringify(receiptData), 1);

          // ------------------------------------------
          // CALL OUR DONATION-COOKIE FUNCTION HERE:
          setDonationCookieOnce();
          // ------------------------------------------

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
                zp: postalCode,
                country: country
              }
            });
          }

          // 4) Call your Conversions API route
          const fbclid = getCookie('fbclid') || null;
          const fbp    = getCookie('_fbp')  || null;
          const fbc    = getCookie('_fbc')  || null;

          const capiPayload = {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            email,
            amount: selectedDonation,
            fbclid: fbclid,
            fbp: fbp,
            fbc: fbc,
            user_data: {
              em: email,
              fn: firstName,
              ln: lastName,
              zp: postalCode,
              country: country
            },
            orderCompleteUrl: window.location.href
          };
          sendFBConversion(capiPayload);

          // 5) Redirect to "Thank you" page
          setTimeout(() => {
            window.location.href = 'https://ituberus.github.io/tesl/thanks';
          }, 500);

        } else {
          throw new Error('Payment failed or was not completed.');
        }
      } catch (err) {
        hideLoadingState();
        showGlobalError(`Payment error: ${err.message}`);
        console.error('Error during payment confirmation:', err);

        // ***** NEW BLOCK FEATURE: handle failures *****
        let count = getAttemptCount();
        count += 1;
        setAttemptCount(count);

        if (count >= 3) {
          // block user for 5 days
          blockUserFor5Days();
          // reset attempts
          resetAttemptCount();
        }
        // ***** END *****
      }
    } catch (err) {
      hideLoadingState();
      showGlobalError('An unexpected error occurred. Please try again.');
      console.error('Unexpected error in donation flow:', err);
    }
  });
})();
</script>
