import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // Support both camelCase (coinId, vsCurrency) and snake_case (coin_id, vs_currency)
    const coinId =
      searchParams.get('coinId') ?? searchParams.get('coin_id');
    const vsCurrency =
      searchParams.get('vsCurrency') ?? searchParams.get('vs_currency');

    if (!coinId || !vsCurrency) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing required query parameters "coinId" and/or "vsCurrency"',
        },
        { status: 400 },
      );
    }

    const normalizedCoinId = coinId.trim().toLowerCase();
    const normalizedVsCurrency = vsCurrency.trim().toLowerCase();

    if (!normalizedCoinId || !normalizedVsCurrency) {
      return NextResponse.json(
        {
          ok: false,
          error: 'coinId and vsCurrency must be non-empty strings',
        },
        { status: 400 },
      );
    }

    const apiKey = process.env.COINGECKO_DEMO_API_KEY;
    const url = new URL('https://api.coingecko.com/api/v3/simple/price');
    url.searchParams.set('ids', normalizedCoinId);
    url.searchParams.set('vs_currencies', normalizedVsCurrency);

    const headers: Record<string, string> = {};
    if (apiKey) {
      // CoinGecko demo API key header, see their documentation.
      headers['x-cg-demo-api-key'] = apiKey;
    }

    const cgResponse = await fetch(url.toString(), {
      headers: Object.keys(headers).length ? headers : undefined,
    });

    if (!cgResponse.ok) {
      const errorBody = await cgResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to fetch price from CoinGecko',
          status: cgResponse.status,
          body: errorBody,
        },
        { status: 502 },
      );
    }

    let data: any;
    try {
      data = await cgResponse.json();
    } catch (err) {
      const bodyText = await cgResponse.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to parse CoinGecko response JSON',
          status: 502,
          body: bodyText.slice(0, 500),
        },
        { status: 502 },
      );
    }

    const price = data?.[normalizedCoinId]?.[normalizedVsCurrency];
    const fetchedAt: string = new Date().toISOString();

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        {
          ok: false,
          status: 404,
          reason: 'Coin not found',
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      coin_id: normalizedCoinId,
      vs_currency: normalizedVsCurrency,
      price,
      fetched_at: fetchedAt,
      raw: data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        status: 500,
      },
      { status: 500 },
    );
  }
}

