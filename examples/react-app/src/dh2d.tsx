'use client'

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from 'react';

import {
  createDH2DSession,
  DHStatus,
  hooks,
  DH2DSessionStatus,
  type ChatMessage,
  type DH2DSession,
} from 'mtai';

export const DH2D: FC<{
  /** Reference to access the DH2D session instance */
  sessionRef?: RefObject<DH2DSession | null>;
  /** Custom CSS styles for the container */
  style?: CSSProperties;
  /** ID of the video to be used for the digital human */
  videoId: string;
  /** Whether to use audio input */
  audioInput?: boolean;
  /** Voice ID to be used for speech synthesis */
  voice?: string;
  /** Model to use for automatic speech recognition */
  asrModel?: | 'local' | 'remote';
  /** System prompt to guide the AI's behavior */
  systemPrompt?: string;
  /** If set, ASR will be triggered when pressing this key */
  asrKey?: string;
  /** Initial message from the digital human */
  greetingMessage?: string;
  /** Configuration for using an OpenAI-compatible LLM */
  openaiCompatibleLLM?: {
    /** Model name to use */
    model?: string;
    /** Custom endpoint for chat completions */
    chatCompletionAddr?: string;
    /** Authentication token */
    bearerToken?: string
  },
  /** Callback fired when the bot produces output */
  onBotOutput?: (output: string) => void;
  /** Callback fired when ASR produces text from speech */
  onAsrOutput?: (output: string) => void;
  /** Callback fired when the conversation history changes */
  onHistoryChanged?: (history: ChatMessage[]) => void;
  /** Callback fired when the digital human's status changes */
  onStatusChanged?: (status: (typeof DHStatus)[number]) => void;
  /** Callback fired when the session status changes */
  onSessionStatusChanged?: (status: (typeof DH2DSessionStatus)[number]) => void;
}> = ({
  sessionRef,
  style,
  videoId,
  audioInput = true,
  voice,
  asrModel,
  systemPrompt,
  asrKey,
  greetingMessage,
  openaiCompatibleLLM,
  onBotOutput,
  onAsrOutput,
  onHistoryChanged,
  onStatusChanged,
  onSessionStatusChanged,
}) => {
  const [session, setSession] = useState<DH2DSession>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const asrSession = useMemo(() => behaviorSubject<boolean>(false), [videoId]);
  const statusLock = useMemo(() => asyncLock(), [asrSession]);
  const latestGreetingMsg = useEvent(() => greetingMessage);
  useEffect(() => {
    if (sessionRef) sessionRef.current = session || null;
  }, [session, sessionRef]);
  const status = useMemo(() => behaviorSubject<(typeof DHStatus)[number]>('sleeping'), [videoId]);
  const upstreamStatus = useMemo(() => behaviorSubject<(typeof DHStatus)[number]>('sleeping'), [videoId]);

  const historyRef = useRef<ChatMessage[]>([]);
  const appendHistory = useEvent((message: ChatMessage) => {
    if (onHistoryChanged && (historyRef.current.length === 0 || historyRef.current[historyRef.current.length - 1].role !== message.role)) {
      historyRef.current = [...historyRef.current, message];
      onHistoryChanged(historyRef.current);
    }
  });
  useEffect(
    () => onStatusChanged &&combineLatest(status, asrSession, (status, asrSession) => onStatusChanged?.(asrSession ? 'listening' : status)),
    [onStatusChanged, status, asrSession],
  );
  useEffect(() => {
    const { model, chatCompletionAddr, bearerToken } = openaiCompatibleLLM || {};
    session?.config({
      type: 'config',
      voice,
      ...(systemPrompt && {
        message_prefix: [
          {
            role: 'system',
            content: systemPrompt,
          },
        ],
      }),
      ...(asrModel && {
        asr_model: asrModel,
      }),
      ...(model && {
        llm_config: {model}
      }),
      ...(chatCompletionAddr && {
        llm_service: {
          provider: 'openai',
          endpoint: chatCompletionAddr,
          ...(bearerToken && {
            token: bearerToken,
          }),
        },
      }),
    });
  }, [session, videoId, voice, systemPrompt, asrModel, openaiCompatibleLLM?.model, openaiCompatibleLLM?.chatCompletionAddr, openaiCompatibleLLM?.bearerToken]);
  useEffect(() => onSessionStatusChanged && session?.on('statuschange', onSessionStatusChanged), [session, onSessionStatusChanged]);
  useEffect(() => {
    if (!containerRef.current) {
      console.error('containerRef.current is null');
      return;
    }
    const session = createDH2DSession(containerRef.current, { videoId, audioInput });
    const unsub = session.on('statuschange', (status) => {
      if (status === 'connected') {
        unsub();
        setTimeout(() => {
          const text = latestGreetingMsg();
          if (text) session.send({ type: 'wakeup', text });
        }, 5000);
      }
    });

    session.on('message', (message) => {
      if (message.type === 'status_change') {
        console.log('status_change', message.status);
        upstreamStatus.value = message.status;
        status.value = message.status;
      } else if (message.type === 'asr_session') {
        const { sentence } = message;
        if (sentence) {
          onAsrOutput?.(sentence);
          if (message.completed) {
            session.send({ type: interactionType(upstreamStatus.value), text: sentence });
            appendHistory({ role: 'user', content: sentence })
            status.value = 'talking';
          }
        } else if (message.completed) {
          status.value = 'sleeping';
        }
      } else if (message.type === 'audio_text') {
        onBotOutput?.(message.text);
      } else if (message.type === 'message_record') {
        appendHistory(message.message);
        if (message.message.role === 'user') {
          if (message.message.content.match(/.*(?:拜拜|再见|睡觉)(?:吧)?$/)) {
            session.send({ type: 'sleep' });
          }
        }
      }
    });
    setSession(session);
    return () => void session.close();
  }, [videoId, audioInput]);
  useKey(asrKey, (_) => {
    asrSession.value = _;
  });
  useEffect(() => {
    if (!session || !asrKey) return;
    let first = true;
    return asrSession.subscribe(asrSession => statusLock(async () => {
      if (first) {
        first = false;
        return;
      }
      if (asrSession && status.value !== 'sleeping') {
        session.send({ type: 'sleep' });
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 5000);
          const unsubscribe = status.subscribe((status) => {
            if (status === 'sleeping') {
              resolve();
              unsubscribe();
            }
          });
        });
      }
      session.send({
        type: 'asr_session',
        command: asrSession ? 'start' : 'stop',
      });
    }));
  }, [asrSession, session, status, asrKey, statusLock]);

  return <div style={style} ref={containerRef} />;
};

