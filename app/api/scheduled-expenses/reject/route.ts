import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface RejectRequestBody {
  run_ids?: unknown;
}

interface ScheduledExpenseRunIdRow {
  id: string;
}

interface RejectSummary {
  ok: boolean;
  rejected: number;
  errors: string[];
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

export async function POST(request: NextRequest) {
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

    let body: RejectRequestBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const runIdsRaw = body.run_ids;
    if (!Array.isArray(runIdsRaw)) {
      return NextResponse.json(
        { ok: false, error: 'run_ids must be an array' },
        { status: 400 },
      );
    }

    const runIds = runIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
    if (runIds.length === 0) {
      return NextResponse.json<RejectSummary>({
        ok: true,
        rejected: 0,
        errors: [],
      });
    }

    // Load only runs that belong to this user and are still due
    const { data: eligibleRows, error: selectError } = await supabaseAdmin
      .from('scheduled_expense_runs')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'due')
      .in('id', runIds);

    if (selectError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to load scheduled_expense_runs',
          details: selectError.message,
        },
        { status: 500 },
      );
    }

    const eligibleIds = (eligibleRows || ([] as ScheduledExpenseRunIdRow[])).map((row) => row.id);

    if (eligibleIds.length === 0) {
      return NextResponse.json<RejectSummary>({
        ok: true,
        rejected: 0,
        errors: [],
      });
    }

    const nowIso = new Date().toISOString();

    const { error: updateError } = await supabaseAdmin
      .from('scheduled_expense_runs')
      .update({
        status: 'rejected',
        applied_at: nowIso,
        error_message: null,
      })
      .in('id', eligibleIds)
      .eq('user_id', userId)
      .eq('status', 'due');

    if (updateError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to update scheduled_expense_runs',
          details: updateError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json<RejectSummary>({
      ok: true,
      rejected: eligibleIds.length,
      errors: [],
    });
  } catch (error) {
    console.error('Error in scheduled-expenses/reject route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

