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
  is_investment?: boolean;
}

interface PositionRow {
  id: string;
  user_id: string;
  broker_account_id: string;
  quote_currency: string | null;
}

interface HistoryRow {
  user_id: string;
  position_id: string;
  price: number;
  currency: string | null;
  captured_date: string;
  quantity_snapshot: number | null;
}

interface FxRow {
  user_id: string;
  base_currency: string;
  quote_currency: string;
  rate: number;
  captured_date: string;
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

const formatMoneyUSD = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export default function StatsPage() {
  const router = useRouter();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<{
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null>(null);

  // Период
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>(''); // '' = All brokers

  // Investment data
  const [brokers, setBrokers] = useState<Account[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [fxRows, setFxRows] = useState<FxRow[]>([]);
  const [investmentLoading, setInvestmentLoading] = useState(false);
  const [investmentError, setInvestmentError] = useState<string | null>(null);

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

  useEffect(() => {
    setBrokers(accounts.filter((a) => a.kind === 'broker'));
  }, [accounts]);

  useEffect(() => {
    if (!userId || !dateFrom || !dateTo) return;
    loadInvestmentData(userId, dateFrom, dateTo);
  }, [userId, dateFrom, dateTo]);

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
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Unexpected error while refreshing prices');
    } finally {
      setRefreshLoading(false);
    }
  };

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

  const loadInvestmentData = async (uid: string, fromDate: string, toDate: string) => {
    setInvestmentLoading(true);
    setInvestmentError(null);

    try {
      const [positionsRes, historyRes, fxRes] = await Promise.all([
        supabase
          .from('positions')
          .select('id, user_id, broker_account_id, quote_currency')
          .eq('user_id', uid),
        supabase
          .from('position_price_history')
          .select('user_id, position_id, price, currency, captured_date, quantity_snapshot')
          .eq('user_id', uid)
          .gte('captured_date', fromDate)
          .lte('captured_date', toDate),
        supabase
          .from('fx_rates')
          .select('user_id, base_currency, quote_currency, rate, captured_date')
          .eq('user_id', uid)
          .eq('base_currency', 'USD')
          .eq('quote_currency', 'EUR')
          .gte('captured_date', fromDate)
          .lte('captured_date', toDate),
      ]);

      if (positionsRes.error) {
        setInvestmentError(positionsRes.error.message);
        return;
      }
      if (historyRes.error) {
        setInvestmentError(historyRes.error.message);
        return;
      }
      if (fxRes.error) {
        setInvestmentError(fxRes.error.message);
        return;
      }

      setPositions((positionsRes.data || []) as PositionRow[]);
      setHistoryRows((historyRes.data || []) as HistoryRow[]);
      setFxRows((fxRes.data || []) as FxRow[]);
    } catch (err) {
      setInvestmentError(err instanceof Error ? err.message : 'Failed to load investment data');
    } finally {
      setInvestmentLoading(false);
    }
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

  // Итоги за период (без transfers, без investment)
  const periodSummary = useMemo(() => {
    if (!dateFrom || !dateTo) return { income: 0, expense: 0, net: 0 };

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    let income = 0;
    let expense = 0;

    transactions.forEach((tx) => {
      if (tx.is_investment) return;
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

  // Итоги за период — инвестиционные сделки (cashflow)
  const investmentPeriodSummary = useMemo(() => {
    if (!dateFrom || !dateTo) return { totalBuy: 0, totalSell: 0, netCashflow: 0 };

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    let totalBuy = 0;
    let totalSell = 0;

    transactions.forEach((tx) => {
      if (!tx.is_investment) return;
      const txDate = new Date(tx.created_at);
      if (txDate >= from && txDate <= to) {
        if (tx.kind === 'expense') totalBuy += tx.amount;
        else if (tx.kind === 'income') totalSell += tx.amount;
      }
    });

    return {
      totalBuy,
      totalSell,
      netCashflow: totalSell - totalBuy,
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
    if (!selectedAccountId || !dateFrom || !dateTo) {
      return { data: [] as Array<{ date: string; balance?: number; balance_usd?: number; balance_eur?: number | null }>, fxWarning: false, isUsd: false };
    }

    const account = accounts.find((a) => a.id === selectedAccountId);
    if (!account) {
      return { data: [], fxWarning: false, isUsd: false };
    }

    const accountCurrency = (account.currency || 'EUR').toUpperCase();
    const isUsd = accountCurrency === 'USD';

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    const days: string[] = [];
    const currentDay = new Date(from);
    while (currentDay <= to) {
      days.push(currentDay.toISOString().split('T')[0]);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    const dailyBalances = allAccountsDailyBalances.get(selectedAccountId);
    if (!dailyBalances) {
      return { data: [], fxWarning: false, isUsd };
    }

    if (!isUsd) {
      const chartData = days.map((day) => {
        const balance = dailyBalances.get(day) || 0;
        return {
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          balance,
        };
      });
      return { data: chartData, fxWarning: false, isUsd: false };
    }

    const fxSorted = [...fxRows].sort((a, b) => a.captured_date.localeCompare(b.captured_date));
    const latestFxOverall = fxSorted.length > 0 ? fxSorted[fxSorted.length - 1].rate : null;
    const getFxRate = (d: string): number | null => {
      const candidates = fxSorted.filter((f) => f.captured_date <= d);
      if (candidates.length > 0) return candidates[candidates.length - 1].rate;
      return latestFxOverall;
    };

    let fxWarning = false;
    const chartData = days.map((day) => {
      const balanceUsd = dailyBalances.get(day) || 0;
      const rate = getFxRate(day);
      let balanceEur: number | null;
      if (rate !== null) {
        balanceEur = balanceUsd * rate;
      } else {
        fxWarning = true;
        balanceEur = latestFxOverall !== null ? balanceUsd * latestFxOverall : null;
      }
      return {
        date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
        balance_usd: balanceUsd,
        balance_eur: balanceEur,
      };
    });
    return { data: chartData, fxWarning, isUsd: true };
  }, [selectedAccountId, allAccountsDailyBalances, dateFrom, dateTo, accounts, fxRows]);

  // Расходы по категориям
  const expensesByCategory = useMemo(() => {
    if (!dateFrom || !dateTo) return [];

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    const categoryMap = new Map<string, number>();

    transactions.forEach((tx) => {
      if (tx.is_investment) return;
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

  // Invest chart: All brokers (EUR total) или по выбранному broker (EUR или USD+EUR dual)
  // Carry forward: для каждой даты D берём последний известный snapshot по каждой позиции (captured_date <= D)
  const investChartData = useMemo(() => {
    if (!dateFrom || !dateTo) {
      return {
        mode: 'all' as const,
        data: [] as Array<{ date: string; value: number; valueUsd?: number; valueEur?: number }>,
        fxNotLoadedWarning: false,
        investmentWarning: [] as string[],
        brokerName: null as string | null,
      };
    }

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    const days: string[] = [];
    const currentDay = new Date(from);
    while (currentDay <= to) {
      days.push(currentDay.toISOString().split('T')[0]);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    const historyByPosition = new Map<string, HistoryRow[]>();
    for (const row of historyRows) {
      const arr = historyByPosition.get(row.position_id) || [];
      arr.push(row);
      historyByPosition.set(row.position_id, arr);
    }
    for (const arr of historyByPosition.values()) {
      arr.sort((a, b) => a.captured_date.localeCompare(b.captured_date));
    }

    const getLatestForPosition = (positionId: string, d: string): HistoryRow | null => {
      const arr = historyByPosition.get(positionId);
      if (!arr || arr.length === 0) return null;
      let lo = 0;
      let hi = arr.length - 1;
      if (arr[0].captured_date > d) return null;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (arr[mid].captured_date <= d) lo = mid;
        else hi = mid - 1;
      }
      return arr[lo].captured_date <= d ? arr[lo] : null;
    };

    const fxSorted = [...fxRows].sort((a, b) => a.captured_date.localeCompare(b.captured_date));
    const latestFxOverall = fxSorted.length > 0 ? fxSorted[fxSorted.length - 1].rate : null;
    const getFxRate = (d: string): number | null => {
      const candidates = fxSorted.filter((f) => f.captured_date <= d);
      if (candidates.length > 0) return candidates[candidates.length - 1].rate;
      return latestFxOverall;
    };

    let fxNotLoadedWarning = false;
    const investmentWarning: string[] = [];
    let currencyMismatchSeen = false;

    const broker =
      selectedBrokerId !== ''
        ? brokers.find((b) => b.id === selectedBrokerId) || accounts.find((a) => a.id === selectedBrokerId)
        : null;
    const brokerName = broker?.name ?? null;
    const brokerCurrency = (broker?.currency || 'EUR').toUpperCase();
    const positionsToUse =
      selectedBrokerId !== ''
        ? positions.filter((p) => p.broker_account_id === selectedBrokerId)
        : positions;

    if (selectedBrokerId === '') {
      const data = days.map((day) => {
        let total = 0;
        for (const pos of positionsToUse) {
          const row = getLatestForPosition(pos.id, day);
          if (!row) continue;
          const qty = row.quantity_snapshot ?? 0;
          const rawValue = row.price * qty;
          const curr = (row.currency || '').toUpperCase();
          if (curr === 'EUR') total += rawValue;
          else if (curr === 'USD') {
            const rate = getFxRate(day);
            if (rate === null) fxNotLoadedWarning = true;
            else total += rawValue * rate;
          }
        }
        return {
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          value: total,
        };
      });
      return { mode: 'all' as const, data, fxNotLoadedWarning, investmentWarning, brokerName: null };
    }

    if (brokerCurrency === 'EUR') {
      const data = days.map((day) => {
        let total = 0;
        for (const pos of positionsToUse) {
          const row = getLatestForPosition(pos.id, day);
          if (!row) continue;
          const curr = (row.currency || '').toUpperCase();
          if (curr !== 'EUR') {
            if (curr) currencyMismatchSeen = true;
            continue;
          }
          const qty = row.quantity_snapshot ?? 0;
          total += row.price * qty;
        }
        return {
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          value: total,
        };
      });
      if (currencyMismatchSeen) investmentWarning.push('Currency mismatch for some positions');
      return { mode: 'broker_eur' as const, data, fxNotLoadedWarning, investmentWarning, brokerName };
    }

    const data = days.map((day) => {
      let valueUsd = 0;
      for (const pos of positionsToUse) {
        const row = getLatestForPosition(pos.id, day);
        if (!row) continue;
        const curr = (row.currency || '').toUpperCase();
        if (curr !== 'USD') {
          if (curr) currencyMismatchSeen = true;
          continue;
        }
        const qty = row.quantity_snapshot ?? 0;
        valueUsd += row.price * qty;
      }
      const rate = getFxRate(day);
      const valueEur = rate !== null ? valueUsd * rate : 0;
      if (valueUsd > 0 && rate === null) fxNotLoadedWarning = true;
      return {
        date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
        valueUsd,
        valueEur,
      };
    });
    if (currencyMismatchSeen) investmentWarning.push('Currency mismatch for some positions');
    return { mode: 'broker_usd' as const, data, fxNotLoadedWarning, investmentWarning, brokerName };
  }, [selectedBrokerId, dateFrom, dateTo, historyRows, fxRows, positions, brokers, accounts]);

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
              onClick={handleManualRefresh}
              disabled={refreshLoading}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              🔄 Refresh prices
            </button>
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

        {/* Итоги за период — инвестиционные сделки (cashflow) */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">
            Итоги за период — инвестиционные сделки (cashflow)
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs text-neutral-600">Total Buy</p>
              <p className="text-2xl font-semibold text-red-700">
                {formatMoney(investmentPeriodSummary.totalBuy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Total Sell</p>
              <p className="text-2xl font-semibold text-emerald-700">
                {formatMoney(investmentPeriodSummary.totalSell)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Net cashflow</p>
              <p
                className={`text-2xl font-semibold ${
                  investmentPeriodSummary.netCashflow >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatMoney(investmentPeriodSummary.netCashflow)}
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

          {accountBalanceChart.fxWarning && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              FX not loaded for some dates
            </div>
          )}

          {accountBalanceChart.data.length > 0 ? (
            accountBalanceChart.isUsd ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={accountBalanceChart.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    yAxisId="left"
                    tickFormatter={(v) => formatMoneyUSD(v)}
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(v) => formatMoney(v)}
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value, name) => {
                      if (value == null || !Number.isFinite(Number(value))) return '—';
                      return name === 'Баланс (USD)' ? formatMoneyUSD(Number(value)) : formatMoney(Number(value));
                    }}
                    labelStyle={{ color: '#171717' }}
                  />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="balance_usd"
                    stroke="#2563eb"
                    strokeWidth={2}
                    name="Баланс (USD)"
                    dot={{ r: 3 }}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="balance_eur"
                    stroke="#16a34a"
                    strokeWidth={2}
                    name="Баланс (EUR)"
                    dot={{ r: 3 }}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={accountBalanceChart.data}>
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
            )
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

        {/* Investments */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Investments</h2>
          {investmentError && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {investmentError}
            </div>
          )}
          {investmentLoading && (
            <p className="mb-4 text-sm text-neutral-600">Загрузка данных инвестиций...</p>
          )}
          <div className="mb-4">
            <label className="block text-xs font-medium text-neutral-700">Broker</label>
            <select
              value={selectedBrokerId}
              onChange={(e) => setSelectedBrokerId(e.target.value)}
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
            >
              <option value="">All brokers</option>
              {brokers.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
          </div>
          {investChartData.fxNotLoadedWarning && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              FX not loaded for some dates
            </div>
          )}
          {investChartData.investmentWarning.length > 0 && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {investChartData.investmentWarning[0]}
            </div>
          )}
          {investChartData.mode === 'all' && investChartData.data.length > 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">Invest total (EUR)</h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={investChartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    tickFormatter={(v) => formatMoney(v)}
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
                    name="€"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : investChartData.mode === 'broker_eur' && investChartData.data.length > 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">
                Invest (Broker: {investChartData.brokerName})
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={investChartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    tickFormatter={(v) => formatMoney(v)}
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
                    name="€"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : investChartData.mode === 'broker_usd' && investChartData.data.length > 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">
                Invest (Broker: {investChartData.brokerName})
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={investChartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    yAxisId="left"
                    tickFormatter={(v) => formatMoneyUSD(v)}
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(v) => formatMoney(v)}
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value: number, name: string) =>
                      name === 'USD' ? formatMoneyUSD(value) : formatMoney(value)
                    }
                    labelStyle={{ color: '#171717' }}
                  />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="valueUsd"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="USD"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="valueEur"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name="EUR"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : selectedBrokerId === '' ? (
            <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 p-8">
              <p className="text-sm text-neutral-500">Нет данных за выбранный период</p>
            </div>
          ) : (
            <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 p-8">
              <p className="text-sm text-neutral-500">Нет данных за выбранный период</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
