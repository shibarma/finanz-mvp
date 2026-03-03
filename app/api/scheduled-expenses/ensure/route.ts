import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ScheduledExpenseRule {
  id: string;
  user_id: string;
  start_date: string; // YYYY-MM-DD (DATE in UTC)
  account_id: string;
  category_id: string | null;
  amount: number;
  comment_template: string | null;
}

interface ExistingRunRow {
  run_date: string; // YYYY-MM-DD
}

interface ScheduledExpenseRunInsert {
  user_id: string;
  scheduled_expense_id: string;
  run_date: string;
  snapshot_account_id: string;
  snapshot_category_id: string | null;
  snapshot_amount: number;
  snapshot_comment: string | null;
  status: 'due';
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

function generateDateRange(startYmd: string, endYmd: string): string[] {
  if (!startYmd || !endYmd || startYmd > endYmd) return [];

  const result: string[] = [];
  const start = new Date(`${startYmd}T00:00:00.000Z`);
  const end = new Date(`${endYmd}T00:00:00.000Z`);

  for (let d = new Date(start.getTime()); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    result.push(`${year}-${month}-${day}`);
  }

  return result;
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

    const todayYmdUtc = new Date().toISOString().slice(0, 10);

    const { data: rules, error: rulesError } = await supabaseAdmin
      .from('scheduled_expenses')
      .select(
        'id, user_id, start_date, account_id, category_id, amount, comment_template',
      )
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('start_date', todayYmdUtc);

    if (rulesError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to load scheduled_expenses',
          details: rulesError.message,
        },
        { status: 500 },
      );
    }

    const ruleRows = (rules || []) as ScheduledExpenseRule[];
    const runsToInsert: ScheduledExpenseRunInsert[] = [];

    for (const rule of ruleRows) {
      const { data: existingRuns, error: runsError } = await supabaseAdmin
        .from('scheduled_expense_runs')
        .select('run_date')
        .eq('user_id', userId)
        .eq('scheduled_expense_id', rule.id)
        .gte('run_date', rule.start_date)
        .lte('run_date', todayYmdUtc);

      if (runsError) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Failed to load scheduled_expense_runs',
            details: runsError.message,
          },
          { status: 500 },
        );
      }

      const existingSet = new Set(
        (existingRuns || ([] as ExistingRunRow[])).map((row) => row.run_date),
      );

      const allDates = generateDateRange(rule.start_date, todayYmdUtc);
      for (const runDate of allDates) {
        if (existingSet.has(runDate)) continue;

        runsToInsert.push({
          user_id: userId,
          scheduled_expense_id: rule.id,
          run_date: runDate,
          snapshot_account_id: rule.account_id,
          snapshot_category_id: rule.category_id,
          snapshot_amount: rule.amount,
          snapshot_comment: rule.comment_template,
          status: 'due',
        });
      }
    }

    if (runsToInsert.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('scheduled_expense_runs')
        .upsert(runsToInsert, {
          onConflict: 'user_id,scheduled_expense_id,run_date',
        });

      if (insertError) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Failed to upsert scheduled_expense_runs',
            details: insertError.message,
          },
          { status: 500 },
        );
      }
    }

    const { count: dueCount, error: dueError } = await supabaseAdmin
      .from('scheduled_expense_runs')
      .select('*', {
        count: 'exact',
        head: true,
      })
      .eq('user_id', userId)
      .eq('status', 'due')
      .lte('run_date', todayYmdUtc);

    if (dueError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to count due scheduled_expense_runs',
          details: dueError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      due_count: dueCount ?? 0,
    });
  } catch (error) {
    console.error('Error in scheduled-expenses/ensure route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

