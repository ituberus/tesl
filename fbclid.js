
(function() {
  // === 1) Constants: your two separate server endpoints ===
  const STRIPE_BASE_URL  = 'https://tesl-production-523c.up.railway.app';
  const SQUARE_BASE_URL  = 'https://tesl-production-556f.up.railway.app';
  const API_SLUG         = '/api/store-fb-data';

  // Your shared FB Pixel ID
  const FACEBOOK_PIXEL_ID = '1200226101753260';

  // === 2) Helper: read query param from URL ===
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  // === 3) Helper: set a cookie ===
  function setCookie(name, value, days) {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
  }

  // === 4) Capture fbclid from the URL and store in a cookie (30 days) ===
  const fbclid = getQueryParam('fbclid');
  if (fbclid) {
    setCookie('fbclid', fbclid, 30);
  }

  // === 5) Load FB Pixel (shared for both Stripe/Square) ===
  (function(f,b,e,v,n,t,s){
    if(f.fbq) return;
    n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};
    if(!f._fbq) f._fbq=n;
    n.push=n;
    n.loaded=true;
    n.version='2.0';
    n.queue=[];
    t=b.createElement(e);t.async=true;
    t.src=v;
    s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s);
  })(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', FACEBOOK_PIXEL_ID);

  // === 6) If fbclid is present & we have no _fbc cookie, build one with current timestamp ===
  if (fbclid && document.cookie.indexOf('_fbc=') === -1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const newFbc = `fb.1.${timestamp}.${fbclid}`;
    setCookie('_fbc', newFbc, 30);
  }

  // === 7) We also want to send the “clean domain” (URL minus query string) to the server
  const urlObj = new URL(window.location.href);
  urlObj.search = '';  // remove query params
  const domain = urlObj.href;  // e.g. https://mydomain.com/path

  // === 8) Poll for up to 1.5s for the _fbp & _fbc cookies, then send same data to both endpoints ===
  const pollInterval = 300;
  const maxWait = 1500;
  const startTime = Date.now();

  const pollHandle = setInterval(() => {
    // Check for _fbp
    const matchFbp = document.cookie.match(/(^| )_fbp=([^;]+)/);
    const fbp = matchFbp ? decodeURIComponent(matchFbp[2]) : null;

    // Check for _fbc
    const matchFbc = document.cookie.match(/(^| )_fbc=([^;]+)/);
    const fbc = matchFbc ? decodeURIComponent(matchFbc[2]) : null;

    // If we have both or time is up, send data
    if ((fbp && fbc) || (Date.now() - startTime >= maxWait)) {
      clearInterval(pollHandle);

      // Even if one is null, we’ll send them anyway.
      const payloadObj = {
        fbclid: fbclid || null,
        fbp:    fbp    || null,
        fbc:    fbc    || null,
        domain: domain || null
      };
      const payload = JSON.stringify(payloadObj);

      console.log('Sending FB data to both servers:', payloadObj);

      // 1) Send to “Stripe” server
      fetch(STRIPE_BASE_URL + API_SLUG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: payload
      })
        .then(res => res.json())
        .then(data => {
          console.log('stripe /api/store-fb-data =>', data);
        })
        .catch(err => console.error('stripe /api/store-fb-data error =>', err));

      // 2) Send to “Square” server
      fetch(SQUARE_BASE_URL + API_SLUG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: payload
      })
        .then(res => res.json())
        .then(data => {
          console.log('square /api/store-fb-data =>', data);
        })
        .catch(err => console.error('square /api/store-fb-data error =>', err));
    }

  }, pollInterval);

})();

