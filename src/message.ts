// ── MatrixMessage ──────────────────────────────────────────────────────────
//
// Wraps a Matrix m.room.message event into a simple object that mirrors
// the EmailMessage interface where it matters for the agent pipeline:
//
//   - `from`          — sender MXID (maps to EmailMessage.from)
//   - `text`          — plain-text body (maps to EmailMessage.text)
//   - `roomId`        — room the message came from (Matrix-specific)
//   - `eventId`       — event ID (Matrix-specific; maps to Message-ID)
//   - `threadRoot`    — the room ID acts as the thread root for routing
//   - `reply()`       — build a reply message for the same room
//   - `logString`     — compact log representation
//
// Unlike EmailMessage, there's no async parsing step — Matrix events are
// already structured JSON.  Construction is always synchronous.

import type { MatrixEvent } from './client.ts';

// ── types ──────────────────────────────────────────────────────────────────

export interface MatrixMessageHeaders {
  sender: string;
  roomId: string;
  eventId: string;
  originServerTs: number;
  msgtype: string;
}

export interface OutgoingMatrixMessage {
  roomId: string;
  body: string;
  /** If truthy, send as HTML with the given formatted_body. */
  formattedBody?: string;
  /** Event ID this is a reply to (used for rich-reply fallback). */
  inReplyTo?: string;
}

// ── MatrixMessage ──────────────────────────────────────────────────────────

export class MatrixMessage {
  readonly inbound: boolean;
  readonly event: MatrixEvent | null;

  /** Parsed headers (always available). */
  readonly headers: MatrixMessageHeaders;

  /** Plain-text body. */
  readonly text: string;

  /** HTML formatted body, if present. */
  readonly html: string | undefined;

  /** Sender MXID. Mirrors EmailMessage.from. */
  readonly from: string;

  // Outbound-only fields.
  #outboundRoomId: string;
  #outboundBody: string;
  #outboundFormattedBody: string | undefined;
  #outboundInReplyTo: string | undefined;

  private constructor() {
    this.inbound = false;
    this.event = null;
    this.headers = {} as MatrixMessageHeaders;
    this.text = '';
    this.html = undefined;
    this.from = '';
    this.#outboundRoomId = '';
    this.#outboundBody = '';
  }

  // ── constructors ────────────────────────────────────────────────────────

  /**
   * Parse an inbound Matrix event into a MatrixMessage.
   *
   * Only `m.room.message` events with `msgtype: "m.text"` or
   * `msgtype: "m.notice"` are meaningful for an agent.  Other event
   * types or msgtypes will still parse but `text` will be empty.
   */
  /**
   * @param event  Raw Matrix timeline event.
   * @param roomId Room ID this event belongs to.  Timeline events don't
   *               carry `room_id` themselves (it's implied by the parent
   *               room key in the /sync response), so the caller must
   *               supply it.
   */
  static fromEvent(event: MatrixEvent, roomId: string): MatrixMessage {
    const self = new MatrixMessage();
    (self as { inbound: boolean }).inbound = true;
    (self as { event: MatrixEvent }).event = event;

    const content = event.content ?? {};

    (self as { headers: MatrixMessageHeaders }).headers = {
      sender: event.sender,
      roomId,
      eventId: event.event_id,
      originServerTs: event.origin_server_ts,
      msgtype: (content.msgtype as string) ?? 'm.unknown',
    };

    (self as { from: string }).from = event.sender;

    // Extract plain-text body.
    const body = typeof content.body === 'string' ? content.body.trim() : '';
    (self as { text: string }).text = body;

    // Extract HTML formatted body if present.
    const format = content.format as string | undefined;
    const formattedBody = content.formatted_body as string | undefined;
    if (format === 'org.matrix.custom.html' && typeof formattedBody === 'string') {
      (self as { html: string | undefined }).html = formattedBody;
    } else {
      (self as { html: string | undefined }).html = undefined;
    }

    return self;
  }

  /**
   * Compose an outbound Matrix message (for sending).
   */
  static compose(opts: OutgoingMatrixMessage): MatrixMessage {
    const self = new MatrixMessage();
    (self as { inbound: boolean }).inbound = false;
    (self as { event: MatrixEvent | null }).event = null;
    self.#outboundRoomId = opts.roomId;
    self.#outboundBody = opts.body;
    self.#outboundFormattedBody = opts.formattedBody;
    self.#outboundInReplyTo = opts.inReplyTo;

    (self as { text: string }).text = opts.body;
    (self as { from: string }).from = ''; // outbound messages have no sender
    (self as { headers: MatrixMessageHeaders }).headers = {
      sender: '',
      roomId: opts.roomId,
      eventId: '',
      originServerTs: Date.now(),
      msgtype: 'm.text',
    };

    return self;
  }

  // ── accessors ───────────────────────────────────────────────────────────

  /** Room ID (always available). */
  get roomId(): string {
    return this.inbound ? this.headers.roomId : this.#outboundRoomId;
  }

  /** Build the JSON content dict for PUT /send. */
  toContent(): Record<string, unknown> {
    if (this.inbound) {
      throw new Error('Cannot send an inbound message — use compose() instead');
    }

    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: this.#outboundBody,
    };

    // Rich reply: include m.in_reply_to fallback and formatted_body.
    if (this.#outboundInReplyTo) {
      content['m.relates_to'] = {
        'm.in_reply_to': { event_id: this.#outboundInReplyTo },
      };

      // Build a quoted fallback body (Matrix clients strip this out).
      const fallbackBody = `> <${this.#outboundInReplyTo}>\n\n${this.#outboundBody}`;
      content.body = fallbackBody;

      if (this.#outboundFormattedBody) {
        content.format = 'org.matrix.custom.html';
        content.formatted_body = `<mx-reply><blockquote><a href="https://matrix.to/#/.../${this.#outboundInReplyTo}">In reply to</a></blockquote></mx-reply>${this.#outboundFormattedBody}`;
      }
    } else if (this.#outboundFormattedBody) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = this.#outboundFormattedBody;
    }

    return content;
  }

  /**
   * Build a reply to this message.  Pre-fills `roomId` and
   * `inReplyTo` from the inbound message.
   */
  reply(opts: { body: string; formattedBody?: string }): MatrixMessage {
    if (!this.inbound || !this.event) {
      throw new Error('Can only reply to inbound messages');
    }
    return MatrixMessage.compose({
      roomId: this.roomId,
      body: opts.body,
      formattedBody: opts.formattedBody,
      inReplyTo: this.event.event_id,
    });
  }

  // ── logging ─────────────────────────────────────────────────────────────

  /**
   * Compact log representation — mirrors EmailMessage.logString.
   */
  get logString(): string {
    const h = this.headers;
    const lines: string[] = [];

    if (this.inbound) {
      lines.push(`Sender:  ${h.sender}`);
      lines.push(`Room:    ${h.roomId}`);
      lines.push(`Event:   ${h.eventId}`);
      lines.push(`MsgType: ${h.msgtype}`);
    } else {
      lines.push(`Room:    ${this.#outboundRoomId}`);
      if (this.#outboundInReplyTo) {
        lines.push(`ReplyTo: ${this.#outboundInReplyTo}`);
      }
    }

    if (this.text) {
      lines.push('');
      lines.push(this.text);
    }

    return lines.join('\n');
  }
}
