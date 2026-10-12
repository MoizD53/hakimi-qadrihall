/**
 * API Configuration — Dynamic Base URL
 * Seamlessly resolves same-origin API routes on Vercel and any connected custom domain,
 * with automatic fallback to port 5000 for local live-server development.
 */
const API_BASE_URL = (function () {
  if (typeof window !== 'undefined' && window.location) {
    const port = window.location.port;
    const host = window.location.hostname;
    // Local development using separate dev server (e.g. Live Server on port 5500/5501) or file://
    if (window.location.protocol === 'file:' || ((host === 'localhost' || host === '127.0.0.1') && port && port !== '5000')) {
      return 'http://localhost:5000';
    }
    // Production on Vercel, preview deployments, and custom domains over HTTPS
    return window.location.origin;
  }
  return '';
})();
