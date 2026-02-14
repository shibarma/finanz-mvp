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

export default function VoicePage() {
  const router = useRouter();

  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [userLanguage, setUserLanguage] = useState<UserLanguage>('en');
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userClearedOrSentRef = useRef(false);
  const isRecordingRef = useRef(false);
  const startingRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const finalByIndexRef = useRef<Record<number, string>>({});
  const maxFinalIndexRef = useRef<number>(-1);

  const RESTART_DEBOUNCE_MS = 300;
  const RECORDING_LIMIT_MS = 30_000;

  const SpeechRecognitionAPI =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const isSupported = !!SpeechRecognitionAPI;

  function getFinalText(): string {
    const map = finalByIndexRef.current;
    const max = maxFinalIndexRef.current;
    const parts: string[] = [];
    for (let i = 0; i <= max; i++) {
      if (map[i] != null) parts.push(map[i]);
    }
    return parts.join(' ');
  }

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const safeStart = useCallback(() => {
    if (startingRef.current) return;
    const rec = recognitionRef.current;
    if (!rec) return;
    if (!isRecordingRef.current) return;
    startingRef.current = true;
    try {
      rec.start();
      console.log('[Voice] start (restart)');
    } catch (err) {
      const name = err instanceof Error ? (err as Error & { name?: string }).name : '';
      if (name === 'InvalidStateError') {
        // will retry via debounced onend
      } else {
        setError(err instanceof Error ? err.message : 'Failed to start recognition');
        setStatus('error');
      }
    } finally {
      startingRef.current = false;
    }
  }, []);

  const getOrCreateRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = speechLangMap[userLanguage];
      return recognitionRef.current;
    }
    const SpeechAPI =
      typeof window !== 'undefined'
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;
    if (!SpeechAPI) return null;
    const recognition = new SpeechAPI();
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.lang = speechLangMap[userLanguage];

    recognition.onresult = (event: {
      resultIndex: number;
      results: Array<{ isFinal: boolean; length?: number; 0: { transcript: string } }>;
    }) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          if (i > maxFinalIndexRef.current) {
            const nextIdx = maxFinalIndexRef.current + 1;
            finalByIndexRef.current[nextIdx] = text;
            maxFinalIndexRef.current = nextIdx;
          }
        } else {
          interimText = text;
        }
      }
      const finalText = getFinalText();
      setTranscript(interimText ? finalText + (finalText ? ' ' : '') + interimText : finalText);
    };

    recognition.onend = () => {
      console.log('[Voice] onend');
      if (userClearedOrSentRef.current) return;
      const finalText = getFinalText();
      setTranscript(finalText);
      if (!isRecordingRef.current) {
        setStatus('done');
        return;
      }
      const deadline = deadlineRef.current;
      if (deadline != null && Date.now() < deadline) {
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          safeStart();
        }, RESTART_DEBOUNCE_MS);
      } else {
        setStatus('done');
      }
    };

    recognition.onerror = (event: { error?: string }) => {
      console.log('[Voice] onerror', event.error ?? '');
      setError(event.error || 'Recognition error');
      setStatus('error');
    };

    recognitionRef.current = recognition;
    return recognitionRef.current;
  }, [userLanguage, safeStart]);

  const startRecording = useCallback(() => {
    if (!SpeechRecognitionAPI || !isSupported) {
      setError('Speech recognition is not supported in this browser.');
      setStatus('error');
      return;
    }
    setError(null);
    stopRecording();

    finalByIndexRef.current = {};
    maxFinalIndexRef.current = -1;
    setTranscript('');
    userClearedOrSentRef.current = false;
    deadlineRef.current = Date.now() + RECORDING_LIMIT_MS;
    isRecordingRef.current = true;

    const recognition = getOrCreateRecognition();
    if (!recognition) {
      setError('Speech recognition is not supported in this browser.');
      setStatus('error');
      isRecordingRef.current = false;
      return;
    }
    recognition.lang = speechLangMap[userLanguage];

    try {
      recognition.start();
      console.log('[Voice] start (primary)');
      setStatus('recording');

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        isRecordingRef.current = false;
        if (restartTimerRef.current) {
          clearTimeout(restartTimerRef.current);
          restartTimerRef.current = null;
        }
        stopRecording();
        setTranscript(getFinalText());
        setStatus('done');
      }, RECORDING_LIMIT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recognition');
      setStatus('error');
      isRecordingRef.current = false;
    }
  }, [userLanguage, isSupported, stopRecording, getOrCreateRecognition]);

  const handleClear = useCallback(() => {
    userClearedOrSentRef.current = true;
    isRecordingRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    stopRecording();
    finalByIndexRef.current = {};
    maxFinalIndexRef.current = -1;
    setTranscript('');
    setError(null);
    setStatus('idle');
  }, [stopRecording]);

  const handleSend = useCallback(() => {
    userClearedOrSentRef.current = true;
    isRecordingRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    stopRecording();
    setStatus('done');
  }, [stopRecording]);

  const handleLanguageChange = useCallback(
    async (lang: UserLanguage) => {
      if (!userId) return;
      const wasRecording = status === 'recording';
      const rec = recognitionRef.current;
      if (rec) {
        rec.lang = speechLangMap[lang];
        if (wasRecording) {
          try {
            rec.stop();
          } catch {
            // ignore
          }
          // onend will fire and schedule safeStart (controlled restart with new lang)
        }
      }

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
    [userId, status]
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
      stopRecording();
    };
  }, [stopRecording]);

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
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => {
            if (status !== 'recording') startRecording();
          }}
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
