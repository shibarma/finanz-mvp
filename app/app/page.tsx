'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';
import { parseMoneyExpression } from '../../lib/parseMoneyExpression';

type AccountKind = 'debit' | 'credit' | 'cash' | 'broker';
type AccountCurrency = 'EUR' | 'USD';

interface Account {
  id: string;
  user_id: string;
  name: string;
  kind: AccountKind;
  currency: AccountCurrency | null;
  starting_balance: number;
  warning_threshold: number;
  credit_limit: number | null;
  credit_warning_threshold: number | null;
  debit_anchor_account_id: string | null;
  is_default_income: boolean;
  is_default_expense: boolean;
  created_at: string;
}

interface InstrumentRef {
  provider_symbol: string | null;
  display_symbol: string | null;
}

interface PositionMain {
  id: string;
  user_id: string;
  broker_account_id: string;
  instrument_id: string;
  quote_currency: AccountCurrency | null;
  quantity: number;
  comment: string | null;
  last_price: number | null;
  last_price_at: string | null;
  created_at: string;
  instruments?: InstrumentRef | InstrumentRef[] | null;
}

interface Transfer {
  id: string;
  user_id: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  is_credit_repayment: boolean;
  comment: string | null;
  created_at: string;
}

interface InvestmentTrade {
  id: string;
  user_id: string;
  broker_account_id: string;
  position_id: string;
  transaction_id: string;
  side: string;
  quantity: number;
  price_per_unit: number;
  fee: number;
  total_amount: number;
  comment: string | null;
  created_at: string;
}

interface Category {
  id: string;
  user_id: string;
  kind: 'income' | 'expense';
  name: string;
  created_at: string;
}

interface Transaction {
  id: string;
  user_id: string;
  account_id: string;
  kind: 'income' | 'expense' | 'transfer';
  direction: 'in' | 'out';
  amount: number;
  category_id: string | null;
  comment: string | null;
  transfer_id: string | null;
  created_at: string;
  is_investment?: boolean;
}

type AccountBalance = {
  balance: number;
  status: 'normal' | 'orange' | 'red';
  creditUsed?: number;
};

