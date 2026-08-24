import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { AuthLayout } from './AuthLayout.jsx';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [sentMessage, setSentMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await api.post(
        '/api/auth/forgot-password',
        { email },
        // Nobody is signed in here, so a 401 is not something to renew a token over.
        { skipAuthRefresh: true },
      );
      setSentMessage(response.data.message);
    } catch (cause) {
      setError(toFormMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sentMessage) {
    return (
      <AuthLayout title="Check your email" subtitle="Password reset">
        {/* Deliberately the same message either way - the API will not confirm
            whether that address has an account, and neither will this screen. */}
        <p className="form-note">{sentMessage}</p>
        <Link className="form-aside" to="/login">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Password reset"
      footer={
        <>
          Remembered it? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <p className="form-hint">We will email you a link to choose a new password.</p>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthLayout>
  );
}
