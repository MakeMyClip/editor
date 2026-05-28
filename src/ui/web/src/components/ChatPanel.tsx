import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { type FormEvent, useEffect, useRef, useState } from 'react';

/**
 * Chat sidebar — talks to /api/chat (AI SDK + Anthropic). The agent can call
 * the same tools the forms call; each tool execution appends to session.json
 * exactly like a UI-driven op, so the OpList and Timeline update via the
 * normal 2-second poll. `onAgentTurnComplete` is an additional kick to
 * refresh immediately after a streaming response ends.
 */
export function ChatPanel({
  onAgentTurnComplete,
  onClose,
}: {
  onAgentTurnComplete: () => void;
  onClose: () => void;
}) {
  // useChat must mount with the final initial-messages list to avoid a
  // double-render that would create a fresh empty chat first. We load
  // history once, then mount the inner component with the real seed.
  const [initial, setInitial] = useState<UIMessage[] | null>(null);

  useEffect(() => {
    fetch('/api/chat')
      .then((r) => r.json() as Promise<{ messages: UIMessage[] }>)
      .then((d) => setInitial(d.messages ?? []))
      .catch(() => setInitial([]));
  }, []);

  return (
    <aside className="chat-panel" aria-label="Chat with the editor">
      <header className="chat-panel-header">
        <h2>Chat</h2>
        <button
          type="button"
          className="chat-close"
          onClick={onClose}
          aria-label="Close chat"
          title="Close chat"
        >
          ×
        </button>
      </header>
      {initial === null ? (
        <div className="chat-loading">Loading…</div>
      ) : (
        <ChatPanelInner initial={initial} onAgentTurnComplete={onAgentTurnComplete} />
      )}
    </aside>
  );
}

function ChatPanelInner({
  initial,
  onAgentTurnComplete,
}: {
  initial: UIMessage[];
  onAgentTurnComplete: () => void;
}) {
  const { messages, sendMessage, status, error, setMessages } = useChat({
    messages: initial,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    onFinish: () => {
      // Trigger a session refresh after every agent turn so tool calls
      // surface in the OpList / Timeline immediately.
      onAgentTurnComplete();
    },
  });

  const [input, setInput] = useState('');
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on every messages / status change. The deps are
  // listed for their trigger-on-change effect, not to read in the body —
  // biome flags this as "unused" but removing them breaks auto-scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive re-run on change
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || status === 'streaming' || status === 'submitted') return;
    setInput('');
    void sendMessage({ text });
  }

  async function handleClear() {
    if (!window.confirm('Clear chat history?')) return;
    try {
      await fetch('/api/chat', { method: 'DELETE' });
    } catch {
      // Network failures are non-blocking — local state is the source of truth
      // for the next render either way.
    }
    setMessages([]);
  }

  const busy = status === 'streaming' || status === 'submitted';

  return (
    <>
      <div className="chat-toolbar">
        {messages.length > 0 ? (
          <button
            type="button"
            className="chat-clear"
            onClick={handleClear}
            disabled={busy}
            title="Clear conversation"
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>Ask the agent to do editing work.</p>
            <ul>
              <li>"Trim the first ingested clip to seconds 5–20."</li>
              <li>"Concat the last three trims with a 0.4s fade."</li>
              <li>"Add a black title card saying 'Demo' before clip 1."</li>
            </ul>
          </div>
        ) : (
          messages.map((msg) => <ChatMessage key={msg.id} msg={msg} />)
        )}
        {busy ? <div className="chat-busy">Thinking…</div> : null}
        <div ref={scrollEndRef} />
      </div>
      {error ? <ChatError error={error} /> : null}
      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends; plain Enter inserts a newline (matches the
            // pattern of agent chat UIs people are used to).
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit(e as unknown as FormEvent);
            }
          }}
          placeholder="Tell the agent what to edit…"
          rows={3}
          disabled={busy}
        />
        <button type="submit" className="btn-primary chat-send" disabled={busy || !input.trim()}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </>
  );
}

function ChatMessage({ msg }: { msg: UIMessage }) {
  return (
    <div className={`chat-msg chat-msg-${msg.role}`}>
      <div className="chat-msg-role">{msg.role}</div>
      <div className="chat-msg-body">
        {msg.parts.map((part, i) => {
          // Parts are append-only and order-stable per message, so composing
          // the key from `${msg.id}-${i}-${part.type}` keeps it unique
          // without breaking the no-array-index rule.
          const key = `${msg.id}-${i}-${part.type}`;
          if (part.type === 'text') {
            return (
              <div className="chat-part-text" key={key}>
                {part.text}
              </div>
            );
          }
          if (part.type === 'reasoning') {
            return (
              <details className="chat-part-reasoning" key={key}>
                <summary>thinking</summary>
                <div>{part.text}</div>
              </details>
            );
          }
          if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
            return <ToolCallPart key={key} part={part as ToolPartLike} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

/**
 * Minimal shape we care about from a tool-* UI part. The full discriminated
 * union is heavy; we narrow to the bits that drive rendering.
 */
interface ToolPartLike {
  type: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolCallId?: string;
}

function ToolCallPart({ part }: { part: ToolPartLike }) {
  const toolName = part.type.slice('tool-'.length);
  const stateLabel =
    part.state === 'input-streaming'
      ? 'preparing'
      : part.state === 'input-available'
        ? 'running'
        : part.state === 'output-available'
          ? 'done'
          : 'error';

  return (
    <div className={`chat-tool chat-tool-${part.state}`}>
      <div className="chat-tool-head">
        <span className="chat-tool-name">{toolName}</span>
        <span className="chat-tool-state">{stateLabel}</span>
      </div>
      {part.input ? (
        <details className="chat-tool-detail">
          <summary>args</summary>
          <pre>{JSON.stringify(part.input, null, 2)}</pre>
        </details>
      ) : null}
      {part.state === 'output-available' && part.output ? (
        <details className="chat-tool-detail">
          <summary>result</summary>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </details>
      ) : null}
      {part.state === 'output-error' && part.errorText ? (
        <div className="chat-tool-error">{part.errorText}</div>
      ) : null}
    </div>
  );
}

function ChatError({ error }: { error: Error }) {
  // Server returns 400 with a structured error when ANTHROPIC_API_KEY is
  // missing — the AI SDK surfaces it via this `error`. We detect the
  // specific message and show a friendlier setup banner.
  const looksLikeMissingKey = /ANTHROPIC_API_KEY/i.test(error.message);
  return (
    <div className="chat-error">
      {looksLikeMissingKey ? (
        <>
          <strong>Set up Anthropic to enable chat.</strong>
          <p>
            Export <code>ANTHROPIC_API_KEY</code> in the shell that runs <code>clip ui</code>, then
            restart.
          </p>
        </>
      ) : (
        <>
          <strong>Chat error.</strong>
          <p>{error.message}</p>
        </>
      )}
    </div>
  );
}
