import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseEnv } from './env';

// Path prefixes that require a signed-in user. Everything else is public
// (the public dashboard at '/', '/login', the auth callback, static assets).
const PROTECTED_PREFIXES = ['/app', '/admin'];

/**
 * Refreshes the Supabase session and enforces route clearance:
 *   - /app/**   requires authentication
 *   - /admin/** requires the admin role (re-checked server-side per route)
 * Signed-in users hitting /login are bounced into the app. When no auth backend
 * is configured (UI preview), requests pass through untouched.
 *
 * `requestHeaders` (when supplied by the security middleware) carries the CSP
 * nonce forward on the request, so Next.js can stamp it onto its inline scripts.
 * We thread it through every NextResponse.next() we build here.
 */
export async function updateSession(
  request: NextRequest,
  requestHeaders?: Headers,
): Promise<NextResponse> {
  const nextInit = requestHeaders ? { request: { headers: requestHeaders } } : { request };
  let response = NextResponse.next(nextInit);

  const env = supabaseEnv();
  if (!env) return response; // preview mode: no backend, allow through

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next(nextInit);
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null; // auth endpoint unreachable — treat as signed out
  }

  const path = request.nextUrl.pathname;
  const needsAuth = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  // Unauthenticated access to a protected area → login, preserving the destination.
  if (!user && needsAuth) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }

  // Signed-in user on the login page → into the app.
  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/app';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Admin area: first-pass role gate. The RPC is SECURITY DEFINER and granted to
  // authenticated; on a transient error we let the request through and rely on
  // the server-side requireRole('admin') check (fail-closed there).
  if (user && (path === '/admin' || path.startsWith('/admin/'))) {
    try {
      const { data: role, error } = await supabase.rpc('current_app_role');
      if (!error && role && role !== 'admin') {
        const url = request.nextUrl.clone();
        url.pathname = '/app';
        url.search = '';
        return NextResponse.redirect(url);
      }
    } catch {
      // allow through; server layout enforces admin clearance
    }
  }

  return response;
}
