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

// Schema: accounts.kind includes 'broker' and 'crypto'; accounts.currency added (was missing in older backups)
type AccountKind = 'debit' | 'credit' | 'cash' | 'broker' | 'crypto';

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

interface InstrumentRef {
  provider_symbol?: string;
  display_symbol?: string;
  kind?: string | null;
  provider?: string | null;
}

interface PositionRow {
  id: string;
  user_id: string;
  broker_account_id: string;
  quote_currency: string | null;
  instrument_id?: string;
  instruments?: InstrumentRef | InstrumentRef[] | null;
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

interface Budget {
  id: string;
  user_id: string;
  name: string;
  base_limit_eur: number;
  start_date: string;
  carry_over: boolean;
  created_at: string;
}

interface BudgetCategoryRow {
  budget_id: string;
  category_id: string;
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

// Budget period helpers (no date libs, Date only)
function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear();
  const monthIndex0 = date.getMonth();
  const day = date.getDate();
  const newMonth = monthIndex0 + months;
  const newYear = year + Math.floor(newMonth / 12);
  const newMonthIndex0 = ((newMonth % 12) + 12) % 12;
  const maxDay = daysInMonth(newYear, newMonthIndex0);
  const clampedDay = Math.min(day, maxDay);
  return new Date(newYear, newMonthIndex0, clampedDay);
}

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

  // Instrument price trend
  const [selectedInstrumentId, setSelectedInstrumentId] = useState<string>('');

