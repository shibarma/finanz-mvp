import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ApplyRequestBody {
  run_ids?: unknown;
}

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

interface TransactionInsertRow {
  id: string;
}

interface ApplyErrorItem {
  run_id: string;
  message: string;
}

interface ApplySummary {
  ok: boolean;
  applied: number;
  failed: number;
  rejected: number;
  errors: ApplyErrorItem[];
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

function buildTransactionComment(base: string | null): string | null {
  const trimmed = (base ?? '').trim();
  if (!trimmed) {
    return 'scheduled';
  }
  return `${trimmed} · scheduled`;
}

function buildCreatedAtFromRunDate(runDate: string): string {
  // Use stable midday UTC so DATE(run.created_at) matches run_date
  if (!runDate || typeof runDate !== 'string') {
    return new Date().toISOString();
  }
  return `${runDate}T12:00:00.000Z`;
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

    let body: ApplyRequestBody;
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
      return NextResponse.json<ApplySummary>({
        ok: true,
        applied: 0,
        failed: 0,
        rejected: 0,
        errors: [],
      });
    }

    // Load only runs that belong to this user and are still due
    const { data: runsData, error: runsError } = await supabaseAdmin
      .from('scheduled_expense_runs')
      .select(
        'id, user_id, scheduled_expense_id, run_date, snapshot_account_id, snapshot_category_id, snapshot_amount, snapshot_comment, status',
      )
      .eq('user_id', userId)
      .eq('status', 'due')
      .in('id', runIds);

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

    const runs = (runsData || []) as ScheduledExpenseRunRow[];

    if (runs.length === 0) {
      return NextResponse.json<ApplySummary>({
        ok: true,
        applied: 0,
        failed: 0,
        rejected: 0,
        errors: [],
      });
    }

    let appliedCount = 0;
    let failedCount = 0;
    const errors: ApplyErrorItem[] = [];
    const nowIso = new Date().toISOString();

    for (const run of runs) {
      const createdAt = buildCreatedAtFromRunDate(run.run_date);
      const comment = buildTransactionComment(run.snapshot_comment);

      try {
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('transactions')
          .insert({
            user_id: run.user_id,
            account_id: run.snapshot_account_id,
            kind: 'expense',
            direction: 'out',
            amount: run.snapshot_amount,
            category_id: run.snapshot_category_id,
            comment,
            transfer_id: null,
            created_at: createdAt,
          })
          .select('id')
          .single<TransactionInsertRow>();

        if (insertError || !inserted) {
          const message = insertError?.message || 'Unknown insert error';
          failedCount += 1;
          errors.push({ run_id: run.id, message });

          const { error: updateError } = await supabaseAdmin
            .from('scheduled_expense_runs')
            .update({
              status: 'failed',
              applied_transaction_id: null,
              applied_at: nowIso,
              error_message: message,
            })
            .eq('id', run.id)
            .eq('user_id', userId);

          if (updateError) {
            errors.push({
              run_id: run.id,
              message: `Failed to update run after insert failure: ${updateError.message}`,
            });
          }

          continue;
        }

        appliedCount += 1;

        const { error: updateOkError } = await supabaseAdmin
          .from('scheduled_expense_runs')
          .update({
            status: 'applied',
            applied_transaction_id: inserted.id,
            applied_at: nowIso,
            error_message: null,
          })
          .eq('id', run.id)
          .eq('user_id', userId);

        if (updateOkError) {
          errors.push({
            run_id: run.id,
            message: `Failed to update run after successful insert: ${updateOkError.message}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error while applying run';
        failedCount += 1;
        errors.push({ run_id: run.id, message });

        const { error: updateError } = await supabaseAdmin
          .from('scheduled_expense_runs')
          .update({
            status: 'failed',
            applied_transaction_id: null,
            applied_at: nowIso,
            error_message: message,
          })
          .eq('id', run.id)
          .eq('user_id', userId);

        if (updateError) {
          errors.push({
            run_id: run.id,
            message: `Failed to update run after exception: ${updateError.message}`,
          });
        }
      }
    }

    return NextResponse.json<ApplySummary>({
      ok: true,
      applied: appliedCount,
      failed: failedCount,
      rejected: 0,
      errors,
    });
  } catch (error) {
    console.error('Error in scheduled-expenses/apply route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

