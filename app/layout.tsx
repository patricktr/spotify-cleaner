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
            <span className="site-title">Spotify Cleaner</span>
            <span className="site-tag">Family library audit</span>
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
