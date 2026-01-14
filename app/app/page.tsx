'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

type Transaction = {
  type: 'income' | 'expense';
  amount: number;
};

export default function FinanceAppPage() {
  const router = useRouter();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [incomeInput, setIncomeInput] = useState('');
  const [expenseInput, setExpenseInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    const init = async () => {
      const session = await getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setUserId(session.user.id);
      setSessionChecked(true);
      fetchTransactions(session.user.id);
    };

    init();
  }, [router]);

  const fetchTransactions = async (uid: string) => {
    setListLoading(true);
    const { data, error: fetchError } = await supabase
      .from('transactions')
      .select('type, amount')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    setListLoading(false);

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setTransactions(data ?? []);
  };

  const balance = useMemo(() => {
    return transactions.reduce((acc, item) => {
      if (item.type === 'income') return acc + (item.amount || 0);
      if (item.type === 'expense') return acc - (item.amount || 0);
      return acc;
    }, 0);
  }, [transactions]);

  const handleSubmit = async () => {
    if (!userId) return;

    const incomeValue = incomeInput ? parseFloat(incomeInput) : 0;
    const expenseValue = expenseInput ? parseFloat(expenseInput) : 0;

    if ((incomeValue && expenseValue) || (!incomeValue && !expenseValue)) {
      setError('Заполните только одно поле: доход или расход.');
      return;
    }

    if (incomeValue < 0 || expenseValue < 0) {
      setError('Сумма должна быть больше 0.');
      return;
    }

    const isIncome = incomeValue > 0;
    const amount = isIncome ? incomeValue : expenseValue;

    if (!amount || Number.isNaN(amount) || amount <= 0) {
      setError('Введите положительное число.');
      return;
    }

    setLoading(true);
    setError(null);

    const { error: insertError } = await supabase.from('transactions').insert({
      type: isIncome ? 'income' : 'expense',
      amount,
      user_id: userId,
    });

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setIncomeInput('');
    setExpenseInput('');
    fetchTransactions(userId);
  };

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
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-6 py-4 shadow-sm">
          <div>
            <p className="text-sm text-neutral-600">Текущий баланс</p>
            <p className="text-3xl font-semibold text-neutral-900">
              {balance.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-100"
          >
            Logout
          </button>
        </header>

        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Добавить транзакцию</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-700" htmlFor="income">
                Доход
              </label>
              <input
                id="income"
                type="number"
                min="0"
                value={incomeInput}
                onChange={(e) => setIncomeInput(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                placeholder="Например, 5000"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-700" htmlFor="expense">
                Расход
              </label>
              <input
                id="expense"
                type="number"
                min="0"
                value={expenseInput}
                onChange={(e) => setExpenseInput(e.target.value)}
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                placeholder="Например, 1200"
              />
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="mt-4 w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            {loading ? 'Сохраняем...' : 'Ввод'}
          </button>
        </section>

        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">Ваши транзакции</h2>
            {listLoading && <span className="text-sm text-neutral-500">Обновление...</span>}
          </div>

          {transactions.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-600">Пока нет данных. Добавьте первую запись.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {transactions.map((item, index) => (
                <div
                  key={`${item.type}-${index}-${item.amount}`}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                        item.type === 'income'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {item.type === 'income' ? '+' : '-'}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-neutral-900">
                        {item.type === 'income' ? 'Доход' : 'Расход'}
                      </p>
                      <p className="text-xs text-neutral-600">Сумма: {item.amount} ₽</p>
                    </div>
                  </div>
                  <p className="text-base font-semibold text-neutral-900">
                    {item.type === 'income' ? '+' : '-'}
                    {item.amount.toLocaleString('ru-RU')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
