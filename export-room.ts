#!/usr/bin/env bun
// ── Matrix Room Exporter ──────────────────────────────────────────────────
//
// Standalone script: dumps raw Matrix room messages to stdout as JSON Lines.
// Uses the vendored MatrixClient directly — no persona system dependency.
//
// Usage:
//   bun run vendored/matrix-connector/export-room.ts \
//     --baseUrl https://matrix.example.com \
//     --userId @butler:example.com \
//     --password <password> \
//     --roomId '!abc123:example.com' \
//     [--from <cursor>] \
//     [--limit 100]
//
// Output: one JSON object per line on stdout.  Progress on stderr.

import { MatrixClient, MatrixError } from './client.ts';

interface Args {
  baseUrl: string;
  userId: string;
  password: string;
  roomId: string;
  from?: string;
  limit: number;
  direction: 'b' | 'f';
}

function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2);
      const val = process.argv[i + 1];
      if (val && !val.startsWith('--')) {
        args[key] = val;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }

  if (!args.baseUrl || !args.userId || !args.password || !args.roomId) {
    console.error('Usage: bun run export-room.ts \\');
    console.error('  --baseUrl <url> --userId <mxid> --password <pw> --roomId <id> \\');
    console.error('  [--from <cursor>] [--limit <N>] [--direction b|f]');
    process.exit(1);
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
        `HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
        'M_UNKNOWN',
        resp.status,
      );
    }

    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs();

  // 1. Login.
  console.error(`Logging in as ${args.userId}...`);
  const loginResp = await request(
    'POST',
    `${args.baseUrl}/_matrix/client/v3/login`,
    {
      type: 'm.login.password',
      user: args.userId,
      password: args.password,
      initial_device_display_name: 'export-script',
    },
    '', // no token yet
  ) as { access_token: string; device_id: string; user_id: string };

  const token = loginResp.access_token;

  // 2. Fetch messages.
  console.error(`Fetching room ${args.roomId} (limit ${args.limit}, dir ${args.direction}${args.from ? ', from ' + args.from.slice(0, 8) + '...' : ''})...`);

  let from = args.from;
  let fetched = 0;
  let end: string | undefined;

  while (fetched < args.limit) {
    const remaining = Math.min(args.limit - fetched, 1000);

    const url = new URL(`${args.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(args.roomId)}/messages`);
    url.searchParams.set('dir', args.direction);
    url.searchParams.set('limit', String(remaining));
    if (from) url.searchParams.set('from', from);

    const resp = await request('GET', url.toString(), null, token) as {
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

main().catch((err) => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
