import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Fetch USD→EUR rate from Frankfurter
    const frankfurterUrl = 'https://api.frankfurter.dev/v1/latest?base=USD';
    const frankfurterResponse = await fetch(frankfurterUrl);

    if (!frankfurterResponse.ok) {
      const errorBody = await frankfurterResponse.text().catch(() => 'Unknown error');
      return NextResponse.json(
        { 
          ok: false, 
          error: 'Failed to fetch from Frankfurter',
          status: frankfurterResponse.status,
          body: errorBody
        },
        { status: 502 }
      );
    }

    const frankfurterData = await frankfurterResponse.json();
    
    if (!frankfurterData.rates || !frankfurterData.rates.EUR || typeof frankfurterData.rates.EUR !== 'number' || frankfurterData.rates.EUR <= 0) {
      return NextResponse.json(
        { 
          ok: false, 
          error: 'Invalid Frankfurter response',
          status: 502,
          body: JSON.stringify(frankfurterData)
        },
        { status: 502 }
      );
    }

    const rateUsdToEur = frankfurterData.rates.EUR;

    return NextResponse.json({
      ok: true,
      rate: rateUsdToEur,
      base: 'USD',
      quote: 'EUR',
      date: frankfurterData.date,
    });
  } catch (error) {
    console.error('Error in FX API:', error);
    return NextResponse.json(
      { 
        ok: false, 
        error: error instanceof Error ? error.message : 'Internal server error',
        status: 500,
        body: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}
