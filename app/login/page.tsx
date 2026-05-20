export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

function sanitizeNext(next: string | undefined): string {
  if (typeof next !== 'string' || next.length === 0) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  return next;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  const error = params.error === 'invalid';

  return (
    <section className="section login-section">
      <div className="card login-card">
        <div className="section-header">
          <h2>Sign in</h2>
        </div>
        {error && (
          <p className="muted login-error">Incorrect password. Try again.</p>
        )}
        <form action="/api/auth/login" method="post" className="form">
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className="btn btn-primary">
            Sign in
          </button>
        </form>
      </div>
    </section>
  );
}
