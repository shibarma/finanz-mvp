import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PositionWithInstrumentRow {
  id: string;
  user_id: string;
  broker_account_id: string;
  instrument_id: string;
  quote_currency: string;
  last_price: number | null;
  last_price_at: string | null;
  instruments:
    | {
        provider_symbol: string | null;
        display_symbol: string | null;
        kind: string | null;
        provider: string | null;
      }
    | Array<{
        provider_symbol: string | null;
        display_symbol: string | null;
        kind: string | null;
        provider: string | null;
      }>;
}

interface Summary {
  ok: boolean;
  processed: number;
  updated: number;
  skipped: number;
  errors: JsonValue[];
}

function getBaseUrl(): string {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    // VERCEL_URL is usually without protocol (e.g. my-app.vercel.app)
    if (vercelUrl.startsWith('http://') || vercelUrl.startsWith('https://')) {
      return vercelUrl;
    }
    return `https://${vercelUrl}`;
  }
  return 'http://localhost:3000';
}

function createAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase admin client is not configured. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

export async function GET(request: NextRequest) {
  const summary: Summary = {
    ok: true,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // Protect route with secret header
    const cronSecretHeader = request.headers.get('x-cron-secret');
    const cronSecretEnv = process.env.CRON_SECRET;

    if (!cronSecretEnv || !cronSecretHeader || cronSecretHeader !== cronSecretEnv) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Unauthorized: invalid or missing cron secret',
        },
        { status: 401 },
      );
    }

    const supabaseAdmin = createAdminClient();
    const baseUrl = getBaseUrl();

    // --- A) Load positions that need price refresh ---
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: positions, error: positionsError } = await supabaseAdmin
      .from('positions')
      .select(
        'id, user_id, broker_account_id, instrument_id, quote_currency, last_price, last_price_at, instruments!inner(provider_symbol, display_symbol, kind, provider)',
      )
      .or(`last_price_at.is.null,last_price_at.lt.${twentyFourHoursAgo}`);

    if (positionsError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to load positions',
          details: positionsError.message,
        },
        { status: 500 },
      );
    }

    const positionsToProcess = (positions || []) as PositionWithInstrumentRow[];
    summary.processed = positionsToProcess.length;

    // --- B) Refresh prices for each position ---
    for (const position of positionsToProcess) {
      const instrumentRaw = position.instruments as any;
      const instrument = Array.isArray(instrumentRaw) ? instrumentRaw[0] : instrumentRaw;

      if (!instrument) {
        summary.skipped += 1;
        summary.errors.push({
          position_id: position.id,
          reason: 'Missing instrument for position',
        });
        continue;
      }

      const providerSymbol = (instrument.provider_symbol || instrument.display_symbol || '').toString().trim();

      if (!providerSymbol) {
        summary.skipped += 1;
        summary.errors.push({
          position_id: position.id,
          reason: 'Instrument has no provider_symbol or display_symbol',
        });
        continue;
      }

      const symbol = providerSymbol.toUpperCase();
      const kind = (instrument.kind || '').toString();
      const convertCurrency = (position.quote_currency || '').toString();

      const quoteUrl = `${baseUrl}/api/market/quote?symbol=${encodeURIComponent(
        symbol,
      )}&kind=${encodeURIComponent(kind)}&convert=${encodeURIComponent(convertCurrency)}`;

      let price: number | null = null;
      let fetchedAt: string | null = null;

      try {
        const quoteResponse = await fetch(quoteUrl);

        let quoteData: any = null;
        try {
          quoteData = await quoteResponse.json();
        } catch {
          summary.skipped += 1;
          summary.errors.push({
            position_id: position.id,
            symbol,
            reason: 'Failed to parse quote response JSON',
            status: quoteResponse.status,
          });
          continue;
        }

        if (!quoteResponse.ok || !quoteData?.ok || typeof quoteData.price !== 'number' || !Number.isFinite(quoteData.price)) {
          summary.skipped += 1;
          summary.errors.push({
            position_id: position.id,
            symbol,
            reason: 'Quote request failed or returned invalid price',
            status: quoteResponse.status,
            body: quoteData,
          });
          continue;
        }

        price = quoteData.price;
        fetchedAt = (quoteData.fetched_at as string | undefined) || new Date().toISOString();
      } catch (err) {
        summary.skipped += 1;
        summary.errors.push({
          position_id: position.id,
          symbol,
          reason: 'Network or unexpected error while fetching quote',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        continue;
      }

      if (price === null || fetchedAt === null) {
        summary.skipped += 1;
        summary.errors.push({
          position_id: position.id,
          symbol,
          reason: 'Price or fetchedAt is null after quote processing',
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      const capturedDate = nowIso.slice(0, 10); // YYYY-MM-DD

      // Update position last_price / last_price_at
      const { error: updateError } = await supabaseAdmin
        .from('positions')
        .update({
          last_price: price,
          last_price_at: fetchedAt,
        })
        .eq('id', position.id);

      if (updateError) {
        summary.skipped += 1;
        summary.errors.push({
          position_id: position.id,
          symbol,
          reason: 'Failed to update position price',
          error: updateError.message,
        });
        continue;
      }

      // Insert / upsert into position_price_history (one row per position per day)
      const { error: historyError } = await supabaseAdmin
        .from('position_price_history')
        .upsert(
          {
            user_id: position.user_id,
            position_id: position.id,
            price,
            currency: position.quote_currency,
            price_at: fetchedAt,
            captured_at: nowIso,
            captured_date: capturedDate,
          },
          {
            onConflict: 'user_id,position_id,captured_date',
          },
        );

      if (historyError) {
        // Price was updated; snapshot failed – record error but still count as updated
        summary.errors.push({
          position_id: position.id,
          symbol,
          reason: 'Failed to upsert position_price_history',
          error: historyError.message,
        });
      }

      summary.updated += 1;
    }

    // --- C) Refresh FX rate USD→EUR for users with USD accounts (once per day) ---
    try {
      const { data: usdAccounts, error: usdAccountsError } = await supabaseAdmin
        .from('accounts')
        .select('user_id, currency')
        .eq('currency', 'USD');

      if (!usdAccountsError && usdAccounts && usdAccounts.length > 0) {
        const userIds = Array.from(new Set(usdAccounts.map((a: any) => a.user_id as string)));

        // Fetch FX rate once via existing API route
        const fxResponse = await fetch(`${baseUrl}/api/market/fx`);
        let fxData: any = null;
        try {
          fxData = await fxResponse.json();
        } catch {
          summary.errors.push({
            scope: 'fx_rates',
            reason: 'Failed to parse FX API response JSON',
            status: fxResponse.status,
          });
          fxData = null;
        }

        if (fxResponse.ok && fxData?.ok && typeof fxData.rate === 'number' && Number.isFinite(fxData.rate) && fxData.rate > 0) {
          const nowIso = new Date().toISOString();

          for (const userId of userIds) {
            const { error: fxUpsertError } = await supabaseAdmin
              .from('fx_rates')
              .upsert(
                {
                  user_id: userId,
                  base_currency: 'USD',
                  quote_currency: 'EUR',
                  rate: fxData.rate,
                  fetched_at: nowIso,
                },
                {
                  onConflict: 'user_id,base_currency,quote_currency',
                },
              );

            if (fxUpsertError) {
              summary.errors.push({
                scope: 'fx_rates',
                user_id: userId,
                reason: 'Failed to upsert FX rate for user',
                error: fxUpsertError.message,
              });
            }
          }
        } else if (usdAccounts && usdAccounts.length > 0) {
          summary.errors.push({
            scope: 'fx_rates',
            reason: 'FX API returned error or invalid rate',
            status: fxResponse.status,
            body: fxData,
          });
        }
      } else if (usdAccountsError) {
        summary.errors.push({
          scope: 'fx_rates',
          reason: 'Failed to load USD accounts',
          error: usdAccountsError.message,
        });
      }
    } catch (err) {
      summary.errors.push({
        scope: 'fx_rates',
        reason: 'Unexpected error while refreshing FX rates',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }

    return NextResponse.json(summary);
  } catch (error) {
    console.error('Error in refresh-prices cron route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

