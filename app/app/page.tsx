'use client';

import { useEffect, useMemo, useState } from 'react';
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
  is_default_income: boolean;
  is_default_expense: boolean;
  created_at: string;
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
}

type AccountBalance = {
  balance: number;
  status: 'normal' | 'orange' | 'red';
  creditUsed?: number;
};

// Helper для форматирования денег в EUR
const formatMoney = (amount: number): string => {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export default function FinanceAppPage() {
  const router = useRouter();
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Флаги для отслеживания ручного выбора счетов
  const [accountIncomeManuallySet, setAccountIncomeManuallySet] = useState(false);
  const [accountExpenseManuallySet, setAccountExpenseManuallySet] = useState(false);

  // Пагинация для операций
  const [operationsPage, setOperationsPage] = useState(0);
  const OPERATIONS_PER_PAGE = 20;

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

  useEffect(() => {
    const init = async () => {
      const session = await getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setUserId(session.user.id);
      setSessionChecked(true);
      await Promise.all([
        loadAccounts(),
        loadCategories(),
        loadTransactions(session.user.id),
        loadTransfers(session.user.id),
      ]);
    };

    init();
  }, [router]);

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
    let totalBalance = 0;
    let debitTotal = 0;
    let creditTotal = 0;
    let cashTotal = 0;

    accountBalances.forEach((accBalance, accountId) => {
      const account = accountsById.get(accountId);
      if (!account) return;

      totalBalance += accBalance.balance;

      if (account.kind === 'debit') {
        debitTotal += accBalance.balance;
      } else if (account.kind === 'credit') {
        creditTotal += accBalance.balance;
      } else if (account.kind === 'cash') {
        cashTotal += accBalance.balance;
      }
    });

    return { totalBalance, debitTotal, creditTotal, cashTotal };
  }, [accountBalances, accountsById]);

  const handleIncome = async () => {
    if (!userId) return;

    setError(null);

    const amount = parseFloat(amountIncome);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
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

    const amount = parseFloat(amountExpense);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
      setError('Введите положительную сумму.');
      return;
    }

    if (!accountExpense) {
      setError('Выберите счёт.');
      return;
    }

    const account = accountsById.get(accountExpense);
    if (account && account.kind === 'cash') {
      const currentBalance = accountBalances.get(accountExpense)?.balance || 0;
      if (amount > currentBalance) {
        setError(`Недостаточно средств на счёте "${account.name}". Доступно: ${formatMoney(currentBalance)}.`);
        return;
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

    const amount = parseFloat(amountTransfer);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
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
    }

    // Check cash restriction
    const fromAccount = accountsById.get(fromAccountId);
    if (fromAccount && fromAccount.kind === 'cash') {
      const currentBalance = accountBalances.get(fromAccountId)?.balance || 0;
      if (amount > currentBalance) {
        setError(`Недостаточно средств на счёте "${fromAccount.name}". Доступно: ${formatMoney(currentBalance)}.`);
        return;
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

    const amount = parseFloat(editAmount);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
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
      }
    } else if (!isCreditRepayment) {
      setFromAccountTransfer('');
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

        {/* Operations form - moved to top */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Операции</h2>

          <div className="grid gap-6 md:grid-cols-3">
            {/* Income */}
            <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Income</h3>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Сумма</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amountIncome}
                    onChange={(e) => setAmountIncome(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
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
                    type="number"
                    min="0"
                    step="0.01"
                    value={amountExpense}
                    onChange={(e) => setAmountExpense(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
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
                    type="number"
                    min="0"
                    step="0.01"
                    value={amountTransfer}
                    onChange={(e) => setAmountTransfer(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
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
                        onChange={(e) => setFromAccountTransfer(e.target.value)}
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
                      <label className="block text-xs font-medium text-neutral-700">Куда</label>
                      <select
                        value={toAccountTransfer}
                        onChange={(e) => setToAccountTransfer(e.target.value)}
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
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-neutral-700">Куда (кредитка)</label>
                      <select
                        value={toAccountTransfer}
                        onChange={(e) => setToAccountTransfer(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                      >
                        <option value="">Выберите кредитный счёт</option>
                        {creditAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name}
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
                  disabled={submittingTransfer}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                >
                  {submittingTransfer ? 'Сохранение...' : 'Ввод Transfer'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Summary */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Сводка</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs text-neutral-600">Общий баланс</p>
              <p className="text-2xl font-semibold text-neutral-900">
                {formatMoney(totals.totalBalance)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Debit</p>
              <p className="text-2xl font-semibold text-neutral-900">
                {formatMoney(totals.debitTotal)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Credit</p>
              <p className="text-2xl font-semibold text-neutral-900">
                {formatMoney(totals.creditTotal)}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-600">Cash</p>
              <p className="text-2xl font-semibold text-neutral-900">
                {formatMoney(totals.cashTotal)}
              </p>
            </div>
          </div>
        </section>

        {/* Accounts list */}
        <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Счета</h2>
          {accounts.length === 0 ? (
            <p className="text-sm text-neutral-600">Нет счетов. Создайте счёт в настройках.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => {
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
                        {formatMoney(accBalance.balance)}
                      </p>
                      {account.kind === 'credit' && accBalance.creditUsed !== undefined && (
                        <p className="mt-1 text-xs text-neutral-600">
                          Использовано кредита: {formatMoney(accBalance.creditUsed)} из{' '}
                          {formatMoney(account.credit_limit || 0)}
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
          <div className="mb-4 flex items-center justify-between">
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
                  transfers.length + transactions.filter((t) => t.kind !== 'transfer').length
                }
                className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-800 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                →
              </button>
            </div>
          </div>

          {(() => {
            // Объединяем transfers и transactions для отображения
            const allOperations: Array<{
              id: string;
              type: 'income' | 'expense' | 'transfer';
              amount: number;
              accountName?: string;
              fromAccountName?: string;
              toAccountName?: string;
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
                fromAccountName: fromAccount?.name,
                toAccountName: toAccount?.name,
                comment: transfer.comment,
                date: transfer.created_at,
              });
            });

            // Добавляем income/expense transactions (исключаем transfer)
            transactions
              .filter((t) => t.kind !== 'transfer')
              .forEach((tx) => {
                const account = accountsById.get(tx.account_id);
                const category = categories.find((c) => c.id === tx.category_id);
                allOperations.push({
                  id: tx.id,
                  type: tx.kind as 'income' | 'expense',
                  amount: tx.amount,
                  accountName: account?.name,
                  categoryName: category?.name,
                  comment: tx.comment,
                  date: tx.created_at,
                });
              });

            // Сортируем по дате (новые сначала)
            allOperations.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            // Пагинация
            const startIndex = operationsPage * OPERATIONS_PER_PAGE;
            const endIndex = startIndex + OPERATIONS_PER_PAGE;
            const paginatedOperations = allOperations.slice(startIndex, endIndex);

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
                        {formatMoney(op.amount)}
                      </p>
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
                    type="number"
                    min="0"
                    step="0.01"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
                    placeholder="0.00"
                  />
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
