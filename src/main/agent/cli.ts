/**
 * Primary agent path: shell out to the `claude` CLI in print mode.
 *
 * WHY THE CLI AND NOT THE SDK. The CLI logs in with your Claude account and
 * draws on the Pro/Max plan's usage pool rather than a separate metered API
 * key. Anthropic shipped a parallel path that authenticates the Agent SDK
 * itself against a subscription, but their own support page had it marked
 * PAUSED as of 2026-07-28, so the primary path deliberately does not depend
 * on it. See resolve.ts for the switchover point.
 *
 * WHY THE FLAGS ARE NOT OPTIONAL. Measured on this machine 2026-07-29,
 * answering the single word "PONG":
 *
 *     bare `claude -p` in the project dir   $0.359   34,692 cache-creation tokens
 *     the flag set below                    $0.0013  0 cache-creation tokens
 *
 * A bare invocation reloads Claude Code's own system prompt, the project's
 * CLAUDE.md, every skill and every MCP server, on EVERY call. Across a
 * six-check scan of twenty candidates that is $43 versus $0.16. These flags
 * are load-bearing; deleting one silently multiplies the bill.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentProvider,
  AgentRunRequest,
  AgentRunResult,
  AgentErrorKind,
  ProviderProbe,
} from './provider';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Finding the binary on Windows, and why not the obvious way.
 *
 * `claude` on PATH is an npm shim: a shell script plus a claude.cmd. Since the
 * CVE-2024-27980 fix, Node refuses to spawn .cmd or .bat without `shell: true`
 * and throws EINVAL. Turning the shell on is the wrong fix here: the system
 * prompt is multi-line and contains apostrophes, and cmd.exe would mangle it
 * (and an empty-string argument like `--setting-sources ""` can vanish
 * entirely). It would also put a shell between us and the args for no gain.
 *
 * claude.cmd itself just execs a real native binary at
 * `<shim dir>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, so we
 * resolve that and spawn it directly with shell: false. No quoting layer, no
 * injection surface, no EINVAL.
 *
 * Set CLAUDE_CLI_PATH to override if the CLI is installed some other way.
 */
let cachedBin: string | null | undefined;

function resolveClaudeBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin;

  const override = process.env.CLAUDE_CLI_PATH;
  if (override && fs.existsSync(override)) return (cachedBin = override);

  if (process.platform !== 'win32') return (cachedBin = 'claude');

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // Mirror what claude.cmd does with %dp0%.
    const viaShim = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(viaShim)) return (cachedBin = viaShim);
    const direct = path.join(dir, 'claude.exe');
    if (fs.existsSync(direct)) return (cachedBin = direct);
  }

  return (cachedBin = null);
}

/**
 * The lean flag set. Every entry earns its place:
 *   --system-prompt                          replaces Claude Code's ~30k-token default
 *   --exclude-dynamic-system-prompt-sections drops env/git/directory preamble
 *   --strict-mcp-config                      ignores every configured MCP server
 *   --setting-sources ""                     no CLAUDE.md, no skills, no plugins, no hooks
 *   --tools ""                               no tool definitions loaded, and the agent
 *                                            genuinely cannot fetch or read files
 *   --no-session-persistence                 nothing written to session history
 */
function buildArgs(req: AgentRunRequest): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--system-prompt',
    req.systemPrompt,
    '--exclude-dynamic-system-prompt-sections',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--no-session-persistence',
    '--model',
    req.model ?? 'sonnet',
  ];
}

/** The CLI's own result envelope. Only the fields we rely on. */
type CliEnvelope = {
  is_error?: boolean;
  subtype?: string;
  api_error_status?: number | null;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

function classify(status: number | null | undefined, message: string): AgentErrorKind {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || m.includes('authenticate') || m.includes('oauth')) {
    return 'auth';
  }
  if (status === 429 || m.includes('rate limit') || m.includes('usage limit')) return 'rate_limit';
  if (status && status >= 500) return 'transport';
  if (m.includes('enoent') || m.includes('not found')) return 'not_available';
  return 'unknown';
}