  // Budgets (read-only analytics)
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetCategoriesMap, setBudgetCategoriesMap] = useState<Map<string, string[]>>(new Map());
  const [budgetsLoading, setBudgetsLoading] = useState(false);
  const [budgetsError, setBudgetsError] = useState<string | null>(null);

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
        loadBudgets(session.user.id),
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

  const loadBudgets = async (uid: string) => {
    setBudgetsLoading(true);
    setBudgetsError(null);

    try {
      const { data: budgetsData, error: budgetsError } = await supabase
        .from('budgets')
        .select('id, user_id, name, base_limit_eur, start_date, carry_over, created_at')
        .eq('user_id', uid)
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
      for (const row of bcData || []) {
        const r = row as BudgetCategoryRow;
        const arr = map.get(r.budget_id) || [];
        arr.push(r.category_id);
        map.set(r.budget_id, arr);
      }
      setBudgetCategoriesMap(map);
    } catch (err) {
      setBudgetsError(err instanceof Error ? err.message : 'Failed to load budgets');
    } finally {
      setBudgetsLoading(false);
    }
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
          .select(
            'id, user_id, broker_account_id, quote_currency, instrument_id, instruments(provider_symbol, display_symbol, kind, provider)',
          )
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
  const accountsById = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach((a) => map.set(a.id, a));
    return map;
  }, [accounts]);

  const investmentPeriodSummaryStocks = useMemo(() => {
    if (!dateFrom || !dateTo) return { totalBuy: 0, totalSell: 0, netCashflow: 0 };

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    let totalBuy = 0;
    let totalSell = 0;

    transactions.forEach((tx) => {
      if (!tx.is_investment) return;
      const account = accountsById.get(tx.account_id);
      if (!account || account.kind !== 'broker') return;

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
  }, [transactions, dateFrom, dateTo, accountsById]);

  const investmentPeriodSummaryCrypto = useMemo(() => {
    if (!dateFrom || !dateTo) return { totalBuy: 0, totalSell: 0, netCashflow: 0 };

    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);

    let totalBuy = 0;
    let totalSell = 0;

    transactions.forEach((tx) => {
      if (!tx.is_investment) return;
      const account = accountsById.get(tx.account_id);
      if (!account || account.kind !== 'crypto') return;

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
  }, [transactions, dateFrom, dateTo, accountsById]);

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
        categoryName: category?.name || 'No category',
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
        categoryName: 'Other',
        amount: othersSum,
      });
    }

    return top10;
  }, [transactions, categories, dateFrom, dateTo]);

  // Budget analytics: spent per budget for the selected period
  const budgetAnalytics = useMemo(() => {
    if (!dateFrom || !dateTo || budgets.length === 0 || accounts.length === 0) {
      return {
        items: [] as Array<{
          budget: Budget;
          limit: number;
          spent: number;
          remaining: number;
          windowStart: string;
          windowEnd: string;
        }>,
        totalSpent: 0,
        fxSkippedWarning: false,
        duplicateCategoryWarning: false,
      };
    }

    const effectiveTo = dateTo || new Date().toISOString().split('T')[0];

    // category_id -> budget_id (first budget wins; track duplicates)
    const categoryToBudget = new Map<string, string>();
    let duplicateCategoryWarning = false;
    budgets.forEach((b) => {
      const catIds = budgetCategoriesMap.get(b.id) || [];
      catIds.forEach((cid) => {
        if (categoryToBudget.has(cid)) {
          duplicateCategoryWarning = true;
        } else {
          categoryToBudget.set(cid, b.id);
        }
      });
    });

    const fxSorted = [...fxRows].sort((a, b) => a.captured_date.localeCompare(b.captured_date));
    const latestFxOverall = fxSorted.length > 0 ? fxSorted[fxSorted.length - 1].rate : null;
    const getFxRate = (d: string): number | null => {
      const candidates = fxSorted.filter((f) => f.captured_date <= d);
      if (candidates.length > 0) return candidates[candidates.length - 1].rate;
      return latestFxOverall;
    };

    const accountsById = new Map<string, Account>();
    accounts.forEach((a) => accountsById.set(a.id, a));

    let fxSkippedWarning = false;

    const items: Array<{
      budget: Budget;
      limit: number;
      spent: number;
      remaining: number;
      windowStart: string;
      windowEnd: string;
    }> = [];

    for (const budget of budgets) {
      const catIds = budgetCategoriesMap.get(budget.id) || [];
      if (catIds.length === 0) continue;

      const budgetCatSet = new Set(catIds);

      // Find budget period containing effectiveTo (monthly recurrence from start_date)
      const startDate = parseYmd(budget.start_date.slice(0, 10));
      let periodStart = new Date(startDate.getTime());
      let nextStart = addMonthsClamped(periodStart, 1);
      let periodEnd = new Date(nextStart);
      periodEnd.setDate(periodEnd.getDate() - 1);

      const effectiveToDate = new Date(effectiveTo);
      while (periodEnd < effectiveToDate) {
        periodStart = nextStart;
        nextStart = addMonthsClamped(periodStart, 1);
        periodEnd = new Date(nextStart);
        periodEnd.setDate(periodEnd.getDate() - 1);
      }

      const periodStartYmd = formatYmd(periodStart);
      const periodEndYmd = formatYmd(periodEnd);
      const windowStartYmd = dateFrom > periodStartYmd ? dateFrom : periodStartYmd;
      const windowEndYmd = dateTo < periodEndYmd ? dateTo : periodEndYmd;

      let spent = 0;

      transactions.forEach((tx) => {
        if (tx.kind !== 'expense' || tx.is_investment || !tx.category_id) return;
        if (!budgetCatSet.has(tx.category_id)) return;

        const txYmd = tx.created_at.slice(0, 10);
        if (txYmd < windowStartYmd || txYmd > windowEndYmd) return;

        const account = accountsById.get(tx.account_id);
        const currency = (account?.currency || 'EUR').toUpperCase();

        if (currency === 'EUR') {
          spent += tx.amount;
        } else if (currency === 'USD') {
          const rate = getFxRate(txYmd);
          if (rate === null) {
            fxSkippedWarning = true;
          } else {
            spent += tx.amount * rate;
          }
        }
      });

      const limit = budget.base_limit_eur;
      const remaining = limit - spent;

      items.push({
        budget,
        limit,
        spent,
        remaining,
        windowStart: formatYmd(periodStart),
        windowEnd: formatYmd(periodEnd),
      });
    }

    const totalSpent = items.reduce((sum, i) => sum + i.spent, 0);

    return {
      items,
      totalSpent,
      fxSkippedWarning,
      duplicateCategoryWarning,
    };
  }, [
    budgets,
    budgetCategoriesMap,
    transactions,
    accounts,
    fxRows,
    dateFrom,
    dateTo,
  ]);

  const getInstrumentKind = (pos: PositionRow): string | null => {
    const inst = pos.instruments;
    if (!inst) return null;
    const i = Array.isArray(inst) ? inst[0] : inst;
    return (i as any)?.kind ?? null;
  };

  const investPositions = useMemo(
    () => positions.filter((p) => getInstrumentKind(p)?.toLowerCase() !== 'crypto'),
    [positions],
  );

  const cryptoPositions = useMemo(
    () => positions.filter((p) => getInstrumentKind(p)?.toLowerCase() === 'crypto'),
    [positions],
  );

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
        ? investPositions.filter((p) => p.broker_account_id === selectedBrokerId)
        : investPositions;

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

  // Unique instruments (dedupe by instrument_id), for Instrument price trend dropdown (non-crypto)
  const uniqueInstruments = useMemo(() => {
    const map = new Map<string, { id: string; label: string; currency: string }>();
    for (const pos of investPositions) {
      const instId = pos.instrument_id;
      if (!instId) continue;
      if (map.has(instId)) continue;
      const inst = pos.instruments;
      const sym = inst
        ? (Array.isArray(inst) ? inst[0] : inst)?.display_symbol ||
          (Array.isArray(inst) ? inst[0] : inst)?.provider_symbol ||
          '—'
        : '—';
      const curr = (pos.quote_currency || 'EUR').toUpperCase();
      map.set(instId, { id: instId, label: `${sym} (${curr})`, currency: curr });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [investPositions]);

  // Instrument price trend chart data: price per unit for selected instrument
  const instrumentPriceTrendData = useMemo(() => {
    if (!dateFrom || !dateTo || !selectedInstrumentId) {
      return { data: [] as Array<{ date: string; price: number | null }>, hasData: false };
    }

    const positionIds = investPositions
      .filter((p) => p.instrument_id === selectedInstrumentId)
      .map((p) => p.id);
    if (positionIds.length === 0) {
      return { data: [], hasData: false };
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
      if (!positionIds.includes(row.position_id)) continue;
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

    const data: Array<{ date: string; price: number | null }> = [];
    for (const day of days) {
      const candidates: HistoryRow[] = [];
      for (const pid of positionIds) {
        const row = getLatestForPosition(pid, day);
        if (row) candidates.push(row);
      }
      if (candidates.length === 0) {
        data.push({ date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }), price: null });
      } else {
        const best = candidates.reduce((a, b) => (a.captured_date >= b.captured_date ? a : b));
        data.push({ date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }), price: best.price });
      }
    }

    const hasData = data.some((d) => d.price !== null);
    return { data, hasData };
  }, [dateFrom, dateTo, selectedInstrumentId, investPositions, historyRows]);

  const instrumentCurrency =
    uniqueInstruments.find((i) => i.id === selectedInstrumentId)?.currency ?? 'EUR';

  // Crypto portfolio trend (all crypto accounts or specific crypto account)
  const cryptoAccounts = useMemo(
    () => accounts.filter((a) => a.kind === 'crypto'),
    [accounts],
  );

  const [selectedCryptoAccountId, setSelectedCryptoAccountId] = useState<string>('');

  const cryptoPortfolioChartData = useMemo(() => {
    if (!dateFrom || !dateTo) {
      return {
        mode: 'all' as const,
        data: [] as Array<{ date: string; valueEur?: number; valueUsd?: number }>,
        fxNotLoadedWarning: false,
        accountName: null as string | null,
        accountCurrency: null as string | null,
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

    const account =
      selectedCryptoAccountId !== ''
        ? cryptoAccounts.find((a) => a.id === selectedCryptoAccountId)
        : null;
    const accountName = account?.name ?? null;
    const accountCurrency = (account?.currency || null)?.toUpperCase() ?? null;

    const positionsToUse =
      selectedCryptoAccountId !== ''
        ? cryptoPositions.filter((p) => p.broker_account_id === selectedCryptoAccountId)
        : cryptoPositions;

    // All crypto accounts: агрегируем только в EUR
    if (selectedCryptoAccountId === '') {
      const data = days.map((day) => {
        let totalEur = 0;
        for (const pos of positionsToUse) {
          const row = getLatestForPosition(pos.id, day);
          if (!row) continue;
          const qty = row.quantity_snapshot ?? 0;
          const rawValue = row.price * qty;
          const curr = (row.currency || '').toUpperCase();
          if (curr === 'EUR') {
            totalEur += rawValue;
          } else if (curr === 'USD') {
            const rate = getFxRate(day);
            if (rate === null) {
              fxNotLoadedWarning = true;
            } else {
              totalEur += rawValue * rate;
            }
          }
        }
        return {
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          valueEur: totalEur,
        };
      });

      return {
        mode: 'all' as const,
        data,
        fxNotLoadedWarning,
        accountName: null,
        accountCurrency: null,
      };
    }

    // Конкретный crypto account в EUR
    if (accountCurrency === 'EUR') {
      const data = days.map((day) => {
        let totalEur = 0;
        for (const pos of positionsToUse) {
          const row = getLatestForPosition(pos.id, day);
          if (!row) continue;
          const curr = (row.currency || '').toUpperCase();
          if (curr !== 'EUR') {
            continue;
          }
          const qty = row.quantity_snapshot ?? 0;
          totalEur += row.price * qty;
        }
        return {
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          valueEur: totalEur,
        };
      });

      return {
        mode: 'eur' as const,
        data,
        fxNotLoadedWarning,
        accountName,
        accountCurrency,
      };
    }

    // Конкретный crypto account в USD: строим USD + EUR (dual)
    const data = days.map((day) => {
      let valueUsd = 0;
      for (const pos of positionsToUse) {
        const row = getLatestForPosition(pos.id, day);
        if (!row) continue;
        const curr = (row.currency || '').toUpperCase();
        if (curr !== 'USD') {
          continue;
        }
        const qty = row.quantity_snapshot ?? 0;
        valueUsd += row.price * qty;
      }
      const rate = getFxRate(day);
      const valueEur = rate !== null ? valueUsd * rate : 0;
      if (valueUsd > 0 && rate === null) {
        fxNotLoadedWarning = true;
      }
      return {
        date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
        valueUsd,
        valueEur,
      };
    });

    return {
      mode: 'usd_dual' as const,
      data,
      fxNotLoadedWarning,
      accountName,
      accountCurrency,
    };
  }, [dateFrom, dateTo, historyRows, fxRows, cryptoPositions, cryptoAccounts, selectedCryptoAccountId]);

  // Crypto instrument price trend (per-unit price for crypto instruments only)
  const uniqueCryptoInstruments = useMemo(() => {
    const map = new Map<string, { id: string; label: string; currency: string }>();
    for (const pos of cryptoPositions) {
      const instId = pos.instrument_id;
      if (!instId) continue;
      if (map.has(instId)) continue;
      const inst = pos.instruments;
      const sym = inst
        ? (Array.isArray(inst) ? inst[0] : inst)?.display_symbol ||
          (Array.isArray(inst) ? inst[0] : inst)?.provider_symbol ||
          '—'
        : '—';
      const curr = (pos.quote_currency || 'EUR').toUpperCase();
      map.set(instId, { id: instId, label: `${sym} (${curr})`, currency: curr });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [cryptoPositions]);

  const [selectedCryptoInstrumentId, setSelectedCryptoInstrumentId] = useState<string>('');

  const cryptoInstrumentPriceTrendData = useMemo(() => {
    if (!dateFrom || !dateTo || !selectedCryptoInstrumentId) {
      return { data: [] as Array<{ date: string; price: number | null }>, hasData: false };
    }

    const positionIds = cryptoPositions
      .filter((p) => p.instrument_id === selectedCryptoInstrumentId)
      .map((p) => p.id);
    if (positionIds.length === 0) {
      return { data: [], hasData: false };
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
      if (!positionIds.includes(row.position_id)) continue;
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

    const data: Array<{ date: string; price: number | null }> = [];
    for (const day of days) {
      const candidates: HistoryRow[] = [];
      for (const pid of positionIds) {
        const row = getLatestForPosition(pid, day);
        if (row) candidates.push(row);
      }
      if (candidates.length === 0) {
        data.push({
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          price: null,
        });
      } else {
        const best = candidates.reduce((a, b) => (a.captured_date >= b.captured_date ? a : b));
        data.push({
          date: new Date(day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
          price: best.price,
        });
      }
    }

    const hasData = data.some((d) => d.price !== null);
    return { data, hasData };
  }, [dateFrom, dateTo, selectedCryptoInstrumentId, cryptoPositions, historyRows]);

  const cryptoInstrumentCurrency =
    uniqueCryptoInstruments.find((i) => i.id === selectedCryptoInstrumentId)?.currency ?? 'EUR';

  useEffect(() => {
    if (uniqueInstruments.length === 0) {
      setSelectedInstrumentId('');
    } else if (!selectedInstrumentId || !uniqueInstruments.some((i) => i.id === selectedInstrumentId)) {
      setSelectedInstrumentId(uniqueInstruments[0]!.id);
    }
  }, [uniqueInstruments, selectedInstrumentId]);

  useEffect(() => {
    if (uniqueCryptoInstruments.length === 0) {
      setSelectedCryptoInstrumentId('');
    } else if (
      !selectedCryptoInstrumentId ||
      !uniqueCryptoInstruments.some((i) => i.id === selectedCryptoInstrumentId)
    ) {
      setSelectedCryptoInstrumentId(uniqueCryptoInstruments[0]!.id);
    }
  }, [uniqueCryptoInstruments, selectedCryptoInstrumentId]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  };

  if (!sessionChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-700">
        Checking session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-8 md:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white px-4 py-4 shadow-sm md:flex-row md:items-center md:justify-between md:px-6">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Statistics</h1>
            <p className="text-sm text-neutral-600">Income and expense analysis</p>
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
              onClick={() => router.push('/setup')}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 md:w-auto"
            >
              Settings
            </button>
            <button
              onClick={handleLogout}
              className="w-full rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100 md:w-auto"
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

        {/* Period */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Period</h2>
          <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPresetPeriod('7d')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                7 days
              </button>
              <button
                onClick={() => setPresetPeriod('30d')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                30 days 
              </button>
              <button
                onClick={() => setPresetPeriod('month')}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100"
              >
                This month
              </button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
              <div className="min-w-0 flex-1">
                <label className="block text-xs font-medium text-neutral-700">From</label>
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
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className="block text-xs font-medium text-neutral-700">To</label>
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
                  className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Period summary */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Period summary</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
            <div>
              <p className="text-xs text-neutral-600">Income</p>
              <p className="text-2xl font-semibold text-emerald-700">
                {formatMoney(periodSummary.income)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Expenses</p>
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

        {/* Period summary — investment trades (cashflow) */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">
            Period summary — investment trades (cashflow)
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-neutral-900">Stocks / ETFs</h3>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
                <div>
                  <p className="text-xs text-neutral-600">Total Buy</p>
                  <p className="text-2xl font-semibold text-red-700">
                    {formatMoney(investmentPeriodSummaryStocks.totalBuy)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-600">Total Sell</p>
                  <p className="text-2xl font-semibold text-emerald-700">
                    {formatMoney(investmentPeriodSummaryStocks.totalSell)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-600">Net cashflow</p>
                  <p
                    className={`text-2xl font-semibold ${
                      investmentPeriodSummaryStocks.netCashflow >= 0
                        ? 'text-emerald-700'
                        : 'text-red-700'
                    }`}
                  >
                    {formatMoney(investmentPeriodSummaryStocks.netCashflow)}
                  </p>
                </div>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-neutral-900">Crypto</h3>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
                <div>
                  <p className="text-xs text-neutral-600">Total Buy</p>
                  <p className="text-2xl font-semibold text-red-700">
                    {formatMoney(investmentPeriodSummaryCrypto.totalBuy)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-600">Total Sell</p>
                  <p className="text-2xl font-semibold text-emerald-700">
                    {formatMoney(investmentPeriodSummaryCrypto.totalSell)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-600">Net cashflow</p>
                  <p
                    className={`text-2xl font-semibold ${
                      investmentPeriodSummaryCrypto.netCashflow >= 0
                        ? 'text-emerald-700'
                        : 'text-red-700'
                    }`}
                  >
                    {formatMoney(investmentPeriodSummaryCrypto.netCashflow)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Budgets */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Budgets</h2>

          {budgetsLoading && <p className="text-sm text-neutral-600">Loading budgets...</p>}
          {budgetsError && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{budgetsError}</div>
          )}
          {budgetAnalytics.fxSkippedWarning && (
            <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Some USD expenses were skipped due to missing FX
            </div>
          )}
          {budgetAnalytics.duplicateCategoryWarning && (
            <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Some categories belong to multiple budgets; only the first budget was used
            </div>
          )}

          {!budgetsLoading && !budgetsError && budgetAnalytics.items.length === 0 && budgets.length === 0 && (
            <p className="text-sm text-neutral-600">No budgets. Create them in Settings.</p>
          )}

          {!budgetsLoading && budgetAnalytics.items.length > 0 && (
            <div className="space-y-4">
              <div className="rounded-lg bg-neutral-50 px-4 py-2">
                <p className="text-xs text-neutral-600">Total budgets spent</p>
                <p className="text-lg font-semibold text-neutral-900">{formatMoney(budgetAnalytics.totalSpent)}</p>
              </div>

              {budgetAnalytics.items.map((item) => {
                const pct = item.limit > 0 ? Math.min(100, (item.spent / item.limit) * 100) : 0;
                return (
                  <div key={item.budget.id} className="rounded-lg border border-neutral-200 p-4">
                    <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <h3 className="font-semibold text-neutral-900">{item.budget.name}</h3>
                      <span className="text-xs text-neutral-500">
                        Budget window: {item.windowStart} – {item.windowEnd}
                      </span>
                    </div>
                    <div className="mb-2 flex justify-between text-sm">
                      <span className="text-neutral-600">Limit: {formatMoney(item.limit)}</span>
                      <span className="text-neutral-600">Spent: {formatMoney(item.spent)}</span>
                      <span
                        className={item.remaining >= 0 ? 'text-emerald-700' : 'text-red-700'}
                      >
                        Remaining: {formatMoney(item.remaining)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
                      <div
                        className="h-full rounded-full bg-red-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {item.spent > item.limit && item.limit > 0 && (
                      <p className="mt-1 text-xs text-red-600">
                        Over by {formatMoney(item.spent - item.limit)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!budgetsLoading && !budgetsError && budgetAnalytics.items.length === 0 && budgets.length > 0 && (
            <p className="text-sm text-neutral-600">Budgets have no categories or period does not overlap.</p>
          )}
        </section>

        {/* Aggregate charts */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Aggregate charts</h2>

          {accounts.length === 0 ? (
            <p className="text-sm text-neutral-600">No accounts to display.</p>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {/* Все счета */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="mb-3 text-sm font-semibold text-neutral-900">All accounts</h3>
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
                  <p className="text-xs text-neutral-600">No data</p>
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
                  <p className="text-xs text-neutral-600">No data</p>
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
                  <p className="text-xs text-neutral-600">No data</p>
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
                  <p className="text-xs text-neutral-600">No data</p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Balance by account */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Balance by account</h2>
            {accounts.length > 0 && (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200 md:w-auto md:min-w-[180px]"
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
                      return name === 'Balance (USD)' ? formatMoneyUSD(Number(value)) : formatMoney(Number(value));
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
                    name="Balance (USD)"
                    dot={{ r: 3 }}
                    connectNulls={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="balance_eur"
                    stroke="#16a34a"
                    strokeWidth={2}
                    name="Balance (EUR)"
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
                    name="Balance"
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )
          ) : (
            <p className="text-sm text-neutral-600">No data для отображения.</p>
          )}
        </section>

        {/* Expenses by category */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Expenses by category</h2>

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
                  <Bar dataKey="amount" fill="#ef4444" name="Expenses" />
                </BarChart>
              </ResponsiveContainer>

              <div className="mt-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      <th className="px-4 py-2 text-left font-semibold text-neutral-900">
                        Category
                      </th>
                      <th className="px-4 py-2 text-right font-semibold text-neutral-900">Amount</th>
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
            <p className="text-sm text-neutral-600">No expenses for the selected period.</p>
          )}
        </section>

        {/* Investments */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Investments</h2>
          {investmentError && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {investmentError}
            </div>
          )}
          {investmentLoading && (
            <p className="mb-4 text-sm text-neutral-600">Loading investment data...</p>
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
              <p className="text-sm text-neutral-500">No data за выбранный период</p>
            </div>
          ) : (
            <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 p-8">
              <p className="text-sm text-neutral-500">No data за выбранный период</p>
            </div>
          )}
        </section>

        {/* Crypto portfolio trend */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Crypto portfolio</h2>
          <div className="mb-4">
            <label className="block text-xs font-medium text-neutral-700">Crypto account</label>
            <select
              value={selectedCryptoAccountId}
              onChange={(e) => setSelectedCryptoAccountId(e.target.value)}
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
            >
              <option value="">All crypto accounts</option>
              {cryptoAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name}
                </option>
              ))}
            </select>
          </div>
          {cryptoPortfolioChartData.fxNotLoadedWarning && (
            <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              FX not loaded for some dates
            </div>
          )}
          {cryptoPortfolioChartData.data.length > 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">
                {cryptoPortfolioChartData.mode === 'usd_dual'
                  ? 'Crypto total (USD & EUR)'
                  : 'Crypto total (EUR)'}
                {cryptoPortfolioChartData.accountName
                  ? ` — ${cryptoPortfolioChartData.accountName}`
                  : ''}
              </h3>
              {cryptoPortfolioChartData.mode === 'usd_dual' ? (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={cryptoPortfolioChartData.data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis
                      yAxisId="left"
                      tickFormatter={(v) => formatMoneyUSD(v as number)}
                      domain={['auto', 'auto']}
                      width={80}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tickFormatter={(v) => formatMoney(v as number)}
                      domain={['auto', 'auto']}
                      width={80}
                    />
                    <Tooltip
                      formatter={(value, name) => {
                        if (value == null || !Number.isFinite(Number(value))) return '—';
                        return name === 'Crypto (USD)'
                          ? formatMoneyUSD(Number(value))
                          : formatMoney(Number(value));
                      }}
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
                      name="Crypto (USD)"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="valueEur"
                      stroke="#16a34a"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      name="Crypto (EUR)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={cryptoPortfolioChartData.data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis
                      tickFormatter={(v) => formatMoney(v as number)}
                      domain={['auto', 'auto']}
                      width={80}
                    />
                    <Tooltip
                      formatter={(value: number) => formatMoney(value)}
                      labelStyle={{ color: '#171717' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="valueEur"
                      stroke="#171717"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      name="€"
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          ) : (
            <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 p-8">
              <p className="text-sm text-neutral-500">No crypto data за выбранный период</p>
            </div>
          )}
        </section>

        {/* Instrument price trend */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Instrument price trend</h2>
          <div className="mb-4">
            <label className="block text-xs font-medium text-neutral-700">Instrument</label>
            <select
              value={selectedInstrumentId}
              onChange={(e) => setSelectedInstrumentId(e.target.value)}
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
            >
              {uniqueInstruments.length === 0 ? (
                <option value="">No instruments yet</option>
              ) : (
                uniqueInstruments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))
              )}
            </select>
          </div>
          {uniqueInstruments.length === 0 ? (
            <p className="text-sm text-neutral-600">No instruments yet</p>
          ) : !instrumentPriceTrendData.hasData ? (
            <p className="text-sm text-neutral-600">No price history for selected instrument</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={instrumentPriceTrendData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    tickFormatter={(v) =>
                      instrumentCurrency === 'USD' ? formatMoneyUSD(Number(v)) : formatMoney(Number(v))
                    }
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value: unknown, _name: string) =>
                      typeof value === 'number'
                        ? instrumentCurrency === 'USD'
                          ? formatMoneyUSD(value)
                          : formatMoney(value)
                        : String(value ?? '')
                    }
                    labelStyle={{ color: '#171717' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="price"
                    stroke="#171717"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls={false}
                    name="Price per unit"
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="mt-2 text-xs text-neutral-500">
                Shows last known price per day (not multiplied by quantity).
              </p>
            </>
          )}
        </section>

        {/* Crypto instrument price trend */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Crypto asset price trend</h2>
          <div className="mb-4">
            <label className="block text-xs font-medium text-neutral-700">Crypto asset</label>
            <select
              value={selectedCryptoInstrumentId}
              onChange={(e) => setSelectedCryptoInstrumentId(e.target.value)}
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
            >
              {uniqueCryptoInstruments.length === 0 ? (
                <option value="">No crypto instruments yet</option>
              ) : (
                uniqueCryptoInstruments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))
              )}
            </select>
          </div>
          {uniqueCryptoInstruments.length === 0 ? (
            <p className="text-sm text-neutral-600">No crypto instruments yet</p>
          ) : !cryptoInstrumentPriceTrendData.hasData ? (
            <p className="text-sm text-neutral-600">No price history for selected crypto asset</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={cryptoInstrumentPriceTrendData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis
                    tickFormatter={(v) =>
                      cryptoInstrumentCurrency === 'USD'
                        ? formatMoneyUSD(Number(v))
                        : formatMoney(Number(v))
                    }
                    domain={['auto', 'auto']}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value: unknown, _name: string) =>
                      typeof value === 'number'
                        ? cryptoInstrumentCurrency === 'USD'
                          ? formatMoneyUSD(value)
                          : formatMoney(value)
                        : String(value ?? '')
                    }
                    labelStyle={{ color: '#171717' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="price"
                    stroke="#171717"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls={false}
                    name="Price per unit"
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="mt-2 text-xs text-neutral-500">
                Shows last known crypto price per day (not multiplied by quantity).
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
