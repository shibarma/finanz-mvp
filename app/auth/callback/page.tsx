'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const next = searchParams.get('next') || '/update-password';

    if (!code) {
      setStatus('error');
      setErrorMessage('Не найден код восстановления. Попробуйте снова запросить письмо.');
      return;
    }

    const exchange = async () => {
      setStatus('loading');
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        setStatus('error');
        setErrorMessage(error.message || 'Не удалось установить сессию.');
        return;
      }

      router.replace(next);
    };

    exchange();
  }, [router, searchParams]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
          <h1 className="mb-4 text-center text-xl font-semibold text-neutral-900">
            Подтверждаем восстановление пароля...
          </h1>
          <p className="text-center text-sm text-neutral-600">Пожалуйста, подождите несколько секунд.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="mb-4 text-center text-xl font-semibold text-neutral-900">
          Ошибка восстановления пароля
        </h1>
        <p className="mb-4 text-center text-sm text-neutral-600">
          {errorMessage || 'Не удалось обработать ссылку восстановления пароля.'}
        </p>
        <button
          type="button"
          onClick={() => router.replace('/login?error=recovery_failed')}
          className="flex w-full items-center justify-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          Перейти на страницу входа
        </button>
      </div>
    </div>
  );
}

