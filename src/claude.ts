import { execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { AGENT_ROLE, roleDatabaseUrl } from "./db/agent-roles.js";

/**
 * What one kind of `claude -p` child is allowed to have.
 *
 * Every spawn names a profile. There is no "everything" profile and no
 * default: before this existed the child got the CLI's whole tool set
 * (subagents, cron, messaging, web fetch, and for a while the owner's
 * Gmail and Drive connectors), the server's whole environment, and the
 * superuser database URL — while reading receipt emails written by
 * strangers.
 */
export interface AgentProfile {
  /**
   * The built-in tools the model is offered, passed as `--tools`. The CLI
   * removes every other built-in from the session, so nothing outside
   * this list is even visible to the model: no Agent (subagents), no
   * Cron* / RemoteTrigger (scheduling), no SendMessage / PushNotification,
   * no WebFetch, no Skill, no ToolSearch.
   */
  readonly tools: readonly string[];
  /** How tool calls are authorised. */
  readonly permissionArgs: () => string[];
  /** Variables copied from the server's environment, on top of `BASE_ENV`. */
  readonly env: readonly string[];
  /** The `DATABASE_URL` the child sees, or null for no database at all. */
  readonly databaseUrl: (() => string) | null;
}

export const AGENT_PROFILES = {
  /**
   * Ingest and re-extract. Bash for psql / curl / pdftotext / python3,
   * Read for images, Write and Edit for scratch files under /tmp,
   * WebSearch for brand discovery (Phase 2.6).
   *
   * Bash is unrestricted here, so permissions stay bypassed: an allowlist
   * of command prefixes would not survive the prompts' heredocs and
   * pipelines, and would add nothing while Bash can run anything anyway.
   * What bounds this agent is the tool list, the environment below and
   * the `receipts_agent` database role.
   *
   * That bounds a mistake and an injection that goes through what the
   * agent was handed. It is NOT a wall around an agent that has been
   * turned: an unrestricted shell running as the server's own Unix user
   * can read the server's environment, log in to Postgres as the owner,
   * call the HTTP API and start another `claude` with every tool. See
   * "What this does not bound" in CLAUDE.md before relying on it.
   */
  extraction: {
    tools: ["Bash", "Read", "Write", "Edit", "WebSearch"],
    permissionArgs: () => ["--dangerously-skip-permissions"],
    // The two keys the prompts actually reference ($GOOGLE_MAPS_API_KEY in
    // Phase 3, $LOGODEV_SECRET_KEY in the icon procedure).
    env: ["GOOGLE_MAPS_API_KEY", "LOGODEV_SECRET_KEY"],
    databaseUrl: () => roleDatabaseUrl(AGENT_ROLE),
  },
  /**
   * Ingest under the server writer (wave 1, `EXTRACTION_WRITER=server_apply`).
   * The agent reads the document and hands back an extraction record in
   * its final message; the server writes the ledger. So: no database URL
   * at all, no WebSearch (it fed only the brand domain, which now comes
   * from the document), no Edit, and of the keys only the Google one,
   * which Phase 3a and Check C still use. Bash stays for pdftotext,
   * pdftoppm, python3 and those curl calls, and is unrestricted for the
   * same reason as above.
   *
   * Bash running as the server's Unix user is still what bounds this
   * agent less than the list suggests: it can read the server's
   * environment through /proc and reach the HTTP API (CLAUDE.md, "What
   * this does not bound"). What changes is that nothing it was handed
   * can write the ledger.
   */
  extraction_record: {
    tools: ["Bash", "Read", "Write"],
    permissionArgs: () => ["--dangerously-skip-permissions"],
    env: ["GOOGLE_MAPS_API_KEY"],
    databaseUrl: null,
  },
  /**
   * Ask. No tools and no database URL: the model writes SQL as text and
   * the server runs it as `receipts_ro` (`src/insights/ask.ts`,
   * `src/insights/ledger-query.ts`).
   *
   * It used to get Bash with an allowlist of one command under `dontAsk`.
   * That is not a boundary on this CLI: 2.1.251 lets its built-in
   * "read-only" commands (`id`, `cat`, `tac`, `du`, `stat`, …) run in
   * every permission mode before any allow rule is consulted, so a
   * question could have read the mounted credentials file and every
   * transcript. A shell with a rule in front of it is still a shell; an
   * empty tool list is not.
   *
   * `dontAsk` stays as a second line: should a future CLI offer a tool
   * despite `--tools ""`, nothing that needs approval runs. It is not what
   * the confinement rests on, and `check-agent-sandbox` fails if this
   * profile is offered any tool at all.
   */
  ask: {
    tools: [],
    permissionArgs: () => ["--permission-mode", "dontAsk"],
    env: [],
    databaseUrl: null,
  },
  /** Text in, text out: no tools and no database. Used by backfill scripts
   *  that only want a classification. */
  text: {
    tools: [],
    permissionArgs: () => [],
    env: [],
    databaseUrl: null,
  },
} as const satisfies Record<string, AgentProfile>;

export type AgentProfileName = keyof typeof AGENT_PROFILES;

/**
 * Variables every child gets. The CLI needs its auth token, its config
 * directory, PATH and HOME; the rest is what a subprocess needs to behave
 * (locale, temp dir) or to reach the network at all behind a proxy.
 *
 * Deliberately absent: the server's `DATABASE_URL` (the owner connection),
 * `ANTHROPIC_API_KEY` (would switch the CLI off subscription auth), and
 * `CLAUDECODE` (makes the CLI refuse to start as a "nested session").
 */
const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * The child's environment, built from an allowlist instead of a copy of
 * `process.env`.
 *
 * This keeps keys out of the agent's own shell — `env`, `$VAR`, a stray
 * `set -x`. It is not a wall: the agent's Bash runs as the same Unix user
 * as this server and can read `/proc/<pid>/environ`. See "Agent sandbox"
 * in CLAUDE.md for what that leaves open.
 */
export function buildClaudeEnv(profileName: AgentProfileName): NodeJS.ProcessEnv {
  const profile: AgentProfile = AGENT_PROFILES[profileName];
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...profile.env]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  if (profile.databaseUrl) env.DATABASE_URL = profile.databaseUrl();
  // Belt and braces for `--strict-mcp-config`: never attach the account's
  // claude.ai connectors. They are how Gmail and Drive tools reached 63
  // extractions while auth was a `/login` session.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  // The image pins the CLI version; it must not replace itself.
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/**
 * The flags that make a profile what it is. Callers add only presentation
 * (`--output-format`, `--verbose`) and `--model`; `runClaude` refuses
 * anything else.
 *
 * Verified against the pinned CLI, 2.1.251 (`claude --help` in the image):
 *
 *   --tools <list>          the built-in tools available; "" for none
 *   --strict-mcp-config     only MCP servers from --mcp-config, and none is
 *                           passed, so: no MCP servers, including the
 *                           account's claude.ai connectors
 *   --disable-slash-commands  no skills (13 bundled ones were listed in
 *                           every session, `schedule` and `loop` among them)
 *   --setting-sources ""    ignore user, project and local settings and
 *                           their CLAUDE.md files. The agent can write to
 *                           ~/.claude and /app, so without this one hostile
 *                           receipt could leave a hook or a CLAUDE.md
 *                           behind for every later run. Managed settings
 *                           (the transcript retention pin) still apply.
 */
export function buildClaudeArgs(profileName: AgentProfileName): string[] {
  const profile: AgentProfile = AGENT_PROFILES[profileName];
  return [
    "--tools",
    profile.tools.join(","),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    ...profile.permissionArgs(),
  ];
}

/**
 * Linux caps a SINGLE `execve` argument at 32 pages, independent of the
 * much larger total `ARG_MAX`. A prompt passed as argv silently works
 * until it crosses this line, then every spawn dies with an opaque
 * `spawn E2BIG`. See `assertArgvSafe` below.
 */
export const MAX_ARG_STRLEN = 32 * 4096;

/**
 * Turn the kernel's unactionable `spawn E2BIG` into a message that names
 * the offending argument and its size. Prompts must go over stdin, so
 * tripping this means someone put payload back on the command line.
 */
export function assertArgvSafe(args: string[]): void {
  for (const [i, arg] of args.entries()) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (bytes >= MAX_ARG_STRLEN) {
      throw new Error(
        `claude CLI argv[${i}] is ${bytes} bytes, over the ${MAX_ARG_STRLEN}-byte ` +
          `per-argument kernel limit (would fail as "spawn E2BIG"). ` +
          `Large payloads must be passed on stdin, not argv. ` +
          `Offending arg starts: ${arg.slice(0, 120)}…`,
      );
    }
  }
}

