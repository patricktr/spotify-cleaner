import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'Spotify Cleaner',
  description: 'Family music library audit',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" prefetch={false} className="site-title">
              Spotify Cleaner
            </Link>
            <nav className="site-nav">
              <Link href="/" prefetch={false} className="site-nav-link">
                Accounts
              </Link>
              <Link href="/review" prefetch={false} className="site-nav-link">
                Review
              </Link>
            </nav>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <a
            href="https://github.com/patricktr/spotify-cleaner"
            target="_blank"
            rel="noreferrer"
          >
            github.com/patricktr/spotify-cleaner
          </a>
        </footer>
      </body>
    </html>
  );
}
