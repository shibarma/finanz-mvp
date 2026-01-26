'use client';

import { useEffect, useMemo, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

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

// Простой helper, чтобы переиспользовать в будущем
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

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  // Редактирование категорий
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [categoryEditError, setCategoryEditError] = useState<string | null>(null);
  const [categoryEditSubmitting, setCategoryEditSubmitting] = useState(false);
  const [categoryDeleteError, setCategoryDeleteError] = useState<string | null>(null);
  const [movingCategoryId, setMovingCategoryId] = useState<string | null>(null);
  const [moveCategoryError, setMoveCategoryError] = useState<string | null>(null);

  // Форма аккаунтов
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

  // Редактирование счета
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

  // Очистка истории операций
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearHistoryError, setClearHistoryError] = useState<string | null>(null);
  const [clearHistorySuccess, setClearHistorySuccess] = useState<string | null>(null);

  // Очистка операций за период
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [clearingPeriod, setClearingPeriod] = useState(false);
  const [clearPeriodError, setClearPeriodError] = useState<string | null>(null);
  const [clearPeriodSuccess, setClearPeriodSuccess] = useState<string | null>(null);

  // Форма категорий
  const [categoryKind, setCategoryKind] = useState<CategoryKind>('income');
  const [categoryName, setCategoryName] = useState('');
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);

  // Investments/Positions
  const [selectedBrokerAccountId, setSelectedBrokerAccountId] = useState<string>('');
  const [positions, setPositions] = useState<PositionWithInstrument[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionFormError, setPositionFormError] = useState<string | null>(null);
  const [positionSubmitting, setPositionSubmitting] = useState(false);
  const [positionKind, setPositionKind] = useState<InstrumentKind>('stock');
  const [positionSymbol, setPositionSymbol] = useState('');
  const [positionQuantity, setPositionQuantity] = useState('');
  const [positionComment, setPositionComment] = useState('');
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [editPositionQuantity, setEditPositionQuantity] = useState('');
  const [editPositionComment, setEditPositionComment] = useState('');
  const [positionEditSubmitting, setPositionEditSubmitting] = useState(false);
  const [positionEditError, setPositionEditError] = useState<string | null>(null);
  const [positionDeleteError, setPositionDeleteError] = useState<string | null>(null);

  const debitAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'debit'),
    [accounts],
  );

  // Map для быстрого поиска имени счета по ID
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
      // First, fetch existing FX rate from fx_rates table
      const { data: existingFxRate, error: fetchError } = await supabase
        .from('fx_rates')
        .select('rate, fetched_at')
        .eq('user_id', userId)
        .eq('base_currency', 'USD')
        .eq('quote_currency', 'EUR')
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
      const now = new Date().toISOString();
      const { error: upsertError } = await supabase
        .from('fx_rates')
        .upsert(
          {
            user_id: userId,
            base_currency: 'USD',
            quote_currency: 'EUR',
            rate: data.rate,
            fetched_at: now,
          },
          {
            onConflict: 'user_id,base_currency,quote_currency',
          }
        );

      if (upsertError) {
        console.error('Error upserting FX rate:', upsertError);
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
      setSessionChecked(true);
      await Promise.all([loadAccounts(), loadCategories()]);
    };

    init();
  }, [router]);

  useEffect(() => {
    // Load FX rate after accounts are loaded
    if (userId && accounts.length >= 0) {
      loadFxRate();
    }
  }, [userId, accounts]);

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

    // Сортируем на клиенте: kind, sort_order asc, created_at asc
    const sorted = (data || []).sort((a, b) => {
      // Сначала по kind
      if (a.kind !== b.kind) {
        return a.kind.localeCompare(b.kind);
      }
      // Затем по sort_order (nulls last)
      const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      // Наконец по created_at
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    setCategories(sorted as Category[]);
  };

  const setDefault = async (kind: 'income' | 'expense', accountId: string, value: boolean) => {
    if (!userId) return;

    const fieldName = kind === 'income' ? 'is_default_income' : 'is_default_expense';
    const updateKey = `${accountId}-${kind}`;

    setDefaultError(null);
    setDefaultUpdating((prev) => new Set(prev).add(updateKey));

    try {
      if (value) {
        // Сначала сбросить флаг у всех счетов пользователя
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

        // Затем установить true только выбранному счёту
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
        // Просто установить false для выбранного счёта
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

      // Обновить локальное состояние
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
      setAccountFormError('Название счёта обязательно.');
      return;
    }

    if (!accountCurrency) {
      setAccountFormError('Валюта обязательна.');
      return;
    }

    if (!startingBalance.trim()) {
      setAccountFormError('Начальный баланс обязателен.');
      return;
    }

    const startingBalanceNum = Number(startingBalance);
    if (Number.isNaN(startingBalanceNum)) {
      setAccountFormError('Начальный баланс должен быть числом.');
      return;
    }

    let warningThresholdNum: number | null = null;
    let creditLimitNum: number | null = null;
    let creditWarningNum: number | null = null;
    let debitAnchorId: string | null = null;

    if (accountKind === 'credit') {
      // Для credit счетов не используем warning_threshold
      if (debitAccounts.length === 0) {
        setAccountFormError('Сначала создайте дебетовый счёт для привязки кредитки.');
        return;
      }

      if (!creditLimit.trim()) {
        setAccountFormError('Лимит по кредиту обязателен.');
        return;
      }
      creditLimitNum = Number(creditLimit);
      if (Number.isNaN(creditLimitNum) || creditLimitNum <= 0) {
        setAccountFormError('Лимит по кредиту должен быть положительным числом.');
        return;
      }

      if (!creditWarningThreshold.trim()) {
        setAccountFormError('Порог приближения к лимиту обязателен.');
        return;
      }
      creditWarningNum = Number(creditWarningThreshold);
      if (Number.isNaN(creditWarningNum)) {
        setAccountFormError('Порог приближения к лимиту должен быть числом.');
        return;
      }

      if (!debitAnchorAccountId) {
        setAccountFormError('Выберите дебетовый счёт для привязки кредитной карты.');
        return;
      }
      debitAnchorId = debitAnchorAccountId;
    } else {
      // Для debit, cash и broker используем warning_threshold
      const warningThresholdValue = warningThreshold || '0';
      warningThresholdNum = Number(warningThresholdValue);
      if (Number.isNaN(warningThresholdNum)) {
        setAccountFormError('Порог предупреждения должен быть числом.');
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

    // Если нужно установить default флаги, делаем это после создания
    if (newAccount) {
      if (isDefaultIncome) {
        await setDefault('income', newAccount.id, true);
      }
      if (isDefaultExpense) {
        await setDefault('expense', newAccount.id, true);
      }
    }

    setAccountSubmitting(false);

    // очистка формы
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
      setEditError('Название счёта обязательно.');
      return;
    }

    if (!editAccountCurrency) {
      setEditError('Валюта обязательна.');
      return;
    }

    const startingBalanceNum = Number(editStartingBalance);
    if (Number.isNaN(startingBalanceNum)) {
      setEditError('Начальный баланс должен быть числом.');
      return;
    }

    let warningThresholdNum: number | null = null;
    let creditLimitNum: number | null = null;
    let creditWarningNum: number | null = null;
    let debitAnchorId: string | null = null;

    if (account.kind === 'credit') {
      if (!editCreditLimit.trim()) {
        setEditError('Лимит по кредиту обязателен.');
        return;
      }
      creditLimitNum = Number(editCreditLimit);
      if (Number.isNaN(creditLimitNum) || creditLimitNum <= 0) {
        setEditError('Лимит по кредиту должен быть положительным числом.');
        return;
      }

      if (!editCreditWarningThreshold.trim()) {
        setEditError('Порог приближения к лимиту обязателен.');
        return;
      }
      creditWarningNum = Number(editCreditWarningThreshold);
      if (Number.isNaN(creditWarningNum) || creditWarningNum < 0) {
        setEditError('Порог приближения к лимиту должен быть неотрицательным числом.');
        return;
      }

      if (!editDebitAnchorAccountId) {
        setEditError('Выберите дебетовый счёт для привязки кредитной карты.');
        return;
      }
      debitAnchorId = editDebitAnchorAccountId;
    } else {
      const warningThresholdValue = editWarningThreshold || '0';
      warningThresholdNum = Number(warningThresholdValue);
      if (Number.isNaN(warningThresholdNum) || warningThresholdNum < 0) {
        setEditError('Порог предупреждения должен быть неотрицательным числом.');
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
    if (!window.confirm('Вы уверены, что хотите удалить этот счёт?')) {
      return;
    }

    setDeleteError(null);
    setEditError(null);

    // Проверка 1: есть ли транзакции
    const { count: transactionsCount } = await supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('account_id', accountId);

    if (transactionsCount && transactionsCount > 0) {
      setDeleteError(
        'Нельзя удалить счёт: по нему есть операции. В v1 удаление возможно только для пустых счетов.',
      );
      return;
    }

    // Проверка 2: есть ли transfers
    const { count: transfersCount } = await supabase
      .from('transfers')
      .select('*', { count: 'exact', head: true })
      .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`);

    if (transfersCount && transfersCount > 0) {
      setDeleteError(
        'Нельзя удалить счёт: по нему есть операции. В v1 удаление возможно только для пустых счетов.',
      );
      return;
    }

    // Проверка 3: для broker счетов - есть ли investment positions
    const account = accounts.find((a) => a.id === accountId);
    if (account && account.kind === 'broker') {
      const { count: positionsCount } = await supabase
        .from('positions')
        .select('*', { count: 'exact', head: true })
        .eq('broker_account_id', accountId);

      if (positionsCount && positionsCount > 0) {
        setDeleteError(
          'Нельзя удалить счёт: по нему есть операции. В v1 удаление возможно только для пустых счетов.',
        );
        return;
      }
    }

    // Проверка 4: используется ли как debit_anchor_account_id
    if (account && account.kind === 'debit') {
      const { count: linkedCreditCount } = await supabase
        .from('accounts')
        .select('*', { count: 'exact', head: true })
        .eq('debit_anchor_account_id', accountId);

      if (linkedCreditCount && linkedCreditCount > 0) {
        setDeleteError(
          'Нельзя удалить дебетовый счёт, пока к нему привязаны кредитные счета.',
        );
        return;
      }
    }

    // Удаление
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
      setCategoryFormError('Название категории обязательно.');
      return;
    }

    setCategorySubmitting(true);

    // Вычисляем sort_order: max по этому kind + 10
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
      setCategoryEditError('Название категории обязательно.');
      return;
    }

    setCategoryEditSubmitting(true);

    const { error } = await supabase
      .from('categories')
      .update({ name: editCategoryName.trim() })
      .eq('id', editingCategoryId);

    setCategoryEditSubmitting(false);

    if (error) {
      // Проверка на unique constraint
      if (error.code === '23505' || error.message.includes('unique') || error.message.includes('duplicate')) {
        setCategoryEditError('Категория с таким названием уже существует для этого типа.');
      } else {
        setCategoryEditError(error.message);
      }
      return;
    }

    cancelEditCategory();
    await loadCategories();
  };

  const handleDeleteCategory = async (categoryId: string) => {
    if (!window.confirm('Вы уверены, что хотите удалить эту категорию?')) {
      return;
    }

    setCategoryDeleteError(null);

    const { error } = await supabase.from('categories').delete().eq('id', categoryId);

    if (error) {
      // Проверка на внешние ключи (использование в transactions)
      if (
        error.code === '23503' ||
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        setCategoryDeleteError(
          'Нельзя удалить категорию: она уже используется в операциях. В v1 удаление возможно только для неиспользуемых категорий.',
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
      // Получаем текущий отсортированный массив категорий этого kind
      const categoriesOfKind = categories
        .filter((c) => c.kind === kind)
        .sort((a, b) => {
          const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      // Находим индекс текущей категории
      const currentIndex = categoriesOfKind.findIndex((c) => c.id === categoryId);
      if (currentIndex === -1) {
        setMoveCategoryError('Категория не найдена.');
        setMovingCategoryId(null);
        return;
      }

      // Определяем индекс соседа
      const neighborIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (neighborIndex < 0 || neighborIndex >= categoriesOfKind.length) {
        // Нет соседа - ничего не делаем
        setMovingCategoryId(null);
        return;
      }

      const current = categoriesOfKind[currentIndex];
      const neighbor = categoriesOfKind[neighborIndex];

      // Swap через 3 обновления
      // 1) Устанавливаем временное значение для current
      const { error: error1 } = await supabase
        .from('categories')
        .update({ sort_order: -999999 })
        .eq('id', current.id)
        .eq('user_id', userId);

      if (error1) {
        setMoveCategoryError(`Ошибка при перемещении: ${error1.message}`);
        setMovingCategoryId(null);
        return;
      }

      // 2) Устанавливаем sort_order соседа для current
      const { error: error2 } = await supabase
        .from('categories')
        .update({ sort_order: neighbor.sort_order })
        .eq('id', current.id)
        .eq('user_id', userId);

      if (error2) {
        setMoveCategoryError(`Ошибка при перемещении: ${error2.message}`);
        setMovingCategoryId(null);
        return;
      }

      // 3) Устанавливаем sort_order current для соседа
      const { error: error3 } = await supabase
        .from('categories')
        .update({ sort_order: current.sort_order })
        .eq('id', neighbor.id)
        .eq('user_id', userId);

      if (error3) {
        setMoveCategoryError(`Ошибка при перемещении: ${error3.message}`);
        setMovingCategoryId(null);
        return;
      }

      // Успешно - обновляем список категорий
      await loadCategories();
    } catch (error: any) {
      setMoveCategoryError(`Неожиданная ошибка: ${error.message || 'Неизвестная ошибка'}`);
    } finally {
      setMovingCategoryId(null);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const handleClearHistory = async () => {
    if (
      !window.confirm(
        'Вы уверены? Все доходы, расходы и переводы будут удалены. Счета и категории сохранятся. Действие нельзя отменить.',
      )
    ) {
      return;
    }

    setClearHistoryError(null);
    setClearHistorySuccess(null);
    setClearingHistory(true);

    try {
      // Получаем текущую сессию
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session?.user?.id) {
        setClearHistoryError('Не удалось получить сессию пользователя.');
        setClearingHistory(false);
        return;
      }

      const userId = sessionData.session.user.id;

      // Удаляем транзакции
      const { error: transactionsError } = await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId);

      if (transactionsError) {
        setClearHistoryError(`Ошибка при удалении транзакций: ${transactionsError.message}`);
        setClearingHistory(false);
        return;
      }

      // Удаляем переводы
      const { error: transfersError } = await supabase
        .from('transfers')
        .delete()
        .eq('user_id', userId);

      if (transfersError) {
        setClearHistoryError(`Ошибка при удалении переводов: ${transfersError.message}`);
        setClearingHistory(false);
        return;
      }

      // Успех
      setClearHistorySuccess('Готово: история очищена');
      setClearingHistory(false);
    } catch (error: any) {
      setClearHistoryError(`Неожиданная ошибка: ${error.message || 'Неизвестная ошибка'}`);
      setClearingHistory(false);
    }
  };

  const handleClearPeriod = async () => {
    // Валидация
    if (!dateFrom || !dateTo) {
      setClearPeriodError('Обе даты обязательны для заполнения.');
      return;
    }

    if (dateFrom > dateTo) {
      setClearPeriodError('Дата начала не может быть позже даты окончания.');
      return;
    }

    // Подтверждение
    if (!window.confirm(`Удалить операции с ${dateFrom} по ${dateTo}? Это нельзя отменить.`)) {
      return;
    }

    setClearPeriodError(null);
    setClearPeriodSuccess(null);
    setClearingPeriod(true);

    try {
      // Получаем текущую сессию
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session?.user?.id) {
        setClearPeriodError('Не удалось получить сессию пользователя.');
        setClearingPeriod(false);
        return;
      }

      const userId = sessionData.session.user.id;

      // Формируем безопасные ISO даты
      const start = new Date(dateFrom + 'T00:00:00');
      const endExclusive = new Date(dateTo + 'T00:00:00');
      endExclusive.setDate(endExclusive.getDate() + 1);

      const startISO = start.toISOString();
      const endISO = endExclusive.toISOString();

      // Удаляем транзакции в диапазоне
      const { error: transactionsError } = await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId)
        .gte('created_at', startISO)
        .lt('created_at', endISO);

      if (transactionsError) {
        setClearPeriodError(`Ошибка при удалении транзакций: ${transactionsError.message}`);
        setClearingPeriod(false);
        return;
      }

      // Удаляем переводы в диапазоне
      const { error: transfersError } = await supabase
        .from('transfers')
        .delete()
        .eq('user_id', userId)
        .gte('created_at', startISO)
        .lt('created_at', endISO);

      if (transfersError) {
        setClearPeriodError(`Ошибка при удалении переводов: ${transfersError.message}`);
        setClearingPeriod(false);
        return;
      }

      // Успех
      setClearPeriodSuccess('Операции за период удалены');
      setClearingPeriod(false);
      // Очищаем поля дат
      setDateFrom('');
      setDateTo('');
    } catch (error: any) {
      setClearPeriodError(`Неожиданная ошибка: ${error.message || 'Неизвестная ошибка'}`);
      setClearingPeriod(false);
    }
  };

  const brokerAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'broker'),
    [accounts],
  );

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

  const handleCreatePosition = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !selectedBrokerAccountId) return;

    setPositionFormError(null);

    if (!positionSymbol.trim()) {
      setPositionFormError('Символ обязателен.');
      return;
    }

    const quantityNum = Number(positionQuantity);
    if (!positionQuantity.trim() || Number.isNaN(quantityNum) || quantityNum <= 0) {
      setPositionFormError('Количество должно быть положительным числом.');
      return;
    }

    const brokerAccount = accounts.find((a) => a.id === selectedBrokerAccountId);
    if (!brokerAccount || !brokerAccount.currency) {
      setPositionFormError('Не удалось найти брокерский счёт или валюта не задана.');
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
          'Не удалось получить цену с Finnhub. Попробуйте позже.',
        );
        return;
      }

      if (!quoteData.ok) {
        setPositionSubmitting(false);
        if (quoteResponse.status === 404) {
          setPositionFormError(
            'Инструмент не найден на Finnhub или для него недоступна цена. Проверьте символ.',
          );
        } else {
          setPositionFormError(
            'Не удалось получить цену с Finnhub. Попробуйте позже.',
          );
        }
        return;
      }

      const finnhubPrice = quoteData.price;
      const fetchedAt = quoteData.fetched_at || new Date().toISOString();

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
          setPositionFormError('Не удалось создать инструмент.');
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
          'Такая позиция уже существует для этого брокерского счёта. В v1 дубликаты запрещены.',
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
            'Такая позиция уже существует для этого брокерского счёта. В v1 дубликаты запрещены.',
          );
        } else {
          setPositionFormError(positionError.message);
        }
        return;
      }

      // Success
      setPositionSymbol('');
      setPositionQuantity('');
      setPositionComment('');
      await loadPositions();
      setPositionSubmitting(false);
    } catch (err) {
      setPositionSubmitting(false);
      setPositionFormError(err instanceof Error ? err.message : 'Failed to create position');
    }
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

    const quantityNum = Number(editPositionQuantity);
    if (!editPositionQuantity.trim() || Number.isNaN(quantityNum) || quantityNum <= 0) {
      setPositionEditError('Количество должно быть положительным числом.');
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
    if (!window.confirm('Вы уверены, что хотите удалить эту позицию?')) {
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
          // Сортируем по sort_order (nulls last), затем по created_at
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
          // Сортируем по sort_order (nulls last), затем по created_at
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
        Загрузка настроек...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-6 py-4 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Настройки</h1>
            <p className="text-sm text-neutral-600">Управляйте счетами и категориями</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/app')}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              На главный
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

        <main className="grid gap-6 md:grid-cols-2">
          {/* Accounts block */}
          <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">Счета</h2>
              {accountsLoading && (
                <span className="text-xs text-neutral-500">Загрузка...</span>
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
                <p className="text-neutral-600">Нет счетов. Создайте первый.</p>
              ) : (
                accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="rounded-md border border-neutral-200 px-3 py-2"
                  >
                    {editingAccountId === acc.id ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-semibold text-neutral-900">Редактирование счёта</h4>
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
                              Название
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
                              Валюта
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
                              Начальный баланс ({editAccountCurrency === 'EUR' ? '€' : '$'})
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
                                Порог предупреждения ({editAccountCurrency === 'EUR' ? '€' : '$'})
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
                                  Кредитный лимит ({editAccountCurrency === 'EUR' ? '€' : '$'})
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
                                  Порог приближения к лимиту ({editAccountCurrency === 'EUR' ? '€' : '$'})
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
                                  Дебетовый счёт для привязки
                                </label>
                                <select
                                  value={editDebitAnchorAccountId}
                                  onChange={(e) => setEditDebitAnchorAccountId(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                >
                                  <option value="">Выберите счёт</option>
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
                              {editSubmitting ? 'Сохранение...' : 'Сохранить'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={editSubmitting}
                              className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                            >
                              Отмена
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
                              Редактировать
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(acc.id)}
                              className="text-xs text-red-600 hover:text-red-800"
                            >
                              Удалить
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600">
                          <span>
                            Стартовый баланс:{' '}
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
                              Порог:{' '}
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
                                Кредитный лимит:{' '}
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
                                Порог приближения к лимиту:{' '}
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
                                Привязанный дебетовый счёт:{' '}
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
                            <span className="text-neutral-700">По умолчанию для income</span>
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={acc.is_default_expense}
                              onChange={(e) => setDefault('expense', acc.id, e.target.checked)}
                              disabled={defaultUpdating.has(`${acc.id}-expense`)}
                              className="h-3 w-3"
                            />
                            <span className="text-neutral-700">По умолчанию для expense</span>
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
              Эти счета будут автоматически выбраны на главном экране.
            </p>

            <form className="mt-2 space-y-3" onSubmit={handleCreateAccount}>
              <h3 className="text-sm font-semibold text-neutral-900">Создать счёт</h3>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700" htmlFor="account-name">
                  Название
                </label>
                <input
                  id="account-name"
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  placeholder="Например, Дебетовая карта"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-neutral-700" htmlFor="account-kind">
                    Тип счёта
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
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-neutral-700" htmlFor="account-currency">
                    Валюта
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
                  Начальный баланс ({accountCurrency === 'EUR' ? '€' : '$'})
                </label>
                <input
                  id="starting-balance"
                  type="number"
                  value={startingBalance}
                  onChange={(e) => setStartingBalance(e.target.value)}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
                <p className="text-xs text-neutral-500">
                  Можно вводить отрицательные значения. Примеры: -300 = долг {accountCurrency === 'EUR' ? '300€' : '300$'}; 0 = нет долга/остатка; +1300 = положительный остаток (например PayPal).
                </p>
              </div>

              {(accountKind !== 'credit' && accountKind !== 'broker') && (
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="warning-threshold"
                  >
                    Порог предупреждения ({accountCurrency === 'EUR' ? '€' : '$'})
                  </label>
                  <input
                    id="warning-threshold"
                    type="number"
                    value={warningThreshold}
                    onChange={(e) => setWarningThreshold(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Оранжевое предупреждение, когда остаток становится маленьким. Пример: 500 → предупреждение при балансе ≤ 500{accountCurrency === 'EUR' ? '€' : '$'}.
                  </p>
                </div>
              )}

              {accountKind === 'broker' && (
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="warning-threshold"
                  >
                    Порог предупреждения ({accountCurrency === 'EUR' ? '€' : '$'})
                  </label>
                  <input
                    id="warning-threshold"
                    type="number"
                    value={warningThreshold}
                    onChange={(e) => setWarningThreshold(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Оранжевое предупреждение, когда остаток становится маленьким. Пример: 500 → предупреждение при балансе ≤ 500{accountCurrency === 'EUR' ? '€' : '$'}.
                  </p>
                </div>
              )}

              {accountKind === 'credit' && (
                <div className="space-y-2 rounded-lg bg-neutral-50 p-3">
                  {debitAccounts.length === 0 && (
                    <p className="mb-2 text-xs text-red-600">
                      Сначала создайте дебетовый счёт для привязки кредитки. Создание
                      кредитного счёта сейчас недоступно.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="credit-limit"
                      >
                        Кредитный лимит ({accountCurrency === 'EUR' ? '€' : '$'})
                      </label>
                      <input
                        id="credit-limit"
                        type="number"
                        value={creditLimit}
                        onChange={(e) => setCreditLimit(e.target.value)}
                        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      />
                      <p className="text-xs text-neutral-500">
                        Введите положительное число. Пример: 10000.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label
                        className="block text-xs font-medium text-neutral-700"
                        htmlFor="credit-warning-threshold"
                      >
                        Порог приближения к лимиту ({accountCurrency === 'EUR' ? '€' : '$'})
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
                        Введите положительное число — на сколько {accountCurrency === 'EUR' ? '€' : '$'} до лимита показать предупреждение. Пример: лимит 10000 и порог 500 → предупреждение начнётся при использовании 9500 из 10000.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="debit-anchor-account"
                    >
                      Дебетовый счёт для привязки
                    </label>
                    <select
                      id="debit-anchor-account"
                      value={debitAnchorAccountId}
                      onChange={(e) => setDebitAnchorAccountId(e.target.value)}
                      disabled={debitAccounts.length === 0}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition disabled:bg-neutral-100 focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    >
                      <option value="">Выберите счёт</option>
                      {debitAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-neutral-500">
                      Кредитка жёстко привязана к выбранному дебетовому счёту. Это используется для ручного 'погашения кредита' на главном экране.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <p className="text-xs font-medium text-neutral-700">Настройки по умолчанию</p>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefaultIncome}
                    onChange={(e) => setIsDefaultIncome(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <span className="text-neutral-700">Сделать по умолчанию для income</span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefaultExpense}
                    onChange={(e) => setIsDefaultExpense(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <span className="text-neutral-700">Сделать по умолчанию для expense</span>
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
                {accountSubmitting ? 'Создание...' : 'Создать счёт'}
              </button>
            </form>
          </section>

          {/* Categories block */}
          <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">Категории</h2>
              {categoriesLoading && (
                <span className="text-xs text-neutral-500">Загрузка...</span>
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
                    <p className="text-neutral-600">Нет категорий доходов.</p>
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
                                {categoryEditSubmitting ? 'Сохранение...' : 'Сохранить'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                              >
                                Отмена
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
                                Редактировать
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCategory(cat.id)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Удалить
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
                    <p className="text-neutral-600">Нет категорий расходов.</p>
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
                                {categoryEditSubmitting ? 'Сохранение...' : 'Сохранить'}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditCategory}
                                disabled={categoryEditSubmitting}
                                className="flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                              >
                                Отмена
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
                                Редактировать
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCategory(cat.id)}
                                disabled={categoryEditSubmitting || movingCategoryId !== null}
                                className="text-xs text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Удалить
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
                Добавить категорию
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
                  Название категории
                </label>
                <input
                  id="category-name"
                  type="text"
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  placeholder="Например, Зарплата"
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
                {categorySubmitting ? 'Добавление...' : 'Добавить категорию'}
              </button>
            </form>
          </section>
        </main>

        {/* Investments/Positions block */}
        <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">Investments / Positions</h2>
              {positionsLoading && <span className="text-xs text-neutral-500">Загрузка...</span>}
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
                Брокерский счёт (обязательно)
              </label>
              <select
                value={selectedBrokerAccountId}
                onChange={(e) => setSelectedBrokerAccountId(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
              >
                <option value="">Выберите брокерский счёт</option>
                {brokerAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({(acc.currency || 'EUR') === 'EUR' ? 'EUR' : 'USD'})
                  </option>
                ))}
              </select>
            </div>

            {brokerAccounts.length === 0 ? (
              <p className="text-sm text-neutral-600">
                Создайте брокерский счёт (тип broker), чтобы добавлять позиции.
              </p>
            ) : selectedBrokerAccountId ? (
              <>
                <div className="max-h-96 space-y-2 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                  {positions.length === 0 ? (
                    <p className="text-neutral-600">Позиции отсутствуют.</p>
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
                                Редактирование позиции
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
                                Символ: {pos.instrument.display_symbol || pos.instrument.provider_symbol} (
                                {pos.instrument.kind})
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Количество
                                </label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  value={editPositionQuantity}
                                  onChange={(e) => setEditPositionQuantity(e.target.value)}
                                  className="w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="block text-xs font-medium text-neutral-700">
                                  Комментарий
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
                                  {positionEditSubmitting ? 'Сохранение...' : 'Сохранить'}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelEditPosition}
                                  disabled={positionEditSubmitting}
                                  className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed"
                                >
                                  Отмена
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
                                    Количество:{' '}
                                    <span className="font-medium">{pos.quantity}</span>
                                  </span>
                                  <span>
                                    Валюта:{' '}
                                    <span className="font-medium">{pos.quote_currency}</span>
                                  </span>
                                  <span>
                                    Цена:{' '}
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
                                    Стоимость:{' '}
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
                                      Комментарий:{' '}
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
                                  Редактировать
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeletePosition(pos.id)}
                                  className="text-xs text-red-600 hover:text-red-800"
                                >
                                  Удалить
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
                  <h3 className="text-sm font-semibold text-neutral-900">Добавить позицию</h3>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-kind"
                    >
                      Тип инструмента
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
                      <option value="crypto">crypto</option>
                      <option value="other">other</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-symbol"
                    >
                      Символ (ручной ввод)
                    </label>
                    <input
                      id="position-symbol"
                      type="text"
                      value={positionSymbol}
                      onChange={(e) => setPositionSymbol(e.target.value)}
                      required
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      placeholder="Например, AAPL"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-quantity"
                    >
                      Количество
                    </label>
                    <input
                      id="position-quantity"
                      type="number"
                      step="any"
                      min="0"
                      value={positionQuantity}
                      onChange={(e) => setPositionQuantity(e.target.value)}
                      required
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-neutral-700"
                      htmlFor="position-comment"
                    >
                      Комментарий (необязательно)
                    </label>
                    <input
                      id="position-comment"
                      type="text"
                      value={positionComment}
                      onChange={(e) => setPositionComment(e.target.value)}
                      className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    />
                  </div>

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
                    {positionSubmitting ? 'Создание...' : 'Создать позицию'}
                  </button>
                </form>
              </>
            ) : null}
          </section>

        {/* Danger Zone */}
        <section className="rounded-2xl border-2 border-red-200 bg-red-50 p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-red-900">Опасная зона</h2>
          <div className="space-y-3">
            <div>
              <p className="mb-2 text-sm text-red-800">
                Очистить всю историю операций. Все доходы, расходы и переводы будут удалены. Счета и категории сохранятся.
              </p>
              {clearHistorySuccess && (
                <div className="mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                  {clearHistorySuccess}
                </div>
              )}
              {clearHistoryError && (
                <div className="mb-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">
                  {clearHistoryError}
                </div>
              )}
              <button
                type="button"
                onClick={handleClearHistory}
                disabled={clearingHistory}
                className="rounded-lg border-2 border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 hover:border-red-700 disabled:cursor-not-allowed disabled:bg-red-400 disabled:border-red-400"
              >
                {clearingHistory ? 'Удаление...' : 'Очистить всю историю операций'}
              </button>
            </div>

            <div className="border-t border-red-200 pt-4">
              <p className="mb-3 text-sm text-red-800">
                Удалит доходы/расходы/переводы в выбранном диапазоне дат. Счета и категории сохранятся.
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
                    Дата начала
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
                    Дата окончания
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
              <button
                type="button"
                onClick={handleClearPeriod}
                disabled={clearingPeriod}
                className="rounded-lg border-2 border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 hover:border-red-700 disabled:cursor-not-allowed disabled:bg-red-400 disabled:border-red-400"
              >
                {clearingPeriod ? 'Удаление...' : 'Очистить за период'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
