'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    const checkSession = async () => {
      const session = await getSession();
      setHasSession(!!session);
    };

    checkSession();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!hasSession) {
      setError('Нет активной сессии. Откройте ссылку из письма заново.');
      return;
    }

    if (!newPassword || !confirmPassword) {
      setError('Введите новый пароль и его подтверждение.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Пароли не совпадают.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });

      if (updateError) {
        setError(updateError.message);
      } else {
        setSuccessMessage('Пароль обновлён.');
        setTimeout(() => {
          router.replace('/app');
        }, 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить пароль.');
    } finally {
      setLoading(false);
    }
  };

  if (hasSession === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
          <h1 className="mb-4 text-center text-2xl font-semibold text-neutral-900">
            Восстановление пароля
          </h1>
          <p className="text-center text-sm text-neutral-600">
            Нет активной сессии. Пожалуйста, откройте ссылку из письма восстановления ещё раз.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold text-neutral-900">Смена пароля</h1>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700" htmlFor="new-password">
              Новый пароль
            </label>
            <input
              id="new-password"
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
              placeholder="Введите новый пароль"
            />
          </div>
          <div className="space-y-2">
            <label
              className="block text-sm font-medium text-neutral-700"
              htmlFor="confirm-new-password"
            >
              Подтверждение пароля
            </label>
            <input
              id="confirm-new-password"
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-200"
              placeholder="Повторите новый пароль"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {successMessage && (
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              {successMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || hasSession === null}
            className="flex w-full items-center justify-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            {loading ? 'Сохраняем...' : 'Сменить пароль'}
          </button>
        </form>
      </div>
    </div>
  );
}

