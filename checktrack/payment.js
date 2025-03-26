/**********************************************
 * Add your railway link below
 **********************************************/
const API_DOMAIN = 'https://tesl-production-523c.up.railway.app';
const FACEBOOK_PIXEL_ID = '1155603432794001'; // your actual Pixel ID

/**********************************************
 * Helper Functions: getQueryParam
 **********************************************/
function getQueryParam(param) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(param);
}

/**********************************************
 * PAYMENT CODE
 **********************************************/
(async function() {
  let selectedDonation = 0;
  const CREATE_PAYMENT_INTENT_URL = API_DOMAIN + '/create-payment-intent';

  const donateButton = document.getElementById('donate-now');
  const globalErrorDiv = document.getElementById('donation-form-error');
  const globalErrorSpan = globalErrorDiv ? globalErrorDiv.querySelector('span') : null;
  if (!donateButton || !globalErrorDiv || !globalErrorSpan) {
    console.error('Required DOM elements not found.');
    return;
  }

  // Collect fbclid from URL
  const fbclid = getQueryParam('fbclid') || null;

  // Send fbclid to backend to store in database
  if (fbclid) {
    try {
      const landingPageUrl = window.location.href.split('?')[0]; // Remove query parameters
      const response = await fetch(API_DOMAIN + '/api/store-fb-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fbclid: fbclid,
          landing_page_url: landingPageUrl
        })
      });
      const data = await response.json();
      console.log('Stored FB data:', data);
    } catch (err) {
      console.error('Failed to store FB data:', err.message);
    }
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
          // Remove any code that sets cookies

          // ------------------------------------------
          // CALL OUR DONATION-COOKIE FUNCTION HERE (if any)
          // ------------------------------------------

          // 4) Call your Conversions API route
          const capiPayload = {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            email,
            amount: selectedDonation,
            fbclid: fbclid,
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
      }
    } catch (err) {
      hideLoadingState();
      showGlobalError('An unexpected error occurred. Please try again.');
      console.error('Unexpected error in donation flow:', err);
    }
  });
})();
