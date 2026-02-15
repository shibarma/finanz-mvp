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

const AUTO_REDIRECT = true;
const REDIRECT_DELAY_MS = 1000;

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
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [llmResult, setLlmResult] = useState<Record<string, unknown> | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<Record<string, unknown> | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const finalTextRef = useRef<string>('');
  const isStartingRef = useRef(false);
  const shouldStopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<Status>(status);
  const restartRecognitionRef = useRef<() => void>(() => {});
  const triedAutostartRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  statusRef.current = status;

  const SpeechRecognitionAPI =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const isSupported = !!SpeechRecognitionAPI;

  const finishRecording = useCallback(() => {
    shouldStopRef.current = true;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (restartTimeoutRef.current != null) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    try {
      recognitionRef.current?.stop?.();
    } catch {
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // ignore
      }
    }
    recognitionRef.current = null;
    setTranscript(finalTextRef.current);
    setStatus('done');
  }, []);

  const clearRecording = useCallback(() => {
    shouldStopRef.current = true;
    try {
      recognitionRef.current?.abort?.();
    } catch {
      // ignore
    }
    recognitionRef.current = null;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (restartTimeoutRef.current != null) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    finalTextRef.current = '';
    setTranscript('');
    setStatus('idle');
    setError(null);
    setLlmResult(null);
    setLlmError(null);
    setCreateResult(null);
    setCreateSuccess(null);
  }, []);

  const createRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort?.();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    const recognition = new SpeechRecognitionAPI();
    recognition.lang = speechLangMap[userLanguage];
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: {
      resultIndex: number;
      results: Array<{ isFinal: boolean; 0?: { transcript?: string } }>;
    }) => {
      if (textareaRef.current && document.activeElement === textareaRef.current) return;
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
      if (shouldStopRef.current) return;
      if (statusRef.current !== 'recording') return;
      restartRecognitionRef.current();
    };

    recognition.onerror = (event: { error?: string }) => {
      const err = event.error || '';
      if (err === 'no-speech' && statusRef.current === 'recording' && !shouldStopRef.current) {
        restartRecognitionRef.current();
        return;
      }
      setError(err || 'Recognition error');
      setStatus('error');
    };

    recognitionRef.current = recognition;
  }, [userLanguage]);

  const restartRecognition = useCallback(() => {
    if (shouldStopRef.current) return;
    if (statusRef.current !== 'recording') return;
    if (isStartingRef.current) return;
    try {
      recognitionRef.current?.abort?.();
    } catch {
      // ignore
    }
    recognitionRef.current = null;
    restartTimeoutRef.current = setTimeout(() => {
      restartTimeoutRef.current = null;
      createRecognition();
      try {
        recognitionRef.current?.start();
      } catch {
        setStatus('done');
        setTranscript(finalTextRef.current);
      }
    }, 300);
  }, [createRecognition]);

  restartRecognitionRef.current = restartRecognition;

  const startRecording = useCallback(() => {
    if (!SpeechRecognitionAPI || !isSupported) {
      setError('Speech recognition is not supported in this browser.');
      setStatus('error');
      return;
    }
    if (status === 'recording' || isStartingRef.current) return;
    setError(null);
    shouldStopRef.current = false;
    const wasIdle = status === 'idle';
    setStatus('recording');
    if (wasIdle) {
      finalTextRef.current = '';
      setTranscript('');
      setLlmResult(null);
      setLlmError(null);
      setCreateResult(null);
      setCreateSuccess(null);
    }
    createRecognition();
    try {
      recognitionRef.current?.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recognition');
      setStatus('error');
      recognitionRef.current = null;
      return;
    }
    isStartingRef.current = true;
    setTimeout(() => {
      isStartingRef.current = false;
    }, 300);
    if (wasIdle) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        finishRecording();
      }, 30000);
    }
  }, [userLanguage, isSupported, status, createRecognition, finishRecording]);

  const handleClear = useCallback(() => {
    clearRecording();
  }, [clearRecording]);

  const handleSend = useCallback(async () => {
    if (status === 'recording') finishRecording();
    const text = transcript.trim();
    if (!text) {
      setLlmError('Enter or dictate text first');
      setLlmResult(null);
      setCreateResult(null);
      setCreateSuccess(null);
      return;
    }
    setIsSending(true);
    setLlmError(null);
    setLlmResult(null);
    setCreateResult(null);
    setCreateSuccess(null);

    try {
      const parseRes = await fetch('/api/voice/parse-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const parseData = (await parseRes.json()) as {
        ok: boolean;
        result?: Record<string, unknown>;
        error?: string;
      };
      if (!parseData.ok || !parseData.result) {
        setLlmError(parseData.error ?? 'Unknown error');
        setLlmResult(null);
        return;
      }
      setLlmResult(parseData.result);

      const session = await getSession();
      if (!session) {
        setLlmError('Not signed in');
        return;
      }
      const accessToken = (session as { access_token?: string }).access_token;
      if (!accessToken) {
        setLlmError('Session expired');
        return;
      }

      const createRes = await fetch('/api/voice/create-expense', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ text, parsed: parseData.result }),
      });
      const createData = (await createRes.json()) as {
        ok: boolean;
        error?: string;
        parsed?: Record<string, unknown>;
        resolved?: Record<string, unknown>;
        transaction?: Record<string, unknown>;
      };
      if (!createData.ok) {
        setLlmError(createData.error ?? 'Failed to create transaction');
        return;
      }

      setCreateResult({
        parsed: createData.parsed,
        resolved: createData.resolved,
        transaction: createData.transaction,
      });
      setCreateSuccess('Expense created ✅');
      if (AUTO_REDIRECT) {
        setTimeout(() => router.push('/app'), REDIRECT_DELAY_MS);
      }
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : 'Failed to contact server');
      setLlmResult(null);
      setCreateResult(null);
      setCreateSuccess(null);
    } finally {
      setIsSending(false);
    }
  }, [status, transcript, finishRecording, router]);

  const handleLanguageChange = useCallback(
    async (lang: UserLanguage) => {
      if (!userId) return;
      const wasRecording = status === 'recording';
      if (wasRecording) clearRecording();

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

      if (wasRecording) {
        setTimeout(() => startRecording(), 100);
      }
    },
    [userId, status, clearRecording, startRecording]
  );

  useEffect(() => {
    const init = async () => {
      const session = await requireSessionOrRedirect(router);
      if (!session) return;

      setUserId(session.user.id);

      const { error: upsertError } = await supabase
        .from('user_settings')
        .upsert(
          { user_id: session.user.id, language_code: 'en' },
          { onConflict: 'user_id' }
        );
      if (upsertError) {
        console.warn('user_settings upsert failed:', upsertError.message);
      }

      const { data: row, error: fetchError } = await supabase
        .from('user_settings')
        .select('language_code')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (fetchError) {
        console.warn('user_settings select failed:', fetchError.message);
      }

      const validLang = row?.language_code;
      if (validLang === 'en' || validLang === 'ru' || validLang === 'de') {
        setUserLanguage(validLang as UserLanguage);
      } else {
        setUserLanguage('en');
      }

      setSessionChecked(true);
    };

    init();
  }, [router]);

  // Best-effort autostart when session is ready (browser may block without user gesture)
  useEffect(() => {
    if (!sessionChecked || !isSupported || triedAutostartRef.current) return;
    triedAutostartRef.current = true;
    try {
      startRecording();
      setHasInteracted(true);
    } catch {
      // overlay remains for tap-to-start
    }
  }, [sessionChecked, isSupported, startRecording]);

  useEffect(() => {
    return () => {
      shouldStopRef.current = true;
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
      if (timerRef.current != null) clearTimeout(timerRef.current);
      if (restartTimeoutRef.current != null) clearTimeout(restartTimeoutRef.current);
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

  const overlay = !hasInteracted && (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => {
        setHasInteracted(true);
        startRecording();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setHasInteracted(true);
          startRecording();
        }
      }}
      aria-label="Tap to start recording"
    >
      <p className="text-white text-lg font-medium">Tap to start recording</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-neutral-50 p-4 pb-8">
      {overlay}

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

      {createSuccess && (
        <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 p-3 text-sm text-green-800 font-medium">
          {createSuccess}
        </div>
      )}

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm mb-4">
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Transcript</h2>
        <textarea
          ref={textareaRef}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder={status === 'recording' ? 'Speaking...' : ''}
          rows={5}
          className="w-full min-h-[120px] rounded-xl border border-neutral-200 bg-white px-3 py-2 text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-y"
        />
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <button
          type="button"
          onClick={() => {
            setHasInteracted(true);
            if (status !== 'recording') startRecording();
          }}
          disabled={status === 'recording' || isSending}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
        >
          Start
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={isSending}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={isSending}
          className="rounded-2xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
        >
          {isSending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {(llmResult != null || llmError != null || createResult != null) && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm space-y-4">
          {llmError != null && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {llmError}
            </div>
          )}
          {llmResult != null && (
            <div>
              <h2 className="text-sm font-medium text-neutral-600 mb-2">Parsed (LLM)</h2>
              <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800 whitespace-pre-wrap break-words">
                {JSON.stringify(llmResult, null, 2)}
              </pre>
            </div>
          )}
          {createResult != null && (
            <div>
              <h2 className="text-sm font-medium text-neutral-600 mb-2">Transaction created</h2>
              <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800 whitespace-pre-wrap break-words">
                {JSON.stringify(createResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