function useEvent<T extends (...args: any[]) => any>(
  handler: T,
): (...args: Parameters<T>) => ReturnType<T> {
  const handlerRef = useRef<T | null>(null);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  return useCallback((...args: Parameters<T>) => {
    const fn = handlerRef.current;
    if (fn === null) {
      throw new Error('Handler is null');
    }
    return fn(...args);
  }, []);
}

function useKey(key: string | undefined, callback: (down: boolean) => void) {
  const cb = useEvent(callback);
  useEffect(() => {
    if (typeof key !== 'string') return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === key) {
        cb(event.type === 'keydown');
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('keyup', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('keyup', handleKey);
    };
  }, [key]);
}

function asyncLock() {
  let released = Promise.resolve();
  
  return async function lock<T>(f: () => Promise<T>): Promise<T> {
    await released;
    let resolve: () => void;
    released = new Promise<void>(_ => resolve = _)
    return f().finally(() => resolve?.())
  }
}

function behaviorSubject<T>(value: T) {
  let v = value;
  let subscribers: ((_: T) => void)[] = [];
  return {
    get value() {
      return v;
    },
    set value(_v: T) {
      if (v !== _v) {
        v = _v;
        const invoking = [...subscribers];
        invoking.forEach((fn) => fn(v));
      }
    },
    subscribe(fn: (_: T) => void) {
      subscribers.push(fn);
      fn(v);
      return () => {
        subscribers = subscribers.filter((f) => f !== fn);
      };
    },
  };
}

function combineLatest<A, B>(
  a: ReturnType<typeof behaviorSubject<A>>,
  b: ReturnType<typeof behaviorSubject<B>>,
  cb: (a: A, b: B) => void,
): () => void {
  let aValue = a.value;
  let bValue = b.value;
  const publish = () => cb(aValue, bValue);
  const s1 = a.subscribe((_) => {
    if (aValue !== _) {
      aValue = _;
      publish();
    }
  });
  const s2 = b.subscribe((_) => {
    if (bValue !== _) {
      bValue = _;
      publish();
    }
  });
  publish();
  return () => (s1(), s2());
}

function interactionType(type: typeof DHStatus[number]) {
  switch (type) {
    case 'listening':
    case 'talking':
      return 'sleep';
    default:
      return 'wakeup';
  }
}

hooks.dh2d.getOrCreatePlayer = (
  (prev) =>
  (...args) => {
    const player = prev(...args);
    const { cover } = player;
    if (cover) {
      cover.style.filter = 'brightness(1.056) contrast(0.946)';
    }
    return player;
  }
)(hooks.dh2d.getOrCreatePlayer);
