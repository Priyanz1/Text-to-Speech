import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { ProtectedRoute } from './app/ProtectedRoute.jsx';
import { AuthLayout } from './features/auth/AuthLayout.jsx';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage.jsx';
import { LoginPage } from './features/auth/LoginPage.jsx';
import { ResendVerificationPage } from './features/auth/ResendVerificationPage.jsx';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage.jsx';
import { SignupPage } from './features/auth/SignupPage.jsx';
import { VerifyEmailPage } from './features/auth/VerifyEmailPage.jsx';
import { DashboardPage } from './features/dashboard/DashboardPage.jsx';
import { HistoryPage } from './features/history/HistoryPage.jsx';

function NotFoundPage() {
  return (
    <AuthLayout title="Page not found" subtitle="404">
      <p className="form-note">That address does not exist.</p>
      <Link className="form-aside" to="/">
        Go home
      </Link>
    </AuthLayout>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Unauthenticated: ProtectedRoute sends them to /login from here. */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      {/* These two read their token from ?token= in the URL. The paths have to
          match the links built in server/src/integrations/email/templates.js. */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/resend-verification" element={<ResendVerificationPage />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/history"
        element={
          <ProtectedRoute>
            <HistoryPage />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
