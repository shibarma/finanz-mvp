import { NextResponse } from 'next/server';

const MAX_TEXT_LENGTH = 500;

export interface ParseExpenseResult {
  account_name: string;
  amount: number;
  category_name: string;
  comment: string;
}

export interface ParseExpenseSuccess {
  ok: true;
  result: ParseExpenseResult;
}

export interface ParseExpenseError {
  ok: false;
  error: string;
}

type ParseExpenseResponse = ParseExpenseSuccess | ParseExpenseError;

/** Raw API response: amount may be null if model could not extract it */
interface RawParseExpenseResult {
  account_name: unknown;
  amount: number | null;
  category_name: unknown;
  comment: unknown;
}

function isRawParseExpenseResult(value: unknown): value is RawParseExpenseResult {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    'account_name' in o &&
    'amount' in o &&
    'category_name' in o &&
    'comment' in o &&
    (o.amount === null || typeof o.amount === 'number')
  );
}

export async function POST(request: Request): Promise<NextResponse<ParseExpenseResponse>> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' } satisfies ParseExpenseError,
        { status: 400 }
      );
    }

    const text = typeof body === 'object' && body !== null && 'text' in body
      ? (body as { text: unknown }).text
      : undefined;

    if (typeof text !== 'string' || text.trim() === '') {
      return NextResponse.json(
        { ok: false, error: 'Missing text' } satisfies ParseExpenseError,
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: 'OpenAI API not configured' } satisfies ParseExpenseError,
        { status: 500 }
      );
    }

    const model = process.env.OPENAI_MODEL_EXPENSE_PARSER ?? 'gpt-5-nano';
    const trimmedText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

    const systemContent = `Ты парсер расходов. Верни ТОЛЬКО валидный JSON, без markdown и без текста.
Поля строго: account_name (string), amount (number или null), category_name (string), comment (string).
amount обязателен. Если сумму извлечь нельзя — верни amount: null.
account_name и category_name, если не уверен — "default".
comment — кратко, может быть пустой строкой.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: trimmedText },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: `OpenAI API error: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}`,
        } satisfies ParseExpenseError,
        { status: res.status >= 400 && res.status < 500 ? 400 : 502 }
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    if (typeof rawContent !== 'string' || !rawContent) {
      return NextResponse.json(
        { ok: false, error: 'Empty or invalid OpenAI response' } satisfies ParseExpenseError,
        { status: 502 }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return NextResponse.json(
        { ok: false, error: 'OpenAI returned invalid JSON' } satisfies ParseExpenseError,
        { status: 502 }
      );
    }

    if (!isRawParseExpenseResult(parsed)) {
      return NextResponse.json(
        { ok: false, error: 'OpenAI response missing required fields' } satisfies ParseExpenseError,
        { status: 502 }
      );
    }

    const amount = parsed.amount;
    if (amount == null || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { ok: false, error: 'Cannot parse amount' } satisfies ParseExpenseError,
        { status: 400 }
      );
    }

    const result: ParseExpenseResult = {
      account_name: String(parsed.account_name ?? '').trim(),
      amount,
      category_name: String(parsed.category_name ?? '').trim(),
      comment: String(parsed.comment ?? '').trim(),
    };

    return NextResponse.json({
      ok: true,
      result,
    } satisfies ParseExpenseSuccess);
  } catch (error) {
    console.error('[parse-expense]', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      } satisfies ParseExpenseError,
      { status: 500 }
    );
  }
}
