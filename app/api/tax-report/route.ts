import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getTaxReport } from '@/server/taxReport';

export const dynamic = 'force-dynamic';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if (!start || !end || !YMD.test(start) || !YMD.test(end)) {
    return NextResponse.json({ error: 'Provide start and end dates as YYYY-MM-DD.' }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: 'The start date must be on or before the end date.' }, { status: 400 });
  }
  const res = await getTaxReport(auth.supabase, start, end);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}
