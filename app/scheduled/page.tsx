'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

type AccountKind = 'debit' | 'credit' | 'cash' | 'broker' | 'crypto';
type AccountCurrency = 'EUR' | 'USD';

interface Account {
  id: string;
  user_id: string;
  name: string;
  kind: AccountKind;
  currency: AccountCurrency | null;
}

interface ScheduledExpenseRun {
  id: string;
  user_id: string;
  scheduled_expense_id: string;
  run_date: string;
  snapshot_account_id: string;
  snapshot_category_id: string | null;
  snapshot_amount: number;
  snapshot_comment: string | null;
  status: 'due';
}

interface ScheduledExpenseDueResponse {
  ok: boolean;
  runs?: ScheduledExpenseRun[];
  error?: string;
}

interface ApplyApiErrorItem {
  run_id: string;
  message: string;
}

interface ApplyApiResponse {
  ok: boolean;
  applied?: number;
  failed?: number;
  rejected?: number;
  errors?: ApplyApiErrorItem[];
  error?: string;
}

interface RejectApiResponse {
  ok: boolean;
  rejected?: number;
  errors?: string[];
  error?: string;
}

// Helper для форматирования денег по валюте
const formatMoney = (amount: number, currency: AccountCurrency = 'EUR'): string => {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency === 'USD' ? 'USD' : 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

export default function ScheduledExpensesPage() {
  const router = useRouter();

  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [runs, setRuns] = useState<ScheduledExpenseRun[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applySummary, setApplySummary] = useState<string | null>(null);

  const accountsById = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach((acc) => map.set(acc.id, acc));
    return map;
  }, [accounts]);

  useEffect(() => {
    const init = async () => {
      const session = await getSession();

      if (!session) {
        router.replace('/login');
        return;
      }

      setUserId(session.user.id);
      const accessToken =
        ((session as { access_token?: string }).access_token as string | undefined) || null;
      setSessionToken(accessToken);
      setSessionChecked(true);

      setLoading(true);
      setError(null);

      try {
        // 1) Load minimal accounts info for resolving names/currencies
        const { data: accountsData, error: accountsError } = await supabase
          .from('accounts')
          .select('id, user_id, name, kind, currency')
          .eq('user_id', session.user.id)
          .order('created_at', { ascending: true });

        if (accountsError) {
          throw new Error(accountsError.message);
        }

        setAccounts((accountsData || []) as Account[]);

        // 2) Ensure scheduled runs exist for today (server-side)
        if (accessToken) {
          const ensureResponse = await fetch('/api/scheduled-expenses/ensure', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
          });

          const ensureJson = await ensureResponse.json().catch(() => ({}));

          if (!ensureResponse.ok || !ensureJson?.ok) {
            throw new Error(ensureJson?.error || 'Failed to ensure scheduled expenses.');
          }
        }

        // 3) Load due runs list
        await loadDueRuns(accessToken);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load scheduled expenses.');
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [router]);

  const loadDueRuns = async (accessToken: string | null) => {
    if (!accessToken) {
      setRuns([]);
      setSelectedIds(new Set());
      return;
    }

    setError(null);

    try {
      const response = await fetch('/api/scheduled-expenses/due', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data: ScheduledExpenseDueResponse = await response
        .json()
        .catch(() => ({ ok: false, error: 'Invalid server response' }));

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to load scheduled expenses.');
      }

      const safeRuns = Array.isArray(data.runs) ? data.runs : [];
      setRuns(safeRuns);
      setSelectedIds(new Set(safeRuns.map((r) => r.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load scheduled expenses.');
      setRuns([]);
      setSelectedIds(new Set());
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isAllSelected = runs.length > 0 && selectedIds.size === runs.length;

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(runs.map((r) => r.id)));
    }
  };

  const applyOrRejectSelected = async () => {
    if (!userId || !sessionToken || runs.length === 0) return;

    setActionLoading(true);
    setError(null);
    setApplySummary(null);

    try {
      const allIds = runs.map((r) => r.id);
      const selectedIdsArray = Array.from(selectedIds);
      const rejectedIds = allIds.filter((id) => !selectedIds.has(id));

      let totalApplied = 0;
      let totalFailed = 0;
      let totalRejected = 0;
      const errorMessages: string[] = [];

      // Apply selected runs
      if (selectedIdsArray.length > 0) {
        try {
          const response = await fetch('/api/scheduled-expenses/apply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ run_ids: selectedIdsArray }),
          });

          const data: ApplyApiResponse = await response
            .json()
            .catch(() => ({ ok: false, error: 'Invalid server response' }));

          if (!response.ok || !data.ok) {
            throw new Error(data.error || 'Failed to apply scheduled expenses.');
          }

          totalApplied += typeof data.applied === 'number' ? data.applied : 0;
          totalFailed += typeof data.failed === 'number' ? data.failed : 0;
          totalRejected += typeof data.rejected === 'number' ? data.rejected : 0;
        } catch (e) {
          errorMessages.push(
            e instanceof Error ? e.message : 'Failed to apply selected scheduled expenses.',
          );
        }
      }

      // Reject unselected runs
      if (rejectedIds.length > 0) {
        try {
          const response = await fetch('/api/scheduled-expenses/reject', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ run_ids: rejectedIds }),
          });

          const data: RejectApiResponse = await response
            .json()
            .catch(() => ({ ok: false, error: 'Invalid server response' }));

          if (!response.ok || !data.ok) {
            throw new Error(data.error || 'Failed to reject scheduled expenses.');
          }

          totalRejected += typeof data.rejected === 'number' ? data.rejected : 0;
        } catch (e) {
          errorMessages.push(
            e instanceof Error ? e.message : 'Failed to reject scheduled expenses.',
          );
        }
      }

      if (errorMessages.length > 0) {
        setError(errorMessages.join(' '));
      }

      setApplySummary(
        `Applied: ${totalApplied}, failed: ${totalFailed}, rejected: ${totalRejected}.`,
      );

      await loadDueRuns(sessionToken);

      // If there were no blocking errors, redirect back to main app
      if (errorMessages.length === 0) {
        router.replace('/app');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to process scheduled expenses.');
    } finally {
      setActionLoading(false);
    }
  };

  if (!sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <p className="text-neutral-500">Checking session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-800">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-semibold mb-4">Scheduled expenses</h1>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {applySummary && (
          <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {applySummary}
          </div>
        )}

        {loading ? (
          <div className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600">
            Loading scheduled expenses...
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600">
            No scheduled expenses due.
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <input
                  id="select-all"
                  type="checkbox"
                  className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                  checked={isAllSelected}
                  onChange={toggleSelectAll}
                />
                <label
                  htmlFor="select-all"
                  className="text-sm text-neutral-700 select-none"
                >
                  Select all
                </label>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-500">
                <span>Selected: {selectedIds.size}</span>
                <span className="mx-1">•</span>
                <span>Total: {runs.length}</span>
              </div>
            </div>

            <div className="space-y-3 mb-4">
              {runs.map((run) => {
                const account = accountsById.get(run.snapshot_account_id);
                const currency: AccountCurrency =
                  (account?.currency || 'EUR') as AccountCurrency;
                const accountName = account?.name || 'Unknown account';

                return (
                  <label
                    key={run.id}
                    className="flex gap-3 rounded-md border border-neutral-200 bg-white p-3 shadow-sm"
                  >
                    <div className="pt-1">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                        checked={selectedIds.has(run.id)}
                        onChange={() => toggleSelection(run.id)}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-medium text-neutral-900">
                          {run.run_date}
                        </span>
                        <span className="text-sm font-semibold text-neutral-900">
                          {formatMoney(run.snapshot_amount, currency)}{' '}
                          <span className="text-xs text-neutral-500">{currency}</span>
                        </span>
                      </div>
                      <div className="text-xs text-neutral-600 mb-1">
                        <span>{accountName}</span>
                        <span className="mx-1 text-neutral-400">•</span>
                        <span>
                          {run.snapshot_category_id ? run.snapshot_category_id : '—'}
                        </span>
                      </div>
                      {run.snapshot_comment && (
                        <div className="text-xs text-neutral-500 line-clamp-2">
                          {run.snapshot_comment}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
                disabled={actionLoading || selectedIds.size === 0}
                onClick={applyOrRejectSelected}
              >
                {actionLoading ? 'Applying...' : 'Apply selected'}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-200"
                onClick={() => router.replace('/app')}
              >
                To main page
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

