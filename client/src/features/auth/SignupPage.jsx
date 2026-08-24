import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { toFormMessage } from '../../lib/formError.js';
import { AuthLayout } from './AuthLayout.jsx';
import { useAuth } from './authContext.js';

export function SignupPage() {
  const { signup, isAuthenticated, status } = useAuth();

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [sentMessage, setSentMessage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (status === 'ready' && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  function handleChange(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // Returns a message, not a session: the API answers identically whether or
      // not that address already had an account, so there is nobody to sign in.
      setSentMessage(await signup(form));
    } catch (cause) {
      setError(toFormMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sentMessage) {
    return (
      <AuthLayout title="Check your email" subtitle="Almost there">
        <p className="form-note">{sentMessage}</p>
        <p className="form-note">
          The link is valid for 24 hours. In development the email is printed to the
          server terminal instead of being sent.
        </p>
        <Link className="form-aside" to="/login">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Get started"
      footer={
        <>
          Already registered? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          value={form.name}
          onChange={handleChange}
          required
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={handleChange}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={handleChange}
          required
        />
        <p className="form-hint">At least 8 characters. A passphrase beats a short password.</p>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Creating your account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
