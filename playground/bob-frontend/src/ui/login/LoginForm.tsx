import { FormEvent, useState } from "react";

interface LoginResponse {
  data: { token: string; user: { id: string; email: string; name: string } } | null;
  error: { code: string; message: string } | null;
}

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const body: LoginResponse = await res.json();

      if (body.error) {
        setError(body.error.message);
        return;
      }

      if (body.data) {
        localStorage.setItem("token", body.data.token);
        // TODO: redirect or update app state after login
      }
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h1>Log in</h1>

      {error && <p role="alert">{error}</p>}

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </label>

      <button type="submit" disabled={loading}>
        {loading ? "Logging in..." : "Log in"}
      </button>
    </form>
  );
}
