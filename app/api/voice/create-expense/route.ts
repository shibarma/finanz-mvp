import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseExpenseFromText } from '../../../../lib/parseExpenseFromText';

const SIMILARITY_THRESHOLD = 0.5;

function createAnonClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase anon client is not configured.');
  }
  return createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
}

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase admin client is not configured.');
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Bigrams for Dice coefficient */
function bigrams(str: string): Set<string> {
  const set = new Set<string>();
  const n = normalizeString(str);
  for (let i = 0; i < n.length - 1; i++) {
    set.add(n.slice(i, i + 2));
  }
  return set;
}

/** Dice coefficient on bigrams: 2 * |intersection| / (|A| + |B|). Returns 0..1. */
function diceSimilarity(a: string, b: string): number {
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  if (bgA.size === 0 && bgB.size === 0) return 1;
  if (bgA.size === 0 || bgB.size === 0) return 0;
  let intersection = 0;
  for (const x of bgA) {
    if (bgB.has(x)) intersection++;
  }
  return (2 * intersection) / (bgA.size + bgB.size);
}

interface ParsedInput {
  amount?: unknown;
  account_name?: unknown;
  category_name?: unknown;
  comment?: unknown;
}

function getParsedAmount(parsed: ParsedInput): number | null {
  const a = parsed.amount;
  if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return null;
  return a;
}

function getParsedString(parsed: ParsedInput, key: keyof ParsedInput): string | null {
  const v = parsed[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

interface AccountRow {
  id: string;
  name: string;
  is_default_expense: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (!authHeader?.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json({ ok: false, error: 'Missing or invalid Authorization header' }, { status: 401 });
    }
    const accessToken = authHeader.slice('bearer '.length).trim();
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: 'Access token is empty' }, { status: 401 });
    }

    const anon = createAnonClient();
    const { data: userData, error: userError } = await anon.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const userId = userData.user.id;
    const admin = createAdminClient();

    let body: { text?: unknown; parsed?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const text = typeof body.text === 'string' ? body.text : '';
    let parsed: ParsedInput;

    if (body.parsed != null && typeof body.parsed === 'object') {
      parsed = body.parsed as ParsedInput;
    } else {
      if (!text.trim()) {
        return NextResponse.json({ ok: false, error: 'Missing text when parsed is not provided' }, { status: 400 });
      }
      try {
        parsed = await parseExpenseFromText(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Parse failed';
        if (msg === 'Could not parse amount') {
          return NextResponse.json({ ok: false, error: 'Could not parse amount' }, { status: 400 });
        }
        return NextResponse.json({ ok: false, error: msg }, { status: 502 });
      }
    }

    const amount = getParsedAmount(parsed);
    if (amount == null) {
      return NextResponse.json({ ok: false, error: 'Could not parse amount' }, { status: 400 });
    }

    const { data: accountsData } = await admin
      .from('accounts')
      .select('id, name, is_default_expense')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    const accounts = (accountsData ?? []) as AccountRow[];
    if (accounts.length === 0) {
      return NextResponse.json({ ok: false, error: 'No accounts available' }, { status: 400 });
    }

    const accountNameInput = getParsedString(parsed, 'account_name') ?? '';
    const normAccountInput = normalizeString(accountNameInput);

    let matchedAccountId: string;
    let matchedAccountName: string;
    let account_score: number;

    if (normAccountInput) {
      let bestScore = 0;
      let bestAccount: AccountRow | null = null;
      for (const a of accounts) {
        const score = diceSimilarity(normAccountInput, a.name);
        if (score > bestScore) {
          bestScore = score;
          bestAccount = a;
        }
      }
      if (bestScore >= SIMILARITY_THRESHOLD && bestAccount) {
        matchedAccountId = bestAccount.id;
        matchedAccountName = bestAccount.name;
        account_score = bestScore;
      } else {
        const defaultExpense = accounts.find((a) => a.is_default_expense) ?? accounts[0];
        matchedAccountId = defaultExpense.id;
        matchedAccountName = defaultExpense.name;
        account_score = 0;
      }
    } else {
      const defaultExpense = accounts.find((a) => a.is_default_expense) ?? accounts[0];
      matchedAccountId = defaultExpense.id;
      matchedAccountName = defaultExpense.name;
      account_score = 0;
    }

    const { data: categoriesData } = await admin
      .from('categories')
      .select('id, name')
      .eq('user_id', userId)
      .eq('kind', 'expense');

    const categories = (categoriesData ?? []) as CategoryRow[];
    const categoryNameInput = getParsedString(parsed, 'category_name') ?? '';
    const normCategoryInput = normalizeString(categoryNameInput);

    let matchedCategoryId: string | null = null;
    let matchedCategoryName: string | null = null;
    let category_score: number = 0;

    if (normCategoryInput && categories.length > 0) {
      let bestScore = 0;
      let bestCategory: CategoryRow | null = null;
      for (const c of categories) {
        const score = diceSimilarity(normCategoryInput, c.name);
        if (score > bestScore) {
          bestScore = score;
          bestCategory = c;
        }
      }
      if (bestScore >= SIMILARITY_THRESHOLD && bestCategory) {
        matchedCategoryId = bestCategory.id;
        matchedCategoryName = bestCategory.name;
        category_score = bestScore;
      }
    }

    const commentPart =
      (getParsedString(parsed, 'comment') ?? '').trim() || (text ?? '').trim() || '';
    const comment = commentPart ? `${commentPart} — audio input` : 'audio input';

    const created_at = new Date().toISOString();
    const { data: inserted, error: insertError } = await admin
      .from('transactions')
      .insert({
        user_id: userId,
        account_id: matchedAccountId,
        kind: 'expense',
        direction: 'out',
        amount,
        category_id: matchedCategoryId,
        comment,
        transfer_id: null,
        created_at,
      })
      .select('id, amount, created_at')
      .single();

    if (insertError) {
      return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
    }

    const row = inserted as { id: string; amount: number; created_at: string } | null;
    const transaction_id = row?.id ?? '';

    const parsedEcho = {
      amount,
      account_name: getParsedString(parsed, 'account_name'),
      category_name: getParsedString(parsed, 'category_name'),
      comment: getParsedString(parsed, 'comment'),
    };

    return NextResponse.json({
      ok: true,
      parsed: parsedEcho,
      resolved: {
        account_id: matchedAccountId,
        account_name: matchedAccountName,
        category_id: matchedCategoryId,
        category_name: matchedCategoryName,
        account_score,
        category_score,
      },
      transaction: {
        id: transaction_id,
        amount: row?.amount ?? amount,
        created_at: row?.created_at ?? created_at,
      },
    });
  } catch (err) {
    console.error('[create-expense]', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