export interface RunClaudeOptions {
  /** Which tools, environment and database role the child gets. Required:
   *  there is no unrestricted spawn. */
  profile: AgentProfileName;
  /** `--output-format <v>`, `--model <v>` and `--verbose`, nothing else
   *  (see `CALLER_FLAGS`). Never payload — the prompt goes on stdin. `-p`
   *  and `--session-id` (or `--resume`) are supplied by this function. */
  args?: string[];
  timeoutMs: number;
  /** Pre-allocated session id. The ingest worker and re-extract mint their
   *  own before spawning, so the run record and the session JSONL path
   *  exist while the agent is still running and survive its failure;
   *  other callers omit it and get a fresh one back. */
  sessionId?: string;
  /**
   * Continue an earlier session instead of starting one: the repair round
   * of a record extraction (wave 1; docs/server-writer.md,
   * "The repair round"). Filled only by server code,
   * and only with the session id the server minted for that same run, so
   * a document can never steer a spawn into somebody else's conversation.
   *
   * It REPLACES `--session-id` with `--resume <id>`: the pinned CLI
   * (2.1.251) refuses the two together unless `--fork-session` is given,
   * and a plain resume appends to the same transcript, so one run keeps
   * one session id and one JSONL file. The profile's flags are applied
   * again, because the resuming spawn's flags, not the session's history,
   * decide which tools are offered. The prompt (the list of problems)
   * still goes on stdin. Never pass it with `sessionId`.
   */
  resumeSessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The whole argv of a `claude -p` spawn: `-p`, the profile's flags, the
 * caller's presentation flags, then exactly one of `--session-id <id>` (a
 * new session) or `--resume <id>` (continue that session). The one place
 * that argv is put together, so `check-agent-sandbox` can spawn exactly
 * what the server spawns.
 */
