import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const supabase = createClient();
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch {
      // already signed out / endpoint unreachable — fall through to redirect
    }
  }
  return NextResponse.redirect(new URL('/', request.url), { status: 303 });
}
