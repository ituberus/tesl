(function() {
    // === Shared Constants and Helper Functions ===
    
    // stripe: production backend endpoint
    const RAILWAY_BASE_URL_STRIPE = 'https://tesl-production-523c.up.railway.app';
    const RAILWAY_API_SLUG_STRIPE = '/api/store-fb-data';
    
    // square: local backend endpoint
    const RAILWAY_BASE_URL_SQUARE = 'https://tesl-production-556f.up.railway.app';
    const RAILWAY_API_SLUG_SQUARE = '/api/store-fb-data';
    
    // UPDATED: Use 1200226101753260
    const FACEBOOK_PIXEL_ID = '1200226101753260';
    
    /**
     * Helper: Get a query parameter from the URL
     */
    function getQueryParam(param) {
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get(param);
    }
    
    /**
     * Helper: Simple cookie setter
     */
    function setCookie(name, value, days) {
      let expires = "";
      if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
    }
    
    // === 1) Capture fbclid from the URL and store in a cookie (shared) ===
    const fbclid = getQueryParam('fbclid');
    if (fbclid) {
      setCookie('fbclid', fbclid, 30);
    }
    
    // === 2) Load Facebook Pixel (to generate _fbp if not blocked) - shared for both systems ===
    (function(f, b, e, v, n, t, s){
      if(f.fbq) return;
      n = f.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if(!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = true;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    
    // Initialize the Pixel using the shared Pixel ID
    fbq('init', FACEBOOK_PIXEL_ID);
    
    // === 3) Manually generate _fbc if fbclid is present and we don’t already have _fbc (shared) ===
    if (fbclid && document.cookie.indexOf('_fbc=') === -1) {
      const timestamp = Math.floor(Date.now() / 1000);
      // Using the exact format: fb.1.<timestamp>.<fbclid>
      const newFbc = `fb.1.${timestamp}.${fbclid}`;
      setCookie('_fbc', newFbc, 30);
    }
    
    // === 4) Poll for _fbp and _fbc for up to 1.5s, then send data to both backends ===
    const pollInterval = 300; // check every 300 ms
    const maxWait = 1500;     // total 1.5 seconds
    const startTime = Date.now();
    
    const pollHandle = setInterval(() => {
      // Check cookies
      const fbpCookieMatch = document.cookie.match(new RegExp('(^| )_fbp=([^;]+)'));
      const fbcCookieMatch = document.cookie.match(new RegExp('(^| )_fbc=([^;]+)'));
    
      const fbp = fbpCookieMatch ? decodeURIComponent(fbpCookieMatch[2]) : null;
      const fbc = fbcCookieMatch ? decodeURIComponent(fbcCookieMatch[2]) : null;
    
      // If both cookies found or we've waited long enough, send to backends
      if ((fbp && fbc) || (Date.now() - startTime >= maxWait)) {
        // ADDED: domain is the full URL
        const domain = window.location.href;
        const payload = JSON.stringify({ fbclid, fbp, fbc, domain });
    
        // stripe: Send data to production backend
        fetch(RAILWAY_BASE_URL_STRIPE + RAILWAY_API_SLUG_STRIPE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // ensures session/cookies if needed
          body: payload
        })
        .then(res => res.json())
        .then(data => {
          console.log('stripe: FB data stored in session:', data);
        })
        .catch(err => console.error('stripe: Error storing FB data:', err));
    
        // square: Send data to local backend
        fetch(RAILWAY_BASE_URL_SQUARE + RAILWAY_API_SLUG_SQUARE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // ensures session/cookies if needed
          body: payload
        })
        .then(res => res.json())
        .then(data => {
          console.log('square: FB data stored in session:', data);
        })
        .catch(err => console.error('square: Error storing FB data:', err));
    
        clearInterval(pollHandle);
      }
    }, pollInterval);
})();
