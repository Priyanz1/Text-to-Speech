import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { User } from '../modules/users/user.model.js';

/**
 * Gate for routes that need a signed-in user. Puts the user document on
 * req.user, so handlers never parse a token themselves.
 *
 * The token is read from the Authorization header rather than a cookie. That is
 * what makes the API resistant to CSRF without a separate token layer: a browser
 * attaches cookies to a forged cross-site request automatically, but it will not
 * add a header an attacker cannot set.
 */
export async function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    next(new ApiError(401, 'Not authenticated'));
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    // Expiry is the ordinary case - access tokens are minutes long, so clients
    // hit it constantly and answer by refreshing. Saying which of the two it was
    // gives away nothing an attacker could not determine from the token itself.
    const expired = error.name === 'TokenExpiredError';
    next(new ApiError(401, expired ? 'Access token expired' : 'Invalid access token'));
    return;
  }

  // One indexed read per request, rather than trusting the token's claims.
  // The cost buys immediacy: a deleted account stops working now instead of
  // whenever its last access token happens to expire.
  const user = await User.findById(payload.sub);

  if (!user) {
    next(new ApiError(401, 'Not authenticated'));
    return;
  }

  req.user = user;
  next();
}
