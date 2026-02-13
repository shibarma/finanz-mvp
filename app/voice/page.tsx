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
  const [hasInteracted, setHasInteracted] = useState(false);

  const recognitionRef = useRef<any>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userClearedOrSentRef = useRef(false);
  const triedAutostartRef = useRef(false);

  const SpeechRecognitionAPI =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const isSupported = !!SpeechRecognitionAPI;

  const stopAndClearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!SpeechRecognitionAPI || !isSupported) {
      setError('Speech recognition is not supported in this browser.');
      setStatus('error');
      return;
    }
    setError(null);
    stopAndClearTimer();

    const recognition = new SpeechRecognitionAPI();
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.lang = speechLangMap[userLanguage];

    let lastFinal = '';
    let lastAddedFinal = '';
    userClearedOrSentRef.current = false;

    recognition.onresult = (event: {
      resultIndex: number;
      results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
    }) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) {
            const isDuplicate = trimmed === lastAddedFinal || lastFinal.endsWith(trimmed);
            if (!isDuplicate) {
              lastFinal = lastFinal ? lastFinal + ' ' + trimmed : trimmed;
              lastAddedFinal = trimmed;
            }
          }
        } else {
          interim += text;
        }
      }
      setTranscript(() => {
        const base = lastFinal;
        if (!interim) return base;
        const it = interim.trim();
        if (!it || it === lastAddedFinal || lastFinal.endsWith(it)) return base;
        return base ? base + ' ' + interim : interim;
      });
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      if (userClearedOrSentRef.current) return;
      setTranscript(lastFinal || '');
      setStatus('done');
    };

    recognition.onerror = (event: { error?: string }) => {
      if (recognitionRef.current === recognition) {
        setError(event.error || 'Recognition error');
        setStatus('error');
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setStatus('recording');
      setTranscript('');

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        try {
          recognition.stop();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
        setTranscript((prev) => lastFinal || prev);
        setStatus('done');
      }, 30000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recognition');
      setStatus('error');
      recognitionRef.current = null;
    }
  }, [userLanguage, isSupported, stopAndClearTimer]);

  const handleClear = useCallback(() => {
    userClearedOrSentRef.current = true;
    stopAndClearTimer();
    setTranscript('');
    setError(null);
    setStatus('idle');
  }, [stopAndClearTimer]);

  const handleSend = useCallback(() => {
    userClearedOrSentRef.current = true;
    stopAndClearTimer();
    setStatus('done');
    // text stays on screen
  }, [stopAndClearTimer]);

  const handleLanguageChange = useCallback(
    async (lang: UserLanguage) => {
      if (!userId) return;
      const wasRecording = status === 'recording';
      if (wasRecording) {
        stopAndClearTimer();
        setStatus('idle');
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

      if (wasRecording) {
        setTimeout(() => startRecording(), 100);
      }
    },
    [userId, status, stopAndClearTimer, startRecording]
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
      stopAndClearTimer();
    };
  }, [stopAndClearTimer]);

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
            setHasInteracted(true);
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