export function claudeSpawnArgs(
  profile: AgentProfileName,
  args: readonly string[],
  session: { sessionId: string } | { resumeSessionId: string },
): string[] {
  assertCallerArgs(args, profile);
  const [flag, id] =
    "resumeSessionId" in session ? ["--resume", session.resumeSessionId] : ["--session-id", session.sessionId];
  if (!UUID_RE.test(id)) {
    throw new Error(`runClaude: ${flag} needs a session uuid, got ${JSON.stringify(id.slice(0, 80))}`);
  }
  return ["-p", ...buildClaudeArgs(profile), ...args, flag, id];
}

/**
 * The flags a caller may pass through `args`, and whether each takes a
 * value. An allowlist, because the CLI keeps growing flags that widen a
 * session — `--brief` adds a messaging tool, `--agent` and
 * `--system-prompt` replace what the model is, `--resume` continues some
 * other session — and a list of forbidden ones is out of date the day
 * the CLI is bumped. Everything else a child gets is decided by its
 * profile, so widening one is always a visible edit to `AGENT_PROFILES`.
 */
const CALLER_FLAGS: Readonly<Record<string, "value" | "bare">> = {
  "--output-format": "value",
  "--model": "value",
  "--verbose": "bare",
};

/** Throws on anything in `args` that is not a `CALLER_FLAGS` flag or the
 *  value of one. */
export function assertCallerArgs(args: readonly string[], profile: string): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const kind = Object.hasOwn(CALLER_FLAGS, name) ? CALLER_FLAGS[name] : undefined;
    if (!kind || (kind === "bare" && eq !== -1)) {
      throw new Error(
        `runClaude: ${JSON.stringify(name)} cannot be passed in args (allowed: ` +
          `${Object.keys(CALLER_FLAGS).join(", ")}). What a "${profile}" child may have is ` +
          `decided by AGENT_PROFILES in src/claude.ts.`,
      );
    }
    if (kind === "value" && eq === -1) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`runClaude: ${name} needs a value`);
      }
    }
  }
}

