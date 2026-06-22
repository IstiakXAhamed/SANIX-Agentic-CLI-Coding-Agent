import type { Metadata, Viewport } from 'next';
import './globals.css';
import { QueryProvider } from '@/providers/QueryProvider';
import { DashboardShell } from '@/components/DashboardShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  title: 'SANIX Dashboard',
  description:
    'SANIX — Sanim’s Agentic Neural Intelligence eXecutor. Web dashboard for the SANIX REST API.',
  applicationName: 'SANIX Dashboard',
  authors: [{ name: 'SANIX' }],
  keywords: ['sanix', 'agent', 'llm', 'dashboard', 'ai'],
  icons: {
    icon: [{ url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 2 L42 12 V36 L24 46 L6 36 V12 Z" stroke="%2300D4FF" stroke-width="2" fill="rgba(0,212,255,0.05)"/></svg>' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0D1117',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body className="min-h-screen bg-bg text-fg antialiased">
        <QueryProvider>
          <ErrorBoundary>
            <DashboardShell>{children}</DashboardShell>
          </ErrorBoundary>
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#161b22',
                border: '1px solid #30363d',
                color: '#e6edf3',
              },
            }}
          />
        </QueryProvider>
      </body>
    </html>
  );
}
