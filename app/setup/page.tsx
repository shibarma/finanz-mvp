'use client';

import { useEffect, useMemo, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

type AccountKind = 'debit' | 'credit' | 'cash';

interface Account {
  id: string;
  user_id: string;
  name: string;
  kind: AccountKind;
  starting_balance: number;
  warning_threshold: number;
  credit_limit: number | null;
  credit_warning_threshold: number | null;
  debit_anchor_account_id: string | null;
  created_at: string;
}

type CategoryKind = 'income' | 'expense';

interface Category {
  id: string;
  user_id: string;
  kind: CategoryKind;
  name: string;
  created_at: string;
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

  // Форма аккаунтов
  const [accountName, setAccountName] = useState('');
  const [accountKind, setAccountKind] = useState<AccountKind>('debit');
  const [startingBalance, setStartingBalance] = useState('0');
  const [warningThreshold, setWarningThreshold] = useState('500');
  const [creditLimit, setCreditLimit] = useState('10000');
  const [creditWarningThreshold, setCreditWarningThreshold] = useState('100');
  const [debitAnchorAccountId, setDebitAnchorAccountId] = useState<string>('');
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountFormError, setAccountFormError] = useState<string | null>(null);

  // Редактирование счета
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [editStartingBalance, setEditStartingBalance] = useState('');
  const [editWarningThreshold, setEditWarningThreshold] = useState('');
  const [editCreditLimit, setEditCreditLimit] = useState('');
  const [editCreditWarningThreshold, setEditCreditWarningThreshold] = useState('');
  const [editDebitAnchorAccountId, setEditDebitAnchorAccountId] = useState<string>('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Форма категорий
  const [categoryKind, setCategoryKind] = useState<CategoryKind>('income');
  const [categoryName, setCategoryName] = useState('');
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);

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

  const loadAccounts = async () => {
    setAccountsLoading(true);
    setAccountsError(null);

    const { data, error } = await supabase
      .from('accounts')
      .select(
        'id, user_id, name, kind, starting_balance, warning_threshold, credit_limit, credit_warning_threshold, debit_anchor_account_id, created_at',
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
      .select('id, user_id, kind, name, created_at')
      .order('created_at', { ascending: true });

    setCategoriesLoading(false);

    if (error) {
      setCategoriesError(error.message);
      return;
    }

    setCategories((data || []) as Category[]);
  };

  const handleCreateAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;

    setAccountFormError(null);

    if (!accountName.trim()) {
      setAccountFormError('Название счёта обязательно.');
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
      // Для debit и cash используем warning_threshold
      const warningThresholdValue = warningThreshold || '0';
      warningThresholdNum = Number(warningThresholdValue);
      if (Number.isNaN(warningThresholdNum)) {
        setAccountFormError('Порог предупреждения должен быть числом.');
        return;
      }
    }

    setAccountSubmitting(true);

    const { error } = await supabase.from('accounts').insert({
      name: accountName.trim(),
      kind: accountKind,
      starting_balance: startingBalanceNum,
      warning_threshold: accountKind === 'credit' ? 0 : warningThresholdNum,
      credit_limit: accountKind === 'credit' ? creditLimitNum : null,
      credit_warning_threshold: accountKind === 'credit' ? creditWarningNum : null,
      debit_anchor_account_id: accountKind === 'credit' ? debitAnchorId : null,
      user_id: userId,
    });

    setAccountSubmitting(false);

    if (error) {
      setAccountFormError(error.message);
      return;
    }

    // очистка формы
    setAccountName('');
    setStartingBalance('0');
    setWarningThreshold('500');
    setCreditLimit('10000');
    setCreditWarningThreshold('100');
    setDebitAnchorAccountId('');
    await loadAccounts();
  };

  const startEditAccount = (account: Account) => {
    setEditingAccountId(account.id);
    setEditAccountName(account.name);
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

    // Проверка 3: используется ли как debit_anchor_account_id
    const account = accounts.find((a) => a.id === accountId);
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

    const { error } = await supabase.from('categories').insert({
      kind: categoryKind,
      name: categoryName.trim(),
      user_id: userId,
    });

    setCategorySubmitting(false);

    if (error) {
      setCategoryFormError(error.message);
      return;
    }

    setCategoryName('');
    await loadCategories();
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const incomeCategories = useMemo(
    () => categories.filter((c) => c.kind === 'income'),
    [categories],
  );
  const expenseCategories = useMemo(
    () => categories.filter((c) => c.kind === 'expense'),
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
                              Начальный баланс
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
                                Порог предупреждения
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
                                  Кредитный лимит
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
                                  Порог приближения к лимиту
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
                          <span className="font-medium text-neutral-900">{acc.name}</span>
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
                            <span className="font-medium">{acc.starting_balance}</span>
                          </span>
                          {acc.kind !== 'credit' && (
                            <span>
                              Порог:{' '}
                              <span className="font-medium">{acc.warning_threshold}</span>
                            </span>
                          )}
                          {acc.kind === 'credit' && (
                            <>
                              <span>
                                Кредитный лимит:{' '}
                                <span className="font-medium">{acc.credit_limit}</span>
                              </span>
                              <span>
                                Порог приближения к лимиту:{' '}
                                <span className="font-medium">
                                  {acc.credit_warning_threshold}
                                </span>
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
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

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
                    onChange={(e) => setAccountKind(e.target.value as AccountKind)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  >
                    <option value="debit">debit</option>
                    <option value="credit">credit</option>
                    <option value="cash">cash</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="starting-balance"
                  >
                    Начальный баланс
                  </label>
                  <input
                    id="starting-balance"
                    type="number"
                    value={startingBalance}
                    onChange={(e) => setStartingBalance(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Можно вводить отрицательные значения. Примеры: -300 = долг 300€; 0 = нет долга/остатка; +1300 = положительный остаток (например PayPal).
                  </p>
                </div>
              </div>

              {accountKind !== 'credit' && (
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-neutral-700"
                    htmlFor="warning-threshold"
                  >
                    Порог предупреждения
                  </label>
                  <input
                    id="warning-threshold"
                    type="number"
                    value={warningThreshold}
                    onChange={(e) => setWarningThreshold(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                  />
                  <p className="text-xs text-neutral-500">
                    Оранжевое предупреждение, когда остаток становится маленьким. Пример: 500 → предупреждение при балансе ≤ 500€.
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
                        Кредитный лимит
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
                        Порог приближения к лимиту
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
                        Введите положительное число — на сколько € до лимита показать предупреждение. Пример: лимит 10000 и порог 500 → предупреждение начнётся при использовании 9500 из 10000.
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

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">
                  Income categories
                </h3>
                <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-3 text-sm">
                  {incomeCategories.length === 0 ? (
                    <p className="text-neutral-600">Нет категорий доходов.</p>
                  ) : (
                    incomeCategories.map((cat) => (
                      <div key={cat.id} className="rounded-md bg-neutral-50 px-2 py-1">
                        {cat.name}
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
                    expenseCategories.map((cat) => (
                      <div key={cat.id} className="rounded-md bg-neutral-50 px-2 py-1">
                        {cat.name}
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
      </div>
    </div>
  );
}