type Spawned = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runCli(args: string[], stdin: string, timeoutMs: number): Promise<Spawned> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBinary();
    if (!bin) {
      resolve({
        code: null,
        stdout: '',
        stderr: 'claude CLI not found on PATH. Install it, or set CLAUDE_CLI_PATH.',
        timedOut: false,
      });
      return;
    }

    // Run from the OS temp dir, not the project. Belt and braces alongside
    // --setting-sources "": nothing here for CLAUDE.md discovery to find.
    let child;
    try {
      child = spawn(bin, args, {
        cwd: os.tmpdir(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn() can throw synchronously (EINVAL on a .cmd, ENOENT on a bad
      // path), which the 'error' event below never sees. This function
      // promises never to throw, so it has to be caught here.
      resolve({ code: null, stdout: '', stderr: `spawn failed: ${(e as Error).message}`, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e: Error) => {
      stderr += `\nspawn error: ${e.message}`;
      finish(null);
    });
    child.on('close', finish);

    // The prompt goes on stdin, verified working 2026-07-29. Passing raw page
    // source as an argv argument would blow the ~32k Windows command-line cap.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
}

export class ClaudeCliProvider implements AgentProvider {
  readonly id = 'cli' as const;
  readonly label = 'claude CLI (Pro/Max subscription usage)';

  async probe(): Promise<ProviderProbe> {
    const res = await this.run({
      systemPrompt: 'You follow instructions exactly.',
      prompt: 'Reply with exactly the word PONG and nothing else.',
      model: 'haiku',
      timeoutMs: 60_000,
    });

    if (res.ok && res.text.trim().toUpperCase().includes('PONG')) {
      return { available: true, detail: `Logged in and answering. Probe cost $${(res.costUsd ?? 0).toFixed(4)}.` };
    }
    if (res.error?.kind === 'auth') {
      return { available: false, detail: 'The claude CLI is installed but not logged in. Run `claude login` in a terminal.' };
    }
    if (res.error?.kind === 'not_available') {
      return { available: false, detail: 'The claude CLI is not on PATH. Install it, or switch agent mode to an API key.' };
    }
    return { available: false, detail: res.error?.message ?? 'The claude CLI did not answer a probe.' };
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const started = Date.now();
    const { code, stdout, stderr, timedOut } = await runCli(
      buildArgs(req),
      req.prompt,
      req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const durationMs = Date.now() - started;

    if (timedOut) {
      return {
        ok: false,
        text: '',
        durationMs,
        error: { kind: 'transport', message: `claude CLI timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` },
      };
    }

    let env: CliEnvelope;
    try {
      env = JSON.parse(stdout) as CliEnvelope;
    } catch {
      const detail = (stderr || stdout || '').trim().slice(0, 400);
      return {
        ok: false,
        text: '',
        durationMs,
        error: {
          kind: classify(null, detail),
          message: detail || `claude CLI exited ${code} with no parseable output`,
        },
      };
    }

    const usage = {
      inputTokens: env.usage?.input_tokens ?? 0,
      outputTokens: env.usage?.output_tokens ?? 0,
      cacheCreationTokens: env.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: env.usage?.cache_read_input_tokens ?? 0,
    };

    // BRANCH ON is_error, NEVER ON subtype OR THE EXIT CODE.
    // A failed auth probe on 2026-07-28 returned {"subtype":"success",
    // "is_error":true} in the same object. subtype describes how the turn
    // ended, not whether it worked.
    if (env.is_error) {
      const message = env.result ?? 'the claude CLI reported an error with no message';
      return {
        ok: false,
        text: '',
        durationMs,
        sessionId: env.session_id,
        costUsd: env.total_cost_usd,
        usage,
        error: {
          kind: classify(env.api_error_status, message),
          message,
          status: env.api_error_status ?? undefined,
        },
      };
    }

    return {
      ok: true,
      text: env.result ?? '',
      durationMs,
      sessionId: env.session_id,
      costUsd: env.total_cost_usd,
      usage,
    };
  }
}

/**
 * Law 1's agent half, exposed for the suite. The lockout below is three argv
 * flags, which is a string, which is exactly the kind of enforcement point
 * that can vanish in a refactor with nothing failing. The test pins it.
 */
export const __test = { buildArgs };
