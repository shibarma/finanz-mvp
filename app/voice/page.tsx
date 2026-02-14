'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, supabase } from '../../lib/supabaseClient';

const speechLangMap: Record<'en' | 'ru' | 'de', string> = {
  en: 'en-US',
  ru: 'ru-RU',
  de: 'de-DE',
};

type Status = 'idle' | 'recording' | 'done' | 'error';
type UserLanguage = 'en' | 'ru' | 'de';

const LANGUAGE_OPTIONS: { value: UserLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Russian' },
  { value: 'de', label: 'German' },
];

async function requireSessionOrRedirect(router: ReturnType<typeof useRouter>) {
  const session = await getSession();
  if (!session) {
    router.replace('/login');
    return null;
  }
  return session;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export default function VoicePage() {
  const router = useRouter();

  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [userLanguage, setUserLanguage] = useState<UserLanguage>('en');
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const finalTextRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const SpeechRecognitionAPI =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const isSupported = !!SpeechRecognitionAPI;

  const stopRecording = useCallback((reason: 'send' | 'timeout' | 'clear') => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop?.();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    if (reason === 'clear') {
      finalTextRef.current = '';
      setTranscript('');
      setStatus('idle');
      setError(null);
    } else {
      setTranscript(finalTextRef.current);
      setStatus('done');
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!SpeechRecognitionAPI || !isSupported) {
      setError('Speech recognition is not supported in this browser.');
      setStatus('error');
      return;
    }
    if (status === 'recording') return;
    setError(null);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop?.();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    finalTextRef.current = '';
    setTranscript('');
    setStatus('recording');

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = speechLangMap[userLanguage];
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: {
      resultIndex: number;
      results: Array<{ isFinal: boolean; 0?: { transcript?: string } }>;
    }) => {
      if (recognitionRef.current !== recognition) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = (res[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (res.isFinal) {
          finalTextRef.current = normalize(finalTextRef.current + ' ' + text);
        } else {
          interim = normalize(interim + ' ' + text);
        }
      }
      setTranscript(normalize(finalTextRef.current + (interim ? ' ' + interim : '')));
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTranscript(finalTextRef.current);
      setStatus('done');
    };

    recognition.onerror = (event: { error?: string }) => {
      if (recognitionRef.current !== recognition) return;
      setError(event.error || 'Recognition error');
      setStatus('error');
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recognition');
      setStatus('error');
      recognitionRef.current = null;
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      stopRecording('timeout');
    }, 30000);
  }, [userLanguage, isSupported, status, stopRecording]);

  const handleClear = useCallback(() => {
    stopRecording('clear');
  }, [stopRecording]);

  const handleSend = useCallback(() => {
    stopRecording('send');
  }, [stopRecording]);

  const handleLanguageChange = useCallback(
    async (lang: UserLanguage) => {
      if (!userId) return;
      const wasRecording = status === 'recording';
      if (wasRecording) stopRecording('send');

      setUserLanguage(lang);

      const { error: upsertError } = await supabase.from('user_settings').upsert(
        { user_id: userId, language_code: lang },
        { onConflict: 'user_id' }
      );
      if (upsertError) {
        setError(upsertError.message);
        return;
      }
      setError(null);
    },
    [userId, status, stopRecording]
  );

  useEffect(() => {
    const init = async () => {
      const session = await requireSessionOrRedirect(router);
      if (!session) return;

      setUserId(session.user.id);

      const { data: row, error: fetchError } = await supabase
        .from('user_settings')
        .select('language_code')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (fetchError) {
        setError(fetchError.message);
        setSessionChecked(true);
        return;
      }

      if (row && (row.language_code === 'en' || row.language_code === 'ru' || row.language_code === 'de')) {
        setUserLanguage(row.language_code as UserLanguage);
      } else {
        const { error: insertError } = await supabase.from('user_settings').insert({
          user_id: session.user.id,
          language_code: 'en',
        });
        if (insertError) {
          setError(insertError.message);
        }
        setUserLanguage('en');
      }

      setSessionChecked(true);
    };

    init();
  }, [router]);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.onresult = null;
          rec.onerror = null;
          rec.onend = null;
          rec.stop?.();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  if (!sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-4">
        <p className="text-neutral-500">Checking session...</p>
      </div>
    );
  }

  if (!isSupported) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-50 p-4">
        <h1 className="text-xl font-semibold text-neutral-800 mb-2">Voice input</h1>
        <p className="text-red-600 text-center">
          Speech recognition is not supported in this browser. Try Chrome on Android or desktop.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 p-4 pb-8">
      <h1 className="text-xl font-semibold text-neutral-800 mb-4">Voice input</h1>

      <div className="mb-4">
        <label className="block text-sm font-medium text-neutral-600 mb-2">Language</label>
        <div className="flex flex-wrap gap-2">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleLanguageChange(opt.value)}
              className={`rounded-2xl border px-4 py-2 text-sm font-medium transition-colors ${
                userLanguage === opt.value
                  ? 'border-neutral-400 bg-neutral-200 text-neutral-800'
                  : 'border-neutral-200 bg-white text-neutral-600 shadow-sm hover:bg-neutral-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm mb-4">
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Transcript</h2>
        <div className="min-h-[120px] text-neutral-800 whitespace-pre-wrap break-words">
          {transcript || (status === 'recording' ? '...' : '')}
        </div>
        {status === 'done' && (
          <p className="text-sm text-neutral-500 mt-2">Recording stopped. Tap Start to continue.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => (status !== 'recording' ? startRecording() : undefined)}
          disabled={status === 'recording'}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
        >
          Start
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleSend}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
