import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface PositionWithInstrumentRow {
  id: string;
  user_id: string;
  broker_account_id: string;
  instrument_id: string;
  quote_currency: string | null;
  quantity: number;
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

export interface RefreshPricesEngineOptions {
  userId: string;
  force?: boolean;
}

export interface RefreshPricesSummary {
  ok: boolean;
  processed: number;
  updated: number;
  skipped: number;
  fxUpdated: boolean;
  fxSkipped: boolean;
  errors: JsonValue[];
}

function getBaseUrl(): string {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
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

export async function refreshPricesEngine(
  options: RefreshPricesEngineOptions,
): Promise<RefreshPricesSummary> {
  const { userId } = options;

  const summary: RefreshPricesSummary = {
    ok: true,
    processed: 0,
    updated: 0,
    skipped: 0,
    fxUpdated: false,
    fxSkipped: false,
    errors: [],
  };

  const supabaseAdmin = createAdminClient();
  const baseUrl = getBaseUrl();

  // --- A) Load positions for this user ---
  const { data: positions, error: positionsError } = await supabaseAdmin
    .from('positions')
    .select(
      'id, user_id, broker_account_id, instrument_id, quote_currency, quantity, last_price, last_price_at, instruments!inner(provider_symbol, display_symbol, kind, provider)',
    )
    .eq('user_id', userId);

  if (positionsError) {
    return {
      ...summary,
      ok: false,
      errors: [
        {
          scope: 'positions',
          reason: 'Failed to load positions',
          error: positionsError.message,
        },
      ],
    };
  }

  const positionsToProcess = (positions || []) as PositionWithInstrumentRow[];
  summary.processed = positionsToProcess.length;

  // --- B) Refresh prices for each position for this user ---
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

    const providerSymbol = (instrument.provider_symbol || instrument.display_symbol || '')
      .toString()
      .trim();

    if (!providerSymbol) {
      summary.skipped += 1;
      summary.errors.push({
        position_id: position.id,
        reason: 'Instrument has no provider_symbol or display_symbol',
      });
      continue;
    }

    const symbol = providerSymbol.toUpperCase();

    const quoteUrl = `${baseUrl}/api/market/quote?symbol=${encodeURIComponent(symbol)}`;

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

      if (
        !quoteResponse.ok ||
        !quoteData?.ok ||
        typeof quoteData.price !== 'number' ||
        !Number.isFinite(quoteData.price)
      ) {
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
      .eq('id', position.id)
      .eq('user_id', userId);

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
          user_id: userId,
          position_id: position.id,
          price,
          currency: position.quote_currency,
          price_at: fetchedAt,
          captured_at: nowIso,
          captured_date: capturedDate,
          quantity_snapshot: position.quantity,
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

  // --- C) Refresh FX rate USD→EUR for this user (once per day) ---
  try {
    const { data: usdAccounts, error: usdAccountsError } = await supabaseAdmin
      .from('accounts')
      .select('id, currency')
      .eq('user_id', userId)
      .eq('currency', 'USD')
      .limit(1);

    if (usdAccountsError) {
      summary.fxSkipped = true;
      summary.errors.push({
        scope: 'fx_rates',
        reason: 'Failed to check USD accounts for user',
        error: usdAccountsError.message,
      });
    } else if (!usdAccounts || usdAccounts.length === 0) {
      // No USD accounts – FX not needed
      summary.fxSkipped = true;
    } else {
      const fxResponse = await fetch(`${baseUrl}/api/market/fx`);
      let fxData: any = null;
      try {
        fxData = await fxResponse.json();
      } catch {
        summary.fxSkipped = true;
        summary.errors.push({
          scope: 'fx_rates',
          reason: 'Failed to parse FX API response JSON',
          status: fxResponse.status,
        });
        fxData = null;
      }

      if (
        fxResponse.ok &&
        fxData?.ok &&
        typeof fxData.rate === 'number' &&
        Number.isFinite(fxData.rate) &&
        fxData.rate > 0
      ) {
        const nowIso = new Date().toISOString();
        const capturedDate = nowIso.slice(0, 10); // YYYY-MM-DD

        const { error: fxUpsertError } = await supabaseAdmin
          .from('fx_rates')
          .upsert(
            {
              user_id: userId,
              base_currency: 'USD',
              quote_currency: 'EUR',
              rate: fxData.rate,
              fetched_at: nowIso,
              captured_date: capturedDate,
            },
            {
              onConflict: 'user_id,base_currency,quote_currency,captured_date',
            },
          );

        if (fxUpsertError) {
          summary.fxSkipped = true;
          summary.errors.push({
            scope: 'fx_rates',
            user_id: userId,
            reason: 'Failed to upsert FX rate for user',
            error: fxUpsertError.message,
          });
        } else {
          summary.fxUpdated = true;
        }
      } else {
        summary.fxSkipped = true;
        summary.errors.push({
          scope: 'fx_rates',
          reason: 'FX API returned error or invalid rate',
          status: fxResponse.status,
          body: fxData,
        });
      }
    }
  } catch (err) {
    summary.fxSkipped = true;
    summary.errors.push({
      scope: 'fx_rates',
      reason: 'Unexpected error while refreshing FX rate for user',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  return summary;
}

