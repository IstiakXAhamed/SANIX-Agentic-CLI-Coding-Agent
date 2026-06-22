/**
 * @file lib/settings.ts — Zustand store for dashboard settings.
 *
 * Persists the SANIX REST API base URL + Bearer auth token in localStorage.
 * The API client (lib/api.ts) reads these on every request.
 */
'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface DashboardSettings {
  /** SANIX REST API base URL, e.g. `http://127.0.0.1:7331`. No trailing slash. */
  serverUrl: string;
  /** Bearer token. Empty string = no auth header sent. */
  authToken: string;
  /** Auto-refresh interval for live data (ms). 0 = disabled. */
  refreshIntervalMs: number;
  /** Whether to stream run events over SSE (vs. polling). */
  preferSSE: boolean;
}

export interface DashboardSettingsStore extends DashboardSettings {
  setServerUrl: (url: string) => void;
  setAuthToken: (token: string) => void;
  setRefreshIntervalMs: (ms: number) => void;
  setPreferSSE: (v: boolean) => void;
  reset: () => void;
}

const DEFAULTS: DashboardSettings = {
  serverUrl: 'http://127.0.0.1:7331',
  authToken: '',
  refreshIntervalMs: 5000,
  preferSSE: true,
};

export const useSettings = create<DashboardSettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setServerUrl: (url) =>
        set({ serverUrl: url.replace(/\/+$/, '') }),
      setAuthToken: (token) => set({ authToken: token }),
      setRefreshIntervalMs: (ms) => set({ refreshIntervalMs: ms }),
      setPreferSSE: (v) => set({ preferSSE: v }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'sanix-dashboard-settings',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);

/**
 * Server-side safe snapshot — returns defaults during SSR.
 * Use this in non-React contexts (e.g. lib/api.ts on the client).
 */
export function readSettings(): DashboardSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  return useSettings.getState();
}
