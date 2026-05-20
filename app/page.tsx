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
    <main style={{ padding: '2rem', maxWidth: 720 }}>
      <h1>Spotify Cleaner</h1>
      <p style={{ color: '#666' }}>Family music library audit.</p>

      <section style={{ marginTop: '2rem' }}>
        <h2>Connected accounts</h2>
        {accounts.length === 0 ? (
          <p style={{ color: '#888' }}>No accounts connected yet.</p>
        ) : (
          <ul>
            {accounts.map((a) => (
              <li key={a.id}>
                <strong>{a.display_name}</strong> <span style={{ color: '#888' }}>({a.role})</span>
                {a.cleanup_enabled && <span style={{ color: '#c33', marginLeft: 8 }}>cleanup ON</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Connect a new account</h2>
        <form action="/api/spotify/connect" method="get" style={{ display: 'grid', gap: '0.75rem', maxWidth: 320 }}>
          <label>
            Display name
            <br />
            <input name="display_name" required style={{ width: '100%', padding: '0.4rem' }} />
          </label>
          <label>
            Role
            <br />
            <select name="role" defaultValue="kid" style={{ width: '100%', padding: '0.4rem' }}>
              <option value="admin">admin</option>
              <option value="parent">parent</option>
              <option value="kid">kid</option>
            </select>
          </label>
          <label>
            <input type="checkbox" name="cleanup_enabled" value="true" /> Enable cleanup cron
          </label>
          <button type="submit" style={{ padding: '0.5rem 1rem' }}>
            Sign in with Spotify
          </button>
        </form>
      </section>
    </main>
  );
}
