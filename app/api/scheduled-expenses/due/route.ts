import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ScheduledExpenseRunRow {
  id: string;
  user_id: string;
  scheduled_expense_id: string;
  run_date: string;
  snapshot_account_id: string;
  snapshot_category_id: string | null;
  snapshot_amount: number;
  snapshot_comment: string | null;
  status: string;
}

function createAnonClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase anon client is not configured.');
  }

  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}

function createAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Supabase admin client is not configured. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');

    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid Authorization header' },
        { status: 401 },
      );
    }

    const accessToken = authHeader.slice('bearer '.length).trim();
    if (!accessToken) {
      return NextResponse.json(
        { ok: false, error: 'Access token is empty' },
        { status: 401 },
      );
    }

    const anonClient = createAnonClient();
    const { data: userData, error: userError } = await anonClient.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Unauthorized: failed to resolve Supabase user',
          details: userError?.message,
        },
        { status: 401 },
      );
    }

    const userId = userData.user.id;
    const supabaseAdmin = createAdminClient();
    const todayYmdUtc = new Date().toISOString().slice(0, 10);

    const { data: runs, error: runsError } = await supabaseAdmin
      .from('scheduled_expense_runs')
      .select(
        'id, user_id, scheduled_expense_id, run_date, snapshot_account_id, snapshot_category_id, snapshot_amount, snapshot_comment, status',
      )
      .eq('user_id', userId)
      .eq('status', 'due')
      .lte('run_date', todayYmdUtc)
      .order('run_date', { ascending: true });

    if (runsError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to load due scheduled_expense_runs',
          details: runsError.message,
        },
        { status: 500 },
      );
    }

    const rows = (runs || []) as ScheduledExpenseRunRow[];

    return NextResponse.json({
      ok: true,
      runs: rows,
    });
  } catch (error) {
    console.error('Error in scheduled-expenses/due route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

