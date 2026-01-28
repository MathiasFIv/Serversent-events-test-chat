import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const LS_USER_ID = 'ssedemo.userId'
const LS_USERNAME = 'ssedemo.username'

function getOrCreateUserId() {
  const existing = localStorage.getItem(LS_USER_ID)
  if (existing) return existing
  const id = crypto.randomUUID().replaceAll('-', '')
  localStorage.setItem(LS_USER_ID, id)
  return id
}

function getOrAskUsername() {
  const existing = localStorage.getItem(LS_USERNAME)
  if (existing) return existing

  let name = ''
  while (!name) {
    name = (prompt('Pick a username:') ?? '').trim()
  }
  localStorage.setItem(LS_USERNAME, name)
  return name
}

function App() {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('disconnected')
  const [me, setMe] = useState(() => ({ userId: getOrCreateUserId(), username: getOrAskUsername() }))

  // userId -> { username, expiresAtMs }
  const [typingUsers, setTypingUsers] = useState({})

  const listRef = useRef(null)

  const lastTypingPingAtMsRef = useRef(0)
  const lastInputAtMsRef = useRef(0)
  const isLocallyTypingRef = useRef(false)

  const canSend = useMemo(() => draft.trim().length > 0, [draft])

  useEffect(() => {
    const params = new URLSearchParams({ userId: me.userId, username: me.username })

    // Connect to the SSE endpoint with identity.
    const es = new EventSource(`/thechat/stream?${params.toString()}`)

    es.onopen = () => setStatus('connected')

    es.addEventListener('hello', (evt) => {
      try {
        const data = JSON.parse(evt.data)
        // Server echoes what it accepted; keep ours in sync.
        if (data?.userId && data?.username) {
          localStorage.setItem(LS_USER_ID, data.userId)
          localStorage.setItem(LS_USERNAME, data.username)
          setMe({ userId: data.userId, username: data.username })
        }
      } catch {
        // ignore
      }
    })

    es.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data)
        if (!data?.content) return
        setMessages((prev) => [
          ...prev,
          {
            id: data.id ?? crypto.randomUUID(),
            from: data.from ?? 'Unknown',
            content: data.content,
            ts: data.ts ?? null,
          },
        ])
      } catch {
        // ignore malformed events
      }
    })

    es.addEventListener('typing', (evt) => {
      try {
        const data = JSON.parse(evt.data)
        const userId = (data?.userId ?? '').toString()
        const username = (data?.username ?? '').toString()
        const isTyping = !!data?.isTyping
        const expiresInMs = Number(data?.expiresInMs ?? 2000)

        if (!userId || userId === me.userId) return

        setTypingUsers((prev) => {
          const next = { ...prev }
          if (!isTyping) {
            delete next[userId]
            return next
          }

          next[userId] = {
            username: username || 'Someone',
            expiresAtMs: Date.now() + (Number.isFinite(expiresInMs) ? expiresInMs : 2000),
          }
          return next
        })
      } catch {
        // ignore
      }
    })

    es.onerror = () => {
      // EventSource will retry automatically.
      setStatus('reconnecting')
    }

    return () => {
      es.close()
      setStatus('disconnected')
    }
  }, [me.userId, me.username])

  useEffect(() => {
    // Auto-scroll to latest message.
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  useEffect(() => {
    // Cleanup typing users locally in case we miss a stop event.
    const t = setInterval(() => {
      const now = Date.now()
      setTypingUsers((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [userId, info] of Object.entries(next)) {
          if (!info?.expiresAtMs || info.expiresAtMs <= now) {
            delete next[userId]
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 250)

    return () => clearInterval(t)
  }, [])

  async function sendTypingPing() {
    const res = await fetch('/thechat/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: me.userId }),
    })

    if (!res.ok) {
      console.warn('typing ping failed', res.status)
    }
  }

  // Keepalive loop: if we're in a typing session, ping every ~2.5s.
  useEffect(() => {
    const pingEveryMs = 2500
    const considerActiveForMs = 4000 // must be > pingEveryMs to avoid gaps due to timer jitter

    const t = setInterval(() => {
      const now = Date.now()

      // Only keepalive if we still have content AND recent edits.
      const hasDraft = draft.trim().length > 0
      const recentlyEdited = now - lastInputAtMsRef.current < considerActiveForMs

      if (!hasDraft || !recentlyEdited) {
        isLocallyTypingRef.current = false
        return
      }

      // Ensure we've marked ourselves as typing (immediate ping might have been skipped)
      if (!isLocallyTypingRef.current) {
        isLocallyTypingRef.current = true
        lastTypingPingAtMsRef.current = now
        sendTypingPing().catch(() => {})
        return
      }

      // Regular keepalive pings
      if (now - lastTypingPingAtMsRef.current >= pingEveryMs) {
        lastTypingPingAtMsRef.current = now
        sendTypingPing().catch(() => {})
      }
    }, 250)

    return () => clearInterval(t)
  }, [draft])

  function onDraftChanged(value) {
    const now = Date.now()
    lastInputAtMsRef.current = now
    setDraft(value)

    const hasDraft = value.trim().length > 0

    // If the draft was cleared, reset local typing session so starting over re-triggers.
    if (!hasDraft) {
      isLocallyTypingRef.current = false
      return
    }

    // If we're starting typing (wasn't typing before), ping immediately.
    if (!isLocallyTypingRef.current) {
      isLocallyTypingRef.current = true
      lastTypingPingAtMsRef.current = now
      sendTypingPing().catch(() => {})
      return
    }

    // Otherwise, we already have a typing session; no need to ping on every keystroke.
    // The keepalive loop will ping every ~2.5s.
  }

  async function sendMessage() {
    const content = draft.trim()
    if (!content) return

    setDraft('')

    const res = await fetch(`/thechat/send?userId=${encodeURIComponent(me.userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Send failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`)
    }
  }

  const typingLine = useMemo(() => {
    const entries = Object.values(typingUsers)
      .map((x) => x?.username)
      .filter(Boolean)

    if (entries.length === 0) return null
    if (entries.length === 1) return `${entries[0]} is typing…`
    if (entries.length === 2) return `${entries[0]} and ${entries[1]} are typing…`
    return `${entries.slice(0, 2).join(', ')} and ${entries.length - 2} others are typing…`
  }, [typingUsers])

  return (
    <div className="app">
      <header className="header">
        <h1>CHAT</h1>
        <div className="status" data-status={status}>
          {status}
        </div>
        <div className="status">You: {me.username}</div>
      </header>

      <div className="messages" ref={listRef}>
        <div className="messages-scroll">
          {messages.length === 0 ? (
            <div className="empty">No messages yet. Send one below.</div>
          ) : (
            messages.map((m) => (
              <div className="message" key={m.id}>
                <strong>{m.from}: </strong>
                {m.content}
              </div>
            ))
          )}
        </div>

        {/* Typing indicator lives INSIDE the chat window, pinned to the bottom. */}
        {typingLine ? (
          <div className="typing-indicator" aria-live="polite">
            {typingLine}
          </div>
        ) : null}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          sendMessage().catch((err) => {
            console.error(err)
            alert(err.message)
          })
        }}
      >
        <input
          value={draft}
          onChange={(e) => onDraftChanged(e.target.value)}
          placeholder="Type a message..."
          aria-label="Message"
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  )
}

export default App
