import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, CommandEnvelope, RoomView, ServerMessage } from '../shared/protocol';
import { commandId } from './commandId';

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'superseded';

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error?.message === 'string' ? value.error.message : typeof value.error === 'string' ? value.error : 'The connection could not be completed. Please try again.');
  return value as T;
}

/** Identity stays in the HttpOnly server cookie. Only a room locator is stored locally. */
export function useRoom(code: string | null) {
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingTypes, setPendingTypes] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const viewRef = useRef<RoomView | null>(null);
  const pending = useRef(new Map<string, CommandEnvelope>());
  const publishPending = () => setPendingTypes([...pending.current.values()].map(c => c.action.type));

  useEffect(() => {
    setView(null);
    viewRef.current = null;
    ready.current = false;
    pending.current.clear();
    publishPending();
    setError(null);
    if (!code) { setConnection('idle'); return; }
    let disposed = false;
    let fenced = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let activeSocket: WebSocket | null = null;

    function connect() {
      if (disposed || fenced) return;
      setConnection(attempt ? 'reconnecting' : 'connecting');
      ready.current = false;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${encodeURIComponent(code!)}/socket`);
      socket.current = ws;
      activeSocket = ws;
      let firstSnapshot = true;
      let version = -1;
      ws.onmessage = event => {
        if (disposed || ws !== activeSocket) return;
        let message: ServerMessage;
        try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { setError('An unreadable server update was received. Reconnecting will restore the room.'); return; }
        if (message.type === 'snapshot') {
          if (!firstSnapshot && message.viewVersion < version) return;
          version = message.viewVersion;
          setOffset(message.serverTime - Date.now());
          viewRef.current = message.view;
          ready.current = true;
          setView(message.view);
          setConnection('online');
          attempt = 0;
          if (firstSnapshot) {
            firstSnapshot = false;
            // Replay the original envelopes: the server's persisted receipts prevent duplicate effects.
            for (const envelope of pending.current.values()) ws.send(JSON.stringify(envelope));
          }
        } else if (message.type === 'ack') {
          if (pending.current.delete(message.commandId)) publishPending();
          if (!message.ok) setError(message.error?.message ?? 'That action could not be accepted.');
        } else if (message.type === 'superseded') {
          fenced = true;
          ready.current = false;
          setConnection('superseded');
          pending.current.clear();
          publishPending();
          ws.close();
        } else if (message.type === 'error') setError(message.message);
      };
      ws.onclose = () => {
        if (disposed || fenced || ws !== activeSocket) return;
        ready.current = false;
        setConnection('reconnecting');
        attempt++;
        const delay = Math.min(12000, 500 * 2 ** Math.min(attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { /* onclose schedules the bounded retry. */ };
    }
    connect();
    return () => { disposed = true; clearTimeout(retryTimer); activeSocket?.close(); socket.current = null; };
  }, [code, retryKey]);

  const send = useCallback((action: Action) => {
    const current = viewRef.current;
    if (!current || !ready.current || socket.current?.readyState !== WebSocket.OPEN) { setError('Wait for your connection to return before submitting an action.'); return false; }
    if (action.type !== 'survival_input' && [...pending.current.values()].some(p => p.action.type === action.type)) return false;
    const command: CommandEnvelope = { commandId: commandId(), gameId: current.survival?.id ?? current.game?.id ?? null, phaseId: current.survival ? null : current.game?.phase.id ?? null, action };
    // Continuous movement is replaceable intent, never replayed after reconnect.
    // Purchases and other durable actions retain their original IDs for deduplication.
    if (action.type !== 'survival_input') { pending.current.set(command.commandId, command); publishPending(); }
    socket.current.send(JSON.stringify(command));
    return true;
  }, []);

  return { view, connection, error, dismissError: () => setError(null), send, pendingTypes, serverOffset: offset, reconnect: () => setRetryKey(k => k + 1) };
}
