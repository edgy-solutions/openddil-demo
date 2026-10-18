// =============================================================================
// AppErrorBoundary — a render error anywhere must not leave a white page
// =============================================================================
// There was no boundary above Root, so an uncaught render error unmounted the
// whole app to nothing. This shows what threw and, when one is known, the
// last request that failed, since a bad response is the usual cause.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { lastFailedRequest } from '../lib/lastFailedRequest';

interface State { error: Error | null }

export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AppErrorBoundary caught a render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const req = lastFailedRequest();
    return (
      <div className="h-screen w-screen bg-slate-950 text-slate-300 font-mono
                      flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="font-orbitron tracking-widest text-red-400 text-lg">
          Something went wrong
        </div>
        <div className="max-w-xl break-words text-xs text-slate-400">
          {error.name}: {error.message}
        </div>
        {req && (
          <div className="max-w-xl break-words text-xs text-slate-500">
            Last failed request: {req.method} {req.path} → {req.status ?? 'network error'} ({req.detail})
          </div>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-sm border border-cyan-700/60 bg-cyan-500/10 px-6 py-2
                     text-xs font-bold tracking-widest text-cyan-300
                     hover:bg-cyan-500/20 transition-colors"
        >
          Reload
        </button>
      </div>
    );
  }
}
