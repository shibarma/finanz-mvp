import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const finnhubApiKey = process.env.FINNHUB_API_KEY;

export async function GET(request: NextRequest) {
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  if (!finnhubApiKey) {
    return NextResponse.json({ error: 'Finnhub API key not configured' }, { status: 500 });
  }

  try {
    // Get cookies from request headers
    const cookieHeader = request.headers.get('cookie') || '';

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: cookieHeader ? {
          Cookie: cookieHeader,
        } : {},
      },
    });

    // Get user from session
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;

    // Fetch EUR/USD rate from Finnhub
    const finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=OANDA:EUR_USD&token=${finnhubApiKey}`;
    const finnhubResponse = await fetch(finnhubUrl);

    if (!finnhubResponse.ok) {
      return NextResponse.json({ error: 'Failed to fetch from Finnhub' }, { status: 502 });
    }

    const finnhubData = await finnhubResponse.json();
    
    if (!finnhubData.c || typeof finnhubData.c !== 'number') {
      return NextResponse.json({ error: 'Invalid Finnhub response' }, { status: 502 });
    }

    // finnhubData.c is EUR->USD rate, we need USD->EUR
    const eurToUsd = finnhubData.c;
    const usdToEur = 1 / eurToUsd;

    // Upsert into fx_rates table
    const now = new Date().toISOString();
    const { data, error: upsertError } = await supabase
      .from('fx_rates')
      .upsert(
        {
          user_id: userId,
          base_currency: 'USD',
          quote_currency: 'EUR',
          rate: usdToEur,
          fetched_at: now,
        },
        {
          onConflict: 'user_id,base_currency,quote_currency',
        }
      )
      .select()
      .single();

    if (upsertError) {
      console.error('Error upserting FX rate:', upsertError);
      return NextResponse.json({ error: 'Failed to save FX rate' }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      rate: usdToEur,
      fetched_at: now,
    });
  } catch (error) {
    console.error('Error in FX API:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
