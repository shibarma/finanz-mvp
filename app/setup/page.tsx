'use client';

import { useEffect, useMemo, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';
import { parseMoneyExpression } from '../../lib/parseMoneyExpression';

type AccountKind = 'debit' | 'credit' | 'cash' | 'broker' | 'crypto';
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

type CategoryKind = 'income' | 'expense';

interface Category {
  id: string;
  user_id: string;
  kind: CategoryKind;
  name: string;
  created_at: string;
  sort_order: number | null;
}

type InstrumentKind = 'stock' | 'etf' | 'bond' | 'crypto' | 'other';

interface Instrument {
  id: string;
  user_id: string;
  kind: InstrumentKind;
  provider: string;
  provider_symbol: string;
  display_symbol: string;
  name: string | null;
  created_at: string;
}

interface Position {
  id: string;
  user_id: string;
  broker_account_id: string;
  instrument_id: string;
  quote_currency: string;
  quantity: number;
  comment: string | null;
  last_price: number;
  last_price_at: string;
  created_at: string;
}

interface PositionWithInstrument extends Position {
  instrument: Instrument;
}

interface Budget {
  id: string;
  user_id: string;
  name: string;
  base_limit_eur: number;
  start_date: string;
  carry_over: boolean;
  created_at: string;
}

// Parse base_limit_eur: accepts "," and "." as decimal separator, rounds to 2 decimals
function parseBaseLimitEur(input: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!input || !input.trim()) return { ok: false, error: 'Enter amount.' };
  const normalized = input.trim().replace(/,/g, '.');
  const num = Number(normalized);
  if (Number.isNaN(num)) return { ok: false, error: 'Invalid number.' };
  const rounded = Math.round(num * 100) / 100;
  if (rounded <= 0) return { ok: false, error: 'Limit must be greater than 0.' };
  return { ok: true, value: rounded };
}

// Simple helper for future reuse
async function requireSessionOrRedirect(router: ReturnType<typeof useRouter>) {
  const session = await getSession();
  if (!session) {
    router.replace('/login');
    return null;
  }
  return session;
}

