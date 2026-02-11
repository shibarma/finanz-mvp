import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const coinId = searchParams.get('coin_id');
    const vsCurrency = searchParams.get('vs_currency');

    if (!coinId || !vsCurrency) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing required query parameters "coin_id" and/or "vs_currency"',
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
          error: 'coin_id and vs_currency must be non-empty strings',
        },
        { status: 400 },
      );
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      normalizedCoinId,
    )}&vs_currencies=${encodeURIComponent(normalizedVsCurrency)}`;

    const cgResponse = await fetch(url);

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

    const price =
      data?.[normalizedCoinId]?.[normalizedVsCurrency];

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid or missing price in CoinGecko response',
          status: 502,
          body: JSON.stringify(data).slice(0, 500),
        },
        { status: 502 },
      );
    }

    const fetchedAt = new Date().toISOString();

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