// Helper для форматирования денег по валюте
const formatMoney = (amount: number, currency: AccountCurrency = 'EUR'): string => {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency === 'USD' ? 'USD' : 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

// Helper для получения символа валюты
const getCurrencySymbol = (currency: AccountCurrency | null): string => {
  return (currency || 'EUR') === 'USD' ? '$' : '€';
};

// Helper для получения валюты счета
const getAccountCurrency = (account: Account | undefined): AccountCurrency => {
  return (account?.currency || 'EUR') as AccountCurrency;
};

// Helper для получения символа позиции
const getPositionSymbol = (position: PositionMain): string => {
  const inst = position.instruments;
  if (!inst) return '—';
  const i = Array.isArray(inst) ? inst[0] : inst;
  return (i?.display_symbol || i?.provider_symbol || '—').toString();
};

// Helper для конвертации баланса счета в EUR
const toEur = (
  amount: number,
  currency: AccountCurrency | null,
  usdToEurRate: number | null,
): number | null => {
  const curr = (currency || 'EUR') as AccountCurrency;
  if (curr === 'EUR') {
    return amount;
  }
  if (curr === 'USD') {
    if (!usdToEurRate || !Number.isFinite(usdToEurRate) || usdToEurRate <= 0) {
      return null;
    }
    return amount * usdToEurRate;
  }
  return null;
};

export default function FinanceAppPage() {
  const router = useRouter();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [positions, setPositions] = useState<PositionMain[]>([]);
  const [investmentTrades, setInvestmentTrades] = useState<InvestmentTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // FX rate
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxError, setFxError] = useState<string | null>(null);
  const [transferCurrencyError, setTransferCurrencyError] = useState<string | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<{
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null>(null);

  // Флаги для отслеживания ручного выбора счетов
  const [accountIncomeManuallySet, setAccountIncomeManuallySet] = useState(false);
  const [accountExpenseManuallySet, setAccountExpenseManuallySet] = useState(false);

  // Пагинация для операций
  const [operationsPage, setOperationsPage] = useState(0);
  const OPERATIONS_PER_PAGE = 20;

  // Фильтры для последних операций
  const [operationsAccountFilter, setOperationsAccountFilter] = useState<string>('all');
  const [operationsCategoryFilter, setOperationsCategoryFilter] = useState<string>('all');
  const [operationsTypeFilter, setOperationsTypeFilter] = useState<'all' | 'income' | 'expense' | 'transfer'>('all');

  // Фильтр видимости счетов в блоке Accounts (только отображение, не влияет на формы)
  const [hiddenAccountIds, setHiddenAccountIds] = useState<Set<string>>(new Set());

  // Редактирование транзакций
  const [editingOperation, setEditingOperation] = useState<{
    id: string;
    type: 'income' | 'expense' | 'transfer';
    amount: number;
    accountId?: string;
    fromAccountId?: string;
    toAccountId?: string;
    categoryId?: string;
    comment: string | null;
  } | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editAccount, setEditAccount] = useState('');
  const [editFromAccount, setEditFromAccount] = useState('');
  const [editToAccount, setEditToAccount] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editComment, setEditComment] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Редактирование сделки с ценными бумагами
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [editTradeQuantity, setEditTradeQuantity] = useState('');
  const [editTradePrice, setEditTradePrice] = useState('');
  const [editTradeFee, setEditTradeFee] = useState('');
  const [editTradeComment, setEditTradeComment] = useState('');
  const [savingTradeEdit, setSavingTradeEdit] = useState(false);
  const [tradeEditError, setTradeEditError] = useState<string | null>(null);
  const [tradeDeleteMessage, setTradeDeleteMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null);

  // Income form
  const [amountIncome, setAmountIncome] = useState('');
  const [accountIncome, setAccountIncome] = useState<string>('');
  const [categoryIncome, setCategoryIncome] = useState<string>('');
  const [commentIncome, setCommentIncome] = useState('');
  const [submittingIncome, setSubmittingIncome] = useState(false);

  // Expense form
  const [amountExpense, setAmountExpense] = useState('');
  const [accountExpense, setAccountExpense] = useState<string>('');
  const [categoryExpense, setCategoryExpense] = useState<string>('');
  const [commentExpense, setCommentExpense] = useState('');
  const [submittingExpense, setSubmittingExpense] = useState(false);

  // Transfer form
  const [amountTransfer, setAmountTransfer] = useState('');
  const [fromAccountTransfer, setFromAccountTransfer] = useState<string>('');
  const [toAccountTransfer, setToAccountTransfer] = useState<string>('');
  const [isCreditRepayment, setIsCreditRepayment] = useState(false);
  const [commentTransfer, setCommentTransfer] = useState('');
  const [submittingTransfer, setSubmittingTransfer] = useState(false);

  // Invest Buy/Sell form
  const [investBroker, setInvestBroker] = useState<string>('');
  const [investInstrument, setInvestInstrument] = useState<string>('');
  const [investSide, setInvestSide] = useState<'Buy' | 'Sell'>('Buy');
  const [investQuantity, setInvestQuantity] = useState('');
  const [investPricePerUnit, setInvestPricePerUnit] = useState('');
  const [investFee, setInvestFee] = useState('0');
  const [investComment, setInvestComment] = useState('');
  const [submittingInvest, setSubmittingInvest] = useState(false);

  const accountsById = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach((acc) => {
      map.set(acc.id, acc);
    });
    return map;
  }, [accounts]);

  const incomeCategories = useMemo(
    () => categories.filter((c) => c.kind === 'income'),
    [categories],
  );
  const expenseCategories = useMemo(
    () => categories.filter((c) => c.kind === 'expense'),
    [categories],
  );
  const creditAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'credit'),
    [accounts],
  );
  const brokerAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'broker'),
    [accounts],
  );
  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !hiddenAccountIds.has(a.id)),
    [accounts, hiddenAccountIds],
  );
  const positionsByBroker = useMemo(
    () => (investBroker ? positions.filter((p) => p.broker_account_id === investBroker) : []),
    [positions, investBroker],
  );

  // Reset instrument when broker changes; set price_per_unit when instrument selected
  useEffect(() => {
    setInvestInstrument('');
    setInvestPricePerUnit('');
  }, [investBroker]);

  useEffect(() => {
    if (investInstrument) {
      const pos = positions.find((p) => p.id === investInstrument);
      if (pos && pos.last_price != null) {
        setInvestPricePerUnit(pos.last_price.toString());
      }
    } else {
      setInvestPricePerUnit('');
    }
  }, [investInstrument, positions]);

  useEffect(() => {
    const init = async () => {
      const session = await getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setUserId(session.user.id);
      const accessToken = (session as { access_token?: string }).access_token;
      setSessionToken(accessToken || null);
      setSessionChecked(true);
      await Promise.all([
        loadAccounts(),
        loadCategories(),
        loadTransactions(session.user.id),
        loadTransfers(session.user.id),
        loadPositions(session.user.id),
        loadInvestmentTrades(session.user.id),
      ]);
    };

    init();
  }, [router]);

  useEffect(() => {
    // Load FX rate after session is available
    if (userId) {
      loadFxRate();
    }
  }, [userId]);

  // При изменении фильтров сбрасываем страницу операций на первую
  useEffect(() => {
    setOperationsPage(0);
  }, [operationsAccountFilter, operationsCategoryFilter, operationsTypeFilter]);

  // Hydrate account visibility filter from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('finanz_visible_accounts');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { visible?: string[]; known?: string[] };
      const visible = parsed.visible || [];
      const known = parsed.known || [];
      if (!Array.isArray(visible) || !Array.isArray(known)) return;
      setHiddenAccountIds(new Set(known.filter((id: string) => !visible.includes(id))));
    } catch {
      // ignore
    }
  }, []);

  // Persist account visibility filter to localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || accounts.length === 0) return;
    try {
      const visible = accounts.filter((a) => !hiddenAccountIds.has(a.id)).map((a) => a.id);
      const known = accounts.map((a) => a.id);
      window.localStorage.setItem('finanz_visible_accounts', JSON.stringify({ visible, known }));
    } catch {
      // ignore
    }
  }, [accounts, hiddenAccountIds]);

  const toggleAccountVisibility = (accountId: string) => {
    setHiddenAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const selectAllAccounts = () => setHiddenAccountIds(new Set());
  const clearAccountsFilter = () => setHiddenAccountIds(new Set());

  const [accountsFilterOpen, setAccountsFilterOpen] = useState(false);

  const loadAccounts = async () => {
    const { data, error: fetchError } = await supabase
      .from('accounts')
      .select('*')
      .order('created_at', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setAccounts((data || []) as Account[]);
  };

  const handleManualRefresh = async () => {
    if (!sessionToken) {
      setRefreshError('Session token is missing. Please re-login.');
      return;
    }

    setRefreshError(null);
    setRefreshSummary(null);
    setRefreshLoading(true);

    try {
      const response = await fetch('/api/refresh-prices/manual', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        setRefreshError(data.error || 'Failed to refresh prices');
        return;
      }

      setRefreshSummary({
        processed: data.processed ?? 0,
        updated: data.updated ?? 0,
        skipped: data.skipped ?? 0,
        errors: Array.isArray(data.errors) ? data.errors.length : data.errors_count ?? 0,
      });

      if (userId) {
        await Promise.all([loadPositions(userId), loadFxRate()]);
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Unexpected error while refreshing prices');
    } finally {
      setRefreshLoading(false);
    }
  };

  const loadFxRate = async () => {
    if (!userId) return;

    setFxError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('fx_rates')
        .select('rate, fetched_at')
        .eq('base_currency', 'USD')
        .eq('quote_currency', 'EUR')
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!fetchError && data) {
        setFxRate(data.rate);
      } else {
        setFxRate(null);
        if (fetchError) {
          setFxError(fetchError.message);
          console.error('FX load error:', fetchError.message);
        }
      }
    } catch (err) {
      setFxRate(null);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setFxError(errorMessage);
      console.error('FX load error:', errorMessage);
    }
  };

  const loadCategories = async () => {
    const { data, error: fetchError } = await supabase
      .from('categories')
      .select('*')
      .order('created_at', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setCategories((data || []) as Category[]);
  };

  const loadTransactions = async (uid: string) => {
    const { data, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setTransactions((data || []) as Transaction[]);
  };

  const loadTransfers = async (uid: string) => {
    const { data, error: fetchError } = await supabase
      .from('transfers')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setTransfers((data || []) as Transfer[]);
  };

  const loadPositions = async (uid: string) => {
    const { data, error: fetchError } = await supabase
      .from('positions')
      .select('id, user_id, broker_account_id, instrument_id, quote_currency, quantity, comment, last_price, last_price_at, created_at, instruments(provider_symbol, display_symbol)')
      .eq('user_id', uid);

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setPositions((data || []) as PositionMain[]);
  };

  const loadInvestmentTrades = async (uid: string) => {
    const { data, error: fetchError } = await supabase
      .from('investment_trades')
      .select('id, user_id, broker_account_id, position_id, transaction_id, side, quantity, price_per_unit, fee, total_amount, comment, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(20);

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setInvestmentTrades((data || []) as InvestmentTrade[]);
  };

  // Calculate balances for each account
  const accountBalances = useMemo(() => {
    const balances = new Map<string, AccountBalance>();

    accounts.forEach((account) => {
      let balance = account.starting_balance;

      transactions.forEach((tx) => {
        if (tx.account_id === account.id) {
          if (tx.direction === 'in') {
            balance += tx.amount;
          } else {
            balance -= tx.amount;
          }
        }
      });

      let status: 'normal' | 'orange' | 'red' = 'normal';
      let creditUsed: number | undefined;

      if (account.kind === 'debit') {
        if (balance <= 0) {
          status = 'red';
        } else if (balance <= account.warning_threshold) {
          status = 'orange';
        }
      } else if (account.kind === 'cash') {
        if (balance <= account.warning_threshold) {
          status = 'orange';
        }
      } else if (account.kind === 'credit') {
        creditUsed = Math.max(0, -balance);
        const creditLimit = account.credit_limit || 0;
        const creditWarningThreshold = account.credit_warning_threshold || 0;

        if (creditUsed > creditLimit) {
          status = 'red';
        } else if (creditUsed >= creditLimit - creditWarningThreshold) {
          status = 'orange';
        }
      }

      balances.set(account.id, { balance, status, creditUsed });
    });

    return balances;
  }, [accounts, transactions]);

  // Calculate totals
  const totals = useMemo(() => {
    let totalEur = 0;
    let debitEur = 0;
    let creditEur = 0;
    let cashEur = 0;
    let brokerCashEur = 0;
    let investEur = 0;
    let usdExcludedFromTotals = false;

    accountBalances.forEach((accBalance, accountId) => {
      const account = accountsById.get(accountId);
      if (!account) return;

      const accountCurrency = getAccountCurrency(account);

      // Broker: считаем отдельно, не включаем в общий totalEur
      if (account.kind === 'broker') {
        const eurValueBroker = toEur(accBalance.balance, accountCurrency, fxRate);
        if (eurValueBroker === null) {
          if (accountCurrency === 'USD') {
            usdExcludedFromTotals = true;
          }
          return;
        }
        brokerCashEur += eurValueBroker;
        return;
      }

      // Сводка (Total/Debit/Credit/Cash) считается только по debit/credit/cash
      if (account.kind !== 'debit' && account.kind !== 'credit' && account.kind !== 'cash') {
        return;
      }

      const eurValue = toEur(accBalance.balance, accountCurrency, fxRate);

      // Если курс для USD недоступен, исключаем такие счета из сводки
      if (eurValue === null) {
        if (accountCurrency === 'USD') {
          usdExcludedFromTotals = true;
        }
        return;
      }

      totalEur += eurValue;

      if (account.kind === 'debit') {
        debitEur += eurValue;
      } else if (account.kind === 'credit') {
        creditEur += eurValue;
      } else if (account.kind === 'cash') {
        cashEur += eurValue;
      }
    });

    // Инвестиции: сумма quantity * last_price по всем позициям
    positions.forEach((position) => {
      const price = position.last_price ?? 0;
      if (!price) {
        // last_price отсутствует или 0 — считаем как 0 EUR для сводки
        return;
      }

      const rawValue = position.quantity * price;
      const eurValue = toEur(rawValue, position.quote_currency as AccountCurrency | null, fxRate);

      if (eurValue === null) {
        // Если нет FX для USD, такие позиции не включаем в сводку
        return;
      }

      investEur += eurValue;
    });

    return { totalEur, debitEur, creditEur, cashEur, brokerCashEur, investEur, usdExcludedFromTotals };
  }, [accountBalances, accountsById, fxRate, positions]);

  const handleIncome = async () => {
    if (!userId) return;

    setError(null);

    const parsed = parseMoneyExpression(amountIncome);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const amount = parsed.value;
    if (amount <= 0) {
      setError('Введите положительную сумму.');
      return;
    }

    if (!accountIncome) {
      setError('Выберите счёт.');
      return;
    }

    setSubmittingIncome(true);

    const { error: insertError } = await supabase.from('transactions').insert({
      user_id: userId,
      account_id: accountIncome,
      kind: 'income',
      direction: 'in',
      amount,
      category_id: categoryIncome || null,
      comment: commentIncome.trim() || null,
      transfer_id: null,
    });

    setSubmittingIncome(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setAmountIncome('');
    setCommentIncome('');
    setOperationsPage(0);
    await Promise.all([loadTransactions(userId), loadTransfers(userId)]);
  };

  const handleExpense = async () => {
    if (!userId) return;

    setError(null);

    const parsed = parseMoneyExpression(amountExpense);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const amount = parsed.value;
    if (amount <= 0) {
      setError('Введите положительную сумму.');
      return;
    }

    if (!accountExpense) {
      setError('Выберите счёт.');
      return;
    }

    const account = accountsById.get(accountExpense);
    if (account) {
      const currentBalance = accountBalances.get(accountExpense)?.balance || 0;
      const accountCurrency = getAccountCurrency(account);
      if (account.kind === 'cash') {
        if (amount > currentBalance) {
          setError(
            `Недостаточно средств на счёте "${account.name}". Доступно: ${formatMoney(currentBalance, accountCurrency)}.`,
          );
          return;
        }
      } else if (account.kind === 'broker') {
        if (amount > currentBalance) {
          setError('Недостаточно средств на брокерском счёте. Баланс не может быть отрицательным.');
          return;
        }
      }
    }

    setSubmittingExpense(true);

    const { error: insertError } = await supabase.from('transactions').insert({
      user_id: userId,
      account_id: accountExpense,
      kind: 'expense',
      direction: 'out',
      amount,
      category_id: categoryExpense || null,
      comment: commentExpense.trim() || null,
      transfer_id: null,
    });

    setSubmittingExpense(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setAmountExpense('');
    setCommentExpense('');
    setOperationsPage(0);
    await Promise.all([loadTransactions(userId), loadTransfers(userId)]);
  };

  const handleTransfer = async () => {
    if (!userId) return;

    setError(null);

    const parsed = parseMoneyExpression(amountTransfer);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const amount = parsed.value;
    if (amount <= 0) {
      setError('Введите положительную сумму.');
      return;
    }

    let fromAccountId = fromAccountTransfer;
    let toAccountId = toAccountTransfer;

    if (isCreditRepayment) {
      if (!toAccountId) {
        setError('Выберите кредитный счёт.');
        return;
      }

      const creditAccount = accountsById.get(toAccountId);
      if (!creditAccount || creditAccount.kind !== 'credit') {
        setError('Выберите кредитный счёт.');
        return;
      }

      if (!creditAccount.debit_anchor_account_id) {
        setError('У выбранной кредитки нет привязанного дебетового счёта.');
        return;
      }

      fromAccountId = creditAccount.debit_anchor_account_id;
    } else {
      if (!fromAccountId || !toAccountId) {
        setError('Выберите счета "Откуда" и "Куда".');
        return;
      }

      if (fromAccountId === toAccountId) {
        setError('Счета "Откуда" и "Куда" не могут совпадать.');
        return;
      }

      // Check currency mismatch
      const fromAccount = accountsById.get(fromAccountId);
      const toAccount = accountsById.get(toAccountId);
      if (fromAccount && toAccount) {
        const fromCurrency = getAccountCurrency(fromAccount);
        const toCurrency = getAccountCurrency(toAccount);
        if (fromCurrency !== toCurrency) {
          setTransferCurrencyError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
          return;
        }
      }
    }

    // Check currency mismatch for credit repayment
    if (isCreditRepayment && toAccountId) {
      const creditAccount = accountsById.get(toAccountId);
      if (creditAccount && creditAccount.debit_anchor_account_id) {
        const debitAccount = accountsById.get(creditAccount.debit_anchor_account_id);
        if (creditAccount && debitAccount) {
          const creditCurrency = getAccountCurrency(creditAccount);
          const debitCurrency = getAccountCurrency(debitAccount);
          if (creditCurrency !== debitCurrency) {
            setTransferCurrencyError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
            return;
          }
        }
      }
    }

    setTransferCurrencyError(null);

    // Check cash/broker restriction
    const fromAccount = accountsById.get(fromAccountId);
    if (fromAccount) {
      const currentBalance = accountBalances.get(fromAccountId)?.balance || 0;
      const accountCurrency = getAccountCurrency(fromAccount);
      if (fromAccount.kind === 'cash') {
        if (amount > currentBalance) {
          setError(
            `Недостаточно средств на счёте "${fromAccount.name}". Доступно: ${formatMoney(currentBalance, accountCurrency)}.`,
          );
          return;
        }
      } else if (fromAccount.kind === 'broker') {
        if (amount > currentBalance) {
          setError('Недостаточно средств на брокерском счёте. Баланс не может быть отрицательным.');
          return;
        }
      }
    }

    // Final currency validation (defensive check)
    if (!isCreditRepayment) {
      const finalFromAccount = accountsById.get(fromAccountId);
      const finalToAccount = accountsById.get(toAccountId);
      if (finalFromAccount && finalToAccount) {
        const fromCurrency = getAccountCurrency(finalFromAccount);
        const toCurrency = getAccountCurrency(finalToAccount);
        if (fromCurrency !== toCurrency) {
          setError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
          return;
        }
      }
    }

    setSubmittingTransfer(true);

    // Create transfer
    const { data: transferData, error: transferError } = await supabase
      .from('transfers')
      .insert({
        user_id: userId,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
        is_credit_repayment: isCreditRepayment,
        comment: commentTransfer.trim() || null,
      })
      .select()
      .single();

    if (transferError) {
      setSubmittingTransfer(false);
      setError(transferError.message);
      return;
    }

    if (!transferData) {
      setSubmittingTransfer(false);
      setError('Ошибка при создании перевода.');
      return;
    }

    // Create two transactions
    const { error: txOutError } = await supabase.from('transactions').insert({
      user_id: userId,
      account_id: fromAccountId,
      kind: 'transfer',
      direction: 'out',
      amount,
      transfer_id: transferData.id,
      category_id: null,
      comment: commentTransfer.trim() || null,
    });

    if (txOutError) {
      // Try to delete transfer (best effort)
      await supabase.from('transfers').delete().eq('id', transferData.id);
      setSubmittingTransfer(false);
      setError(txOutError.message);
      return;
    }

    const { error: txInError } = await supabase.from('transactions').insert({
      user_id: userId,
      account_id: toAccountId,
      kind: 'transfer',
      direction: 'in',
      amount,
      transfer_id: transferData.id,
      category_id: null,
      comment: commentTransfer.trim() || null,
    });

    if (txInError) {
      // Try to delete transfer and out transaction (best effort)
      await supabase.from('transactions').delete().eq('transfer_id', transferData.id);
      await supabase.from('transfers').delete().eq('id', transferData.id);
      setSubmittingTransfer(false);
      setError(txInError.message);
      return;
    }

    setSubmittingTransfer(false);
    setAmountTransfer('');
    setFromAccountTransfer('');
    setToAccountTransfer('');
    setIsCreditRepayment(false);
    setCommentTransfer('');
    setOperationsPage(0);
    await Promise.all([loadTransactions(userId), loadTransfers(userId)]);
  };

  const handleInvestSubmit = async (side: 'Buy' | 'Sell') => {
    if (!userId) return;

    setError(null);

    const quantityParsed = parseMoneyExpression(investQuantity);
    if (!quantityParsed.ok) {
      setError(quantityParsed.error);
      return;
    }
    const quantity = quantityParsed.value;

    const priceParsed = parseMoneyExpression(investPricePerUnit);
    if (!priceParsed.ok) {
      setError(priceParsed.error);
      return;
    }
    const pricePerUnit = priceParsed.value;

    const feeParsed = parseMoneyExpression(investFee || '0');
    if (!feeParsed.ok) {
      setError(feeParsed.error);
      return;
    }
    const fee = feeParsed.value;

    if (!investBroker) {
      setError('Выберите брокера.');
      return;
    }
    if (!investInstrument) {
      setError('Выберите инструмент.');
      return;
    }
    if (quantity <= 0) {
      setError('Количество должно быть больше 0.');
      return;
    }
    if (pricePerUnit <= 0) {
      setError('Цена за единицу должна быть больше 0.');
      return;
    }
    if (fee < 0) {
      setError('Комиссия должна быть не меньше 0.');
      return;
    }

    const position = positions.find((p) => p.id === investInstrument);
    const brokerAccount = accountsById.get(investBroker);

    if (!position || !brokerAccount) {
      setError('Позиция или брокерский счёт не найдены.');
      return;
    }

    if (position.broker_account_id !== investBroker) {
      setError('Позиция не принадлежит выбранному брокеру.');
      return;
    }

    const brokerCurrency = (brokerAccount.currency || 'EUR') as AccountCurrency;
    const posCurrency = (position.quote_currency || 'EUR') as AccountCurrency;
    if (brokerCurrency !== posCurrency) {
      setError('Валюта позиции не совпадает с валютой брокерского счёта.');
      return;
    }

    const curSym = brokerCurrency === 'USD' ? '$' : '€';

    let amount: number;
    if (side === 'Buy') {
      amount = quantity * pricePerUnit + fee;
    } else {
      amount = quantity * pricePerUnit - fee;
      if (amount < 0) {
        setError('При Sell комиссия не может превышать сумму сделки (quantity × price).');
        return;
      }
      if (quantity > position.quantity) {
        setError(`Количество для продажи (${quantity}) превышает текущую позицию (${position.quantity}).`);
        return;
      }
    }

    // For Buy, ensure broker account will not go negative
    if (side === 'Buy') {
      const currentBalance = accountBalances.get(investBroker)?.balance || 0;
      if (amount > currentBalance) {
        setError('Недостаточно средств на брокерском счёте. Баланс не может быть отрицательным.');
        return;
      }
    }

    const symbol = getPositionSymbol(position);
    const autoComment =
      side === 'Buy'
        ? `Buy ${symbol} x${quantity} @ ${pricePerUnit} ${curSym} (fee ${fee} ${curSym})`
        : `Sell ${symbol} x${quantity} @ ${pricePerUnit} ${curSym} (fee ${fee} ${curSym})`;
    const comment = investComment.trim() ? `${autoComment} — ${investComment.trim()}` : autoComment;

    setSubmittingInvest(true);

    try {
      const newQty = side === 'Buy' ? position.quantity + quantity : position.quantity - quantity;

      const { error: updatePosError } = await supabase
        .from('positions')
        .update({ quantity: newQty })
        .eq('id', position.id)
        .eq('user_id', userId);

      if (updatePosError) {
        setError(`Ошибка обновления позиции: ${updatePosError.message}`);
        setSubmittingInvest(false);
        return;
      }

      const kind = side === 'Buy' ? 'expense' : 'income';
      const direction = side === 'Buy' ? 'out' : 'in';

      const { data: txData, error: txError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          account_id: investBroker,
          kind,
          direction,
          amount,
          category_id: null,
          comment,
          transfer_id: null,
          is_investment: true,
        })
        .select('id')
        .single();

      if (txError || !txData) {
        setError(`Ошибка создания операции: ${txError?.message || 'Неизвестная ошибка'}`);
        setSubmittingInvest(false);
        return;
      }

      const { error: tradeError } = await supabase.from('investment_trades').insert({
        user_id: userId,
        broker_account_id: investBroker,
        position_id: position.id,
        side: side.toLowerCase(),
        quantity,
        price_per_unit: pricePerUnit,
        fee,
        total_amount: amount,
        transaction_id: txData.id,
        comment: investComment.trim() || null,
      });

      if (tradeError) {
        setError(`Ошибка записи сделки: ${tradeError.message}`);
        setSubmittingInvest(false);
        return;
      }

      setInvestInstrument('');
      setInvestQuantity('');
      setInvestPricePerUnit('');
      setInvestFee('0');
      setInvestComment('');
      setOperationsPage(0);
      await Promise.all([loadPositions(userId), loadTransactions(userId), loadInvestmentTrades(userId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неожиданная ошибка');
    } finally {
      setSubmittingInvest(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const handleEditOperation = (op: {
    id: string;
    type: 'income' | 'expense' | 'transfer';
    amount: number;
    accountName?: string;
    fromAccountName?: string;
    toAccountName?: string;
    categoryName?: string;
    comment: string | null;
  }) => {
    if (op.type === 'transfer') {
      // Найти transfer и связанные transactions
      const transfer = transfers.find((t) => t.id === op.id);
      if (!transfer) return;

      setEditingOperation({
        id: transfer.id,
        type: 'transfer',
        amount: transfer.amount,
        fromAccountId: transfer.from_account_id,
        toAccountId: transfer.to_account_id,
        comment: transfer.comment,
      });
      setEditAmount(transfer.amount.toString());
      setEditFromAccount(transfer.from_account_id);
      setEditToAccount(transfer.to_account_id);
      setEditComment(transfer.comment || '');
    } else {
      // Найти transaction
      const transaction = transactions.find((t) => t.id === op.id);
      if (!transaction) return;

      setEditingOperation({
        id: transaction.id,
        type: transaction.kind as 'income' | 'expense',
        amount: transaction.amount,
        accountId: transaction.account_id,
        categoryId: transaction.category_id || undefined,
        comment: transaction.comment,
      });
      setEditAmount(transaction.amount.toString());
      setEditAccount(transaction.account_id);
      setEditCategory(transaction.category_id || '');
      setEditComment(transaction.comment || '');
    }
  };

  const handleCancelEdit = () => {
    setEditingOperation(null);
    setEditAmount('');
    setEditAccount('');
    setEditFromAccount('');
    setEditToAccount('');
    setEditCategory('');
    setEditComment('');
  };

  const handleSaveEdit = async () => {
    if (!userId || !editingOperation) return;

    setError(null);

    const parsed = parseMoneyExpression(editAmount);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const amount = parsed.value;
    if (amount <= 0) {
      setError('Введите положительную сумму.');
      return;
    }

    setSavingEdit(true);

    try {
      if (editingOperation.type === 'transfer') {
        // Обновляем transfer
        const { error: transferError } = await supabase
          .from('transfers')
          .update({
            amount,
            comment: editComment.trim() || null,
          })
          .eq('id', editingOperation.id)
          .eq('user_id', userId);

        if (transferError) {
          setError(transferError.message);
          setSavingEdit(false);
          return;
        }

        // Обновляем обе связанные transactions
        const { error: txError } = await supabase
          .from('transactions')
          .update({
            amount,
            comment: editComment.trim() || null,
          })
          .eq('transfer_id', editingOperation.id)
          .eq('user_id', userId);

        if (txError) {
          setError(txError.message);
          setSavingEdit(false);
          return;
        }
      } else {
        // Обновляем transaction для income/expense
        if (!editAccount) {
          setError('Выберите счёт.');
          setSavingEdit(false);
          return;
        }

        const { error: txError } = await supabase
          .from('transactions')
          .update({
            amount,
            account_id: editAccount,
            category_id: editCategory || null,
            comment: editComment.trim() || null,
          })
          .eq('id', editingOperation.id)
          .eq('user_id', userId);

        if (txError) {
          setError(txError.message);
          setSavingEdit(false);
          return;
        }
      }

      // Обновляем данные
      await Promise.all([loadTransactions(userId), loadTransfers(userId)]);
      handleCancelEdit();
    } catch (err: any) {
      setError(err.message || 'Ошибка при сохранении');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteOperation = async (op: {
    id: string;
    type: 'income' | 'expense' | 'transfer';
  }) => {
    if (!userId) return;

    if (!window.confirm('Вы уверены, что хотите удалить эту операцию?')) {
      return;
    }

    setError(null);

    try {
      if (op.type === 'transfer') {
        // Удаляем связанные transactions
        const { error: txError } = await supabase
          .from('transactions')
          .delete()
          .eq('transfer_id', op.id)
          .eq('user_id', userId);

        if (txError) {
          setError(txError.message);
          return;
        }

        // Удаляем transfer
        const { error: transferError } = await supabase
          .from('transfers')
          .delete()
          .eq('id', op.id)
          .eq('user_id', userId);

        if (transferError) {
          setError(transferError.message);
          return;
        }
      } else {
        // Удаляем transaction
        const { error: txError } = await supabase
          .from('transactions')
          .delete()
          .eq('id', op.id)
          .eq('user_id', userId);

        if (txError) {
          setError(txError.message);
          return;
        }
      }

      // Обновляем данные
      await Promise.all([loadTransactions(userId), loadTransfers(userId)]);
      setOperationsPage(0);
    } catch (err: any) {
      setError(err.message || 'Ошибка при удалении');
    }
  };

  const handleEditInvestmentTrade = (trade: InvestmentTrade) => {
    setEditingTradeId(trade.id);
    setEditTradeQuantity(trade.quantity.toString());
    setEditTradePrice(trade.price_per_unit.toString());
    setEditTradeFee(trade.fee.toString());
    setEditTradeComment(trade.comment || '');
    setTradeEditError(null);
  };

  const handleCancelEditTrade = () => {
    setEditingTradeId(null);
    setEditTradeQuantity('');
    setEditTradePrice('');
    setEditTradeFee('');
    setEditTradeComment('');
    setTradeEditError(null);
  };

  const handleSaveEditTrade = async () => {
    if (!userId || !editingTradeId) return;

    const trade = investmentTrades.find((t) => t.id === editingTradeId);
    if (!trade) return;

    const quantityParsed = parseMoneyExpression(editTradeQuantity);
    if (!quantityParsed.ok) {
      setTradeEditError(quantityParsed.error);
      return;
    }
    const quantity = quantityParsed.value;

    const priceParsed = parseMoneyExpression(editTradePrice);
    if (!priceParsed.ok) {
      setTradeEditError(priceParsed.error);
      return;
    }
    const pricePerUnit = priceParsed.value;

    const feeParsed = parseMoneyExpression(editTradeFee || '0');
    if (!feeParsed.ok) {
      setTradeEditError(feeParsed.error);
      return;
    }
    const fee = feeParsed.value;

    if (quantity <= 0) {
      setTradeEditError('Количество должно быть больше 0.');
      return;
    }
    if (pricePerUnit <= 0) {
      setTradeEditError('Цена за единицу должна быть больше 0.');
      return;
    }
    if (fee < 0) {
      setTradeEditError('Комиссия должна быть не меньше 0.');
      return;
    }

    const position = positions.find((p) => p.id === trade.position_id);
    const brokerAccount = accountsById.get(trade.broker_account_id);
    if (!position || !brokerAccount) {
      setTradeEditError('Позиция или брокерский счёт не найдены.');
      return;
    }

    const amount =
      trade.side === 'buy' ? quantity * pricePerUnit + fee : quantity * pricePerUnit - fee;
    if (amount < 0) {
      setTradeEditError('При Sell комиссия не может превышать сумму сделки.');
      return;
    }

    if (trade.side === 'sell' && quantity > position.quantity) {
      setTradeEditError(`Количество для продажи (${quantity}) превышает текущую позицию (${position.quantity}).`);
      return;
    }

    if (trade.side === 'buy') {
      const currentBalance = accountBalances.get(trade.broker_account_id)?.balance || 0;
      if (amount > currentBalance + trade.total_amount) {
        setTradeEditError('Недостаточно средств на брокерском счёте.');
        return;
      }
    }

    setTradeEditError(null);
    setSavingTradeEdit(true);

    try {
      const positionDelta =
        trade.side === 'buy' ? quantity - trade.quantity : trade.quantity - quantity;
      const newPositionQty = position.quantity + positionDelta;

      const { error: posError } = await supabase
        .from('positions')
        .update({ quantity: newPositionQty })
        .eq('id', position.id)
        .eq('user_id', userId);

      if (posError) {
        setTradeEditError(`Ошибка обновления позиции: ${posError.message}`);
        setSavingTradeEdit(false);
        return;
      }

      const { error: txError } = await supabase
        .from('transactions')
        .update({ amount, comment: editTradeComment.trim() || null })
        .eq('id', trade.transaction_id)
        .eq('user_id', userId);

      if (txError) {
        setTradeEditError(`Ошибка обновления транзакции: ${txError.message}`);
        setSavingTradeEdit(false);
        return;
      }

      const { error: tradeError } = await supabase
        .from('investment_trades')
        .update({
          quantity,
          price_per_unit: pricePerUnit,
          fee,
          total_amount: amount,
          comment: editTradeComment.trim() || null,
        })
        .eq('id', trade.id)
        .eq('user_id', userId);

      if (tradeError) {
        setTradeEditError(`Ошибка обновления сделки: ${tradeError.message}`);
        setSavingTradeEdit(false);
        return;
      }

      await Promise.all([loadPositions(userId), loadTransactions(userId), loadInvestmentTrades(userId)]);
      handleCancelEditTrade();
    } catch (err: any) {
      setTradeEditError(err.message || 'Ошибка при сохранении');
    } finally {
      setSavingTradeEdit(false);
    }
  };

  const handleDeleteInvestmentTrade = async (trade: InvestmentTrade) => {
    if (!userId || !sessionToken) return;
    if (!window.confirm('Вы уверены, что хотите удалить эту сделку?')) return;

    setTradeDeleteMessage(null);
    setDeletingTradeId(trade.id);

    try {
      const response = await fetch('/api/investments/trades/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ trade_id: trade.id }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        setTradeDeleteMessage({
          type: 'error',
          text: data.error || 'Ошибка при удалении сделки',
        });
        return;
      }

      setTradeDeleteMessage({ type: 'success', text: 'Сделка удалена.' });
      await Promise.all([
        loadAccounts(),
        loadPositions(userId),
        loadTransactions(userId),
        loadInvestmentTrades(userId),
      ]);
      setTimeout(() => setTradeDeleteMessage(null), 3000);
    } catch (err: any) {
      setTradeDeleteMessage({
        type: 'error',
        text: err.message || 'Ошибка при удалении',
      });
    } finally {
      setDeletingTradeId(null);
    }
  };

  // Автовыбор счетов по умолчанию при загрузке данных
  useEffect(() => {
    if (accounts.length === 0) return;

    // Автовыбор для Income
    if (!accountIncomeManuallySet && accountIncome === '') {
      const defaultIncomeAccount = accounts.find((a) => a.is_default_income);
      if (defaultIncomeAccount) {
        setAccountIncome(defaultIncomeAccount.id);
      } else if (accounts.length > 0) {
        setAccountIncome(accounts[0].id);
      }
    } else if (accountIncome && !accounts.find((a) => a.id === accountIncome)) {
      // Если выбранный счёт исчез, сбросить и выбрать заново
      setAccountIncomeManuallySet(false);
      const defaultIncomeAccount = accounts.find((a) => a.is_default_income);
      if (defaultIncomeAccount) {
        setAccountIncome(defaultIncomeAccount.id);
      } else if (accounts.length > 0) {
        setAccountIncome(accounts[0].id);
      }
    }

    // Автовыбор для Expense
    if (!accountExpenseManuallySet && accountExpense === '') {
      const defaultExpenseAccount = accounts.find((a) => a.is_default_expense);
      if (defaultExpenseAccount) {
        setAccountExpense(defaultExpenseAccount.id);
      } else if (accounts.length > 0) {
        setAccountExpense(accounts[0].id);
      }
    } else if (accountExpense && !accounts.find((a) => a.id === accountExpense)) {
      // Если выбранный счёт исчез, сбросить и выбрать заново
      setAccountExpenseManuallySet(false);
      const defaultExpenseAccount = accounts.find((a) => a.is_default_expense);
      if (defaultExpenseAccount) {
        setAccountExpense(defaultExpenseAccount.id);
      } else if (accounts.length > 0) {
        setAccountExpense(accounts[0].id);
      }
    }
  }, [accounts, accountIncome, accountExpense, accountIncomeManuallySet, accountExpenseManuallySet]);

  // Update fromAccountTransfer when credit account is selected for repayment
  useEffect(() => {
    if (isCreditRepayment && toAccountTransfer) {
      const creditAccount = accountsById.get(toAccountTransfer);
      if (creditAccount && creditAccount.debit_anchor_account_id) {
        setFromAccountTransfer(creditAccount.debit_anchor_account_id);
        // Check currency mismatch
        const debitAccount = accountsById.get(creditAccount.debit_anchor_account_id);
        if (creditAccount && debitAccount) {
          const creditCurrency = getAccountCurrency(creditAccount);
          const debitCurrency = getAccountCurrency(debitAccount);
          if (creditCurrency !== debitCurrency) {
            setTransferCurrencyError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
          } else {
            setTransferCurrencyError(null);
          }
        }
      }
    } else if (!isCreditRepayment) {
      setFromAccountTransfer('');
      setTransferCurrencyError(null);
    }
  }, [isCreditRepayment, toAccountTransfer, accountsById]);

  if (!sessionChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-700">
        Проверяем сессию...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-6 py-4 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Главная</h1>
            <p className="text-sm text-neutral-600">Управление финансами</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleManualRefresh}
              disabled={refreshLoading}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              🔄 Refresh prices
            </button>
            <button
              onClick={() => router.push('/setup')}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              Настройки
            </button>
            <button
              onClick={() => router.push('/stats')}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              Статистика
            </button>
            <button
              onClick={handleLogout}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              Logout
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {refreshLoading && (
          <div className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
            Обновляем котировки и FX...
          </div>
        )}

        {refreshError && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{refreshError}</div>
        )}

        {refreshSummary && !refreshLoading && !refreshError && (
          <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Updated {refreshSummary.updated}, Skipped {refreshSummary.skipped}, Errors {refreshSummary.errors}
          </div>
        )}

        {fxError && (
          <div className="rounded-lg bg-yellow-50 px-4 py-3 text-xs text-yellow-700">
            FX load error: {fxError}
          </div>
        )}

        {/* Operations form - moved to top */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Операции</h2>

          <div className="grid gap-6 md:grid-cols-4">
            {/* Income */}
            <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Income</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сумма</label>
                  <input
                    type="text"
                    value={amountIncome}
                    onChange={(e) => setAmountIncome(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Куда</label>
                    <select
                      value={accountIncome}
                      onChange={(e) => {
                        setAccountIncome(e.target.value);
                        setAccountIncomeManuallySet(true);
                      }}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    >
                      <option value="">Выберите счёт</option>
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({acc.kind}) {getCurrencySymbol(acc.currency)}
                        </option>
                      ))}
                    </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Категория (опционально)
                  </label>
                  <select
                    value={categoryIncome}
                    onChange={(e) => setCategoryIncome(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="">Без категории</option>
                    {incomeCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Комментарий (опционально)
                  </label>
                  <input
                    type="text"
                    value={commentIncome}
                    onChange={(e) => setCommentIncome(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="Комментарий"
                  />
                </div>
                <button
                  onClick={handleIncome}
                  disabled={submittingIncome}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {submittingIncome ? 'Сохранение...' : 'Ввод Income'}
                </button>
              </div>
            </div>

            {/* Expense */}
              <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Expense</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сумма</label>
                  <input
                    type="text"
                    value={amountExpense}
                    onChange={(e) => setAmountExpense(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Откуда</label>
                    <select
                      value={accountExpense}
                      onChange={(e) => {
                        setAccountExpense(e.target.value);
                        setAccountExpenseManuallySet(true);
                      }}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    >
                      <option value="">Выберите счёт</option>
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({acc.kind}) {getCurrencySymbol(acc.currency)}
                        </option>
                      ))}
                    </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Категория (опционально)
                  </label>
                  <select
                    value={categoryExpense}
                    onChange={(e) => setCategoryExpense(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="">Без категории</option>
                    {expenseCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Комментарий (опционально)
                  </label>
                  <input
                    type="text"
                    value={commentExpense}
                    onChange={(e) => setCommentExpense(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="Комментарий"
                  />
                </div>
                <button
                  onClick={handleExpense}
                  disabled={submittingExpense}
                  className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {submittingExpense ? 'Сохранение...' : 'Ввод Expense'}
                </button>
              </div>
            </div>

            {/* Transfer */}
              <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Transfer</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сумма</label>
                  <input
                    type="text"
                    value={amountTransfer}
                    onChange={(e) => setAmountTransfer(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                </div>
                <div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isCreditRepayment}
                      onChange={(e) => setIsCreditRepayment(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-xs font-medium text-neutral-700">Погашение кредита</span>
                  </label>
                </div>
                {!isCreditRepayment ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Откуда</label>
                      <select
                        value={fromAccountTransfer}
                        onChange={(e) => {
                          setFromAccountTransfer(e.target.value);
                          setTransferCurrencyError(null);
                          // Check currency mismatch
                          if (e.target.value && toAccountTransfer) {
                            const fromAcc = accountsById.get(e.target.value);
                            const toAcc = accountsById.get(toAccountTransfer);
                            if (fromAcc && toAcc) {
                              const fromCurrency = getAccountCurrency(fromAcc);
                              const toCurrency = getAccountCurrency(toAcc);
                              if (fromCurrency !== toCurrency) {
                                setTransferCurrencyError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
                              } else {
                                setTransferCurrencyError(null);
                              }
                            }
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.kind}) {getCurrencySymbol(acc.currency)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Куда</label>
                      <select
                        value={toAccountTransfer}
                        onChange={(e) => {
                          setToAccountTransfer(e.target.value);
                          setTransferCurrencyError(null);
                          // Check currency mismatch
                          if (e.target.value && fromAccountTransfer) {
                            const fromAcc = accountsById.get(fromAccountTransfer);
                            const toAcc = accountsById.get(e.target.value);
                            if (fromAcc && toAcc) {
                              const fromCurrency = getAccountCurrency(fromAcc);
                              const toCurrency = getAccountCurrency(toAcc);
                              if (fromCurrency !== toCurrency) {
                                setTransferCurrencyError('Перевод между счетами с разной валютой запрещён в v1. Выберите счета с одинаковой валютой.');
                              } else {
                                setTransferCurrencyError(null);
                              }
                            }
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.kind}) {getCurrencySymbol(acc.currency)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Куда (кредитка)</label>
                      <select
                        value={toAccountTransfer}
                        onChange={(e) => {
                          setToAccountTransfer(e.target.value);
                          setTransferCurrencyError(null);
                        }}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Выберите кредитный счёт</option>
                        {creditAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} {getCurrencySymbol(acc.currency)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {fromAccountTransfer && (
                      <div>
                        <label className="block text-xs font-medium text-neutral-700">Откуда</label>
                        <input
                          type="text"
                          value={accountsById.get(fromAccountTransfer)?.name || ''}
                          disabled
                          className="mt-1 w-full rounded-lg border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm"
                        />
                        <p className="mt-1 text-xs text-neutral-500">
                          Автоматически выбран привязанный дебетовый счёт
                        </p>
                      </div>
                    )}
                  </>
                )}
                {transferCurrencyError && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {transferCurrencyError}
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Комментарий (опционально)
                  </label>
                  <input
                    type="text"
                    value={commentTransfer}
                    onChange={(e) => setCommentTransfer(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="Комментарий"
                  />
                </div>
                <button
                  onClick={handleTransfer}
                  disabled={submittingTransfer || !!transferCurrencyError}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {submittingTransfer ? 'Сохранение...' : 'Ввод Transfer'}
                </button>
              </div>
            </div>

            {/* Invest Buy / Sell */}
            <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Invest Buy / Sell</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Брокер</label>
                  <select
                    value={investBroker}
                    onChange={(e) => setInvestBroker(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="">Выберите брокера</option>
                    {brokerAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} {getCurrencySymbol(acc.currency)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Инструмент</label>
                  <select
                    value={investInstrument}
                    onChange={(e) => setInvestInstrument(e.target.value)}
                    disabled={!investBroker}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200 disabled:bg-neutral-100"
                  >
                    <option value="">Выберите инструмент</option>
                    {positionsByBroker.map((pos) => (
                      <option key={pos.id} value={pos.id}>
                        {getPositionSymbol(pos)} (qty: {pos.quantity})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сторона</label>
                  <select
                    value={investSide}
                    onChange={(e) => setInvestSide(e.target.value as 'Buy' | 'Sell')}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="Buy">Buy</option>
                    <option value="Sell">Sell</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Количество</label>
                  <input
                    type="text"
                    value={investQuantity}
                    onChange={(e) => setInvestQuantity(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                  {parseFloat(investQuantity) <= 0 && investQuantity !== '' && (
                    <p className="mt-1 text-xs text-red-600">Количество должно быть &gt; 0</p>
                  )}
                  {investSide === 'Sell' && investInstrument && (
                    <p className="mt-1 text-xs text-neutral-500">
                      При Sell количество должно быть ≤ текущей позиции (проверка позже)
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Цена за единицу</label>
                  <input
                    type="text"
                    value={investPricePerUnit}
                    onChange={(e) => setInvestPricePerUnit(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Комиссия (опционально)</label>
                  <input
                    type="text"
                    value={investFee}
                    onChange={(e) => setInvestFee(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0"
                  />
                  {parseFloat(investFee) < 0 && investFee !== '' && (
                    <p className="mt-1 text-xs text-red-600">Комиссия должна быть ≥ 0</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Комментарий (опционально)</label>
                  <input
                    type="text"
                    value={investComment}
                    onChange={(e) => setInvestComment(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="Комментарий"
                  />
                </div>
                {(() => {
                  const qty = parseFloat(investQuantity);
                  const price = parseFloat(investPricePerUnit);
                  const fee = parseFloat(investFee);
                  const valid =
                    investBroker &&
                    investInstrument &&
                    !Number.isNaN(qty) &&
                    qty > 0 &&
                    !Number.isNaN(price) &&
                    price > 0 &&
                    !Number.isNaN(fee) &&
                    fee >= 0;
                  const canBuy = valid && investSide === 'Buy';
                  const canSell = valid && investSide === 'Sell';
                  const sellQtyOk =
                    investSide !== 'Sell' ||
                    !investInstrument ||
                    parseFloat(investQuantity) <= (positions.find((p) => p.id === investInstrument)?.quantity ?? 0);
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => handleInvestSubmit('Buy')}
                        disabled={!canBuy || submittingInvest}
                        className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                      >
                        {submittingInvest ? 'Сохранение...' : 'Submit Buy'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInvestSubmit('Sell')}
                        disabled={!canSell || !sellQtyOk || submittingInvest}
                        className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                      >
                        {submittingInvest ? 'Сохранение...' : 'Submit Sell'}
                      </button>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* Summary */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Сводка (в EUR)</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs text-neutral-600">Общий баланс (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.totalEur.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Debit (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.debitEur.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Credit (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.creditEur.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Cash (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.cashEur.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Broker (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.brokerCashEur.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Invest (EUR)</p>
              <p className="text-2xl font-semibold text-neutral-900">
                €{totals.investEur.toFixed(2)}
              </p>
            </div>
          </div>
          {totals.usdExcludedFromTotals && (
            <p className="mt-2 text-xs text-yellow-700">
              Курс FX не загружен: USD-счета временно исключены из EUR-итогов.
            </p>
          )}
        </section>

        {/* Accounts list */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-neutral-900">Счета</h2>
            {accounts.length > 0 && (
              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAccountsFilterOpen((o) => !o)}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
                  >
                    Фильтр счетов
                  </button>
                  {accountsFilterOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 min-w-[200px] rounded-lg border border-neutral-200 bg-white py-2 shadow-lg">
                    <div className="max-h-48 overflow-y-auto px-3 py-1">
                      {accounts.map((acc) => (
                        <label
                          key={acc.id}
                          className="flex cursor-pointer items-center gap-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50"
                        >
                          <input
                            type="checkbox"
                            checked={!hiddenAccountIds.has(acc.id)}
                            onChange={() => toggleAccountVisibility(acc.id)}
                            className="h-4 w-4 rounded border-neutral-300"
                          />
                          <span>{acc.name}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2 border-t border-neutral-100 px-3 pt-2">
                      <button
                        type="button"
                        onClick={selectAllAccounts}
                        className="rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
                      >
                        Выбрать все
                      </button>
                      <button
                        type="button"
                        onClick={clearAccountsFilter}
                        className="rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
                      >
                        Сбросить
                      </button>
                    </div>
                  </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {accounts.length === 0 ? (
            <p className="text-sm text-neutral-600">Нет счетов. Создайте счёт в настройках.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {visibleAccounts.map((account) => {
                const accBalance = accountBalances.get(account.id);
                if (!accBalance) return null;

                const statusColors = {
                  normal: 'border-neutral-200',
                  orange: 'border-orange-400 bg-orange-50',
                  red: 'border-red-500 bg-red-50',
                };

                return (
                  <div
                    key={account.id}
                    className={`rounded-lg border-2 px-4 py-3 ${statusColors[accBalance.status]}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-neutral-900">{account.name}</p>
                        <p className="text-xs uppercase text-neutral-500">{account.kind}</p>
                      </div>
                      {(accBalance.status === 'orange' || accBalance.status === 'red') && (
                        <span
                          className={`text-xs font-semibold ${
                            accBalance.status === 'red' ? 'text-red-700' : 'text-orange-700'
                          }`}
                        >
                          {accBalance.status === 'red' ? '🔴' : '🟧'}
                        </span>
                      )}
                    </div>
                    <div className="mt-2">
                      <p className="text-lg font-semibold text-neutral-900">
                        {formatMoney(accBalance.balance, getAccountCurrency(account))}
                        {getAccountCurrency(account) === 'USD' && fxRate && (
                          <span className="ml-1 text-sm font-normal text-neutral-500">
                            (≈ €{(accBalance.balance * fxRate).toFixed(2)})
                          </span>
                        )}
                        {getAccountCurrency(account) === 'USD' && !fxRate && (
                          <span className="ml-1 text-sm font-normal text-neutral-400">
                            (≈ € — FX not loaded)
                          </span>
                        )}
                      </p>
                      {account.kind === 'credit' && accBalance.creditUsed !== undefined && (
                        <p className="mt-1 text-xs text-neutral-600">
                          Использовано кредита: {formatMoney(accBalance.creditUsed, getAccountCurrency(account))} из{' '}
                          {formatMoney(account.credit_limit || 0, getAccountCurrency(account))}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Last operations */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="mb-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-neutral-900">Последние операции</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOperationsPage((p) => Math.max(0, p - 1))}
                  disabled={operationsPage === 0}
                  className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ←
                </button>
                <span className="text-xs text-neutral-600">
                  Страница {operationsPage + 1}
                </span>
                <button
                  onClick={() => setOperationsPage((p) => p + 1)}
                  disabled={
                    (operationsPage + 1) * OPERATIONS_PER_PAGE >=
                    transfers.length + transactions.filter((t) => t.kind !== 'transfer' && !t.is_investment).length
                  }
                  className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  →
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              <div className="flex flex-col gap-1">
                <span className="font-medium text-neutral-700">Счёт</span>
                <select
                  value={operationsAccountFilter}
                  onChange={(e) => setOperationsAccountFilter(e.target.value)}
                  className="min-w-[160px] rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                >
                  <option value="all">Все счета</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-neutral-700">Категория</span>
                <select
                  value={operationsCategoryFilter}
                  onChange={(e) => setOperationsCategoryFilter(e.target.value)}
                  className="min-w-[160px] rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                >
                  <option value="all">Все категории</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-neutral-700">Тип</span>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setOperationsTypeFilter('all')}
                    className={`rounded-full px-3 py-1 text-xs font-medium border ${
                      operationsTypeFilter === 'all'
                        ? 'border-neutral-900 bg-neutral-900 text-white'
                        : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100'
                    }`}
                  >
                    Все
                  </button>
                  <button
                    type="button"
                    onClick={() => setOperationsTypeFilter('income')}
                    className={`rounded-full px-3 py-1 text-xs font-medium border ${
                      operationsTypeFilter === 'income'
                        ? 'border-emerald-700 bg-emerald-700 text-white'
                        : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100'
                    }`}
                  >
                    Доход
                  </button>
                  <button
                    type="button"
                    onClick={() => setOperationsTypeFilter('expense')}
                    className={`rounded-full px-3 py-1 text-xs font-medium border ${
                      operationsTypeFilter === 'expense'
                        ? 'border-red-700 bg-red-700 text-white'
                        : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100'
                    }`}
                  >
                    Расход
                  </button>
                  <button
                    type="button"
                    onClick={() => setOperationsTypeFilter('transfer')}
                    className={`rounded-full px-3 py-1 text-xs font-medium border ${
                      operationsTypeFilter === 'transfer'
                        ? 'border-blue-700 bg-blue-700 text-white'
                        : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100'
                    }`}
                  >
                    Перевод
                  </button>
                </div>
              </div>
            </div>
          </div>

          {(() => {
            // Объединяем transfers и transactions для отображения
            const allOperations: Array<{
              id: string;
              type: 'income' | 'expense' | 'transfer';
              amount: number;
              accountId?: string;
              fromAccountId?: string;
              toAccountId?: string;
              accountName?: string;
              accountCurrency?: AccountCurrency;
              fromAccountName?: string;
              fromAccountCurrency?: AccountCurrency;
              toAccountName?: string;
              toAccountCurrency?: AccountCurrency;
              categoryId?: string;
              categoryName?: string;
              comment: string | null;
              date: string;
            }> = [];

            // Добавляем transfers
            transfers.forEach((transfer) => {
              const fromAccount = accountsById.get(transfer.from_account_id);
              const toAccount = accountsById.get(transfer.to_account_id);
              allOperations.push({
                id: transfer.id,
                type: 'transfer',
                amount: transfer.amount,
                fromAccountId: transfer.from_account_id,
                toAccountId: transfer.to_account_id,
                fromAccountName: fromAccount?.name,
                fromAccountCurrency: fromAccount ? getAccountCurrency(fromAccount) : 'EUR',
                toAccountName: toAccount?.name,
                toAccountCurrency: toAccount ? getAccountCurrency(toAccount) : 'EUR',
                comment: transfer.comment,
                date: transfer.created_at,
              });
            });

            // Добавляем income/expense transactions (исключаем transfer и investment)
            transactions
              .filter((t) => t.kind !== 'transfer' && !t.is_investment)
              .forEach((tx) => {
                const account = accountsById.get(tx.account_id);
                const category = categories.find((c) => c.id === tx.category_id);
                allOperations.push({
                  id: tx.id,
                  type: tx.kind as 'income' | 'expense',
                  amount: tx.amount,
                  accountId: tx.account_id,
                  accountName: account?.name,
                  accountCurrency: account ? getAccountCurrency(account) : 'EUR',
                  categoryId: tx.category_id || undefined,
                  categoryName: category?.name,
                  comment: tx.comment,
                  date: tx.created_at,
                });
              });

            // Применяем фильтры
            const filteredOperations = allOperations.filter((op) => {
              // Фильтр по типу
              if (operationsTypeFilter !== 'all' && op.type !== operationsTypeFilter) {
                return false;
              }

              // Фильтр по счёту
              if (operationsAccountFilter !== 'all') {
                if (op.type === 'transfer') {
                  if (op.fromAccountId !== operationsAccountFilter && op.toAccountId !== operationsAccountFilter) {
                    return false;
                  }
                } else {
                  if (op.accountId !== operationsAccountFilter) {
                    return false;
                  }
                }
              }

              // Фильтр по категории
              if (operationsCategoryFilter !== 'all') {
                // Для переводов категория не применяется — при выборе категории скрываем переводы
                if (op.type === 'transfer') {
                  return false;
                }
                if (op.categoryId !== operationsCategoryFilter) {
                  return false;
                }
              }

              return true;
            });

            // Сортируем по дате (новые сначала)
            filteredOperations.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            // Пагинация
            const startIndex = operationsPage * OPERATIONS_PER_PAGE;
            const endIndex = startIndex + OPERATIONS_PER_PAGE;
            const paginatedOperations = filteredOperations.slice(startIndex, endIndex);

            if (paginatedOperations.length === 0) {
              return (
                <p className="text-sm text-neutral-600">Нет операций. Добавьте первую операцию.</p>
              );
            }

            return (
              <div className="space-y-2">
                {paginatedOperations.map((op) => (
                  <div
                    key={op.id}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                          op.type === 'income'
                            ? 'bg-emerald-100 text-emerald-700'
                            : op.type === 'expense'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-blue-100 text-blue-700'
                        }`}
                      >
                        {op.type === 'income' ? '+' : op.type === 'expense' ? '-' : '⇄'}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-neutral-900">
                          {op.type === 'income' && 'Доход'}
                          {op.type === 'expense' && 'Расход'}
                          {op.type === 'transfer' && 'Перевод'}
                        </p>
                        <div className="text-xs text-neutral-600">
                          {op.type === 'transfer' ? (
                            <>
                              {op.fromAccountName} → {op.toAccountName}
                            </>
                          ) : (
                            <>
                              {op.accountName}
                              {op.categoryName && ` • ${op.categoryName}`}
                            </>
                          )}
                          {op.comment && ` • ${op.comment}`}
                        </div>
                        <p className="text-xs text-neutral-500">
                          {new Date(op.date).toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const opCurrency = op.type === 'transfer' 
                          ? (op.fromAccountCurrency || 'EUR')
                          : (op.accountCurrency || 'EUR');
                        const formattedAmount = formatMoney(op.amount, opCurrency);
                        const showEurEquivalent = opCurrency === 'USD' && fxRate;
                        const eurAmount = opCurrency === 'USD' && fxRate ? op.amount * fxRate : null;
                        
                        return (
                          <>
                            <p
                              className={`text-base font-semibold ${
                                op.type === 'income'
                                  ? 'text-emerald-700'
                                  : op.type === 'expense'
                                    ? 'text-red-700'
                                    : 'text-blue-700'
                              }`}
                            >
                              {op.type === 'income' ? '+' : op.type === 'expense' ? '-' : ''}
                              {formattedAmount}
                              {showEurEquivalent && eurAmount && (
                                <span className="ml-1 text-sm font-normal text-neutral-500">
                                  (≈ €{eurAmount.toFixed(2)})
                                </span>
                              )}
                              {opCurrency === 'USD' && !fxRate && (
                                <span className="ml-1 text-sm font-normal text-neutral-400">
                                  (≈ € — FX not loaded)
                                </span>
                              )}
                            </p>
                          </>
                        );
                      })()}
                      <button
                        onClick={() => handleEditOperation(op)}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteOperation(op)}
                        className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </section>

        {/* Последние операции с ценными бумагами */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">
            Последние операции с ценными бумагами
          </h2>
          {tradeDeleteMessage && (
            <div
              className={`mb-4 rounded-lg px-4 py-3 text-sm ${
                tradeDeleteMessage.type === 'success'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              {tradeDeleteMessage.text}
            </div>
          )}
          {investmentTrades.length === 0 ? (
            <p className="text-sm text-neutral-600">Нет сделок с ценными бумагами.</p>
          ) : (
            <div className="space-y-2">
              {investmentTrades.map((trade) => {
                const brokerAccount = accountsById.get(trade.broker_account_id);
                const position = positions.find((p) => p.id === trade.position_id);
                const symbol = position ? getPositionSymbol(position) : '—';
                const currency = (brokerAccount?.currency || 'EUR') as AccountCurrency;
                const curSym = getCurrencySymbol(currency);
                return (
                  <div
                    key={trade.id}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                          trade.side === 'buy' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {trade.side === 'buy' ? 'B' : 'S'}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-neutral-900">
                          {trade.side === 'buy' ? 'Buy' : 'Sell'} {symbol} × {trade.quantity}
                        </p>
                        <div className="text-xs text-neutral-600">
                          {brokerAccount?.name ?? '—'} • {trade.price_per_unit} {curSym}/ед.
                          {trade.fee > 0 && ` • fee ${trade.fee} ${curSym}`}
                        </div>
                        <p className="text-xs text-neutral-500">
                          {new Date(trade.created_at).toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                        {trade.comment && (
                          <p className="mt-1 text-xs text-neutral-500">{trade.comment}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-base font-semibold text-neutral-900">
                        {formatMoney(trade.total_amount, currency)}
                      </p>
                      <button
                        onClick={() => handleEditInvestmentTrade(trade)}
                        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteInvestmentTrade(trade)}
                        disabled={deletingTradeId === trade.id}
                        className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingTradeId === trade.id ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Модальное окно редактирования сделки */}
        {editingTradeId && (() => {
          const trade = investmentTrades.find((t) => t.id === editingTradeId);
          if (!trade) return null;
          const position = positions.find((p) => p.id === trade.position_id);
          const symbol = position ? getPositionSymbol(position) : '—';
          const brokerAccount = accountsById.get(trade.broker_account_id);
          const curSym = getCurrencySymbol(brokerAccount?.currency ?? null);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
              <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-lg">
                <h3 className="mb-4 text-lg font-semibold text-neutral-900">
                  Редактировать сделку {trade.side === 'buy' ? 'Buy' : 'Sell'} {symbol}
                </h3>

                {tradeEditError && (
                  <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                    {tradeEditError}
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-neutral-700">Количество</label>
                    <input
                      type="text"
                      value={editTradeQuantity}
                      onChange={(e) => setEditTradeQuantity(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="0"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-700">
                      Цена за единицу ({curSym})
                    </label>
                    <input
                      type="text"
                      value={editTradePrice}
                      onChange={(e) => setEditTradePrice(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="0"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-700">
                      Комиссия ({curSym})
                    </label>
                    <input
                      type="text"
                      value={editTradeFee}
                      onChange={(e) => setEditTradeFee(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="0"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-700">
                      Комментарий (опционально)
                    </label>
                    <input
                      type="text"
                      value={editTradeComment}
                      onChange={(e) => setEditTradeComment(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="Комментарий"
                    />
                  </div>
                </div>

                <div className="mt-6 flex gap-3">
                  <button
                    onClick={handleCancelEditTrade}
                    disabled={savingTradeEdit}
                    className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleSaveEditTrade}
                    disabled={savingTradeEdit}
                    className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                  >
                    {savingTradeEdit ? 'Сохранение...' : 'Сохранить'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Модальное окно редактирования */}
        {editingOperation && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-lg">
              <h3 className="mb-4 text-lg font-semibold text-neutral-900">
                Редактировать {editingOperation.type === 'income' ? 'Доход' : editingOperation.type === 'expense' ? 'Расход' : 'Перевод'}
              </h3>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сумма</label>
                  <input
                    type="text"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Можно вводить выражение: 5+6-2, поддерживаются + - * / ( )
                  </p>
                </div>

                {editingOperation.type === 'transfer' ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Откуда</label>
                      <select
                        value={editFromAccount}
                        onChange={(e) => setEditFromAccount(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        disabled
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.kind})
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-neutral-500">
                        Счета для Transfer нельзя изменить
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Куда</label>
                      <select
                        value={editToAccount}
                        onChange={(e) => setEditToAccount(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        disabled
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.kind})
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">
                        {editingOperation.type === 'income' ? 'Куда' : 'Откуда'}
                      </label>
                      <select
                        value={editAccount}
                        onChange={(e) => setEditAccount(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.kind})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">
                        Категория (опционально)
                      </label>
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Без категории</option>
                        {(editingOperation.type === 'income' ? incomeCategories : expenseCategories).map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-xs font-medium text-neutral-700">
                    Комментарий (опционально)
                  </label>
                  <input
                    type="text"
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="Комментарий"
                  />
                </div>
              </div>

              <div className="mt-6 flex gap-3">
                <button
                  onClick={handleCancelEdit}
                  disabled={savingEdit}
                  className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={savingEdit}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {savingEdit ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
