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

const MIN_QUOTE_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QuoteSuccess {
  ok: true;
  price: number;
  fetched_at: string;
}

interface QuoteFailure {
  ok: false;
  status: number;
  reason: string;
  body?: JsonValue;
}

type QuoteResult = QuoteSuccess | QuoteFailure;

async function fetchQuoteWithRetry(symbol: string): Promise<QuoteResult> {
  const maxRetries = 3;
  const backoffs = [1000, 2000, 4000];
  const url = `/api/market/quote?symbol=${encodeURIComponent(symbol)}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);

      let bodyText = '';
      let data: any = null;
      try {
        bodyText = await res.text();
        data = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        // If we cannot parse JSON, still keep body snippet for diagnostics
      }

      if (res.status === 429) {
        if (attempt < maxRetries) {
          const delay = backoffs[attempt] ?? backoffs[backoffs.length - 1];
          await sleep(delay);
          continue;
        }

        return {
          ok: false,
          status: res.status,
          reason: 'Rate limit (429) — will retry later',
          body: bodyText.slice(0, 300),
        };
      }

      if (!res.ok || !data?.ok) {
        return {
          ok: false,
          status: res.status,
          reason: (data && typeof data.error === 'string' && data.error) || 'Quote request failed',
          body: (bodyText || JSON.stringify(data || {})).slice(0, 300),
        };
      }

      const price = data.price;
      const fetchedAt: string = data.fetched_at || new Date().toISOString();

      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        return {
          ok: false,
          status: res.status,
          reason: 'Invalid or missing price',
          body: (bodyText || JSON.stringify(data || {})).slice(0, 300),
        };
      }

      return { ok: true, price, fetched_at: fetchedAt };
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = backoffs[attempt] ?? backoffs[backoffs.length - 1];
        await sleep(delay);
        continue;
      }

      return {
        ok: false,
        status: 0,
        reason:
          err instanceof Error
            ? `Network or unexpected error while fetching quote: ${err.message}`
            : 'Network or unexpected error while fetching quote',
      };
    }
  }

  return {
    ok: false,
    status: 0,
    reason: 'Unknown quote error',
  };
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
  const quoteCache = new Map<string, QuoteResult>();
  let lastQuoteRequestAt: number | null = null;

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

    let quoteResult = quoteCache.get(symbol);

    if (!quoteResult) {
      const now = Date.now();
      if (lastQuoteRequestAt !== null) {
        const elapsed = now - lastQuoteRequestAt;
        if (elapsed < MIN_QUOTE_DELAY_MS) {
          await sleep(MIN_QUOTE_DELAY_MS - elapsed);
        }
      }

      lastQuoteRequestAt = Date.now();
      quoteResult = await fetchQuoteWithRetry(symbol);
      quoteCache.set(symbol, quoteResult);
    }

    if (!quoteResult.ok) {
      summary.skipped += 1;
      summary.errors.push({
        position_id: position.id,
        symbol,
        status: quoteResult.status,
        reason: quoteResult.reason,
        body: quoteResult.body,
      });
      continue;
    }

    const price = quoteResult.price;
    const fetchedAt = quoteResult.fetched_at;

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
      const frankfurterUrl = 'https://api.frankfurter.dev/v1/latest?base=USD';
      const fxResponse = await fetch(frankfurterUrl);

      let fxData: any = null;
      let fxBodyText = '';
      try {
        fxBodyText = await fxResponse.text();
        fxData = JSON.parse(fxBodyText);
      } catch {
        summary.fxSkipped = true;
        summary.errors.push({
          scope: 'fx_rates',
          status: fxResponse.status,
          reason: 'Failed to parse FX API response JSON',
          body: fxBodyText.slice(0, 300),
        });
      }

      if (fxData !== null) {
        if (!fxResponse.ok) {
          summary.fxSkipped = true;
          summary.errors.push({
            scope: 'fx_rates',
            status: fxResponse.status,
            reason: 'Frankfurter API request failed',
            body: JSON.stringify(fxData).slice(0, 300),
          });
        } else {
          const rate = fxData.rates?.EUR;
          if (
            typeof rate !== 'number' ||
            !Number.isFinite(rate) ||
            rate <= 0
          ) {
            summary.fxSkipped = true;
            summary.errors.push({
              scope: 'fx_rates',
              status: fxResponse.status,
              reason: 'Invalid or missing rates.EUR',
              body: JSON.stringify(fxData).slice(0, 300),
            });
          } else {
            const nowIso = new Date().toISOString();
            const capturedDate = nowIso.slice(0, 10); // YYYY-MM-DD

            const { error: fxUpsertError } = await supabaseAdmin
              .from('fx_rates')
              .upsert(
                {
                  user_id: userId,
                  base_currency: 'USD',
                  quote_currency: 'EUR',
                  rate,
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
          }
        }
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

