import Link from 'next/link';
import { revalidatePath } from 'next/cache';
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

async function toggleCleanup(formData: FormData) {
  'use server';
  const accountId = formData.get('account_id');
  const enabledRaw = formData.get('enabled');
  if (typeof accountId !== 'string' || typeof enabledRaw !== 'string') {
    return;
  }
  const enabled = enabledRaw === 'true';
  await sql`
    UPDATE spotify_accounts
    SET cleanup_enabled = ${enabled}, updated_at = now()
    WHERE id = ${accountId}
  `;
  revalidatePath('/');
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
                  <div className="account-meta">
                    <span className="account-name">{a.display_name}</span>
                    <span className="badge badge-role">{a.role}</span>
                    {a.cleanup_enabled && (
                      <span className="badge badge-cleanup">cleanup on</span>
                    )}
                  </div>
                  <form action={toggleCleanup} className="account-action">
                    <input type="hidden" name="account_id" value={a.id} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={a.cleanup_enabled ? 'false' : 'true'}
                    />
                    <button type="submit" className="btn btn-sm">
                      {a.cleanup_enabled ? 'Disable cleanup' : 'Enable cleanup'}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="card-link-row">
            <Link href="/review" prefetch={false} className="card-link">
              Review classifications →
            </Link>
          </p>
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

            <div className="field-checkbox">
              <label className="field-inline">
                <input type="checkbox" name="cleanup_enabled" value="true" />
                Auto-unlike brain rot for this account
              </label>
              <p className="field-help">
                Daily scan auto-removes high-confidence brain rot tracks. Every removal is logged and reversible.
              </p>
            </div>

            <button type="submit" className="btn btn-primary">
              Sign in with Spotify
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
