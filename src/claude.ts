import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_ROLE, RO_ROLE, roleDatabaseUrl } from "./db/agent-roles.js";

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

/**
 * The one command the Ask agent may run: `src/insights/ledger-query.ts`,
 * which sends a single SQL string to Postgres and prints the rows.
 *
 * Not `psql`. psql is a shell of its own — `\!`, `\copy … to program`,
 * `\o |cmd`, `-f <any file>` — so "Bash, but only psql" still means
 * "Bash".
 *
 * Resolved next to this module so it is right in the image
 * (`node /app/dist/insights/ledger-query.js`) and under tsx on a laptop.
 */
export function ledgerQueryCommand(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.join(path.dirname(here), "insights");
  return here.endsWith(".ts")
    ? `npx tsx ${path.join(dir, "ledger-query.ts")}`
    : `node ${path.join(dir, "ledger-query.js")}`;
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
   * Ask. One tool, one command. `dontAsk` denies anything that is not
   * pre-approved instead of prompting, and the only approval is the
   * ledger-query command prefix; the CLI checks every part of a compound
   * command against it, so `… ; curl …` is refused.
   */
  ask: {
    tools: ["Bash"],
    permissionArgs: () => [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `Bash(${ledgerQueryCommand()}:*)`,
    ],
    env: [],
    databaseUrl: () => roleDatabaseUrl(RO_ROLE),
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
 * (`--output-format`) and `--model`.
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
  /** Presentation flags only (`--output-format`, `--model`), never payload
   *  — the prompt goes on stdin — and never tool or permission flags,
   *  which belong to the profile. `-p` and `--session-id` are supplied by
   *  this function. */
  args?: string[];
  timeoutMs: number;
  /** Pre-allocated session id. The ingest path mints its own before
   *  spawning so the session JSONL path is known while the agent is
   *  still running (root CLAUDE.md invariant); other callers omit it and
   *  get a fresh one back. */
  sessionId?: string;
}

/** Flags a caller must not smuggle in through `args`: each one would
 *  widen what the profile allows. */
const PROFILE_OWNED_FLAGS = new Set([
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
  "--mcp-config",
  "--strict-mcp-config",
  "--settings",
  "--setting-sources",
  "--add-dir",
  "--agents",
  "--plugin-dir",
  "--plugin-url",
]);

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
 */
export function runClaude(
  prompt: string,
  { profile, args = [], timeoutMs, sessionId = randomUUID() }: RunClaudeOptions,
): Promise<{ stdout: string; sessionId: string }> {
  const smuggled = args.find((a) => PROFILE_OWNED_FLAGS.has(a.split("=")[0]!));
  if (smuggled) {
    throw new Error(
      `runClaude: ${smuggled} is set by the "${profile}" profile and cannot be passed in args`,
    );
  }
  const fullArgs = ["-p", ...buildClaudeArgs(profile), ...args, "--session-id", sessionId];
  assertArgvSafe(fullArgs);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", fullArgs, {
      env: buildClaudeEnv(profile),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // The child may exit before draining stdin (bad flag, auth failure).
    // Without this the EPIPE surfaces as an unhandled 'error' on the
    // stream and crashes the process instead of rejecting the promise.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `claude -p exited with code ${code}`));
      } else {
        resolve({ stdout, sessionId });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
