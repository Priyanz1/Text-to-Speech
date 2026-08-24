import { z } from 'zod';

// Trim and lowercase *before* validating, not after. z.email() would otherwise
// reject "  me@example.com " outright - and a pasted address or a mobile
// keyboard's autocomplete very often arrives with a trailing space. Lowercasing
// early also means the value that reaches the unique index is already canonical.
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254, 'Email address is too long'));

// The upper bound is not arbitrary: bcrypt hashes at most 72 bytes and silently
// ignores the rest, so without this, two different long passwords sharing their
// first 72 bytes would both unlock the account. Rejecting is honest; truncating
// is not. Counted in bytes, not characters, because non-ASCII takes more than
// one byte each.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password is too long (72 bytes maximum)',
  });

// Tokens arrive from a link the user clicked. Bounding the length rejects
// obvious junk without a database lookup; the real check is the hash comparison.
const token = z.string().min(20, 'Invalid token').max(200, 'Invalid token');

export const signupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  // Deliberately not the `password` schema above. Login should check the
  // password that exists, not today's strength policy - otherwise tightening the
  // rules locks out everyone who signed up under the old ones, and the error
  // message tells an attacker the policy for free.
  password: z.string().min(1, 'Password is required'),
});

export const emailOnlySchema = z.object({ email });

export const verifyEmailSchema = z.object({ token });

export const resetPasswordSchema = z.object({ token, password });
