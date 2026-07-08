import { NextResponse } from 'next/server';

/** Uniform response when a data route is hit but Supabase isn't configured. */
export function supabaseNotConfigured(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see README → Running it).',
    },
    { status: 503 },
  );
}
