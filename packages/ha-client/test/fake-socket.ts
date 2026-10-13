import type { WebSocketLike } from '../src/connection.ts';

/** A stand-in WebSocket that records what the client sends and lets a test play the server. */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('No socket was opened');
    return socket;
  }

  readonly url: string;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // --- Server side ---

  open(haVersion = '2026.10.0'): void {
    this.readyState = 1;
    this.onopen?.({});
    this.receive({ type: 'auth_required', ha_version: haVersion });
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Opens the socket and accepts the token the client sends. */
  async acceptAuth(haVersion = '2026.10.0'): Promise<void> {
    this.open(haVersion);
    await flush();
    const auth = this.sent.find((message) => message.type === 'auth');
    if (!auth) throw new Error('Client did not authenticate');
    this.receive({ type: 'auth_ok', ha_version: haVersion });
  }

  /** The server dropping the connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  lastSent(type: string): Record<string, unknown> & { id: number } {
    const message = this.sent.findLast((item) => item.type === type);
    if (!message) throw new Error(`Client never sent ${type}`);
    return message as Record<string, unknown> & { id: number };
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((item) => item.type === type);
  }

  reply(type: string, result: unknown = null): void {
    this.receive({ id: this.lastSent(type).id, type: 'result', success: true, result });
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
