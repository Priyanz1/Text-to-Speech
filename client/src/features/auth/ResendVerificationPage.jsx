import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { AuthLayout } from './AuthLayout.jsx';

/**
 * For the person whose confirmation link expired before they opened it, and who
 * is not signed in - signed-in users have the same button on the dashboard.
 */
export function ResendVerificationPage() {
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
        '/api/auth/resend-verification',
        { email },
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
      <AuthLayout title="Check your email" subtitle="Email confirmation">
        <p className="form-note">{sentMessage}</p>
        <p className="form-note">
          Requesting a new link retires the previous one, so use the newest email.
        </p>
        <Link className="form-aside" to="/login">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Send a new confirmation link"
      subtitle="Email confirmation"
      footer={
        <>
          Already confirmed? <Link to="/login">Sign in</Link>
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

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send link'}
        </button>
      </form>
    </AuthLayout>
  );
}