export default function SetupPage() {
  const router = useRouter();

  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  // Category editing
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [categoryEditError, setCategoryEditError] = useState<string | null>(null);
  const [categoryEditSubmitting, setCategoryEditSubmitting] = useState(false);
  const [categoryDeleteError, setCategoryDeleteError] = useState<string | null>(null);
  const [movingCategoryId, setMovingCategoryId] = useState<string | null>(null);
  const [moveCategoryError, setMoveCategoryError] = useState<string | null>(null);

  // Accounts form
  const [accountName, setAccountName] = useState('');
  const [accountKind, setAccountKind] = useState<AccountKind>('debit');
  const [accountCurrency, setAccountCurrency] = useState<AccountCurrency>('EUR');
  const [startingBalance, setStartingBalance] = useState('0');
  const [warningThreshold, setWarningThreshold] = useState('500');
  const [creditLimit, setCreditLimit] = useState('10000');
  const [creditWarningThreshold, setCreditWarningThreshold] = useState('100');
  const [debitAnchorAccountId, setDebitAnchorAccountId] = useState<string>('');
  const [isDefaultIncome, setIsDefaultIncome] = useState(false);
  const [isDefaultExpense, setIsDefaultExpense] = useState(false);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountFormError, setAccountFormError] = useState<string | null>(null);

  // FX rates
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<{
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null>(null);

  // Account editing
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [editAccountCurrency, setEditAccountCurrency] = useState<AccountCurrency>('EUR');
  const [editStartingBalance, setEditStartingBalance] = useState('');
  const [editWarningThreshold, setEditWarningThreshold] = useState('');
  const [editCreditLimit, setEditCreditLimit] = useState('');
  const [editCreditWarningThreshold, setEditCreditWarningThreshold] = useState('');
  const [editDebitAnchorAccountId, setEditDebitAnchorAccountId] = useState<string>('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [defaultUpdating, setDefaultUpdating] = useState<Set<string>>(new Set());
  const [defaultError, setDefaultError] = useState<string | null>(null);

  // Clear operations for period
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showPeriodDeletePanel, setShowPeriodDeletePanel] = useState(false);
  const [clearingPeriod, setClearingPeriod] = useState(false);
  const [clearPeriodError, setClearPeriodError] = useState<string | null>(null);
  const [clearPeriodSuccess, setClearPeriodSuccess] = useState<string | null>(null);

  // Categories form
  const [categoryKind, setCategoryKind] = useState<CategoryKind>('income');
  const [categoryName, setCategoryName] = useState('');
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);

  // Investments/Positions (broker)
  const [selectedBrokerAccountId, setSelectedBrokerAccountId] = useState<string>('');
  const [positions, setPositions] = useState<PositionWithInstrument[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionFormError, setPositionFormError] = useState<string | null>(null);
  const [positionSubmitting, setPositionSubmitting] = useState(false);
  const [positionKind, setPositionKind] = useState<InstrumentKind>('stock');
  const [positionSymbol, setPositionSymbol] = useState('');
  const [positionQuantity, setPositionQuantity] = useState('');
  const [positionInputMode, setPositionInputMode] =
    useState<'quantity' | 'amount'>('quantity');
  const [positionAmount, setPositionAmount] = useState('');
  const [positionComment, setPositionComment] = useState('');
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [editPositionQuantity, setEditPositionQuantity] = useState('');
  const [editPositionComment, setEditPositionComment] = useState('');
  const [positionEditSubmitting, setPositionEditSubmitting] = useState(false);
  const [positionEditError, setPositionEditError] = useState<string | null>(null);
  const [positionDeleteError, setPositionDeleteError] = useState<string | null>(null);

  // Crypto positions
  const [selectedCryptoAccountId, setSelectedCryptoAccountId] = useState<string>('');
  const [cryptoPositions, setCryptoPositions] = useState<PositionWithInstrument[]>([]);
  const [cryptoPositionsLoading, setCryptoPositionsLoading] = useState(false);
  const [cryptoPositionsError, setCryptoPositionsError] = useState<string | null>(null);
  const [cryptoPositionFormError, setCryptoPositionFormError] = useState<string | null>(
    null,
  );
  const [cryptoPositionSubmitting, setCryptoPositionSubmitting] = useState(false);
  const [cryptoCoinId, setCryptoCoinId] = useState('');
  const [cryptoQuantity, setCryptoQuantity] = useState('');
  const [cryptoPositionInputMode, setCryptoPositionInputMode] = useState<
    'quantity' | 'amount'
  >('quantity');
  const [cryptoAmount, setCryptoAmount] = useState('');
  const [cryptoComment, setCryptoComment] = useState('');
  const [editingCryptoPositionId, setEditingCryptoPositionId] = useState<string | null>(
    null,
  );
  const [editCryptoPositionQuantity, setEditCryptoPositionQuantity] = useState('');
  const [editCryptoPositionComment, setEditCryptoPositionComment] = useState('');
  const [editCryptoPositionInputMode, setEditCryptoPositionInputMode] = useState<
    'quantity' | 'amount'
  >('quantity');
  const [editCryptoAmount, setEditCryptoAmount] = useState('');
  const [cryptoPositionEditSubmitting, setCryptoPositionEditSubmitting] = useState(false);
  const [cryptoPositionEditError, setCryptoPositionEditError] = useState<string | null>(
    null,
  );
  const [cryptoPositionDeleteError, setCryptoPositionDeleteError] = useState<
    string | null
  >(null);

  // Budgets
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetCategoriesMap, setBudgetCategoriesMap] = useState<Map<string, string[]>>(new Map());
  const [budgetsLoading, setBudgetsLoading] = useState(false);
  const [budgetsError, setBudgetsError] = useState<string | null>(null);
  const [budgetSuccess, setBudgetSuccess] = useState<string | null>(null);
  const [budgetName, setBudgetName] = useState('');
  const [budgetBaseLimitEur, setBudgetBaseLimitEur] = useState('');
  const [budgetStartDate, setBudgetStartDate] = useState('');
  const [budgetCarryOver, setBudgetCarryOver] = useState(false);
  const [budgetSelectedCategories, setBudgetSelectedCategories] = useState<Set<string>>(new Set());
  const [budgetSubmitting, setBudgetSubmitting] = useState(false);
  const [budgetFormError, setBudgetFormError] = useState<string | null>(null);
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null);
  const [editBudgetName, setEditBudgetName] = useState('');
  const [editBudgetBaseLimitEur, setEditBudgetBaseLimitEur] = useState('');
  const [editBudgetStartDate, setEditBudgetStartDate] = useState('');
  const [editBudgetCarryOver, setEditBudgetCarryOver] = useState(false);
  const [editBudgetSelectedCategories, setEditBudgetSelectedCategories] = useState<Set<string>>(new Set());
  const [budgetEditSubmitting, setBudgetEditSubmitting] = useState(false);
  const [budgetEditError, setBudgetEditError] = useState<string | null>(null);
  const [budgetDeleteError, setBudgetDeleteError] = useState<string | null>(null);
  const [categoryToBudgetIdsMap, setCategoryToBudgetIdsMap] = useState<Map<string, string[]>>(new Map());

  const debitAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'debit'),
    [accounts],
  );

  // Map for quick account name lookup by ID
  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((acc) => {
      map.set(acc.id, acc.name);
    });
    return map;
  }, [accounts]);

  const loadFxRate = async () => {
    if (!userId) return;

    setFxLoading(true);
    setFxError(null);

    try {
      const todayStr = new Date().toISOString().slice(0, 10);

      // First, fetch existing FX rate from fx_rates table (today's captured_date)
      const { data: existingFxRate, error: fetchError } = await supabase
        .from('fx_rates')
        .select('rate, fetched_at')
        .eq('user_id', userId)
        .eq('base_currency', 'USD')
        .eq('quote_currency', 'EUR')
        .eq('captured_date', todayStr)
        .single();

      let refreshNeeded = false;

      if (fetchError || !existingFxRate) {
        // FX rate missing - refresh needed
        refreshNeeded = true;
      } else {
        // Check if fetched_at is older than 24 hours
        const fetchedAt = new Date(existingFxRate.fetched_at);
        const now = new Date();
        const hoursDiff = (now.getTime() - fetchedAt.getTime()) / (1000 * 60 * 60);

        if (hoursDiff >= 24) {
          refreshNeeded = true;
        } else {
          // Use existing rate (still fresh)
          setFxRate(existingFxRate.rate);
          setFxLoading(false);
          return;
        }
      }

      // Check if there's at least one USD account before refreshing
      const hasUsdAccounts = accounts.some((acc) => (acc.currency || 'EUR') === 'USD');
      if (!hasUsdAccounts) {
        // No USD accounts, use existing rate if available, otherwise leave null
        if (existingFxRate) {
          setFxRate(existingFxRate.rate);
        }
        setFxLoading(false);
        return;
      }

      // Refresh needed and USD accounts exist - fetch from Frankfurter
      const response = await fetch('/api/market/fx');
      const data = await response.json();

      if (!data.ok) {
        setFxError(data.error || 'Failed to fetch FX rate');
        // Use existing rate if available, otherwise leave null
        if (existingFxRate) {
          setFxRate(existingFxRate.rate);
        }
        setFxLoading(false);
        return;
      }

      // Upsert into fx_rates table
      const nowIso = new Date().toISOString();
      const { error: upsertError } = await supabase
        .from('fx_rates')
        .upsert(
          {
            user_id: userId,
            base_currency: 'USD',
            quote_currency: 'EUR',
            rate: data.rate,
            fetched_at: nowIso,
            captured_date: todayStr,
          },
          {
            onConflict: 'user_id,base_currency,quote_currency,captured_date',
          }
        );

      if (upsertError) {
        console.error('Error upserting FX rate:', { message: upsertError?.message, details: upsertError?.details, code: upsertError?.code, hint: upsertError?.hint });
        setFxError('Failed to save FX rate');
        // Use existing rate if available, otherwise use the fetched rate
        setFxRate(existingFxRate?.rate || data.rate);
        setFxLoading(false);
        return;
      }

      // Re-fetch fx_rates row to ensure consistency
      const { data: updatedFxRate, error: refetchError } = await supabase
        .from('fx_rates')
        .select('rate')
        .eq('user_id', userId)
        .eq('base_currency', 'USD')
        .eq('quote_currency', 'EUR')
        .eq('captured_date', todayStr)
        .single();

      if (refetchError || !updatedFxRate) {
        // Fallback to the rate we just fetched
        setFxRate(data.rate);
      } else {
        setFxRate(updatedFxRate.rate);
      }
    } catch (err) {
      setFxError(err instanceof Error ? err.message : 'Failed to fetch FX rate');
    } finally {
      setFxLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      const session = await requireSessionOrRedirect(router);
      if (!session) return;

      setUserId(session.user.id);
      const accessToken = (session as { access_token?: string }).access_token;
      setSessionToken(accessToken || null);
      setSessionChecked(true);
      await Promise.all([loadAccounts(), loadCategories(), loadBudgets()]);
    };

    init();
  }, [router]);

  useEffect(() => {
    // Load FX rate after accounts are loaded
    if (userId && accounts.length >= 0) {
      loadFxRate();
    }
  }, [userId, accounts]);

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
        await loadFxRate();
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Unexpected error while refreshing prices');
    } finally {
      setRefreshLoading(false);
    }
  };

  const loadAccounts = async () => {
    setAccountsLoading(true);
    setAccountsError(null);

    const { data, error } = await supabase
      .from('accounts')
      .select(
        'id, user_id, name, kind, currency, starting_balance, warning_threshold, credit_limit, credit_warning_threshold, debit_anchor_account_id, is_default_income, is_default_expense, created_at',
      )
      .order('created_at', { ascending: true });

    setAccountsLoading(false);

    if (error) {
      setAccountsError(error.message);
      return;
    }

    setAccounts((data || []) as Account[]);
  };

  const loadCategories = async () => {
    setCategoriesLoading(true);
    setCategoriesError(null);

    const { data, error } = await supabase
      .from('categories')
      .select('id, user_id, kind, name, created_at, sort_order')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    setCategoriesLoading(false);

    if (error) {
      setCategoriesError(error.message);
      return;
    }

    // Sort on client: kind, sort_order asc, created_at asc
    const sorted = (data || []).sort((a, b) => {
      // First by kind
      if (a.kind !== b.kind) {
        return a.kind.localeCompare(b.kind);
      }
      // Then by sort_order (nulls last)
      const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      // Finally by created_at
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    setCategories(sorted as Category[]);
  };

  const loadBudgets = async () => {
    const session = await getSession();
    if (!session?.user?.id) return;

    setBudgetsLoading(true);
    setBudgetsError(null);

    try {
      const { data: budgetsData, error: budgetsError } = await supabase
        .from('budgets')
        .select('id, user_id, name, base_limit_eur, start_date, carry_over, created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: true });

      if (budgetsError) {
        setBudgetsError(budgetsError.message);
        setBudgetsLoading(false);
        return;
      }

      const budgetList = (budgetsData || []) as Budget[];
      setBudgets(budgetList);

      if (budgetList.length === 0) {
        setBudgetCategoriesMap(new Map());
        setCategoryToBudgetIdsMap(new Map());
        setBudgetsLoading(false);
        return;
      }

      const { data: bcData, error: bcError } = await supabase
        .from('budget_categories')
        .select('budget_id, category_id')
        .in('budget_id', budgetList.map((b) => b.id));

      if (bcError) {
        setBudgetsError(bcError.message);
        setBudgetsLoading(false);
        return;
      }

      const map = new Map<string, string[]>();
      for (const b of budgetList) {
        map.set(b.id, []);
      }
      const reverseMap = new Map<string, string[]>();
      for (const row of bcData || []) {
        const r = row as { budget_id: string; category_id: string };
        const arr = map.get(r.budget_id) || [];
        arr.push(r.category_id);
        map.set(r.budget_id, arr);

        const revArr = reverseMap.get(r.category_id) || [];
        revArr.push(r.budget_id);
        reverseMap.set(r.category_id, revArr);
      }
      setBudgetCategoriesMap(map);
      setCategoryToBudgetIdsMap(reverseMap);
    } catch (err) {
      setBudgetsError(err instanceof Error ? err.message : 'Failed to load budgets');
    } finally {
      setBudgetsLoading(false);
    }
  };

  const setDefault = async (kind: 'income' | 'expense', accountId: string, value: boolean) => {
    if (!userId) return;

    const fieldName = kind === 'income' ? 'is_default_income' : 'is_default_expense';
    const updateKey = `${accountId}-${kind}`;

    setDefaultError(null);
    setDefaultUpdating((prev) => new Set(prev).add(updateKey));

    try {
      if (value) {
        // First reset flag for all user accounts
        const { error: resetError } = await supabase
          .from('accounts')
          .update({ [fieldName]: false })
          .eq('user_id', userId);

        if (resetError) {
          setDefaultError(resetError.message);
          setDefaultUpdating((prev) => {
            const next = new Set(prev);
            next.delete(updateKey);
            return next;
          });
          return;
        }

        // Then set true only for the selected account
        const { error: setError } = await supabase
          .from('accounts')
          .update({ [fieldName]: true })
          .eq('id', accountId);

        if (setError) {
          setDefaultError(setError.message);
          setDefaultUpdating((prev) => {
            const next = new Set(prev);
            next.delete(updateKey);
            return next;
          });
          return;
        }
      } else {
        // Simply set false for the selected account
        const { error: setError } = await supabase
          .from('accounts')
          .update({ [fieldName]: false })
          .eq('id', accountId);

        if (setError) {
          setDefaultError(setError.message);
          setDefaultUpdating((prev) => {
            const next = new Set(prev);
            next.delete(updateKey);
            return next;
          });
          return;
        }
      }

      // Update local state
      await loadAccounts();
    } finally {
      setDefaultUpdating((prev) => {
        const next = new Set(prev);
        next.delete(updateKey);
        return next;
      });
    }
  };

  const handleCreateAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;

    setAccountFormError(null);

    if (!accountName.trim()) {
      setAccountFormError('Account name is required.');
      return;
    }

    if (!accountCurrency) {
      setAccountFormError('Currency is required.');
      return;
    }

    if (!startingBalance.trim()) {
      setAccountFormError('Starting balance is required.');
      return;
    }

    const startingBalanceNum = Number(startingBalance);
    if (Number.isNaN(startingBalanceNum)) {
      setAccountFormError('Starting balance must be a number.');
      return;
    }

    let warningThresholdNum: number | null = null;
    let creditLimitNum: number | null = null;
    let creditWarningNum: number | null = null;
    let debitAnchorId: string | null = null;

    if (accountKind === 'credit') {
      // For credit accounts don't use warning_threshold
      if (debitAccounts.length === 0) {
        setAccountFormError('Create a debit account first to link the credit card.');
        return;
      }

      if (!creditLimit.trim()) {
        setAccountFormError('Credit limit is required.');
        return;
      }
      creditLimitNum = Number(creditLimit);
      if (Number.isNaN(creditLimitNum) || creditLimitNum <= 0) {
        setAccountFormError('Credit limit must be a positive number.');
        return;
      }

      if (!creditWarningThreshold.trim()) {
        setAccountFormError('Credit warning threshold is required.');
        return;
      }
      creditWarningNum = Number(creditWarningThreshold);
      if (Number.isNaN(creditWarningNum)) {
        setAccountFormError('Credit warning threshold must be a number.');
        return;
      }

      if (!debitAnchorAccountId) {
        setAccountFormError('Select a debit account to link the credit card.');
        return;
      }
      debitAnchorId = debitAnchorAccountId;
    } else {
      // For debit, cash and broker use warning_threshold
      const warningThresholdValue = warningThreshold || '0';
      warningThresholdNum = Number(warningThresholdValue);
      if (Number.isNaN(warningThresholdNum)) {
        setAccountFormError('Warning threshold must be a number.');
        return;
      }
    }

    setAccountSubmitting(true);

    const { data: newAccount, error } = await supabase
      .from('accounts')
      .insert({
        name: accountName.trim(),
        kind: accountKind.toLowerCase(),
        currency: accountCurrency,
        starting_balance: startingBalanceNum,
        warning_threshold: accountKind === 'credit' ? 0 : warningThresholdNum,
        credit_limit: accountKind === 'credit' ? creditLimitNum : null,
        credit_warning_threshold: accountKind === 'credit' ? creditWarningNum : null,
        debit_anchor_account_id: accountKind === 'credit' ? debitAnchorId : null,
        is_default_income: false,
        is_default_expense: false,
        user_id: userId,
      })
      .select()
      .single();

    if (error) {
      setAccountSubmitting(false);
      setAccountFormError(error.message);
      return;
    }

    // If we need to set default flags, do it after creation
    if (newAccount) {
      if (isDefaultIncome) {
        await setDefault('income', newAccount.id, true);
      }
      if (isDefaultExpense) {
        await setDefault('expense', newAccount.id, true);
      }
    }

    setAccountSubmitting(false);

    // clear form
    setAccountName('');
    setAccountCurrency('EUR');
    setStartingBalance('0');
    setWarningThreshold('500');
    setCreditLimit('10000');
    setCreditWarningThreshold('100');
    setDebitAnchorAccountId('');
    setIsDefaultIncome(false);
    setIsDefaultExpense(false);
    await loadAccounts();
    
    // If USD account was created, ensure FX rate is loaded
    if (accountCurrency === 'USD') {
      await loadFxRate();
    }
  };

  const startEditAccount = (account: Account) => {
    setEditingAccountId(account.id);
    setEditAccountName(account.name);
    setEditAccountCurrency((account.currency || 'EUR') as AccountCurrency);
    setEditStartingBalance(account.starting_balance.toString());
    setEditWarningThreshold(account.warning_threshold.toString());
    setEditCreditLimit(account.credit_limit?.toString() || '');
    setEditCreditWarningThreshold(account.credit_warning_threshold?.toString() || '');
    setEditDebitAnchorAccountId(account.debit_anchor_account_id || '');
    setEditError(null);
    setDeleteError(null);
  };

  const cancelEdit = () => {
    setEditingAccountId(null);
    setEditAccountName('');
    setEditAccountCurrency('EUR');
    setEditStartingBalance('');
    setEditWarningThreshold('');
    setEditCreditLimit('');
    setEditCreditWarningThreshold('');
    setEditDebitAnchorAccountId('');
    setEditError(null);
  };

  const handleUpdateAccount = async () => {
    if (!editingAccountId) return;

    setEditError(null);

    const account = accounts.find((a) => a.id === editingAccountId);
    if (!account) return;

    if (!editAccountName.trim()) {
      setEditError('Account name is required.');
      return;
    }

    if (!editAccountCurrency) {
      setEditError('Currency is required.');
      return;
    }

    const startingBalanceNum = Number(editStartingBalance);
    if (Number.isNaN(startingBalanceNum)) {
      setEditError('Starting balance must be a number.');
      return;
    }

    let warningThresholdNum: number | null = null;
    let creditLimitNum: number | null = null;
    let creditWarningNum: number | null = null;
    let debitAnchorId: string | null = null;

    if (account.kind === 'credit') {
      if (!editCreditLimit.trim()) {
        setEditError('Credit limit is required.');
        return;
      }
      creditLimitNum = Number(editCreditLimit);
      if (Number.isNaN(creditLimitNum) || creditLimitNum <= 0) {
        setEditError('Credit limit must be a positive number.');
        return;
      }

      if (!editCreditWarningThreshold.trim()) {
        setEditError('Credit warning threshold is required.');
        return;
      }
      creditWarningNum = Number(editCreditWarningThreshold);
      if (Number.isNaN(creditWarningNum) || creditWarningNum < 0) {
        setEditError('Credit warning threshold must be a non-negative number.');
        return;
      }

      if (!editDebitAnchorAccountId) {
        setEditError('Select a debit account to link the credit card.');
        return;
      }
      debitAnchorId = editDebitAnchorAccountId;
    } else {
      const warningThresholdValue = editWarningThreshold || '0';
      warningThresholdNum = Number(warningThresholdValue);
      if (Number.isNaN(warningThresholdNum) || warningThresholdNum < 0) {
        setEditError('Warning threshold must be a non-negative number.');
        return;
      }
    }

    setEditSubmitting(true);

    const updateData: any = {
      name: editAccountName.trim(),
      currency: editAccountCurrency,
      starting_balance: startingBalanceNum,
    };

    if (account.kind === 'credit') {
      updateData.warning_threshold = 0;
      updateData.credit_limit = creditLimitNum;
      updateData.credit_warning_threshold = creditWarningNum;
      updateData.debit_anchor_account_id = debitAnchorId;
    } else {
      updateData.warning_threshold = warningThresholdNum;
      updateData.credit_limit = null;
      updateData.credit_warning_threshold = null;
      updateData.debit_anchor_account_id = null;
    }

    const { error } = await supabase
      .from('accounts')
      .update(updateData)
      .eq('id', editingAccountId);

    setEditSubmitting(false);

    if (error) {
      setEditError(error.message);
      return;
    }

    cancelEdit();
    await loadAccounts();
    
    // If USD account was updated, ensure FX rate is loaded
    if (editAccountCurrency === 'USD') {
      await loadFxRate();
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    if (!window.confirm('Are you sure you want to delete this account?')) {
      return;
    }

    setDeleteError(null);
    setEditError(null);

    // Check 1: are there transactions
    const { count: transactionsCount } = await supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', accountId);

    if (transactionsCount && transactionsCount > 0) {
      setDeleteError(
        'Cannot delete account: it has transactions. In v1 deletion is only allowed for empty accounts.',
      );
      return;
    }

    // Check 2: are there transfers
    const { count: transfersCount } = await supabase
      .from('transfers')
      .select('*', { count: 'exact', head: true })
      .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`);

    if (transfersCount && transfersCount > 0) {
      setDeleteError(
        'Cannot delete account: it has transactions. In v1 deletion is only allowed for empty accounts.',
      );
      return;
    }

    // Check 3: for broker accounts - are there investment positions
    const account = accounts.find((a) => a.id === accountId);
    if (account && account.kind === 'broker') {
      const { count: positionsCount } = await supabase
        .from('positions')
        .select('*', { count: 'exact', head: true })
        .eq('broker_account_id', accountId);

      if (positionsCount && positionsCount > 0) {
        setDeleteError(
          'Cannot delete account: it has transactions. In v1 deletion is only allowed for empty accounts.',
        );
        return;
      }
    }

    // Check 4: is it used as debit_anchor_account_id
    if (account && account.kind === 'debit') {
      const { count: linkedCreditCount } = await supabase
        .from('accounts')
        .select('*', { count: 'exact', head: true })
        .eq('debit_anchor_account_id', accountId);

      if (linkedCreditCount && linkedCreditCount > 0) {
        setDeleteError(
          'Cannot delete debit account while credit accounts are linked to it.',
        );
        return;
      }
    }

    // Delete
    const { error } = await supabase.from('accounts').delete().eq('id', accountId);

    if (error) {
      setDeleteError(error.message);
      return;
    }

    setDeleteError(null);
    await loadAccounts();
  };

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;

    setCategoryFormError(null);

    if (!categoryName.trim()) {
      setCategoryFormError('Category name is required.');
      return;
    }

    setCategorySubmitting(true);

    // Compute sort_order: max for this kind + 10
    const categoriesOfKind = categories.filter((c) => c.kind === categoryKind);
    const maxSortOrder =
      categoriesOfKind.length > 0
        ? Math.max(...categoriesOfKind.map((c) => c.sort_order ?? 0))
        : 0;
    const newSortOrder = maxSortOrder + 10;

    const { error } = await supabase.from('categories').insert({
      kind: categoryKind,
      name: categoryName.trim(),
      user_id: userId,
      sort_order: newSortOrder,
    });

    setCategorySubmitting(false);

    if (error) {
      setCategoryFormError(error.message);
      return;
    }

    setCategoryName('');
    await loadCategories();
  };

  const startEditCategory = (category: Category) => {
    setEditingCategoryId(category.id);
    setEditCategoryName(category.name);
    setCategoryEditError(null);
  };

  const cancelEditCategory = () => {
    setEditingCategoryId(null);
    setEditCategoryName('');
    setCategoryEditError(null);
  };

  const handleUpdateCategory = async () => {
    if (!editingCategoryId || !userId) return;

    setCategoryEditError(null);

    if (!editCategoryName.trim()) {
      setCategoryEditError('Category name is required.');
      return;
    }

    setCategoryEditSubmitting(true);

    const { error } = await supabase
      .from('categories')
      .update({ name: editCategoryName.trim() })
      .eq('id', editingCategoryId);

    setCategoryEditSubmitting(false);

    if (error) {
      // Check for unique constraint
      if (error.code === '23505' || error.message.includes('unique') || error.message.includes('duplicate')) {
        setCategoryEditError('A category with this name already exists for this type.');
      } else {
        setCategoryEditError(error.message);
      }
      return;
    }

    cancelEditCategory();
    await loadCategories();
  };

  const handleDeleteCategory = async (categoryId: string) => {
    if (!window.confirm('Are you sure you want to delete this category?')) {
      return;
    }

    setCategoryDeleteError(null);

    const { error } = await supabase.from('categories').delete().eq('id', categoryId);

    if (error) {
      // Check for foreign keys (usage in transactions)
      if (
        error.code === '23503' ||
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        setCategoryDeleteError(
          'Cannot delete category: it is already used in transactions. In v1 deletion is only allowed for unused categories.',
        );
      } else {
        setCategoryDeleteError(error.message);
      }
      return;
    }

    await loadCategories();
  };

  const moveCategory = async (kind: 'income' | 'expense', categoryId: string, direction: 'up' | 'down') => {
    if (!userId) return;

    setMoveCategoryError(null);
    setMovingCategoryId(categoryId);

    try {
      // Get current sorted array of categories of this kind
      const categoriesOfKind = categories
        .filter((c) => c.kind === kind)
        .sort((a, b) => {
          const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      // Find index of current category
      const currentIndex = categoriesOfKind.findIndex((c) => c.id === categoryId);
      if (currentIndex === -1) {
        setMoveCategoryError('Category not found.');
        setMovingCategoryId(null);
        return;
      }

      // Determine neighbor index
      const neighborIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (neighborIndex < 0 || neighborIndex >= categoriesOfKind.length) {
        // No neighbor - do nothing
        setMovingCategoryId(null);
        return;
      }

      const current = categoriesOfKind[currentIndex];
      const neighbor = categoriesOfKind[neighborIndex];

      // Swap via 3 updates
      // 1) Set temporary value for current
      const { error: error1 } = await supabase
        .from('categories')
        .update({ sort_order: -999999 })
        .eq('id', current.id)
        .eq('user_id', userId);

      if (error1) {
        setMoveCategoryError(`Error moving: ${error1.message}`);
        setMovingCategoryId(null);
        return;
      }

      // 2) Set neighbor's sort_order for current
      const { error: error2 } = await supabase
        .from('categories')
        .update({ sort_order: neighbor.sort_order })
        .eq('id', current.id)
        .eq('user_id', userId);

      if (error2) {
        setMoveCategoryError(`Error moving: ${error2.message}`);
        setMovingCategoryId(null);
        return;
      }

      // 3) Set current's sort_order for neighbor
      const { error: error3 } = await supabase
        .from('categories')
        .update({ sort_order: current.sort_order })
        .eq('id', neighbor.id)
        .eq('user_id', userId);

      if (error3) {
        setMoveCategoryError(`Error moving: ${error3.message}`);
        setMovingCategoryId(null);
        return;
      }

      // Success - update categories list
      await loadCategories();
    } catch (error: any) {
      setMoveCategoryError(`Unexpected error: ${error.message || 'Unknown error'}`);
    } finally {
      setMovingCategoryId(null);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const handleCreateBudget = async (e: FormEvent) => {
    e.preventDefault();
    const session = await getSession();
    if (!session?.user?.id) return;

    setBudgetFormError(null);
    setBudgetSuccess(null);

    if (!budgetName.trim()) {
      setBudgetFormError('Budget name is required.');
      return;
    }

    const parsed = parseBaseLimitEur(budgetBaseLimitEur);
    if (!parsed.ok) {
      setBudgetFormError(parsed.error);
      return;
    }

    if (!budgetStartDate.trim()) {
      setBudgetFormError('Start date is required.');
      return;
    }

    if (budgetSelectedCategories.size === 0) {
      setBudgetFormError('Select at least one expense category.');
      return;
    }

    // Validate: no selected category is assigned to another budget
    const conflicting: string[] = [];
    budgetSelectedCategories.forEach((catId) => {
      const budgetIds = categoryToBudgetIdsMap.get(catId) || [];
      if (budgetIds.length > 0) {
        const catName = categories.find((c) => c.id === catId)?.name || catId;
        const otherBudgets = budgetIds.map((bid) => budgets.find((b) => b.id === bid)?.name || bid).join(', ');
        conflicting.push(`${catName} (in budgets: ${otherBudgets})`);
      }
    });
    if (conflicting.length > 0) {
      setBudgetFormError(`Category already assigned to another budget: ${conflicting.join('; ')}`);
      return;
    }

    setBudgetSubmitting(true);

    try {
      const { data: newBudget, error: budgetError } = await supabase
        .from('budgets')
        .insert({
          user_id: session.user.id,
          name: budgetName.trim(),
          base_limit_eur: parsed.value,
          start_date: budgetStartDate,
          carry_over: budgetCarryOver,
        })
        .select()
        .single();

      if (budgetError) {
        setBudgetFormError(budgetError.message);
        setBudgetSubmitting(false);
        return;
      }

      if (newBudget) {
        const inserts = Array.from(budgetSelectedCategories).map((categoryId) => ({
          user_id: session.user.id,
          budget_id: (newBudget as Budget).id,
          category_id: categoryId,
        }));
        const { error: bcError } = await supabase.from('budget_categories').insert(inserts);

        if (bcError) {
          setBudgetFormError(bcError.message);
          setBudgetSubmitting(false);
          return;
        }
      }

      setBudgetName('');
      setBudgetBaseLimitEur('');
      setBudgetStartDate('');
      setBudgetCarryOver(false);
      setBudgetSelectedCategories(new Set());
      setBudgetSuccess('Budget created.');
      await loadBudgets();
    } finally {
      setBudgetSubmitting(false);
    }
  };

  const startEditBudget = (budget: Budget) => {
    setEditingBudgetId(budget.id);
    setEditBudgetName(budget.name);
    setEditBudgetBaseLimitEur(budget.base_limit_eur.toFixed(2));
    setEditBudgetStartDate(budget.start_date.slice(0, 10));
    setEditBudgetCarryOver(budget.carry_over);
    setEditBudgetSelectedCategories(new Set(budgetCategoriesMap.get(budget.id) || []));
    setBudgetEditError(null);
  };

  const cancelEditBudget = () => {
    setEditingBudgetId(null);
    setEditBudgetName('');
    setEditBudgetBaseLimitEur('');
    setEditBudgetStartDate('');
    setEditBudgetCarryOver(false);
    setEditBudgetSelectedCategories(new Set());
    setBudgetEditError(null);
  };

  const handleUpdateBudget = async () => {
    if (!editingBudgetId) return;

    const session = await getSession();
    if (!session?.user?.id) return;

    setBudgetEditError(null);
    setBudgetSuccess(null);

    if (!editBudgetName.trim()) {
      setBudgetEditError('Budget name is required.');
      return;
    }

    const parsed = parseBaseLimitEur(editBudgetBaseLimitEur);
    if (!parsed.ok) {
      setBudgetEditError(parsed.error);
      return;
    }

    if (!editBudgetStartDate.trim()) {
      setBudgetEditError('Start date is required.');
      return;
    }

    if (editBudgetSelectedCategories.size === 0) {
      setBudgetEditError('Select at least one expense category.');
      return;
    }

    // Validate: no selected category is assigned to a different budget
    const conflicting: string[] = [];
    editBudgetSelectedCategories.forEach((catId) => {
      const budgetIds = categoryToBudgetIdsMap.get(catId) || [];
      const otherBudgetIds = budgetIds.filter((bid) => bid !== editingBudgetId);
      if (otherBudgetIds.length > 0) {
        const catName = categories.find((c) => c.id === catId)?.name || catId;
        const otherBudgets = otherBudgetIds
          .map((bid) => budgets.find((b) => b.id === bid)?.name || bid)
          .join(', ');
        conflicting.push(`${catName} (in budgets: ${otherBudgets})`);
      }
    });
    if (conflicting.length > 0) {
      setBudgetEditError(`Category already assigned to another budget: ${conflicting.join('; ')}`);
      return;
    }

    setBudgetEditSubmitting(true);

    try {
      const { error: updateError } = await supabase
        .from('budgets')
        .update({
          name: editBudgetName.trim(),
          base_limit_eur: parsed.value,
          start_date: editBudgetStartDate,
          carry_over: editBudgetCarryOver,
        })
        .eq('id', editingBudgetId);

      if (updateError) {
        setBudgetEditError(updateError.message);
        setBudgetEditSubmitting(false);
        return;
      }

      await supabase.from('budget_categories').delete().eq('budget_id', editingBudgetId);

      const inserts = Array.from(editBudgetSelectedCategories).map((categoryId) => ({
        user_id: session.user.id,
        budget_id: editingBudgetId,
        category_id: categoryId,
      }));
      const { error: bcError } = await supabase.from('budget_categories').insert(inserts);

      if (bcError) {
        setBudgetEditError(bcError.message);
        setBudgetEditSubmitting(false);
        return;
      }

      setBudgetSuccess('Budget updated.');
      cancelEditBudget();
      await loadBudgets();
    } finally {
      setBudgetEditSubmitting(false);
    }
  };

  const handleDeleteBudget = async (budgetId: string) => {
    if (!window.confirm('Are you sure you want to delete this budget?')) return;

    setBudgetDeleteError(null);
    setBudgetSuccess(null);

    const { error: bcError } = await supabase.from('budget_categories').delete().eq('budget_id', budgetId);

    if (bcError) {
      setBudgetDeleteError(bcError.message);
      return;
    }

    const { error: budgetError } = await supabase.from('budgets').delete().eq('id', budgetId);

    if (budgetError) {
      setBudgetDeleteError(budgetError.message);
      return;
    }

    setBudgetSuccess('Budget deleted.');
    cancelEditBudget();
    await loadBudgets();
  };

  const handleClearPeriod = async () => {
    // Validation
    if (!dateFrom || !dateTo) {
      setClearPeriodError('Both dates are required.');
      return;
    }

    if (dateFrom > dateTo) {
      setClearPeriodError('Start date cannot be after end date.');
      return;
    }

    // Confirmation
    if (!window.confirm(`Delete transactions from ${dateFrom} to ${dateTo}? This cannot be undone.`)) {
      return;
    }

    setClearPeriodError(null);
    setClearPeriodSuccess(null);
    setClearingPeriod(true);

    try {
      // Get current session
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session?.user?.id) {
        setClearPeriodError('Failed to get user session.');
        setClearingPeriod(false);
        return;
      }

      const userId = sessionData.session.user.id;

      // Build safe ISO dates
      const start = new Date(dateFrom + 'T00:00:00');
      const endExclusive = new Date(dateTo + 'T00:00:00');
      endExclusive.setDate(endExclusive.getDate() + 1);

      const startISO = start.toISOString();
      const endISO = endExclusive.toISOString();

      // Delete transactions in range
      const { error: transactionsError } = await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId)
        .gte('created_at', startISO)
        .lt('created_at', endISO);

      if (transactionsError) {
        setClearPeriodError(`Error deleting transactions: ${transactionsError.message}`);
        setClearingPeriod(false);
        return;
      }

      // Delete transfers in range
      const { error: transfersError } = await supabase
        .from('transfers')
        .delete()
        .eq('user_id', userId)
        .gte('created_at', startISO)
        .lt('created_at', endISO);

      if (transfersError) {
        setClearPeriodError(`Error deleting transfers: ${transfersError.message}`);
        setClearingPeriod(false);
        return;
      }

      // Success
      setClearPeriodSuccess('Transactions for period deleted');
      setClearingPeriod(false);
      // Clear date fields
      setDateFrom('');
      setDateTo('');
    } catch (error: any) {
      setClearPeriodError(`Unexpected error: ${error.message || 'Unknown error'}`);
      setClearingPeriod(false);
    }
  };

  const brokerAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'broker'),
    [accounts],
  );

  const cryptoAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'crypto'),
    [accounts],
  );

  // Map category_id -> budget name (for "already in X" display)
  const categoryToBudgetMap = useMemo(() => {
    const map = new Map<string, string>();
    budgets.forEach((b) => {
      const catIds = budgetCategoriesMap.get(b.id) || [];
      catIds.forEach((cid) => map.set(cid, b.name));
    });
    return map;
  }, [budgets, budgetCategoriesMap]);

  // Duplicate categories: category_id -> [budget_ids]; if any has length > 1, build warning list
  const budgetDuplicateWarning = useMemo(() => {
    const list: Array<{ categoryName: string; budgetNames: string }> = [];
    categoryToBudgetIdsMap.forEach((budgetIds, categoryId) => {
      if (budgetIds.length > 1) {
        const categoryName = categories.find((c) => c.id === categoryId)?.name || categoryId;
        const budgetNames = budgetIds
          .map((bid) => budgets.find((b) => b.id === bid)?.name || bid)
          .join(', ');
        list.push({ categoryName, budgetNames });
      }
    });
    return list;
  }, [categoryToBudgetIdsMap, categories, budgets]);

  const loadPositions = async () => {
    if (!selectedBrokerAccountId || !userId) {
      setPositions([]);
      return;
    }

    setPositionsLoading(true);
    setPositionsError(null);

    try {
      const { data, error } = await supabase
        .from('positions')
        .select(
          'id, user_id, broker_account_id, instrument_id, quote_currency, quantity, comment, last_price, last_price_at, created_at, instruments!inner(id, user_id, kind, provider, provider_symbol, display_symbol, name, created_at)',
        )
        .eq('broker_account_id', selectedBrokerAccountId)
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      setPositionsLoading(false);

      if (error) {
        setPositionsError(error.message);
        return;
      }

      // Transform the data to PositionWithInstrument[]
      const positionsWithInstruments: PositionWithInstrument[] = (data || []).map((p: any) => ({
        id: p.id,
        user_id: p.user_id,
        broker_account_id: p.broker_account_id,
        instrument_id: p.instrument_id,
        quote_currency: p.quote_currency,
        quantity: p.quantity,
        comment: p.comment,
        last_price: p.last_price,
        last_price_at: p.last_price_at,
        created_at: p.created_at,
        instrument: Array.isArray(p.instruments) ? p.instruments[0] : p.instruments,
      }));

      setPositions(positionsWithInstruments);
    } catch (err) {
      setPositionsLoading(false);
      setPositionsError(err instanceof Error ? err.message : 'Failed to load positions');
    }
  };

  useEffect(() => {
    loadPositions();
  }, [selectedBrokerAccountId, userId]);

  const loadCryptoPositions = async () => {
    if (!selectedCryptoAccountId || !userId) {
      setCryptoPositions([]);
      return;
    }

    setCryptoPositionsLoading(true);
    setCryptoPositionsError(null);

    try {
      const { data, error } = await supabase
        .from('positions')
        .select(
          'id, user_id, broker_account_id, instrument_id, quote_currency, quantity, comment, last_price, last_price_at, created_at, instruments!inner(id, user_id, kind, provider, provider_symbol, display_symbol, name, created_at)',
        )
        .eq('broker_account_id', selectedCryptoAccountId)
        .eq('user_id', userId)
        .eq('instruments.kind', 'crypto')
        .order('created_at', { ascending: true });

      setCryptoPositionsLoading(false);

      if (error) {
        setCryptoPositionsError(error.message);
        return;
      }

      const positionsWithInstruments: PositionWithInstrument[] = (data || []).map(
        (p: any) => ({
          id: p.id,
          user_id: p.user_id,
          broker_account_id: p.broker_account_id,
          instrument_id: p.instrument_id,
          quote_currency: p.quote_currency,
          quantity: p.quantity,
          comment: p.comment,
          last_price: p.last_price,
          last_price_at: p.last_price_at,
          created_at: p.created_at,
          instrument: Array.isArray(p.instruments) ? p.instruments[0] : p.instruments,
        }),
      );

      setCryptoPositions(positionsWithInstruments);
    } catch (err) {
      setCryptoPositionsLoading(false);
      setCryptoPositionsError(
        err instanceof Error ? err.message : 'Failed to load crypto positions',
      );
    }
  };

  useEffect(() => {
    loadCryptoPositions();
  }, [selectedCryptoAccountId, userId]);

  const handleCreatePosition = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !selectedBrokerAccountId) return;

    setPositionFormError(null);

    if (!positionSymbol.trim()) {
      setPositionFormError('Symbol is required.');
      return;
    }

    const brokerAccount = accounts.find((a) => a.id === selectedBrokerAccountId);
    if (!brokerAccount || !brokerAccount.currency) {
      setPositionFormError('Broker account not found or currency not set.');
      return;
    }

    setPositionSubmitting(true);
    setPositionFormError(null);

    try {
      // Normalize symbol
      const normalizedSymbol = positionSymbol.trim().toUpperCase();

      // Fetch quote from Finnhub BEFORE creating instrument/position
      const quoteResponse = await fetch(
        `/api/market/quote?symbol=${encodeURIComponent(normalizedSymbol)}`,
      );

      let quoteData;
      try {
        quoteData = await quoteResponse.json();
      } catch (parseError) {
        setPositionSubmitting(false);
        setPositionFormError(
          'Failed to get price from Finnhub. Try again later.',
        );
        return;
      }

      if (!quoteData.ok) {
        setPositionSubmitting(false);
        if (quoteResponse.status === 404) {
          setPositionFormError(
            'Instrument not found on Finnhub or price unavailable. Check symbol.',
          );
        } else {
          setPositionFormError(
            'Failed to get price from Finnhub. Try again later.',
          );
        }
        return;
      }

      const finnhubPrice = quoteData.price;
      const fetchedAt = quoteData.fetched_at || new Date().toISOString();

      // Determine quantity based on input mode
      let quantityNum: number;

      if (positionInputMode === 'quantity') {
        const parsed = parseMoneyExpression(positionQuantity);
        if (!parsed.ok) {
          setPositionSubmitting(false);
          setPositionFormError(parsed.error);
          return;
        }
        quantityNum = parsed.value;

        if (quantityNum < 0) {
          setPositionSubmitting(false);
          setPositionFormError('Quantity cannot be negative.');
          return;
        }
      } else {
        const amountNum = Number(positionAmount);

        if (!positionAmount.trim() || Number.isNaN(amountNum) || amountNum < 0) {
          setPositionSubmitting(false);
          setPositionFormError('Enter amount (0 or greater).');
          return;
        }

        if (!finnhubPrice || finnhubPrice <= 0) {
          setPositionSubmitting(false);
          setPositionFormError('Cannot calculate quantity: price unavailable.');
          return;
        }

        quantityNum = amountNum / finnhubPrice;
      }

      // General check: NaN / negative values disallowed, 0 allowed
      if (Number.isNaN(quantityNum) || quantityNum < 0) {
        setPositionSubmitting(false);
        setPositionFormError('Invalid quantity.');
        return;
      }

      // Find or create instrument
      const { data: existingInstrument, error: findError } = await supabase
        .from('instruments')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', 'manual')
        .eq('provider_symbol', normalizedSymbol)
        .maybeSingle();

      if (findError && findError.code !== 'PGRST116') {
        setPositionSubmitting(false);
        setPositionFormError(findError.message);
        return;
      }

      let instrumentId: string;

      if (existingInstrument) {
        instrumentId = existingInstrument.id;
      } else {
        const { data: newInstrument, error: createError } = await supabase
          .from('instruments')
          .insert({
            user_id: userId,
            kind: positionKind,
            provider: 'manual',
            provider_symbol: normalizedSymbol,
            display_symbol: normalizedSymbol,
            name: null,
          })
          .select('id')
          .single();

        if (createError) {
          setPositionSubmitting(false);
          setPositionFormError(createError.message);
          return;
        }

        if (!newInstrument) {
          setPositionSubmitting(false);
          setPositionFormError('Failed to create instrument.');
          return;
        }

        instrumentId = newInstrument.id;
      }

      // Check for existing position
      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('user_id', userId)
        .eq('broker_account_id', selectedBrokerAccountId)
        .eq('instrument_id', instrumentId)
        .maybeSingle();

      if (existingPosition) {
        setPositionSubmitting(false);
        setPositionFormError(
          'This position already exists for this broker account. Duplicates are not allowed in v1.',
        );
        return;
      }

      // Create position with last_price from Finnhub
      const { error: positionError } = await supabase.from('positions').insert({
        user_id: userId,
        broker_account_id: selectedBrokerAccountId,
        instrument_id: instrumentId,
        quote_currency: brokerAccount.currency,
        quantity: quantityNum,
        comment: positionComment.trim() || null,
        last_price: finnhubPrice,
        last_price_at: fetchedAt,
      });

      if (positionError) {
        setPositionSubmitting(false);
        if (
          positionError.code === '23505' ||
          positionError.message.includes('unique') ||
          positionError.message.includes('duplicate')
        ) {
          setPositionFormError(
            'This position already exists for this broker account. Duplicates are not allowed in v1.',
          );
        } else {
          setPositionFormError(positionError.message);
        }
        return;
      }

      // Success
      setPositionSymbol('');
      setPositionQuantity('');
      setPositionAmount('');
      setPositionComment('');
      await loadPositions();
      setPositionSubmitting(false);
    } catch (err) {
      setPositionSubmitting(false);
      setPositionFormError(err instanceof Error ? err.message : 'Failed to create position');
    }
  };

  const handleCreateCryptoPosition = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !selectedCryptoAccountId) return;

    setCryptoPositionFormError(null);

    setCryptoPositionSubmitting(true);
    setCryptoPositionFormError(null);

    try {
      if (!cryptoCoinId.trim()) {
        setCryptoPositionSubmitting(false);
        setCryptoPositionFormError('CoinGecko coin id is required.');
        return;
      }

      const cryptoAccount = accounts.find((a) => a.id === selectedCryptoAccountId);
      if (!cryptoAccount || !cryptoAccount.currency) {
        setCryptoPositionSubmitting(false);
        setCryptoPositionFormError('Crypto account not found or currency not set.');
        return;
      }

      const normalizedCoinId = cryptoCoinId.trim().toLowerCase();
      const displaySymbol = normalizedCoinId.toUpperCase();
      const vsCurrency = (cryptoAccount.currency || 'EUR').toLowerCase();

      // Fetch price from CoinGecko before creating instrument/position
      let quoteData: any;
      try {
        const resp = await fetch(
          `/api/market/crypto-quote?coinId=${encodeURIComponent(
            normalizedCoinId,
          )}&vsCurrency=${encodeURIComponent(vsCurrency)}`,
        );
        try {
          quoteData = await resp.json();
        } catch {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Failed to get price from CoinGecko. Try again later.');
          return;
        }
        if (
          !resp.ok ||
          !quoteData?.ok ||
          typeof quoteData.price !== 'number' ||
          !Number.isFinite(quoteData.price) ||
          quoteData.price <= 0
        ) {
          setCryptoPositionSubmitting(false);
          if (quoteData?.reason === 'Coin not found' || resp.status === 404) {
            setCryptoPositionFormError('Crypto asset not found on CoinGecko. Please check coin id.');
          } else {
            setCryptoPositionFormError('Failed to get price from CoinGecko. Try again later.');
          }
          return;
        }
      } catch (fetchErr) {
        setCryptoPositionSubmitting(false);
        setCryptoPositionFormError(
          fetchErr instanceof Error ? fetchErr.message : 'Failed to get price from CoinGecko.',
        );
        return;
      }

      const cgPrice: number = quoteData.price;
      const fetchedAt: string = (quoteData.fetched_at as string) || new Date().toISOString();

      // Determine quantity based on input mode
      let quantityNum: number;

      if (cryptoPositionInputMode === 'quantity') {
        const parsedQty = parseMoneyExpression(cryptoQuantity);
        if (!parsedQty.ok) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError(parsedQty.error);
          return;
        }
        quantityNum = parsedQty.value;
        if (quantityNum < 0) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Quantity cannot be negative.');
          return;
        }
      } else {
        const amountNum = Number(cryptoAmount);

        if (!cryptoAmount.trim() || Number.isNaN(amountNum) || amountNum < 0) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Enter amount (0 or greater).');
          return;
        }

        if (!cgPrice || cgPrice <= 0) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Cannot calculate quantity: price unavailable.');
          return;
        }

        quantityNum = amountNum / cgPrice;

        if (Number.isNaN(quantityNum) || quantityNum < 0) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Invalid quantity calculated.');
          return;
        }
      }

      // Find or create crypto instrument
      const { data: existingInstrument, error: findError } = await supabase
        .from('instruments')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', 'coingecko')
        .eq('provider_symbol', normalizedCoinId)
        .maybeSingle();

      if (findError && findError.code !== 'PGRST116') {
        setCryptoPositionSubmitting(false);
        setCryptoPositionFormError(findError.message);
        return;
      }

      let instrumentId: string;

      if (existingInstrument) {
        instrumentId = (existingInstrument as { id: string }).id;
      } else {
        const { data: newInstrument, error: createError } = await supabase
          .from('instruments')
          .insert({
            user_id: userId,
            kind: 'crypto',
            provider: 'coingecko',
            provider_symbol: normalizedCoinId,
            display_symbol: displaySymbol,
            name: null,
          })
          .select('id')
          .single();

        if (createError) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError(createError.message);
          return;
        }

        if (!newInstrument) {
          setCryptoPositionSubmitting(false);
          setCryptoPositionFormError('Failed to create instrument.');
          return;
        }

        instrumentId = (newInstrument as { id: string }).id;
      }

      const { data: newPosition, error: positionError } = await supabase
        .from('positions')
        .insert({
          user_id: userId,
          broker_account_id: selectedCryptoAccountId,
          instrument_id: instrumentId,
          quote_currency: cryptoAccount.currency,
          quantity: quantityNum,
          comment: cryptoComment.trim() || null,
          last_price: cgPrice,
          last_price_at: fetchedAt,
        })
        .select('id, quantity')
        .single();

      if (positionError || !newPosition) {
        setCryptoPositionSubmitting(false);
        setCryptoPositionFormError(positionError?.message || 'Failed to create position');
        return;
      }

      // Записываем snapshot в position_price_history (как в refreshPricesEngine)
      try {
        const nowIso = new Date().toISOString();
        const capturedDate = nowIso.slice(0, 10); // YYYY-MM-DD
        await supabase.from('position_price_history').upsert(
          {
            user_id: userId,
            position_id: newPosition.id,
            price: cgPrice,
            currency: cryptoAccount.currency,
            price_at: fetchedAt,
            captured_at: nowIso,
            captured_date: capturedDate,
            quantity_snapshot: newPosition.quantity,
          },
          { onConflict: 'user_id,position_id,captured_date' },
        );
      } catch {
        // если snapshot не сохранился — не ломаем поток
      }

      // Clear form only on success
      setCryptoCoinId('');
      setCryptoQuantity('');
      setCryptoAmount('');
      setCryptoComment('');
      setCryptoPositionInputMode('quantity');

      await loadCryptoPositions();
      setCryptoPositionSubmitting(false);
    } catch (err) {
      setCryptoPositionSubmitting(false);
      setCryptoPositionFormError(
        err instanceof Error ? err.message : 'Failed to create crypto position',
      );
    }
  };

  const startEditCryptoPosition = (position: PositionWithInstrument) => {
    setEditingCryptoPositionId(position.id);
    setEditCryptoPositionQuantity(position.quantity.toString());
    setEditCryptoPositionComment(position.comment || '');
    setEditCryptoPositionInputMode('quantity');
    setEditCryptoAmount('');
    setCryptoPositionEditError(null);
  };

  const cancelEditCryptoPosition = () => {
    setEditingCryptoPositionId(null);
    setEditCryptoPositionQuantity('');
    setEditCryptoPositionComment('');
    setEditCryptoAmount('');
    setEditCryptoPositionInputMode('quantity');
    setCryptoPositionEditError(null);
  };

  const handleUpdateCryptoPosition = async () => {
    if (!editingCryptoPositionId) return;

    setCryptoPositionEditError(null);

    // Find current position to get last_price if needed for amount mode
    const currentPosition = cryptoPositions.find(
      (p) => p.id === editingCryptoPositionId,
    );

    let quantityNum: number;

    if (editCryptoPositionInputMode === 'quantity') {
      const parsed = parseMoneyExpression(editCryptoPositionQuantity);
      if (!parsed.ok) {
        setCryptoPositionEditError(parsed.error);
        return;
      }
      quantityNum = parsed.value;
      if (quantityNum < 0) {
        setCryptoPositionEditError('Quantity cannot be negative.');
        return;
      }
    } else {
      if (!currentPosition || !currentPosition.last_price || currentPosition.last_price <= 0) {
        setCryptoPositionEditError('Cannot calculate quantity: price unavailable.');
        return;
      }

      const amountNum = Number(editCryptoAmount);

      if (!editCryptoAmount.trim() || Number.isNaN(amountNum) || amountNum < 0) {
        setCryptoPositionEditError('Enter amount (0 or greater).');
        return;
      }

      quantityNum = amountNum / currentPosition.last_price;

      if (Number.isNaN(quantityNum) || quantityNum < 0) {
        setCryptoPositionEditError('Invalid quantity calculated.');
        return;
      }
    }

    setCryptoPositionEditSubmitting(true);

    const { error } = await supabase
      .from('positions')
      .update({
        quantity: quantityNum,
        comment: editCryptoPositionComment.trim() || null,
      })
      .eq('id', editingCryptoPositionId);

    setCryptoPositionEditSubmitting(false);

    if (error) {
      setCryptoPositionEditError(error.message);
      return;
    }

    cancelEditCryptoPosition();
    await loadCryptoPositions();
  };

  const handleDeleteCryptoPosition = async (positionId: string) => {
    if (!window.confirm('Are you sure you want to delete this crypto position?')) {
      return;
    }

    setCryptoPositionDeleteError(null);

    const { error } = await supabase.from('positions').delete().eq('id', positionId);

    if (error) {
      setCryptoPositionDeleteError(error.message);
      return;
    }

    await loadCryptoPositions();
  };

  const startEditPosition = (position: PositionWithInstrument) => {
    setEditingPositionId(position.id);
    setEditPositionQuantity(position.quantity.toString());
    setEditPositionComment(position.comment || '');
    setPositionEditError(null);
  };

  const cancelEditPosition = () => {
    setEditingPositionId(null);
    setEditPositionQuantity('');
    setEditPositionComment('');
    setPositionEditError(null);
  };

  const handleUpdatePosition = async () => {
    if (!editingPositionId) return;

    setPositionEditError(null);

    const parsed = parseMoneyExpression(editPositionQuantity);
    if (!parsed.ok) {
      setPositionEditError(parsed.error);
      return;
    }
    const quantityNum = parsed.value;
    if (quantityNum < 0) {
      setPositionEditError('Quantity cannot be negative.');
      return;
    }

    setPositionEditSubmitting(true);

    const { error } = await supabase
      .from('positions')
      .update({
        quantity: quantityNum,
        comment: editPositionComment.trim() || null,
      })
      .eq('id', editingPositionId);

    setPositionEditSubmitting(false);

    if (error) {
      setPositionEditError(error.message);
      return;
    }

    cancelEditPosition();
    await loadPositions();
  };

  const handleDeletePosition = async (positionId: string) => {
    if (!window.confirm('Are you sure you want to delete this position?')) {
      return;
    }

    setPositionDeleteError(null);

    const { error } = await supabase.from('positions').delete().eq('id', positionId);

    if (error) {
      setPositionDeleteError(error.message);
      return;
    }

    await loadPositions();
  };

  const incomeCategories = useMemo(
    () =>
      categories
        .filter((c) => c.kind === 'income')
        .sort((a, b) => {
          // Sort by sort_order (nulls last), then by created_at
          const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        }),
    [categories],
  );
  const expenseCategories = useMemo(
    () =>
      categories
        .filter((c) => c.kind === 'expense')
        .sort((a, b) => {
          // Sort by sort_order (nulls last), then by created_at
          const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        }),
    [categories],
  );

  if (!sessionChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-700">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8 md:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white px-4 py-4 shadow-sm md:flex-row md:items-center md:justify-between md:px-6">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Settings</h1>
            <p className="text-sm text-neutral-600">Manage accounts and categories</p>
          </div>
          <div className="flex flex-wrap gap-2 md:gap-3">
            <button
              onClick={handleManualRefresh}
              disabled={refreshLoading}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60 md:w-auto"
            >
              🔄 Refresh prices
            </button>
            <button
              onClick={() => router.push('/app')}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 md:w-auto"
            >
              Dashboard
            </button>
            <button
              onClick={() => router.push('/stats')}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 md:w-auto"
            >
              Statistics
            </button>
            <button
              onClick={handleLogout}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 md:w-auto"
            >
              Logout
            </button>
          </div>
        </header>

        {refreshLoading && (
          <div className="rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
            Refreshing quotes and FX...
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

        <main className="flex flex-col gap-6">
          {/* Accounts block */}
          <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">Accounts</h2>
              {accountsLoading && (
                <span className="text-xs text-neutral-500">Loading...</span>
              )}
            </div>

            {accountsError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {accountsError}
              </div>
            )}

            {deleteError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {deleteError}
              </div>
            )}

            <div className="max-h-96 space-y-2 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
              {accounts.length === 0 ? (
                <p className="text-neutral-600">No accounts. Create the first one.</p>
              ) : (
                accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="rounded-md border border-neutral-200 px-3 py-2"
                  >
                    {editingAccountId === acc.id ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-semibold text-neutral-900">Edit account</h4>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="text-xs text-neutral-600 hover:text-neutral-900"
                          >
                            ✕
                          </button>
                        </div>

                        <div className="space-y-2">
                          <div className="space-y-1">
                            <label className="block text-xs font-medium text-neutral-700">
                              Name
                            </label>
                            <input
                              type="text"
                              value={editAccountName}
                              onChange={(e) => setEditAccountName(e.target.value)}
                              className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="block text-xs font-medium text-neutral-700">
                              Currency
                            </label>
                            <select
                              value={editAccountCurrency}
                              onChange={(e) => setEditAccountCurrency(e.target.value as AccountCurrency)}
                              className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                            >
                              <option value="EUR">EUR</option>
                              <option value="USD">USD</option>
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label className="block text-xs font-medium text-neutral-700">
                              Starting balance ({editAccountCurrency === 'EUR' ? '€' : '$'})
                            </label>
                            <input
                              type="number"
                              value={editStartingBalance}
                              onChange={(e) => setEditStartingBalance(e.target.value)}
                              className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                            />
                          </div>

                          {acc.kind !== 'credit' && (
                            <div className="space-y-1">
                              <label className="block text-xs font-medium text-neutral-700">
                                Warning threshold ({editAccountCurrency === 'EUR' ? '€' : '$'})
                              </label>
                              <input
                                type="number"
                                min="0"
                                value={editWarningThreshold}
                                onChange={(e) => setEditWarningThreshold(e.target.value)}
                                className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                              />
                            </div>
                          )}

                          {acc.kind === 'credit' && (
                            <>
                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Credit limit ({editAccountCurrency === 'EUR' ? '€' : '$'})
                                </label>
                                <input
                                  type="number"
                                  min="1"
                                  value={editCreditLimit}
                                  onChange={(e) => setEditCreditLimit(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Credit warning threshold ({editAccountCurrency === 'EUR' ? '€' : '$'})
                                </label>
                                <input
                                  type="number"
                                  min="0"
                                  value={editCreditWarningThreshold}
                                  onChange={(e) => setEditCreditWarningThreshold(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Linked debit account
                                </label>
                                <select
                                  value={editDebitAnchorAccountId}
                                  onChange={(e) => setEditDebitAnchorAccountId(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                >
                                  <option value="">Select account</option>
                                  {debitAccounts.map((debitAcc) => (
                                    <option key={debitAcc.id} value={debitAcc.id}>
                                      {debitAcc.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          )}

                          {editError && (
                            <div className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                              {editError}
                            </div>
                          )}

                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleUpdateAccount}
                              disabled={editSubmitting}
                              className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                            >
                              {editSubmitting ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={editSubmitting}
                              className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-neutral-900">{acc.name}</span>
                            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
                              {(acc.currency || 'EUR') === 'EUR' ? 'EUR' : 'USD'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs uppercase text-neutral-500">{acc.kind}</span>
                            <button
                              type="button"
                              onClick={() => startEditAccount(acc)}
                              className="text-xs text-blue-600 hover:text-blue-800"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(acc.id)}
                              className="text-xs text-red-600 hover:text-red-800"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600">
                          <span>
                            Starting balance:{' '}
                            <span className="font-medium">
                              {(acc.currency || 'EUR') === 'EUR' ? '€' : '$'}{acc.starting_balance.toFixed(2)}
                            </span>
                            {(acc.currency || 'EUR') === 'USD' && fxRate && (
                              <span className="ml-1 text-neutral-500">
                                (≈ €{(acc.starting_balance * fxRate).toFixed(2)})
                              </span>
                            )}
                            {(acc.currency || 'EUR') === 'USD' && !fxRate && !fxLoading && (
                              <span className="ml-1 text-neutral-400">(≈ € — FX not loaded)</span>
                            )}
                          </span>
                          {acc.kind !== 'credit' && (
                            <span>
                              Threshold:{' '}
                              <span className="font-medium">
                                {(acc.currency || 'EUR') === 'EUR' ? '€' : '$'}{acc.warning_threshold.toFixed(2)}
                              </span>
                              {(acc.currency || 'EUR') === 'USD' && fxRate && (
                                <span className="ml-1 text-neutral-500">
                                  (≈ €{(acc.warning_threshold * fxRate).toFixed(2)})
                                </span>
                              )}
                            </span>
                          )}
                          {acc.kind === 'credit' && (
                            <>
                              <span>
                                Credit limit:{' '}
                                <span className="font-medium">
                                  {(acc.currency || 'EUR') === 'EUR' ? '€' : '$'}{acc.credit_limit?.toFixed(2) || '—'}
                                </span>
                                {(acc.currency || 'EUR') === 'USD' && fxRate && acc.credit_limit && (
                                  <span className="ml-1 text-neutral-500">
                                    (≈ €{(acc.credit_limit * fxRate).toFixed(2)})
                                  </span>
                                )}
                              </span>
                              <span>
                                Credit warning threshold:{' '}
                                <span className="font-medium">
                                  {(acc.currency || 'EUR') === 'EUR' ? '€' : '$'}{acc.credit_warning_threshold?.toFixed(2) || '—'}
                                </span>
                                {(acc.currency || 'EUR') === 'USD' && fxRate && acc.credit_warning_threshold && (
                                  <span className="ml-1 text-neutral-500">
                                    (≈ €{(acc.credit_warning_threshold * fxRate).toFixed(2)})
                                  </span>
                                )}
                              </span>
                              <span className="col-span-2">
                                Linked debit account:{' '}
                                <span className="font-medium">
                                  {acc.debit_anchor_account_id
                                    ? accountNameMap.get(acc.debit_anchor_account_id) || acc.debit_anchor_account_id
                                    : '—'}
                                </span>
                              </span>
                            </>
                          )}
                        </div>
                        {(acc.currency || 'EUR') === 'USD' && fxError && (
                          <div className="mt-1 rounded bg-yellow-50 px-2 py-1 text-xs text-yellow-700">
                            FX rate warning: {fxError}
                          </div>
                        )}
                        <div className="mt-2 space-y-1 border-t border-neutral-200 pt-2">
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={acc.is_default_income}
                              onChange={(e) => setDefault('income', acc.id, e.target.checked)}
                              disabled={defaultUpdating.has(`${acc.id}-income`)}
                              className="h-3 w-3"
                            />
                            <span className="text-neutral-700">Default for income</span>
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={acc.is_default_expense}
                              onChange={(e) => setDefault('expense', acc.id, e.target.checked)}
                              disabled={defaultUpdating.has(`${acc.id}-expense`)}
                              className="h-3 w-3"
                            />
                            <span className="text-neutral-700">Default for expense</span>
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            {defaultError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {defaultError}
              </div>
            )}

            <p className="text-xs text-neutral-500">
              These accounts will be automatically selected on the dashboard.
            </p>

            <form className="mt-2 space-y-3" onSubmit={handleCreateAccount}>
              <h3 className="text-sm font-semibold text-neutral-900">Create account</h3>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700" htmlFor="account-name">
                  Name
                </label>
                <input
                  id="account-name"
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  placeholder="e.g. Debit card"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-neutral-700" htmlFor="account-kind">
                    Account type
                  </label>
                  <select
                    id="account-kind"
                    value={accountKind}
                    onChange={(e) => setAccountKind(e.target.value.toLowerCase() as AccountKind)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="debit">debit</option>
                    <option value="credit">credit</option>
                    <option value="cash">cash</option>
                    <option value="broker">broker</option>
                    <option value="crypto">crypto</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-neutral-700" htmlFor="account-currency">
                    Currency
                  </label>
                  <select
                    id="account-currency"
                    value={accountCurrency}
                    onChange={(e) => setAccountCurrency(e.target.value as AccountCurrency)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-neutral-700"
                  htmlFor="starting-balance"
                >
                  Initial balance ({accountCurrency === 'EUR' ? '€' : '$'})
                </label>
                <input
                  id="starting-balance"
                  type="number"
                  value={startingBalance}
                  onChange={(e) => setStartingBalance(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
                <p className="text-xs text-neutral-500">
                  You can enter negative values. Examples: -300 = debt {accountCurrency === 'EUR' ? '300€' : '300$'}; 0 = no debt/balance; +1300 = positive balance (e.g. PayPal).
                </p>
              </div>

              {(accountKind !== 'credit' && accountKind !== 'broker') && (
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="warning-threshold"
                  >
                    Warning threshold ({accountCurrency === 'EUR' ? '€' : '$'})
                  </label>
                  <input
                    id="warning-threshold"
                    type="number"
                    value={warningThreshold}
                    onChange={(e) => setWarningThreshold(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Orange warning when balance becomes low. Example: 500 → warning when balance ≤ 500{accountCurrency === 'EUR' ? '€' : '$'}.
                  </p>
                </div>
              )}

              {accountKind === 'broker' && (
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="warning-threshold"
                  >
                    Warning threshold ({accountCurrency === 'EUR' ? '€' : '$'})
                  </label>
                  <input
                    id="warning-threshold"
                    type="number"
                    value={warningThreshold}
                    onChange={(e) => setWarningThreshold(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Orange warning when balance becomes low. Example: 500 → warning when balance ≤ 500{accountCurrency === 'EUR' ? '€' : '$'}.
                  </p>
                </div>
              )}

              {accountKind === 'credit' && (
                <div className="space-y-2 rounded-lg bg-neutral-50 p-3">
                  {debitAccounts.length === 0 && (
                    <p className="mb-2 text-xs text-red-600">
                      Create a debit account first to link the credit card. Credit account creation is unavailable.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="credit-limit"
                      >
                        Credit limit ({accountCurrency === 'EUR' ? '€' : '$'})
                      </label>
                      <input
                        id="credit-limit"
                        type="number"
                        value={creditLimit}
                        onChange={(e) => setCreditLimit(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      />
                      <p className="text-xs text-neutral-500">
                        Enter a positive number. Example: 10000.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="credit-warning-threshold"
                      >
                        Limit approach threshold ({accountCurrency === 'EUR' ? '€' : '$'})
                      </label>
                      <input
                        id="credit-warning-threshold"
                        type="number"
                        value={creditWarningThreshold}
                        onChange={(e) => setCreditWarningThreshold(e.target.value)}
                        required
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      />
                      <p className="text-xs text-neutral-500">
                        Enter a positive number — how many {accountCurrency === 'EUR' ? '€' : '$'} before the limit to show warning. Example: limit 10000 and threshold 500 → warning starts when 9500 of 10000 used.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="debit-anchor-account"
                    >
                      Linked debit account
                    </label>
                    <select
                      id="debit-anchor-account"
                      value={debitAnchorAccountId}
                      onChange={(e) => setDebitAnchorAccountId(e.target.value)}
                      disabled={debitAccounts.length === 0}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition disabled:bg-neutral-100 focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    >
                      <option value="">Select account</option>
                      {debitAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-neutral-500">
                      Credit card is linked to the selected debit account. Used for manual 'credit repayment' on the dashboard.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <p className="text-xs font-medium text-neutral-700">Default settings</p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefaultIncome}
                    onChange={(e) => setIsDefaultIncome(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <span className="text-neutral-700">Set as default for income</span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefaultExpense}
                    onChange={(e) => setIsDefaultExpense(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <span className="text-neutral-700">Set as default for expense</span>
                </label>
              </div>

              {accountFormError && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  {accountFormError}
                </div>
              )}

              <button
                type="submit"
                disabled={accountSubmitting || (accountKind === 'credit' && debitAccounts.length === 0)}
                className="mt-1 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
              >
                {accountSubmitting ? 'Creating...' : 'Create account'}
              </button>
            </form>
          </section>

          {/* Categories block */}
          <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">Categories</h2>
              {categoriesLoading && (
                <span className="text-xs text-neutral-500">Loading...</span>
              )}
            </div>

            {categoriesError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {categoriesError}
              </div>
            )}

            {categoryDeleteError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {categoryDeleteError}
              </div>
            )}

            {moveCategoryError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {moveCategoryError}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">
                  Income categories
                </h3>
                <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                  {incomeCategories.length === 0 ? (
                    <p className="text-neutral-600">No income categories.</p>
                  ) : (
                    incomeCategories.map((cat, index) => (
                      <div key={cat.id} className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                        {editingCategoryId === cat.id ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={editCategoryName}
                              onChange={(e) => setEditCategoryName(e.target.value)}
                              className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                              autoFocus
                            />
                            {categoryEditError && (
                              <div className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                                {categoryEditError}
                              </div>
                            )}
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={handleUpdateCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg bg-neutral-900 px-2 py-1 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                              >
                                {categoryEditSubmitting ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex-1 font-medium text-neutral-900">{cat.name}</span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => moveCategory('income', cat.id, 'up')}
                                disabled={
                                  movingCategoryId !== null ||
                                  categoryEditSubmitting ||
                                  index === 0
                                }
                                className="text-xs text-neutral-600 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => moveCategory('income', cat.id, 'down')}
                                disabled={
                                  movingCategoryId !== null ||
                                  categoryEditSubmitting ||
                                  index === incomeCategories.length - 1
                                }
                                className="text-xs text-neutral-600 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move down"
                              >
                                ↓
                              </button>
                              {movingCategoryId === cat.id && (
                                <span className="text-xs text-neutral-500">Saving...</span>
                              )}
                              <button
                                type="button"
                                onClick={() => startEditCategory(cat)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCategory(cat.id)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">
                  Expense categories
                </h3>
                <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                  {expenseCategories.length === 0 ? (
                    <p className="text-neutral-600">No expense categories.</p>
                  ) : (
                    expenseCategories.map((cat, index) => (
                      <div key={cat.id} className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
                        {editingCategoryId === cat.id ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={editCategoryName}
                              onChange={(e) => setEditCategoryName(e.target.value)}
                              className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                              autoFocus
                            />
                            {categoryEditError && (
                              <div className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                                {categoryEditError}
                              </div>
                            )}
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={handleUpdateCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg bg-neutral-900 px-2 py-1 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                              >
                                {categoryEditSubmitting ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex-1 font-medium text-neutral-900">{cat.name}</span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => moveCategory('expense', cat.id, 'up')}
                                disabled={
                                  movingCategoryId !== null ||
                                  categoryEditSubmitting ||
                                  index === 0
                                }
                                className="text-xs text-neutral-600 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => moveCategory('expense', cat.id, 'down')}
                                disabled={
                                  movingCategoryId !== null ||
                                  categoryEditSubmitting ||
                                  index === expenseCategories.length - 1
                                }
                                className="text-xs text-neutral-600 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move down"
                              >
                                ↓
                              </button>
                              {movingCategoryId === cat.id && (
                                <span className="text-xs text-neutral-500">Saving...</span>
                              )}
                              <button
                                type="button"
                                onClick={() => startEditCategory(cat)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCategory(cat.id)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <form className="mt-2 space-y-3" onSubmit={handleCreateCategory}>
              <h3 className="text-sm font-semibold text-neutral-900">
                Add category
              </h3>

              <div className="flex gap-4 text-sm">
                <label className="inline-flex items-center gap-1 text-neutral-700">
                  <input
                    type="radio"
                    name="category-kind"
                    value="income"
                    checked={categoryKind === 'income'}
                    onChange={() => setCategoryKind('income')}
                    className="h-4 w-4"
                  />
                  <span>Income</span>
                </label>
                <label className="inline-flex items-center gap-1 text-neutral-700">
                  <input
                    type="radio"
                    name="category-kind"
                    value="expense"
                    checked={categoryKind === 'expense'}
                    onChange={() => setCategoryKind('expense')}
                    className="h-4 w-4"
                  />
                  <span>Expense</span>
                </label>
              </div>

              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-neutral-700"
                  htmlFor="category-name"
                >
                  Category name
                </label>
                <input
                  id="category-name"
                  type="text"
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  placeholder="e.g. Salary"
                />
              </div>

              {categoryFormError && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  {categoryFormError}
                </div>
              )}

              <button
                type="submit"
                disabled={categorySubmitting}
                className="mt-1 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
              >
                {categorySubmitting ? 'Adding...' : 'Add category'}
              </button>
            </form>
          </section>
        </main>

        {/* Budgets block */}
        <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Budgets</h2>
            {budgetsLoading && <span className="text-xs text-neutral-500">Loading...</span>}
          </div>

          {budgetsError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{budgetsError}</div>
          )}

          {budgetSuccess && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{budgetSuccess}</div>
          )}

          {budgetDeleteError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{budgetDeleteError}</div>
          )}

          {budgetDuplicateWarning.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p className="font-medium">Conflict: category assigned to multiple budgets</p>
              <ul className="mt-1 list-inside list-disc">
                {budgetDuplicateWarning.map((item, i) => (
                  <li key={i}>
                    {item.categoryName} → {item.budgetNames}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-4">
            {budgets.map((budget) => (
              <div
                key={budget.id}
                className="rounded-lg border border-neutral-200 bg-neutral-50 p-4"
              >
                {editingBudgetId === budget.id ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-neutral-900">Edit budget</h4>
                      <button
                        type="button"
                        onClick={cancelEditBudget}
                        className="text-xs text-neutral-600 hover:text-neutral-900"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-neutral-700">Name</label>
                        <input
                          type="text"
                          value={editBudgetName}
                          onChange={(e) => setEditBudgetName(e.target.value)}
                          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-neutral-700">Limit (EUR)</label>
                        <input
                          type="text"
                          value={editBudgetBaseLimitEur}
                          onChange={(e) => setEditBudgetBaseLimitEur(e.target.value)}
                          placeholder="500.00 or 500,00"
                          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-neutral-700">Start date</label>
                        <input
                          type="date"
                          value={editBudgetStartDate}
                          onChange={(e) => setEditBudgetStartDate(e.target.value)}
                          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        />
                      </div>
                      <div className="flex items-center gap-2 pt-8">
                        <input
                          type="checkbox"
                          id={`edit-carry-over-${budget.id}`}
                          checked={editBudgetCarryOver}
                          onChange={(e) => setEditBudgetCarryOver(e.target.checked)}
                          className="h-4 w-4 rounded border-neutral-300"
                        />
                        <label htmlFor={`edit-carry-over-${budget.id}`} className="text-sm text-neutral-700">
                          Balance carryover
                        </label>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-xs font-medium text-neutral-700">Expense categories</label>
                      <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-2">
                        {expenseCategories.length === 0 ? (
                          <p className="text-xs text-neutral-500">No expense categories.</p>
                        ) : (
                          expenseCategories.map((cat) => {
                            const assignedTo = categoryToBudgetMap.get(cat.id);
                            const isInOtherBudget = assignedTo && assignedTo !== budget.name;
                            const isChecked = editBudgetSelectedCategories.has(cat.id);
                            return (
                              <label
                                key={cat.id}
                                className={`flex items-center gap-2 ${isInOtherBudget ? 'cursor-not-allowed opacity-60' : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  disabled={!!isInOtherBudget}
                                  onChange={(e) => {
                                    if (isInOtherBudget) return;
                                    setEditBudgetSelectedCategories((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(cat.id);
                                      else next.delete(cat.id);
                                      return next;
                                    });
                                  }}
                                  className="h-4 w-4 rounded border-neutral-300"
                                />
                                <span className="text-sm">
                                  {cat.name}
                                  {isInOtherBudget && (
                                    <span className="ml-1 text-neutral-500">(already in {assignedTo})</span>
                                  )}
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {budgetEditError && (
                      <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{budgetEditError}</div>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleUpdateBudget}
                        disabled={budgetEditSubmitting}
                        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                      >
                        {budgetEditSubmitting ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditBudget}
                        className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between">
                    <div>
                      <h4 className="font-semibold text-neutral-900">{budget.name}</h4>
                      <p className="text-sm text-neutral-600">
                        {budget.base_limit_eur.toFixed(2)} € · from {budget.start_date.slice(0, 10)} ·{' '}
                        {budget.carry_over ? 'carry over' : 'no carry over'}
                      </p>
                      {((budgetCategoriesMap.get(budget.id) || []).length > 0) && (
                        <p className="mt-1 text-xs text-neutral-500">
                          Categories: {(budgetCategoriesMap.get(budget.id) || []).map((cid) => categories.find((c) => c.id === cid)?.name || cid).join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => startEditBudget(budget)}
                        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteBudget(budget.id)}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <form onSubmit={handleCreateBudget} className="mt-4 space-y-4 rounded-lg border border-neutral-200 p-4">
            <h3 className="text-sm font-semibold text-neutral-900">Create budget</h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700" htmlFor="budget-name">
                  Name
                </label>
                <input
                  id="budget-name"
                  type="text"
                  value={budgetName}
                  onChange={(e) => setBudgetName(e.target.value)}
                  placeholder="e.g. Groceries"
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700" htmlFor="budget-limit">
                  Limit (EUR)
                </label>
                <input
                  id="budget-limit"
                  type="text"
                  value={budgetBaseLimitEur}
                  onChange={(e) => setBudgetBaseLimitEur(e.target.value)}
                  placeholder="500.00 or 500,00"
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700" htmlFor="budget-start-date">
                  Start date
                </label>
                <input
                  id="budget-start-date"
                  type="date"
                  value={budgetStartDate}
                  onChange={(e) => setBudgetStartDate(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
              <div className="flex items-center gap-2 pt-8">
                <input
                  type="checkbox"
                  id="budget-carry-over"
                  checked={budgetCarryOver}
                  onChange={(e) => setBudgetCarryOver(e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-300"
                />
                <label htmlFor="budget-carry-over" className="text-sm text-neutral-700">
                  Balance carryover
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-neutral-700">Expense categories</label>
              <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-2">
                {expenseCategories.length === 0 ? (
                  <p className="text-xs text-neutral-500">Create expense categories.</p>
                ) : (
                  expenseCategories.map((cat) => {
                    const assignedTo = categoryToBudgetMap.get(cat.id);
                    const isInOtherBudget = !!assignedTo;
                    const isChecked = budgetSelectedCategories.has(cat.id);
                    return (
                      <label
                        key={cat.id}
                        className={`flex items-center gap-2 ${isInOtherBudget ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isInOtherBudget}
                          onChange={(e) => {
                            if (isInOtherBudget) return;
                            setBudgetSelectedCategories((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(cat.id);
                              else next.delete(cat.id);
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-neutral-300"
                        />
                        <span className="text-sm">
                          {cat.name}
                          {isInOtherBudget && (
                            <span className="ml-1 text-neutral-500">(already in {assignedTo})</span>
                          )}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            {budgetFormError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{budgetFormError}</div>
            )}

            <button
              type="submit"
              disabled={budgetSubmitting}
              className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
            >
              {budgetSubmitting ? 'Creating...' : 'Create budget'}
            </button>
          </form>
        </section>

        {/* Investments/Positions block */}
        <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Investments / Positions</h2>
            {positionsLoading && <span className="text-xs text-neutral-500">Loading...</span>}
          </div>

            {positionsError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {positionsError}
              </div>
            )}

            {positionDeleteError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {positionDeleteError}
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-xs font-medium text-neutral-700">
                Broker account (required)
              </label>
              <select
                value={selectedBrokerAccountId}
                onChange={(e) => setSelectedBrokerAccountId(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
              >
                <option value="">Select broker account</option>
                {brokerAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({(acc.currency || 'EUR') === 'EUR' ? 'EUR' : 'USD'})
                  </option>
                ))}
              </select>
            </div>

            {brokerAccounts.length === 0 ? (
              <p className="text-sm text-neutral-600">
                Create a broker account (type broker) to add positions.
              </p>
            ) : selectedBrokerAccountId ? (
              <>
                <div className="max-h-96 space-y-2 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                  {positions.length === 0 ? (
                    <p className="text-neutral-600">No positions.</p>
                  ) : (
                    positions.map((pos) => (
                      <div
                        key={pos.id}
                        className="rounded-md border border-neutral-200 px-3 py-2"
                      >
                        {editingPositionId === pos.id ? (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <h4 className="text-sm font-semibold text-neutral-900">
                                Edit position
                              </h4>
                              <button
                                type="button"
                                onClick={cancelEditPosition}
                                className="text-xs text-neutral-600 hover:text-neutral-900"
                              >
                                ✕
                              </button>
                            </div>

                            <div className="space-y-2">
                              <div className="text-xs text-neutral-600">
                                Symbol: {pos.instrument.display_symbol || pos.instrument.provider_symbol} (
                                {pos.instrument.kind})
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Quantity
                                </label>
                                <input
                                  type="text"
                                  value={editPositionQuantity}
                                  onChange={(e) => setEditPositionQuantity(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                                <p className="mt-1 text-[10px] text-neutral-500">
                                  You can enter expressions: 5+6-2, supports + - * / ( )
                                </p>
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Comment
                                </label>
                                <input
                                  type="text"
                                  value={editPositionComment}
                                  onChange={(e) => setEditPositionComment(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                              </div>

                              {positionEditError && (
                                <div className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                                  {positionEditError}
                                </div>
                              )}

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={handleUpdatePosition}
                                  disabled={positionEditSubmitting}
                                  className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                                >
                                  {positionEditSubmitting ? 'Saving...' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditPosition}
                                  disabled={positionEditSubmitting}
                                  className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-neutral-900">
                                    {pos.instrument.display_symbol || pos.instrument.provider_symbol}
                                  </span>
                                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
                                    {pos.instrument.kind}
                                  </span>
                                </div>
                                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600">
                                  <span>
                                    Quantity:{' '}
                                    <span className="font-medium">{pos.quantity}</span>
                                  </span>
                                  <span>
                                    Currency:{' '}
                                    <span className="font-medium">{pos.quote_currency}</span>
                                  </span>
                                  <span>
                                    Price:{' '}
                                    <span className="font-medium">
                                      {pos.quote_currency === 'EUR' ? '€' : '$'}
                                      {pos.last_price.toFixed(2)}
                                    </span>
                                    {pos.quote_currency === 'USD' && fxRate && (
                                      <span className="ml-1 text-neutral-500">
                                        (≈ €{(pos.last_price * fxRate).toFixed(2)})
                                      </span>
                                    )}
                                  </span>
                                  <span>
                                    Value:{' '}
                                    <span className="font-medium">
                                      {pos.quote_currency === 'EUR' ? '€' : '$'}
                                      {(pos.quantity * pos.last_price).toFixed(2)}
                                    </span>
                                    {pos.quote_currency === 'USD' && fxRate && (
                                      <span className="ml-1 text-neutral-500">
                                        (≈ €
                                        {(pos.quantity * pos.last_price * fxRate).toFixed(2)})
                                      </span>
                                    )}
                                  </span>
                                  {pos.comment && (
                                    <span className="col-span-2">
                                      Comment:{' '}
                                      <span className="font-medium">{pos.comment}</span>
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  onClick={() => startEditPosition(pos)}
                                  className="text-xs text-blue-600 hover:text-blue-800"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeletePosition(pos.id)}
                                  className="text-xs text-red-600 hover:text-red-800"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <form className="mt-2 space-y-3" onSubmit={handleCreatePosition}>
                  <h3 className="text-sm font-semibold text-neutral-900">Add position</h3>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-kind"
                    >
                      Instrument type
                    </label>
                    <select
                      id="position-kind"
                      value={positionKind}
                      onChange={(e) => setPositionKind(e.target.value as InstrumentKind)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    >
                      <option value="stock">stock</option>
                      <option value="etf">etf</option>
                      <option value="bond">bond</option>
                      <option value="other">other</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-symbol"
                    >
                      Symbol (manual entry)
                    </label>
                    <input
                      id="position-symbol"
                      type="text"
                      value={positionSymbol}
                      onChange={(e) => setPositionSymbol(e.target.value)}
                      required
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="e.g. AAPL"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-comment"
                    >
                      Comment (optional)
                    </label>
                    <input
                      id="position-comment"
                      type="text"
                      value={positionComment}
                      onChange={(e) => setPositionComment(e.target.value)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    />
                  </div>

                  <div className="space-y-1">
                    <span className="block text-xs font-medium text-neutral-700">
                      Input mode
                    </span>
                    <div className="inline-flex rounded-lg border border-neutral-300 bg-neutral-50 p-0.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setPositionInputMode('quantity')}
                        className={`px-3 py-1 rounded-md ${
                          positionInputMode === 'quantity'
                            ? 'bg-white text-neutral-900 shadow-sm'
                            : 'text-neutral-600'
                        }`}
                      >
                        Quantity
                      </button>
                      <button
                        type="button"
                        onClick={() => setPositionInputMode('amount')}
                        className={`px-3 py-1 rounded-md ${
                          positionInputMode === 'amount'
                            ? 'bg-white text-neutral-900 shadow-sm'
                            : 'text-neutral-600'
                        }`}
                      >
                        Amount
                      </button>
                    </div>
                  </div>

                  {positionInputMode === 'quantity' ? (
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="position-quantity"
                      >
                        Quantity
                      </label>
                      <input
                        id="position-quantity"
                        type="text"
                        value={positionQuantity}
                        onChange={(e) => setPositionQuantity(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      />
                      <p className="mt-1 text-xs text-neutral-500">
                        You can enter expressions: 5+6-2, supports + - * / ( )
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="position-amount"
                      >
                        Amount in broker account currency
                      </label>
                      <input
                        id="position-amount"
                        type="number"
                        step="any"
                        min="0"
                        value={positionAmount}
                        onChange={(e) => setPositionAmount(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                        placeholder="e.g. 1500"
                      />
                      <p className="text-[11px] text-neutral-500">
                        Quantity will be calculated automatically based on the current instrument price.
                      </p>
                    </div>
                  )}

                  {positionFormError && (
                    <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                      {positionFormError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={positionSubmitting}
                    className="mt-1 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                  >
                    {positionSubmitting ? 'Creating...' : 'Create position'}
                  </button>
                </form>
              </>
            ) : null}
          </section>

        {/* Crypto / Positions block */}
        <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Crypto / Positions</h2>
            {cryptoPositionsLoading && (
              <span className="text-xs text-neutral-500">Loading...</span>
            )}
          </div>

          {cryptoPositionsError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {cryptoPositionsError}
            </div>
          )}

          {cryptoPositionDeleteError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {cryptoPositionDeleteError}
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-xs font-medium text-neutral-700">
              Crypto account (required)
            </label>
            <select
              value={selectedCryptoAccountId}
              onChange={(e) => setSelectedCryptoAccountId(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
            >
              <option value="">Select crypto account</option>
              {cryptoAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({(acc.currency || 'EUR') === 'EUR' ? 'EUR' : 'USD'})
                </option>
              ))}
            </select>
          </div>

          {cryptoAccounts.length === 0 ? (
            <p className="text-sm text-neutral-600">
              Create a crypto account (type crypto) to add crypto positions.
            </p>
          ) : selectedCryptoAccountId ? (
            <>
              <div className="max-h-96 space-y-2 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                {cryptoPositions.length === 0 ? (
                  <p className="text-neutral-600">No crypto positions.</p>
                ) : (
                  cryptoPositions.map((pos) => (
                    <div
                      key={pos.id}
                      className="rounded-md border border-neutral-200 px-3 py-2"
                    >
                      {editingCryptoPositionId === pos.id ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-neutral-900">
                              Edit crypto position
                            </h4>
                            <button
                              type="button"
                              onClick={cancelEditCryptoPosition}
                              className="text-xs text-neutral-600 hover:text-neutral-900"
                            >
                              ✕
                            </button>
                          </div>

                          <div className="space-y-2">
                            <div className="text-xs text-neutral-600">
                              Symbol:{' '}
                              {pos.instrument.display_symbol || pos.instrument.provider_symbol}{' '}
                              ({pos.instrument.kind})
                            </div>

                            <div className="space-y-1">
                              <label className="block text-xs font-medium text-neutral-700">
                                Input mode
                              </label>
                              <div className="inline-flex rounded-lg border border-neutral-300 bg-neutral-50 p-0.5 text-[10px]">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditCryptoPositionInputMode('quantity');
                                    setEditCryptoAmount('');
                                  }}
                                  className={`px-2 py-0.5 rounded-md ${
                                    editCryptoPositionInputMode === 'quantity'
                                      ? 'bg-white text-neutral-900 shadow-sm'
                                      : 'text-neutral-600'
                                  }`}
                                >
                                  Quantity
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditCryptoPositionInputMode('amount');
                                    setEditCryptoPositionQuantity('');
                                  }}
                                  className={`px-2 py-0.5 rounded-md ${
                                    editCryptoPositionInputMode === 'amount'
                                      ? 'bg-white text-neutral-900 shadow-sm'
                                      : 'text-neutral-600'
                                  }`}
                                >
                                  Amount
                                </button>
                              </div>
                            </div>

                            {editCryptoPositionInputMode === 'quantity' ? (
                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Quantity
                                </label>
                                <input
                                  type="text"
                                  value={editCryptoPositionQuantity}
                                  onChange={(e) =>
                                    setEditCryptoPositionQuantity(e.target.value)
                                  }
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                                <p className="mt-1 text-[10px] text-neutral-500">
                                  You can enter expressions: 0.1+0.2, supports + - * / ( )
                                </p>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Amount in crypto account currency
                                </label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  value={editCryptoAmount}
                                  onChange={(e) => setEditCryptoAmount(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                                <p className="text-[10px] text-neutral-500">
                                  Quantity will be calculated automatically based on the current
                                  coin price.
                                </p>
                              </div>
                            )}

                            <div className="space-y-1">
                              <label className="block text-xs font-medium text-neutral-700">
                                Comment
                              </label>
                              <input
                                type="text"
                                value={editCryptoPositionComment}
                                onChange={(e) => setEditCryptoPositionComment(e.target.value)}
                                className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                              />
                            </div>

                            {cryptoPositionEditError && (
                              <div className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                                {cryptoPositionEditError}
                              </div>
                            )}

                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={handleUpdateCryptoPosition}
                                disabled={cryptoPositionEditSubmitting}
                                className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                              >
                                {cryptoPositionEditSubmitting ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditCryptoPosition}
                                disabled={cryptoPositionEditSubmitting}
                                className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-neutral-900">
                                {pos.instrument.display_symbol || pos.instrument.provider_symbol}
                              </span>
                              <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-800">
                                {pos.instrument.kind}
                              </span>
                            </div>
                            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600">
                              <span>
                                Coin id:{' '}
                                <span className="font-medium">
                                  {pos.instrument.provider_symbol}
                                </span>
                              </span>
                              <span>
                                Quantity:{' '}
                                <span className="font-medium">{pos.quantity}</span>
                              </span>
                              <span>
                                Currency:{' '}
                                <span className="font-medium">{pos.quote_currency}</span>
                              </span>
                              <span>
                                Price:{' '}
                                {pos.last_price !== null && pos.last_price !== undefined ? (
                                  <>
                                    <span className="font-medium">
                                      {pos.quote_currency === 'EUR' ? '€' : '$'}
                                      {pos.last_price.toFixed(2)}
                                    </span>
                                    {pos.quote_currency === 'USD' && fxRate && (
                                      <span className="ml-1 text-neutral-500">
                                        (≈ €{(pos.last_price * fxRate).toFixed(2)})
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="font-medium">—</span>
                                )}
                              </span>
                              <span>
                                Value:{' '}
                                {pos.last_price !== null && pos.last_price !== undefined ? (
                                  <>
                                    <span className="font-medium">
                                      {pos.quote_currency === 'EUR' ? '€' : '$'}
                                      {(pos.quantity * pos.last_price).toFixed(2)}
                                    </span>
                                    {pos.quote_currency === 'USD' && fxRate && (
                                      <span className="ml-1 text-neutral-500">
                                        (≈ €
                                        {(pos.quantity * pos.last_price * fxRate).toFixed(2)})
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="font-medium">—</span>
                                )}
                              </span>
                              {pos.comment && (
                                <span className="col-span-2">
                                  Comment:{' '}
                                  <span className="font-medium">{pos.comment}</span>
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={() => startEditCryptoPosition(pos)}
                              className="text-xs text-blue-600 hover:text-blue-800"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCryptoPosition(pos.id)}
                              className="text-xs text-red-600 hover:text-red-800"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <form className="mt-2 space-y-3" onSubmit={handleCreateCryptoPosition}>
                <h3 className="text-sm font-semibold text-neutral-900">Add crypto position</h3>

                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="crypto-coin-id"
                  >
                    CoinGecko coin id
                  </label>
                  <input
                    id="crypto-coin-id"
                    type="text"
                    value={cryptoCoinId}
                    onChange={(e) => setCryptoCoinId(e.target.value)}
                    required
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="e.g. bitcoin"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Coin id from CoinGecko, e.g. &quot;bitcoin&quot; or &quot;ethereum&quot;.
                  </p>
                </div>

                {/* Display symbol is derived automatically from the CoinGecko id */}
                <div className="space-y-1">
                  <span className="block text-xs font-medium text-neutral-700">
                    Display symbol (auto)
                  </span>
                  <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                    {cryptoCoinId.trim()
                      ? cryptoCoinId.trim().toUpperCase()
                      : 'Will be set automatically from coin id'}
                  </div>
                </div>

                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                  >
                    Input mode
                  </label>
                  <div className="inline-flex rounded-lg border border-neutral-300 bg-neutral-50 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setCryptoPositionInputMode('quantity');
                        setCryptoAmount('');
                      }}
                      className={`px-3 py-1 rounded-md ${
                        cryptoPositionInputMode === 'quantity'
                          ? 'bg-white text-neutral-900 shadow-sm'
                          : 'text-neutral-600'
                      }`}
                    >
                      Quantity
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCryptoPositionInputMode('amount');
                        setCryptoQuantity('');
                      }}
                      className={`px-3 py-1 rounded-md ${
                        cryptoPositionInputMode === 'amount'
                          ? 'bg-white text-neutral-900 shadow-sm'
                          : 'text-neutral-600'
                      }`}
                    >
                      Amount
                    </button>
                  </div>
                </div>

                {cryptoPositionInputMode === 'quantity' ? (
                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="crypto-quantity"
                    >
                      Quantity
                    </label>
                    <input
                      id="crypto-quantity"
                      type="text"
                      value={cryptoQuantity}
                      onChange={(e) => setCryptoQuantity(e.target.value)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="e.g. 0.5"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      You can enter expressions: 0.1+0.2, supports + - * / ( )
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="crypto-amount"
                    >
                      Amount in crypto account currency
                    </label>
                    <input
                      id="crypto-amount"
                      type="number"
                      step="any"
                      min="0"
                      value={cryptoAmount}
                      onChange={(e) => setCryptoAmount(e.target.value)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="e.g. 1500"
                    />
                    <p className="text-[11px] text-neutral-500">
                      Quantity will be calculated automatically based on the current coin price.
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="crypto-comment"
                  >
                    Comment (optional)
                  </label>
                  <input
                    id="crypto-comment"
                    type="text"
                    value={cryptoComment}
                    onChange={(e) => setCryptoComment(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                </div>

                {cryptoPositionFormError && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {cryptoPositionFormError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={cryptoPositionSubmitting}
                  className="mt-1 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {cryptoPositionSubmitting ? 'Creating...' : 'Create crypto position'}
                </button>
              </form>
            </>
          ) : null}
        </section>

        {/* Danger Zone */}
        <section className="rounded-2xl border-2 border-red-200 bg-red-50 p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-red-900">Danger zone</h2>
          <div className="space-y-3">
            <div>
              {showPeriodDeletePanel ? (
                <>
                  <p className="mb-3 text-sm text-red-800">
                    Will delete income/expense/transfers in the selected date range. Accounts and categories will be preserved.
                  </p>
                  {clearPeriodSuccess && (
                    <div className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                      {clearPeriodSuccess}
                    </div>
                  )}
                  {clearPeriodError && (
                    <div className="mb-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">
                      {clearPeriodError}
                    </div>
                  )}
                  <div className="mb-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-red-900" htmlFor="date-from">
                        Start date
                      </label>
                      <input
                        id="date-from"
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        disabled={clearingPeriod}
                        className="w-full rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200 disabled:cursor-not-allowed disabled:bg-red-100"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-red-900" htmlFor="date-to">
                        End date
                      </label>
                      <input
                        id="date-to"
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        disabled={clearingPeriod}
                        className="w-full rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-200 disabled:cursor-not-allowed disabled:bg-red-100"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:gap-2">
                    <button
                      type="button"
                      onClick={handleClearPeriod}
                      disabled={clearingPeriod}
                      className="w-full rounded-lg border-2 border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 hover:border-red-700 disabled:cursor-not-allowed disabled:bg-red-400 disabled:border-red-400 md:w-auto"
                    >
                      {clearingPeriod ? 'Deleting...' : 'Delete transactions for period'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowPeriodDeletePanel(false)}
                      className="w-full rounded-lg border-2 border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 md:w-auto"
                    >
                      Hide
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowPeriodDeletePanel(true)}
                  className="rounded-lg border-2 border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50"
                >
                  Delete transactions for period
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
