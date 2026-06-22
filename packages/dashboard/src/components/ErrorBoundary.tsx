'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

/**
 * React error boundary — catches render-time errors anywhere in the
 * dashboard subtree and shows a recoverable error screen.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  private reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-error/15">
            <AlertTriangle className="h-8 w-8 text-error" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-fg">Something broke</h2>
            <p className="mt-1 max-w-md text-sm text-fg-muted">
              {this.state.error.message || 'An unexpected error occurred while rendering this view.'}
            </p>
          </div>
          <Button onClick={this.reset} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
