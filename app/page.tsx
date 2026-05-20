import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface AccountRow {
  id: string;
  display_name: string;
  role: string;
  spotify_user_id: string | null;
  cleanup_enabled: boolean;
  created_at: Date;
}

export default async function HomePage() {
  const accounts = (await sql`
    SELECT id, display_name, role, spotify_user_id, cleanup_enabled, created_at
    FROM spotify_accounts
    ORDER BY created_at ASC
  `) as unknown as AccountRow[];

  return (
    <>
      <section className="section">
        <div className="section-header">
          <h2>Connected accounts</h2>
        </div>
        <div className="card">
          {accounts.length === 0 ? (
            <p className="empty">No accounts connected yet.</p>
          ) : (
            <ul className="account-list">
              {accounts.map((a) => (
                <li key={a.id} className="account-row">
                  <span className="account-name">{a.display_name}</span>
                  <span className="badge badge-role">{a.role}</span>
                  {a.cleanup_enabled && (
                    <span className="badge badge-cleanup">cleanup on</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Connect a new account</h2>
        </div>
        <div className="card">
          <form action="/api/spotify/connect" method="get" className="form">
            <div className="field">
              <label className="field-label" htmlFor="display_name">
                Display name
              </label>
              <input id="display_name" name="display_name" type="text" required />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="role">
                Role
              </label>
              <select id="role" name="role" defaultValue="kid">
                <option value="admin">admin</option>
                <option value="parent">parent</option>
                <option value="kid">kid</option>
              </select>
            </div>

            <label className="field-inline">
              <input type="checkbox" name="cleanup_enabled" value="true" />
              Enable cleanup cron
            </label>

            <button type="submit" className="btn btn-primary">
              Sign in with Spotify
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
