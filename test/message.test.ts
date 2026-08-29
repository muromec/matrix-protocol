import { describe, it, expect } from 'vitest';
import { MatrixMessage } from '../src/message.ts';
import type { MatrixEvent } from '../src/client.ts';

function event(overrides: Partial<MatrixEvent> = {}): MatrixEvent {
  return {
    type: 'm.room.message',
    sender: '@alice:example.com',
    event_id: '$evt123',
    origin_server_ts: 1_700_000_000_000,
    room_id: '!room:example.com',
    content: { msgtype: 'm.text', body: 'hello' },
    ...overrides,
  };
}

describe('MatrixMessage.fromEvent', () => {
  it('parses sender, room, event id, and text', () => {
    const m = MatrixMessage.fromEvent(
      event({
        sender: '@alice:example.com',
        event_id: '$evt123',
        content: { msgtype: 'm.text', body: '  hi there  ' },
      }),
      '!room:example.com',
    );

    expect(m.inbound).toBe(true);
    expect(m.event).not.toBeNull();
    expect(m.from).toBe('@alice:example.com');
    expect(m.roomId).toBe('!room:example.com');
    expect(m.text).toBe('hi there');
    expect(m.headers).toEqual({
      sender: '@alice:example.com',
      roomId: '!room:example.com',
      eventId: '$evt123',
      originServerTs: 1_700_000_000_000,
      msgtype: 'm.text',
    });
  });

  it('defaults msgtype to m.unknown when absent', () => {
    const m = MatrixMessage.fromEvent(event({ content: { body: 'no msgtype' } }), '!r:ex.com');
    expect(m.headers.msgtype).toBe('m.unknown');
  });

  it('produces empty text when body is not a string', () => {
    const m = MatrixMessage.fromEvent(
      event({ content: { msgtype: 'm.text', body: 42 } }),
      '!r:ex.com',
    );
    expect(m.text).toBe('');
  });

  it('extracts html when format is org.matrix.custom.html', () => {
    const m = MatrixMessage.fromEvent(
      event({
        content: {
          msgtype: 'm.text',
          body: 'plain',
          format: 'org.matrix.custom.html',
          formatted_body: '<b>plain</b>',
        },
      }),
      '!r:ex.com',
    );
    expect(m.html).toBe('<b>plain</b>');
  });

  it('leaves html undefined when formatted_body is not a string', () => {
    const m = MatrixMessage.fromEvent(
      event({
        content: {
          msgtype: 'm.text',
          body: 'plain',
          format: 'org.matrix.custom.html',
          formatted_body: 123,
        },
      }),
      '!r:ex.com',
    );
    expect(m.html).toBeUndefined();
  });

  it('leaves html undefined when format is not html', () => {
    const m = MatrixMessage.fromEvent(
      event({ content: { msgtype: 'm.text', body: 'plain' } }),
      '!r:ex.com',
    );
    expect(m.html).toBeUndefined();
  });
});

describe('MatrixMessage.compose', () => {
  it('builds an outbound message', () => {
    const m = MatrixMessage.compose({ roomId: '!r:ex.com', body: 'hello back' });

    expect(m.inbound).toBe(false);
    expect(m.event).toBeNull();
    expect(m.from).toBe('');
    expect(m.text).toBe('hello back');
    expect(m.roomId).toBe('!r:ex.com');
    expect(m.headers.sender).toBe('');
    expect(m.headers.roomId).toBe('!r:ex.com');
    expect(m.headers.msgtype).toBe('m.text');
  });

  it('stores formattedBody and inReplyTo for later serialisation', () => {
    const m = MatrixMessage.compose({
      roomId: '!r:ex.com',
      body: 'reply text',
      formattedBody: '<b>reply</b>',
      inReplyTo: '$orig',
    });
    expect(m.toContent().format).toBe('org.matrix.custom.html');
  });
});

