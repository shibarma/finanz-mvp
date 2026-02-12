import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface FxRateRow {
  base_currency: string;
  quote_currency: string;
  rate: number;
  captured_date: string;
  fetched_at: string;
  source_date: string | null;
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
    auth: {
      persistSession: false,
    },
  });
}

export async function GET() {
  try {
    const supabaseAdmin = createAdminClient();

    const nowIso = new Date().toISOString();
    const todayStr = nowIso.slice(0, 10); // YYYY-MM-DD in UTC

    // 1) Try to read existing FX rate for today from fx_rates_global
    const { data: existingRow, error: fetchError } = await supabaseAdmin
      .from('fx_rates_global')
      .select('base_currency, quote_currency, rate, captured_date, fetched_at, source_date')
      .eq('base_currency', 'USD')
      .eq('quote_currency', 'EUR')
      .eq('captured_date', todayStr)
      .maybeSingle<FxRateRow>();

    if (!fetchError && existingRow) {
      return NextResponse.json({
        ok: true,
        rate: existingRow.rate,
        base: existingRow.base_currency,
        quote: existingRow.quote_currency,
        captured_date: existingRow.captured_date,
        source_date: existingRow.source_date,
        fetched_at: existingRow.fetched_at,
      });
    }

    // 2) No row for today (or failed to read) → fetch from Frankfurter
    const frankfurterUrl = 'https://api.frankfurter.dev/v1/latest?base=USD';
    const frankfurterResponse = await fetch(frankfurterUrl);

    if (!frankfurterResponse.ok) {
      const errorBody = await frankfurterResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to fetch from Frankfurter',
          status: frankfurterResponse.status,
          body: errorBody,
        },
        { status: 502 },
      );
    }

    let frankfurterData: any;
    try {
      frankfurterData = await frankfurterResponse.json();
    } catch (err) {
      const errorBody = await frankfurterResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to parse Frankfurter response JSON',
          status: 502,
          body: errorBody,
        },
        { status: 502 },
      );
    }

    const eurRate = frankfurterData?.rates?.EUR;

    if (typeof eurRate !== 'number' || !Number.isFinite(eurRate) || eurRate <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid Frankfurter response',
          status: 502,
          body: JSON.stringify(frankfurterData) as JsonValue,
        },
        { status: 502 },
      );
    }

    const rateUsdToEur = eurRate as number;
    const sourceDate: string | null = typeof frankfurterData?.date === 'string' ? frankfurterData.date : null;

    // 3) Upsert into fx_rates_global using service role
    const { error: upsertError } = await supabaseAdmin
      .from('fx_rates_global')
      .upsert(
        {
          base_currency: 'USD',
          quote_currency: 'EUR',
          rate: rateUsdToEur,
          captured_date: todayStr,
          fetched_at: nowIso,
          source_date: sourceDate,
        },
        {
          onConflict: 'base_currency,quote_currency,captured_date',
        },
      );

    if (upsertError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to upsert FX rate into fx_rates_global',
          status: 500,
          body: upsertError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      rate: rateUsdToEur,
      base: 'USD',
      quote: 'EUR',
      captured_date: todayStr,
      source_date: sourceDate,
      fetched_at: nowIso,
    });
  } catch (error) {
    console.error('Error in FX ensure API:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        status: 500,
        body: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}

