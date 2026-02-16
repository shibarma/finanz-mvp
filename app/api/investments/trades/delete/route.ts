import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Supabase admin client is not configured. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function createAnonClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase anon client is not configured.');
  }

  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}

interface InvestmentTradeRow {
  id: string;
  user_id: string;
  broker_account_id: string;
  position_id: string;
  side: string;
  quantity: number;
  price_per_unit: number;
  fee: number;
  total_amount: number;
  transaction_id: string | null;
}

interface PositionRow {
  id: string;
  user_id: string;
  quantity: number;
}

interface AccountRow {
  id: string;
  user_id: string;
  starting_balance: number;
}

interface TransactionRow {
  id: string;
  account_id: string;
  direction: 'in' | 'out';
  amount: number;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid Authorization header' },
        { status: 401 },
      );
    }

    const accessToken = authHeader.slice('bearer '.length).trim();
    if (!accessToken) {
      return NextResponse.json(
        { ok: false, error: 'Access token is empty' },
        { status: 401 },
      );
    }

    const anonClient = createAnonClient();
    const { data: userData, error: userError } = await anonClient.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized: failed to resolve user' },
        { status: 401 },
      );
    }

    const userId = userData.user.id;

    let body: { trade_id?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const tradeId = body.trade_id;
    if (!tradeId || typeof tradeId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'trade_id is required' },
        { status: 400 },
      );
    }

    const supabase = createAdminClient();

    const { data: trade, error: tradeError } = await supabase
      .from('investment_trades')
      .select('id, user_id, broker_account_id, position_id, side, quantity, price_per_unit, fee, total_amount, transaction_id')
      .eq('id', tradeId)
      .single();

    if (tradeError || !trade) {
      return NextResponse.json(
        { ok: false, error: 'Trade not found.' },
        { status: 404 },
      );
    }

    const tradeRow = trade as InvestmentTradeRow;
    if (tradeRow.user_id !== userId) {
      return NextResponse.json(
        { ok: false, error: 'Trade not found.' },
        { status: 404 },
      );
    }

    const { data: position, error: posError } = await supabase
      .from('positions')
      .select('id, user_id, quantity')
      .eq('id', tradeRow.position_id)
      .single();

    if (posError || !position) {
      return NextResponse.json(
        { ok: false, error: 'Position not found.' },
        { status: 404 },
      );
    }

    const posRow = position as PositionRow;
    if (posRow.user_id !== userId) {
      return NextResponse.json(
        { ok: false, error: 'Position not found.' },
        { status: 404 },
      );
    }

    const { data: account, error: accError } = await supabase
      .from('accounts')
      .select('id, user_id, starting_balance')
      .eq('id', tradeRow.broker_account_id)
      .single();

    if (accError || !account) {
      return NextResponse.json(
        { ok: false, error: 'Broker account not found.' },
        { status: 404 },
      );
    }

    const accRow = account as AccountRow;
    if (accRow.user_id !== userId) {
      return NextResponse.json(
        { ok: false, error: 'Broker account not found.' },
        { status: 404 },
      );
    }

    const { data: brokerTransactions } = await supabase
      .from('transactions')
      .select('id, account_id, direction, amount')
      .eq('account_id', tradeRow.broker_account_id);

    const txRows = (brokerTransactions || []) as TransactionRow[];
    let brokerBalance = accRow.starting_balance;
    for (const tx of txRows) {
      if (tx.direction === 'in') {
        brokerBalance += tx.amount;
      } else {
        brokerBalance -= tx.amount;
      }
    }

    const side = tradeRow.side.toLowerCase();
    if (side !== 'buy' && side !== 'sell') {
      return NextResponse.json(
        { ok: false, error: 'Invalid trade type.' },
        { status: 400 },
      );
    }

    if (side === 'buy') {
      const newQty = posRow.quantity - tradeRow.quantity;
      if (newQty < 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Cannot delete buy trade: insufficient quantity (part of position already sold).',
          },
          { status: 400 },
        );
      }
    } else {
      const rollbackAmount = tradeRow.quantity * tradeRow.price_per_unit - tradeRow.fee;
      const newBalance = brokerBalance - rollbackAmount;
      if (newBalance < 0) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Delete all buy trades first or edit the broker account state in settings.',
          },
          { status: 400 },
        );
      }
    }

    const positionDelta = side === 'buy' ? -tradeRow.quantity : tradeRow.quantity;
    const newPositionQty = posRow.quantity + positionDelta;

    const { error: updatePosError } = await supabase
      .from('positions')
      .update({ quantity: newPositionQty })
      .eq('id', posRow.id)
      .eq('user_id', userId);

    if (updatePosError) {
      return NextResponse.json(
        { ok: false, error: `Error updating position: ${updatePosError.message}` },
        { status: 500 },
      );
    }

    if (tradeRow.transaction_id) {
      const { error: delTxError } = await supabase
        .from('transactions')
        .delete()
        .eq('id', tradeRow.transaction_id)
        .eq('user_id', userId);

      if (delTxError) {
        return NextResponse.json(
          { ok: false, error: `Error deleting transaction: ${delTxError.message}` },
          { status: 500 },
        );
      }
    }

    const { error: delTradeError } = await supabase
      .from('investment_trades')
      .delete()
      .eq('id', tradeId)
      .eq('user_id', userId);

    if (delTradeError) {
      return NextResponse.json(
        { ok: false, error: `Error deleting trade: ${delTradeError.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error in investments/trades/delete:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
