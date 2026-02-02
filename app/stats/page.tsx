'use client';

/**
 * Supabase schema reference (from app/api/cron/refresh-prices, app/setup, app/app):
 * - position_price_history: date=captured_date (YYYY-MM-DD), price=price, currency=currency; also price_at, captured_at
 * - positions: quantity, broker_account_id, instrument_id, quote_currency, last_price, last_price_at
 * - accounts: id, name, kind, currency; also user_id, starting_balance, warning_threshold, etc.
 * - instruments: id, user_id, kind, provider, provider_symbol, display_symbol, name, created_at
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// Schema: accounts.kind includes 'broker'; accounts.currency added (was missing in older backups)
type AccountKind = 'debit' | 'credit' | 'cash' | 'broker';

interface Account {
  id: string;
  user_id: string;
  name: string;
  kind: AccountKind;
  currency: string | null; // Schema: accounts.currency (EUR|USD)
  starting_balance: number;
  warning_threshold: number;
  credit_limit: number | null;
  credit_warning_threshold: number | null;
  debit_anchor_account_id: string | null;
  is_default_income: boolean;
  is_default_expense: boolean;
  created_at: string;
}

// Schema: categories has is_default, sort_order (from supabase_backups)
interface Category {
  id: string;
  user_id: string;
  kind: 'income' | 'expense';
  name: string;
  created_at: string;
  is_default?: boolean;
  sort_order?: number | null;
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
}

// Helper для форматирования денег в EUR
const formatMoney = (amount: number): string => {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export default function StatsPage() {
  const router = useRouter();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Период
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  useEffect(() => {
    const init = async () => {
      const session = await getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setUserId(session.user.id);
      setSessionChecked(true);

      // Установить период по умолчанию: последние 30 дней
      const today = new Date();
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(today.getDate() - 30);

      setDateTo(today.toISOString().split('T')[0]);
      setDateFrom(thirtyDaysAgo.toISOString().split('T')[0]);

      await Promise.all([
        loadAccounts(),
        loadCategories(),
        loadTransactions(session.user.id, thirtyDaysAgo.toISOString(), today.toISOString()),
      ]);
    };

    init();
  }, [router]);

  const loadAccounts = async () => {
    // Schema: id, name, kind, currency (accounts table)
    const { data, error: fetchError } = await supabase
      .from('accounts')
      .select('id, user_id, name, kind, currency, starting_balance, warning_threshold, credit_limit, credit_warning_threshold, debit_anchor_account_id, is_default_income, is_default_expense, created_at')
      .order('created_at', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setAccounts((data || []) as Account[]);
    if (data && data.length > 0 && !selectedAccountId) {
      setSelectedAccountId(data[0].id);
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

  const loadTransactions = async (uid: string, fromDate: string, toDate: string) => {
    // Загружаем транзакции за период + 90 дней назад для корректного расчёта баланса
    const extendedFrom = new Date(fromDate);
    extendedFrom.setDate(extendedFrom.getDate() - 90);
    const extendedFromStr = extendedFrom.toISOString();

    const { data, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', uid)
      .lte('created_at', toDate)
      .gte('created_at', extendedFromStr)
      .order('created_at', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setTransactions((data || []) as Transaction[]);
  };

  const handlePeriodChange = async (from: string, to: string) => {
    if (!userId) return;

    setDateFrom(from);
    setDateTo(to);

    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    await loadTransactions(userId, fromDate.toISOString(), toDate.toISOString());
  };

  const setPresetPeriod = (preset: '7d' | '30d' | 'month') => {
    const today = new Date();
    let from: Date;

    if (preset === '7d') {
      from = new Date(today);
      from.setDate(today.getDate() - 7);
    } else if (preset === '30d') {
      from = new Date(today);
      from.setDate(today.getDate() - 30);
    } else {
      // Этот месяц
      from = new Date(today.getFullYear(), today.getMonth(), 1);
    }

    handlePeriodChange(from.toISOString().split('T')[0], today.toISOString().split('T')[0]);
  };

  // Итоги за период (без transfers)
  const periodSummary = useMemo(() => {
    if (!dateFrom || !dateTo) return { income: 0, expense: 0, net: 0 };

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    let income = 0;
    let expense = 0;

    transactions.forEach((tx) => {
      const txDate = new Date(tx.created_at);
      if (txDate >= from && txDate <= to && tx.kind !== 'transfer') {
        if (tx.kind === 'income') {
          income += tx.amount;
        } else if (tx.kind === 'expense') {
          expense += tx.amount;
        }
      }
    });

    return {
      income,
      expense,
      net: income - expense,
    };
  }, [transactions, dateFrom, dateTo]);

  // Вычисляем балансы по дням для всех счетов
  const allAccountsDailyBalances = useMemo(() => {
    if (!dateFrom || !dateTo || accounts.length === 0) return new Map<string, Map<string, number>>();

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    // Создаём массив всех дней в периоде
    const days: string[] = [];
    const currentDay = new Date(from);
    while (currentDay <= to) {
      days.push(currentDay.toISOString().split('T')[0]);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    // Для каждого счёта вычисляем баланс по дням
    const balancesByAccount = new Map<string, Map<string, number>>();

    accounts.forEach((account) => {
      const accountTransactions = transactions.filter((tx) => tx.account_id === account.id);

      // Вычисляем баланс на начало периода
      let balanceAtPeriodStart = account.starting_balance;
      accountTransactions.forEach((tx) => {
        const txDate = new Date(tx.created_at);
        if (txDate < from) {
          if (tx.direction === 'in') {
            balanceAtPeriodStart += tx.amount;
          } else {
            balanceAtPeriodStart -= tx.amount;
          }
        }
      });

      // Группируем транзакции в периоде по дням
      const dailyDeltas = new Map<string, number>();
      accountTransactions.forEach((tx) => {
        const txDate = new Date(tx.created_at);
        if (txDate >= from && txDate <= to) {
          const dayKey = txDate.toISOString().split('T')[0];
          const current = dailyDeltas.get(dayKey) || 0;
          if (tx.direction === 'in') {
            dailyDeltas.set(dayKey, current + tx.amount);
          } else {
            dailyDeltas.set(dayKey, current - tx.amount);
          }
        }
      });

      // Вычисляем баланс для каждого дня
      const dailyBalances = new Map<string, number>();
      let cumulativeBalance = balanceAtPeriodStart;
      days.forEach((day) => {
        const delta = dailyDeltas.get(day) || 0;
        cumulativeBalance += delta;
        dailyBalances.set(day, cumulativeBalance);
      });

      balancesByAccount.set(account.id, dailyBalances);
    });

    return balancesByAccount;
  }, [accounts, transactions, dateFrom, dateTo]);

  // Агрегатные графики: Все счета, Debit, Credit, Cash
  const aggregatedCharts = useMemo(() => {
    if (!dateFrom || !dateTo || accounts.length === 0) {
      return {
        all: [],
        debit: [],
        credit: [],
        cash: [],
      };
    }

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    // Создаём массив всех дней в периоде
    const days: string[] = [];
    const currentDay = new Date(from);
    while (currentDay <= to) {
      days.push(currentDay.toISOString().split('T')[0]);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    // Инициализируем массивы для каждого типа
    const allData: Array<{ date: string; value: number }> = [];
    const debitData: Array<{ date: string; value: number }> = [];
    const creditData: Array<{ date: string; value: number }> = [];
    const cashData: Array<{ date: string; value: number }> = [];

    days.forEach((day) => {
      let totalAll = 0;
      let totalDebit = 0;
      let totalCredit = 0;
      let totalCash = 0;

      accounts.forEach((account) => {
        const dailyBalances = allAccountsDailyBalances.get(account.id);
        const balance = dailyBalances?.get(day) || 0;

        totalAll += balance;

        if (account.kind === 'debit') {
          totalDebit += balance;
        } else if (account.kind === 'credit') {
          totalCredit += balance;
        } else if (account.kind === 'cash') {
          totalCash += balance;
        }
      });

      const dateLabel = new Date(day).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
      });

      allData.push({ date: dateLabel, value: totalAll });
      debitData.push({ date: dateLabel, value: totalDebit });
      creditData.push({ date: dateLabel, value: totalCredit });
      cashData.push({ date: dateLabel, value: totalCash });
    });

    return {
      all: allData,
      debit: debitData,
      credit: creditData,
      cash: cashData,
    };
  }, [allAccountsDailyBalances, accounts, dateFrom, dateTo]);

  // График баланса по дням для выбранного счёта
  const accountBalanceChart = useMemo(() => {
    if (!selectedAccountId || !dateFrom || !dateTo) return [];

    const account = accounts.find((a) => a.id === selectedAccountId);
    if (!account) return [];

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    // Создаём массив всех дней в периоде
    const days: string[] = [];
    const currentDay = new Date(from);
    while (currentDay <= to) {
      days.push(currentDay.toISOString().split('T')[0]);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    // Используем уже вычисленные балансы
    const dailyBalances = allAccountsDailyBalances.get(selectedAccountId);
    if (!dailyBalances) return [];

    const chartData = days.map((day) => {
      const balance = dailyBalances.get(day) || 0;
      return {
        date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
        balance,
      };
    });

    return chartData;
  }, [selectedAccountId, allAccountsDailyBalances, dateFrom, dateTo]);

  // Расходы по категориям
  const expensesByCategory = useMemo(() => {
    if (!dateFrom || !dateTo) return [];

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    const categoryMap = new Map<string, number>();

    transactions.forEach((tx) => {
      const txDate = new Date(tx.created_at);
      if (txDate >= from && txDate <= to && tx.kind === 'expense') {
        const categoryId = tx.category_id || 'no-category';
        const current = categoryMap.get(categoryId) || 0;
        categoryMap.set(categoryId, current + tx.amount);
      }
    });

    const result = Array.from(categoryMap.entries()).map(([categoryId, amount]) => {
      const category = categoryId === 'no-category' ? null : categories.find((c) => c.id === categoryId);
      return {
        categoryId,
        categoryName: category?.name || 'Без категории',
        amount,
      };
    });

    result.sort((a, b) => b.amount - a.amount);

    // Top 10, остальные в "Другое"
    const top10 = result.slice(0, 10);
    const others = result.slice(10);
    const othersSum = others.reduce((sum, item) => sum + item.amount, 0);

    if (othersSum > 0) {
      top10.push({
        categoryId: 'others',
        categoryName: 'Другое',
        amount: othersSum,
      });
    }

    return top10;
  }, [transactions, categories, dateFrom, dateTo]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  if (!sessionChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-700">
        Проверяем сессию...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-6 py-4 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Статистика</h1>
            <p className="text-sm text-neutral-600">Анализ доходов и расходов</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/app')}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              Главная
            </button>
            <button
              onClick={() => router.push('/setup')}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
            >
              Настройки
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

        {/* Период */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Период</h2>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex gap-2">
              <button
                onClick={() => setPresetPeriod('7d')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                7 дней
              </button>
              <button
                onClick={() => setPresetPeriod('30d')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                30 дней
              </button>
              <button
                onClick={() => setPresetPeriod('month')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                Этот месяц
              </button>
            </div>
            <div className="flex gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-700">От</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    if (dateTo) {
                      handlePeriodChange(e.target.value, dateTo);
                    } else {
                      setDateFrom(e.target.value);
                    }
                  }}
                  className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700">До</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    if (dateFrom) {
                      handlePeriodChange(dateFrom, e.target.value);
                    } else {
                      setDateTo(e.target.value);
                    }
                  }}
                  className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Итоги за период */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Итоги за период</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs text-neutral-600">Доходы</p>
              <p className="text-2xl font-semibold text-emerald-700">
                {formatMoney(periodSummary.income)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Расходы</p>
              <p className="text-2xl font-semibold text-red-700">
                {formatMoney(periodSummary.expense)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Net</p>
              <p
                className={`text-2xl font-semibold ${
                  periodSummary.net >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatMoney(periodSummary.net)}
              </p>
            </div>
          </div>
        </section>

        {/* Суммарные графики */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Суммарные графики</h2>

          {accounts.length === 0 ? (
            <p className="text-sm text-neutral-600">Нет счетов для отображения.</p>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {/* Все счета */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-900">Все счета</h3>
                {aggregatedCharts.all.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={aggregatedCharts.all}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis
                        tickFormatter={(value) => formatMoney(value)}
                        domain={['auto', 'auto']}
                        width={80}
                      />
                      <Tooltip
                        formatter={(value: number) => formatMoney(value)}
                        labelStyle={{ color: '#171717' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#171717"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-xs text-neutral-600">Нет данных</p>
                )}
              </div>

              {/* Debit */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-900">Debit</h3>
                {aggregatedCharts.debit.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={aggregatedCharts.debit}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis
                        tickFormatter={(value) => formatMoney(value)}
                        domain={['auto', 'auto']}
                        width={80}
                      />
                      <Tooltip
                        formatter={(value: number) => formatMoney(value)}
                        labelStyle={{ color: '#171717' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#2563eb"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-xs text-neutral-600">Нет данных</p>
                )}
              </div>

              {/* Credit */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-900">Credit</h3>
                {aggregatedCharts.credit.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={aggregatedCharts.credit}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis
                        tickFormatter={(value) => formatMoney(value)}
                        domain={['auto', 'auto']}
                        width={80}
                      />
                      <Tooltip
                        formatter={(value: number) => formatMoney(value)}
                        labelStyle={{ color: '#171717' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#dc2626"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-xs text-neutral-600">Нет данных</p>
                )}
              </div>

              {/* Cash */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-900">Cash</h3>
                {aggregatedCharts.cash.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={aggregatedCharts.cash}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis
                        tickFormatter={(value) => formatMoney(value)}
                        domain={['auto', 'auto']}
                        width={80}
                      />
                      <Tooltip
                        formatter={(value: number) => formatMoney(value)}
                        labelStyle={{ color: '#171717' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#16a34a"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-xs text-neutral-600">Нет данных</p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* График баланса по счетам */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Баланс по счетам</h2>
            {accounts.length > 0 && (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.kind})
                  </option>
                ))}
              </select>
            )}
          </div>

          {accountBalanceChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={accountBalanceChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis
                  tickFormatter={(value) => formatMoney(value)}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  formatter={(value: number) => formatMoney(value)}
                  labelStyle={{ color: '#171717' }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="#171717"
                  strokeWidth={2}
                  name="Баланс"
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-neutral-600">Нет данных для отображения.</p>
          )}
        </section>

        {/* Расходы по категориям */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Расходы по категориям</h2>

          {expensesByCategory.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={expensesByCategory}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="categoryName"
                    angle={-45}
                    textAnchor="end"
                    height={100}
                    interval={0}
                  />
                  <YAxis tickFormatter={(value) => formatMoney(value)} />
                  <Tooltip
                    formatter={(value: number) => formatMoney(value)}
                    labelStyle={{ color: '#171717' }}
                  />
                  <Legend />
                  <Bar dataKey="amount" fill="#ef4444" name="Расходы" />
                </BarChart>
              </ResponsiveContainer>

              <div className="mt-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      <th className="px-4 py-2 text-left font-semibold text-neutral-900">
                        Категория
                      </th>
                      <th className="px-4 py-2 text-right font-semibold text-neutral-900">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expensesByCategory.map((item) => (
                      <tr key={item.categoryId} className="border-b border-neutral-100">
                        <td className="px-4 py-2 text-neutral-700">{item.categoryName}</td>
                        <td className="px-4 py-2 text-right font-medium text-neutral-900">
                          {formatMoney(item.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-600">Нет расходов за выбранный период.</p>
          )}
        </section>
      </div>
    </div>
  );
}