describe('MatrixMessage.toContent', () => {
  it('throws for inbound messages', () => {
    const m = MatrixMessage.fromEvent(event(), '!r:ex.com');
    expect(() => m.toContent()).toThrow('Cannot send an inbound message');
  });

  it('serialises a plain outbound message', () => {
    const m = MatrixMessage.compose({ roomId: '!r:ex.com', body: 'hello' });
    expect(m.toContent()).toEqual({ msgtype: 'm.text', body: 'hello' });
  });

  it('adds m.relates_to and a fallback body when replying', () => {
    const m = MatrixMessage.compose({
      roomId: '!r:ex.com',
      body: 'my reply',
      inReplyTo: '$orig123',
    });
    expect(m.toContent()).toEqual({
      msgtype: 'm.text',
      body: '> <$orig123>\n\nmy reply',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$orig123' } },
    });
  });

  it('adds html reply fallback when replying with formattedBody', () => {
    const m = MatrixMessage.compose({
      roomId: '!r:ex.com',
      body: 'my reply',
      formattedBody: '<b>reply</b>',
      inReplyTo: '$orig123',
    });
    const c = m.toContent();
    expect(c.format).toBe('org.matrix.custom.html');
    expect(c.formatted_body).toBe(
      '<mx-reply><blockquote><a href="https://matrix.to/#/.../$orig123">In reply to</a></blockquote></mx-reply><b>reply</b>',
    );
    expect(c['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$orig123' } });
  });

  it('includes html without reply when only formattedBody is set', () => {
    const m = MatrixMessage.compose({
      roomId: '!r:ex.com',
      body: 'hello',
      formattedBody: '<b>hello</b>',
    });
    const c = m.toContent();
    expect(c.format).toBe('org.matrix.custom.html');
    expect(c.formatted_body).toBe('<b>hello</b>');
    expect(c['m.relates_to']).toBeUndefined();
  });
});

describe('MatrixMessage.reply', () => {
  it('pre-fills roomId and inReplyTo from the inbound message', () => {
    const orig = MatrixMessage.fromEvent(
      event({ event_id: '$orig', content: { msgtype: 'm.text', body: 'original' } }),
      '!r:ex.com',
    );
    const reply = orig.reply({ body: 'a reply' });
    expect(reply.inbound).toBe(false);
    expect(reply.roomId).toBe('!r:ex.com');
    expect(reply.toContent()['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$orig' } });
  });

  it('throws when called on an outbound message', () => {
    const m = MatrixMessage.compose({ roomId: '!r:ex.com', body: 'hi' });
    expect(() => m.reply({ body: 'nope' })).toThrow('Can only reply to inbound messages');
  });
});

describe('MatrixMessage.logString', () => {
  it('renders inbound sender/room/event/msgtype plus text', () => {
    const m = MatrixMessage.fromEvent(
      event({
        sender: '@alice:example.com',
        event_id: '$evt',
        content: { msgtype: 'm.text', body: 'hello world' },
      }),
      '!r:ex.com',
    );
    const s = m.logString;
    expect(s).toContain('Sender:  @alice:example.com');
    expect(s).toContain('Room:    !r:ex.com');
    expect(s).toContain('Event:   $evt');
    expect(s).toContain('MsgType: m.text');
    expect(s).toContain('hello world');
  });

  it('omits the body block when text is empty', () => {
    const m = MatrixMessage.fromEvent(
      event({ content: { msgtype: 'm.text', body: '' } }),
      '!r:ex.com',
    );
    expect(m.logString).toBe(
      'Sender:  @alice:example.com\nRoom:    !r:ex.com\nEvent:   $evt123\nMsgType: m.text',
    );
  });

  it('renders outbound room and reply-to', () => {
    const m = MatrixMessage.compose({ roomId: '!r:ex.com', body: 'hi', inReplyTo: '$orig' });
    const s = m.logString;
    expect(s).toContain('Room:    !r:ex.com');
    expect(s).toContain('ReplyTo: $orig');
    expect(s).toContain('hi');
  });

  it('renders outbound room without reply-to', () => {
    const m = MatrixMessage.compose({ roomId: '!r:ex.com', body: 'hi' });
    expect(m.logString).toBe('Room:    !r:ex.com\n\nhi');
  });
});
