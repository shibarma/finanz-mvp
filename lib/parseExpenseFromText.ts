const MAX_TEXT_LENGTH = 500;

export interface ParsedExpense {
  account_name: string;
  amount: number;
  category_name: string;
  comment: string;
}

interface RawParsed {
  account_name: unknown;
  amount: number | null;
  category_name: unknown;
  comment: unknown;
}

function isRawParsed(value: unknown): value is RawParsed {
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

/**
 * Calls OpenAI to parse expense from text. Returns normalized result.
 * Throws on missing/invalid config, API errors, or when amount cannot be parsed.
 */
export async function parseExpenseFromText(text: string): Promise<ParsedExpense> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Missing text');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API not configured');

  const model = process.env.OPENAI_MODEL_EXPENSE_PARSER ?? 'gpt-5-nano';
  const inputText = trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) : trimmed;

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
        { role: 'user', content: inputText },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI API error: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const rawContent = data?.choices?.[0]?.message?.content?.trim();
  if (typeof rawContent !== 'string' || !rawContent) {
    throw new Error('Empty or invalid OpenAI response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error('OpenAI returned invalid JSON');
  }

  if (!isRawParsed(parsed)) {
    throw new Error('OpenAI response missing required fields');
  }

  const amount = parsed.amount;
  if (amount == null || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Could not parse amount');
  }

  return {
    account_name: String(parsed.account_name ?? '').trim(),
    amount,
    category_name: String(parsed.category_name ?? '').trim(),
    comment: String(parsed.comment ?? '').trim(),
  };
}
