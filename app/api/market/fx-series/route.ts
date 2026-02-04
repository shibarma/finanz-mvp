import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    if (!from || !to) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing required query parameters "from" and/or "to"',
        },
        { status: 400 },
      );
    }

    const frankfurterUrl = `https://api.frankfurter.dev/v1/${encodeURIComponent(
      from,
    )}..${encodeURIComponent(to)}?base=USD&symbols=EUR`;

    const frankfurterResponse = await fetch(frankfurterUrl);

    if (!frankfurterResponse.ok) {
      const errorBody = await frankfurterResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to fetch FX series from Frankfurter',
          status: frankfurterResponse.status,
          body: errorBody,
        },
        { status: 502 },
      );
    }

    const frankfurterData: any = await frankfurterResponse.json();

    if (!frankfurterData || typeof frankfurterData.rates !== 'object' || frankfurterData.rates === null) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Invalid Frankfurter FX series response',
          status: 502,
          body: JSON.stringify(frankfurterData),
        },
        { status: 502 },
      );
    }

    const rates: Array<{ date: string; rate: number }> = Object.entries(frankfurterData.rates)
      .flatMap(([date, value]) => {
        const eur = (value as any)?.EUR;
        if (typeof eur !== 'number' || !Number.isFinite(eur)) {
          return [];
        }
        return [{ date, rate: eur }];
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      ok: true,
      rates,
    });
  } catch (error) {
    console.error('Error in FX series API:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

