'use client';

import * as React from 'react';
import { runsApi } from '@/lib/api';
import type { RunEvent } from '@/lib/types';

/**
 * useRunEvents — subscribe to a run's SSE event stream.
 *
 * Returns the accumulated events array, the live connection status,
 * and a `stop()` function. Re-subscribes if `runId` changes.
 */
export function useRunEvents(runId: string | null | undefined): {
  events: RunEvent[];
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  error: Error | null;
  stop: () => void;
} {
  const [events, setEvents] = React.useState<RunEvent[]>([]);
  const [status, setStatus] = React.useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle');
  const [error, setError] = React.useState<Error | null>(null);
  const ctrlRef = React.useRef<AbortController | null>(null);

  const stop = React.useCallback(() => {
    if (ctrlRef.current) {
      ctrlRef.current.abort();
      ctrlRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!runId) {
      setStatus('idle');
      setEvents([]);
      return;
    }
    setEvents([]);
    setStatus('connecting');
    setError(null);

    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    (async () => {
      try {
        for await (const evt of runsApi.streamEvents(runId, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
          setStatus('open');
          setEvents((prev) => {
            const next = [...prev, evt];
            // Cap the buffer at 500 events.
            if (next.length > 500) next.splice(0, next.length - 500);
            return next;
          });
          if (evt.type === 'complete' || evt.type === 'aborted' || evt.type === 'error' || evt.type === 'done') {
            setStatus('closed');
            break;
          }
        }
        if (!ctrl.signal.aborted) setStatus('closed');
      } catch (err) {
        if (ctrl.signal.aborted) {
          setStatus('closed');
          return;
        }
        setStatus('error');
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return () => {
      ctrl.abort();
      ctrlRef.current = null;
    };
  }, [runId]);

  return { events, status, error, stop };
}
