import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { AuthLayout } from './AuthLayout.jsx';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [form, setForm] = useState({ password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [doneMessage, setDoneMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleChange(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    // Checked here only. The server has no use for it - the point is to catch a
    // typo before it becomes a password nobody knows.
    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await api.post(
        '/api/auth/reset-password',
        // The token travels in the body, never the query string, so it stays out
        // of access logs and Referer headers.
        { token, password: form.password },
        { skipAuthRefresh: true },
      );
      setDoneMessage(response.data.message);
    } catch (cause) {
      setError(toFormMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Link incomplete" subtitle="Password reset">
        <p className="form-error" role="alert">
          This reset link is missing its token. Open the most recent link from your email,
          or request a new one.
        </p>
        <Link className="form-aside" to="/forgot-password">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  if (doneMessage) {
    return (
      <AuthLayout title="Password changed" subtitle="Password reset">
        <p className="form-note">{doneMessage}</p>
        {/* No session on purpose: the reset ended every existing session, and
            signing in confirms the new password is the one they meant to set. */}
        <Link className="form-aside" to="/login">
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="Password reset">
      <form className="form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="password">New password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={handleChange}
          required
        />
        <p className="form-hint">At least 8 characters.</p>

        <label htmlFor="confirm">Confirm new password</label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={handleChange}
          required
        />

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Change password'}
        </button>

        <Link className="form-aside" to="/forgot-password">
          Need a new link?
        </Link>
      </form>
    </AuthLayout>
  );
}
