import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    if (!symbol) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Symbol parameter is required',
        },
        { status: 400 }
      );
    }

    const finnhubApiKey = process.env.FINNHUB_API_KEY;
    if (!finnhubApiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: 'FINNHUB_API_KEY missing',
        },
        { status: 500 }
      );
    }

    // Encode symbol for URL
    const encodedSymbol = encodeURIComponent(symbol.trim().toUpperCase());
    const finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=${encodedSymbol}&token=${finnhubApiKey}`;

    const finnhubResponse = await fetch(finnhubUrl);

    if (!finnhubResponse.ok) {
      const errorBody = await finnhubResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        {
          ok: false,
          error: 'Finnhub HTTP error',
          status: finnhubResponse.status,
          body: errorBody,
        },
        { status: 502 }
      );
    }

    const finnhubData = await finnhubResponse.json();

    // Finnhub quote response structure: { c: current price, d: change, dp: percent change, h: high, l: low, o: open, pc: previous close, t: timestamp }
    // For "not found" cases, Finnhub returns zeros or nulls
    const price = finnhubData.c; // 'c' is the current price

    // Validate price: must be a finite number and > 0
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Symbol not found or no price available',
          symbol: symbol.trim().toUpperCase(),
          raw: finnhubData,
        },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();

    return NextResponse.json({
      ok: true,
      symbol: symbol.trim().toUpperCase(),
      price: price,
      fetched_at: now,
      raw: finnhubData,
    });
  } catch (error) {
    console.error('Error in Quote API:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        status: 500,
        body: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}
