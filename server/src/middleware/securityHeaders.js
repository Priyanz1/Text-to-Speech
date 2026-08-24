import { isProduction } from '../config/env.js';

/**
 * Security headers, set by hand rather than with helmet.
 *
 * Helmet's value is mostly in its defaults for HTML applications - CSP for
 * scripts and styles, plugin policies, referrer rules for pages a browser
 * renders. This server returns JSON and audio bytes to a separate SPA, so the
 * useful subset is short enough to state explicitly, and stating it explicitly
 * means each header has a reason next to it instead of coming from a library
 * default nobody has read.
 *
 * The frontend is a separate deployment (Vercel), and ITS headers are the ones
 * that matter for script and style policy - see client/vercel.json if that ever
 * needs tightening. Nothing here can protect a page this server does not serve.
 */
export function securityHeaders(req, res, next) {
  /**
   * Never let a browser second-guess a Content-Type.
   *
   * The most concrete case here is the audio endpoint: without nosniff, a
   * response whose bytes happen to start like HTML could be sniffed as HTML and
   * rendered, and the bytes are user-supplied text turned into a file.
   */
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Nothing this API returns should ever be framed. Both headers, because
  // X-Frame-Options is what older browsers honour and CSP is what current ones do.
  res.setHeader('X-Frame-Options', 'DENY');

  /**
   * A JSON API should never cause a subresource load of any kind, so the policy
   * is "load nothing". This is not the client's CSP and does not replace it - it
   * only constrains what an API response itself could pull in if a browser were
   * ever tricked into treating one as a document.
   */
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // API URLs can carry ids in the path. no-referrer means none of them leak into
  // a third party's logs through a Referer header.
  res.setHeader('Referrer-Policy', 'no-referrer');

  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');

  /**
   * Deliberately not set: Cross-Origin-Resource-Policy.
   *
   * The client is on a different site from the API (vercel.app talking to
   * onrender.com), which is exactly the case a restrictive CORP blocks. CORS with
   * an explicit allowlist is what authorises those reads - see config/cors.js -
   * and adding CORP here would break the audio fetch without adding a boundary
   * CORS does not already provide.
   */

  /**
   * HSTS only in production, and only over a connection that is already HTTPS.
   *
   * Sending it locally would pin http://localhost to HTTPS in the developer's
   * browser for a year, which breaks every other local project on that port and
   * is genuinely painful to undo. Render terminates TLS and forwards over HTTP,
   * so req.secure is only meaningful because app.js sets trust proxy.
   */
  if (isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
