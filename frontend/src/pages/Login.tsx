import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, ErrorNote, Field } from "../components/ui";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={from === "/login" ? "/" : from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(from === "/login" ? "/" : from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="login-wrap">
      <form className="card card-body login-card" onSubmit={submit} aria-label="Sign in">
        <div className="login-brand">
          <div className="brand-mark" aria-hidden>B</div>
          <div>
            <h1 className="login-title">Bambou Hub</h1>
            <div className="login-hint">Sign in to the automation console</div>
          </div>
        </div>
        <Field label="Username">
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" loading={busy} disabled={!username || !password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
