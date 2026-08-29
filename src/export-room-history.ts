// ── Matrix Room Exporter ──────────────────────────────────────────────────
//
// Exports room-message history from a Matrix homeserver to stdout as JSON
// Lines.  Library form: import `main` or `parseArgs`.  The CLI shim lives in
// `export-room-history-cli.ts` (wired as the `matrix-export-room-history` bin).
//
// Usage (CLI):
//   matrix-export-room-history \
//     --baseUrl https://matrix.example.com \
//     --userId @butler:example.com \
//     --password <password> \
//     --roomId '!abc123:example.com' \
//     [--from <cursor>] \
//     [--limit 100]
//
// Output: one JSON object per line on stdout.  Progress on stderr.

import { MatrixError } from './client.ts';

export interface Args {
  baseUrl: string;
  userId: string;
  password: string;
  roomId: string;
  from?: string;
  limit: number;
  direction: 'b' | 'f';
}

export function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }

  if (!args.baseUrl || !args.userId || !args.password || !args.roomId) {
    throw new Error(
      'Usage: matrix-export-room-history \\\n' +
        '  --baseUrl <url> --userId <mxid> --password <pw> --roomId <id> \\\n' +
        '  [--from <cursor>] [--limit <N>] [--direction b|f]',
    );
  }

  return {
    baseUrl: args.baseUrl,
    userId: args.userId,
    password: args.password,
    roomId: args.roomId,
    from: args.from,
    limit: parseInt(args.limit || '100', 10),
    direction: (args.direction as 'b' | 'f') || 'b',
  };
}

async function request(
  method: string,
  url: string,
  body: unknown,
  accessToken: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new MatrixError(
        resp.status,
        'M_UNKNOWN',
        `HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
        errBody,
      );
    }

    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // 1. Login.
  console.error(`Logging in as ${args.userId}...`);
  const loginResp = (await request(
    'POST',
    `${args.baseUrl}/_matrix/client/v3/login`,
    {
      type: 'm.login.password',
      user: args.userId,
      password: args.password,
      initial_device_display_name: 'export-script',
    },
    '',
  )) as { access_token: string; device_id: string; user_id: string };

  const token = loginResp.access_token;

  // 2. Fetch messages.
  console.error(
    `Fetching room ${args.roomId} (limit ${args.limit}, dir ${args.direction}${args.from ? ', from ' + args.from.slice(0, 8) + '...' : ''})...`,
  );

  let from = args.from;
  let fetched = 0;
  let end: string | undefined;

  while (fetched < args.limit) {
    const remaining = Math.min(args.limit - fetched, 1000);

    const url = new URL(
      `${args.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(args.roomId)}/messages`,
    );
    url.searchParams.set('dir', args.direction);
    url.searchParams.set('limit', String(remaining));
    if (from) url.searchParams.set('from', from);

    const resp = (await request('GET', url.toString(), null, token)) as {
      chunk: unknown[];
      start: string;
      end: string;
    };

    for (const event of resp.chunk) {
      console.log(JSON.stringify(event));
      fetched++;
    }

    end = resp.end;
    from = resp.end;

    if (resp.chunk.length < remaining) break; // no more messages
    console.error(`  fetched ${fetched} / ${args.limit}...`);
  }

  console.error(`Done. ${fetched} messages. End cursor: ${end || 'none'}`);
}
