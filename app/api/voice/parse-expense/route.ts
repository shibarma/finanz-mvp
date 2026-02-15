import { NextResponse } from 'next/server';
import { parseExpenseFromText, type ParsedExpense } from '../../../../lib/parseExpenseFromText';

export type { ParsedExpense as ParseExpenseResult };

export interface ParseExpenseSuccess {
  ok: true;
  result: ParsedExpense;
}

export interface ParseExpenseError {
  ok: false;
  error: string;
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const text =
      typeof body === 'object' && body !== null && 'text' in body
        ? (body as { text: unknown }).text
        : undefined;

    if (typeof text !== 'string' || text.trim() === '') {
      return NextResponse.json({ ok: false, error: 'Missing text' }, { status: 400 });
    }

    try {
      const result = await parseExpenseFromText(text);
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Parse failed';
      if (message === 'Could not parse amount') {
        return NextResponse.json({ ok: false, error: message }, { status: 400 });
      }
      if (message.startsWith('OpenAI')) {
        return NextResponse.json({ ok: false, error: message }, { status: 502 });
      }
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  } catch (error) {
    console.error('[parse-expense]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
