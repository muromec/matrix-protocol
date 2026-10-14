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

/**
 * A file a message carries: where the bytes are, and what the far side said about them.
 *
 * Nothing here is trusted.  The name is text the sender chose, the type and size are its claims,
 * and the bytes are only fetched when the consumer decides to.
 */
export interface MediaRef {
  /** The `mxc://` URL the bytes are fetched from — with this client's own token. */
  url: string;
  /** The filename as the far side sent it. */
  name: string;
  /** The declared MIME type, or `application/octet-stream` when the event did not say. */
  mime: string;
  /** The declared size in bytes, when the event said. */
  size: number | undefined;
}

/**
 * The msgtypes that carry a file rather than (or beside) text.
 *
 * A watcher that keeps only `m.text` and `m.notice` never sees a screenshot: the file is dropped
 * before it becomes a message, and nothing downstream can tell that anything was there.
 */
export function isMediaMessageType(msgtype: string | undefined): boolean {
  return (
    msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio' || msgtype === 'm.video'
  );
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

  /** The file this message carries, when it carries one. */
  readonly media: MediaRef | undefined;

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
    this.media = undefined;
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

    // A media message: the bytes live behind an mxc URL that only this client's token can open.
    // An encrypted file (`content.file`) is left alone, because its key is not ours to use —
    // the same wall the room's text meets.
    const url = typeof content.url === 'string' ? content.url : '';
    if (url.startsWith('mxc://')) {
      const info = (content.info ?? {}) as { mimetype?: unknown; size?: unknown };
      const filename = typeof content.filename === 'string' ? content.filename : '';
      (self as { media: MediaRef | undefined }).media = {
        url,
        name: filename || body,
        mime: typeof info.mimetype === 'string' ? info.mimetype : 'application/octet-stream',
        size: typeof info.size === 'number' ? info.size : undefined,
      };
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