/** How long a child gets after SIGTERM before its process group is
 *  SIGKILLed, and again after SIGKILL (or after it exited on its own)
 *  before its pipes are abandoned. */
export const KILL_GRACE_MS = 15_000;

/**
 * Every process on the machine as `[pid, ppid, pgid]`, from `/proc` on
 * Linux (the container) and `ps` elsewhere. Empty when neither can be
 * read: the caller then signals only the child's own group, as it would
 * have anyway.
 */
function processTable(): Array<[number, number, number]> {
  try {
    if (process.platform === "linux") {
      const rows: Array<[number, number, number]> = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${name}/stat`, "utf8");
        } catch {
          continue; // exited while we looked
        }
        // "pid (comm) state ppid pgrp …"; comm may hold spaces and ")".
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push([Number(name), Number(f[1]), Number(f[2])]);
      }
      return rows;
    }
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r): r is [number, number, number] => r.length === 3 && r.every(Number.isInteger));
  } catch {
    return [];
  }
}

/**
 * The process groups of `rootPid`'s live descendants, other than its own
 * group. The CLI (2.1.251) starts every Bash tool command `detached`, in
 * a session of its own, so a `psql` waiting on a lock or a command left
 * running with `&` is not in the group `kill(-pid)` reaches. They are the
 * CLI's descendants only while it lives (an orphan is re-parented), so
 * this is read before the first signal. Never returns this server's own
 * group, or group 0 or 1.
 */
function descendantGroups(rootPid: number): number[] {
  const table = processTable();
  const children = new Map<number, number[]>();
  const groupOf = new Map<number, number>();
  for (const [pid, ppid, pgid] of table) {
    groupOf.set(pid, pgid);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const own = groupOf.get(process.pid);
  const groups = new Set<number>();
  const seen = new Set<number>();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const g = groupOf.get(p);
    if (g !== undefined && g > 1 && g !== rootPid && g !== own) groups.add(g);
    stack.push(...(children.get(p) ?? []));
  }
  return [...groups];
}

/** Why a supervised child did not succeed. */
export type ChildFailureKind = "spawn" | "timeout" | "exit";

/**
 * A `claude -p` run that did not exit 0. The message is the same text the
 * callers have always stored (`ingests.error` is categorised from it), and
 * the fields say what happened without parsing it.
 */
export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly kind: ChildFailureKind,
    readonly exitCode: number | null,
    readonly signal: string | null,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

export interface SupervisedExit {
  stdout: string;
  stderr: string;
  /** NULL when the child was ended by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The timeout fired and the process group was killed. */
  timedOut: boolean;
}

export interface SuperviseOptions {
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input: string;
  timeoutMs: number;
  killGraceMs?: number;
  /** For the log lines a kill writes. */
  label: string;
}

/**
 * Spawn a child in a process group of its own and settle only once it is
 * gone.
 *
 * The child is the leader of a new process group (`detached: true`, which
 * is `setsid` on Linux and macOS), so every process it starts in that
 * group — a `curl`, a `python3`, a `sleep` left in the background — can
 * be signalled at once with `kill(-pgid)`. The CLI's Bash tool is the
 * exception: CLI 2.1.251 runs each tool command in a session of its own,
 * outside that group (see `descendantGroups`).
 *
 *   - Timeout: the groups of the child's descendants that left its group
 *     are read first, while they are still its descendants. Then SIGTERM
 *     to the child's group and to those, and SIGKILL to all of them after
 *     `killGraceMs`. When the pipes close, any of those groups still alive
 *     is SIGKILLed before the promise settles. A child that has not closed
 *     its pipes another `killGraceMs` after the SIGKILL (something held
 *     them from outside every group we know) has its pipes destroyed so
 *     the caller is not held forever; the log says so.
 *   - Exit before the timeout: whatever is left in the child's group is
 *     SIGKILLed as soon as the leader exits, and the timeout is cancelled,
 *     so a late close is never reported as a timeout. If the pipes are
 *     still open `killGraceMs` after the exit (held by a process in a
 *     session of its own), they are destroyed and the exit stands. Such a
 *     process, and a tool command left running in its own session, is
 *     not reached after a normal exit: by then it is no longer the
 *     child's descendant and cannot be told from anyone else's process.
 *   - The promise settles on 'close' — after the child has exited AND its
 *     stdout/stderr have closed (or been destroyed as above) — never on
 *     the timer. The worker releases its slot when this settles, so the
 *     next job cannot start while a timed-out child's processes are still
 *     alive (before wave 1 the timeout rejected at once and only
 *     SIGTERMed the leader).
 *
 * Resolves with how the child ended, timeouts included. Rejects only when
 * the child could not be spawned at all.
 */
export function runSupervised(
  command: string,
  args: string[],
  { env, input, timeoutMs, killGraceMs = KILL_GRACE_MS, label }: SuperviseOptions,
): Promise<SupervisedExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;

    let settled = false;
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      timers.splice(0).forEach(clearTimeout);
    };
    /** Groups the child's descendants moved to, collected on timeout. */
    const strayGroups = new Set<number>();

    const killGroup = (signal: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch (err) {
        // ESRCH: the group is already empty. Anything else (EPERM) means
        // the group cannot be signalled; fall back to the leader alone.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      }
    };
    const killStrays = (signal: NodeJS.Signals): void => {
      for (const g of strayGroups) {
        try {
          process.kill(-g, signal);
        } catch {
          /* ESRCH: that group is gone */
        }
      }
    };
    const collectStrays = (): void => {
      if (pid === undefined || exited) return;
      for (const g of descendantGroups(pid)) strayGroups.add(g);
    };
    const abandonPipes = (why: string): void => {
      console.error(
        `[${label}] pipes of process ${pid} still open ${why} (held by a process outside its group); abandoning them`,
      );
      child.stdout.destroy();
      child.stderr.destroy();
    };

    // The child may exit before draining stdin (bad flag, auth failure).
    // Without this the EPIPE surfaces as an unhandled 'error' on the
    // stream and crashes the process instead of rejecting the promise.
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      timedOut = true;
      // Before any signal: once the leader dies its tool shells are
      // re-parented and can no longer be found.
      collectStrays();
      console.warn(
        `[${label}] timed out after ${timeoutMs}ms; SIGTERM to process group ${pid}` +
          (strayGroups.size > 0
            ? ` and to ${strayGroups.size} group(s) its descendants started (${[...strayGroups].join(", ")})`
            : ""),
      );
      killGroup("SIGTERM");
      killStrays("SIGTERM");
      timers.push(
        setTimeout(() => {
          collectStrays(); // anything started since, if the leader still lives
          console.warn(`[${label}] process group ${pid} still open after ${killGraceMs}ms; SIGKILL`);
          killGroup("SIGKILL");
          killStrays("SIGKILL");
          timers.push(setTimeout(() => abandonPipes(`${killGraceMs}ms after SIGKILL`), killGraceMs));
        }, killGraceMs),
      );
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // The leader is gone; nothing it started in its group may outlive it.
      killGroup("SIGKILL");
      if (timeoutTimer) {
        // It ended before the timeout: waiting for its pipes is not a
        // timeout, but it is bounded.
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
        timers.push(setTimeout(() => abandonPipes(`${killGraceMs}ms after it exited`), killGraceMs));
      }
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // A timed-out run's stragglers die before the caller (and the next
      // job) goes on. SIGTERM went out at the timeout; whatever ignored it
      // or has not finished yet gets no more time.
      if (timedOut) killStrays("SIGKILL");
      resolve({
        stdout,
        stderr,
        exitCode: code ?? exitCode,
        signal: signal ?? exitSignal,
        timedOut,
      });
    });

    child.on("error", (err) => {
      // 'error' with no pid is a failed spawn (ENOENT, E2BIG): nothing is
      // running and 'close' may never come. Any other 'error' (a failed
      // kill) leaves the child running, and 'close' still settles it.
      if (pid !== undefined || settled) return;
      settled = true;
      clearTimers();
      reject(err);
    });
  });
}

/**
 * Run `claude -p` and return its stdout plus the session id used.
 *
 * The single owner of "how this service spawns the Claude CLI" — the
 * ingest extractor, re-extract and insights paths all come through here.
 * It used to be copy-pasted per call site, which is how the same
 * three-line stdin fix had to be written twice in #195.
 *
 * The prompt is written to the child's **stdin**, never argv: a single
 * argv element is capped at 128 KiB (`MAX_ARG_STRLEN`) regardless of the
 * 2 MB total `ARG_MAX`, and `buildExtractorPrompt()` alone is already
 * ~135 KB of fixed contract text. Passing it as argv made every ingest
 * die with an opaque `spawn E2BIG` (incident 2026-07-28, #194 —
 * production ingestion was down until this moved to stdin). stdin has no
 * such limit.
 *
 * The child runs under `runSupervised`: its own process group, killed as
 * a group on timeout, and the promise settles only after it has closed.
 * A failure rejects with a `ClaudeRunError` whose message is the text
 * this function has always produced.
 *
 * With `resumeSessionId` it continues that session (`--resume`) instead
 * of starting a new one; see `RunClaudeOptions`.
 */
export async function runClaude(
  prompt: string,
  { profile, args = [], timeoutMs, sessionId, resumeSessionId }: RunClaudeOptions,
): Promise<{ stdout: string; sessionId: string }> {
  if (resumeSessionId !== undefined && sessionId !== undefined) {
    throw new Error("runClaude: pass sessionId or resumeSessionId, not both (the CLI refuses --session-id with --resume)");
  }
  const id = resumeSessionId ?? sessionId ?? randomUUID();
  const fullArgs = claudeSpawnArgs(
    profile,
    args,
    resumeSessionId !== undefined ? { resumeSessionId: id } : { sessionId: id },
  );
  assertArgvSafe(fullArgs);
  const stdout = await runAgentChild("claude", fullArgs, {
    env: buildClaudeEnv(profile),
    input: prompt,
    timeoutMs,
    sessionId: id,
  });
  return { stdout, sessionId: id };
}

/**
 * Run an agent-shaped child under `runSupervised` and turn how it ended
 * into `runClaude`'s contract: stdout on exit 0, otherwise a
 * `ClaudeRunError` carrying the text callers have always stored.
 *
 * Exported for the sandbox stub extractor's `child` mode, which runs a
 * fake agent through this exact path so a timeout or a stray grandchild
 * can be tested without spending a real run.
 */
export async function runAgentChild(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input: string; timeoutMs: number; sessionId: string; killGraceMs?: number },
): Promise<string> {
  const { sessionId, timeoutMs } = opts;
  let exit: SupervisedExit;
  try {
    exit = await runSupervised(command, args, {
      env: opts.env,
      input: opts.input,
      timeoutMs,
      killGraceMs: opts.killGraceMs,
      label: `claude ${sessionId.slice(0, 8)}`,
    });
  } catch (err) {
    throw new ClaudeRunError((err as Error).message, "spawn", null, null, sessionId);
  }
  if (exit.timedOut) {
    throw new ClaudeRunError(
      `claude -p timed out after ${timeoutMs}ms`,
      "timeout",
      exit.exitCode,
      exit.signal,
      sessionId,
    );
  }
  if (exit.exitCode !== 0) {
    throw new ClaudeRunError(
      exit.stderr || exit.stdout || `claude -p exited with code ${exit.exitCode}`,
      "exit",
      exit.exitCode,
      exit.signal,
      sessionId,
    );
  }
  return exit.stdout;
}

let cliVersionPromise: Promise<string | null> | null = null;

/**
 * The CLI's version (`claude --version`), read once per process and kept.
 * NULL when the CLI cannot be run. The server starts the read at boot so
 * the first run record does not wait for it.
 */
export function claudeCliVersion(): Promise<string | null> {
  cliVersionPromise ??= runSupervised("claude", ["--version"], {
    env: buildClaudeEnv("text"),
    input: "",
    timeoutMs: 10_000,
    killGraceMs: 2_000,
    label: "claude --version",
  })
    .then((exit) => {
      if (exit.timedOut || exit.exitCode !== 0) return null;
      const line = exit.stdout.trim().split("\n")[0] ?? "";
      return line.match(/^\d+\.\d+\.\d+\S*/)?.[0] ?? (line.slice(0, 100) || null);
    })
    .catch(() => null);
  return cliVersionPromise;
}
