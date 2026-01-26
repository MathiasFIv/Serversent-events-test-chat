import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

function App() {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('disconnected')
  const listRef = useRef(null)

  const canSend = useMemo(() => draft.trim().length > 0, [draft])

  useEffect(() => {
    // Connect to the SSE endpoint.
    const es = new EventSource('/thechat/stream')

    es.onopen = () => setStatus('connected')

    // Server sends: `data: <content>\n\n`
    es.onmessage = (evt) => {
      const content = (evt?.data ?? '').toString()
      if (!content) return
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), content }])
    }

    es.onerror = () => {
      // EventSource will retry automatically.
      setStatus('reconnecting')
    }

    return () => {
      es.close()
      setStatus('disconnected')
    }
  }, [])

  useEffect(() => {
    // Auto-scroll to latest message.
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  async function sendMessage() {
    const content = draft.trim()
    if (!content) return

    setDraft('')

    const res = await fetch('/thechat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Send failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Chat (SSE demo)</h1>
        <div className="status" data-status={status}>
          {status}
        </div>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty">No messages yet. Send one below.</div>
        ) : (
          messages.map((m) => (
            <div className="message" key={m.id}>
              {m.content}
            </div>
          ))
        )}
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
          onChange={(e) => setDraft(e.target.value)}
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
