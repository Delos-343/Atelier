'use client';

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

/**
 * Cloudflare Turnstile challenge. Renders only when NEXT_PUBLIC_TURNSTILE_SITE_KEY
 * is set — otherwise it's inert and reports itself unconfigured, so the login form
 * behaves exactly as before on a backend without CAPTCHA. The resulting token is
 * handed to the parent, which passes it to Supabase Auth as `captchaToken`;
 * Supabase verifies it server-side with the matching SECRET key (configured in the
 * Supabase dashboard), so this app never needs the secret and never verifies the
 * token itself.
 *
 * Tokens are single-use, so the parent calls `reset()` (via ref) after a failed
 * sign-in to fetch a fresh one.
 */

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

export const isTurnstileConfigured = (): boolean => SITE_KEY !== null;

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileHandle {
  reset: () => void;
}

interface Props {
  /** Fires with the token on success, or null when it expires / errors. */
  onToken: (token: string | null) => void;
  /** Fires when the challenge fails to load or errors (e.g. an invalid site key). */
  onError?: (reason: string) => void;
}

let scriptPromise: Promise<void> | null = null;

/** Load the Turnstile script once, shared across mounts. */
function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Turnstile.'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, Props>(function TurnstileWidget(
  { onToken, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    reset() {
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
        onToken(null);
      }
    },
  }));

  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;

    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        // Guard against a double render under React strict mode.
        if (widgetIdRef.current) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => {
            onToken(null);
            onError?.('The CAPTCHA challenge failed to load. Check NEXT_PUBLIC_TURNSTILE_SITE_KEY.');
          },
          theme: 'auto',
        });
      })
      .catch(() => {
        // Script blocked / offline — surface it so the user isn't left staring at a
        // disabled button; Supabase still enforces CAPTCHA server-side if required.
        onError?.('The CAPTCHA script could not be loaded (offline or blocked).');
      });

    return () => {
      cancelled = true;
      if (window.turnstile && widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* already gone */
        }
        widgetIdRef.current = null;
      }
    };
    // onToken is stable from the parent (useCallback); intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} className="mb-[0.9rem]" />;
});
