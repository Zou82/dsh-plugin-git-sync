/**
 * Minimal structural views over DSH context seams this plugin uses.
 * DSH seams verified against installed packages:
 *  - ctx.tools.register(defineTool(...))          @deepseek-ai/dsh-tools
 *  - ctx.userQuestions.ask({questions,agent,signal}) -> {answers:[{id,selected[],custom?}]}
 *                                                 @deepseek-ai/dsh-user-questions
 *  - ctx.credentials.resolve(ref)/describe/set    @deepseek-ai/dsh-credentials
 *  - ctx.on("session/created") / ("session/event") @deepseek-ai/dsh-session
 */

/** Tool execution context passed to defineTool's execute(args, exec). */
export interface ToolExec {
  /** The live calling agent (required for human interaction validation). */
  agent?: {
    /** The agent's session; its header carries the session workspace cwd. */
    session?: { header?: { cwd?: string } };
  };
  /** Abort signal for the current tool call. */
  signal?: AbortSignal;
}

/**
 * Resolve the session workspace from a tool exec context — the same source
 * the built-in bash tool uses (`exec.agent.session.header.cwd`). The exec
 * context has NO top-level cwd field; falling back to process.cwd() would
 * point at the host process directory instead of the user's project.
 */
export function execSessionCwd(exec: unknown): string | undefined {
  const agent = (exec as ToolExec | undefined)?.agent;
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/** Resolve the effective working directory: explicit arg > session cwd > cwd. */
export function resolveWorkspaceCwd(explicit: string | undefined, exec: unknown): string {
  if (explicit && explicit.length > 0) return explicit;
  const sessionCwd = execSessionCwd(exec);
  if (sessionCwd !== undefined) return sessionCwd;
  return process.cwd();
}

/**
 * Resolve the workspace path from a session object seen in lifecycle hooks
 * (`session/created`, `session/event`). The session entity carries its
 * creation cwd in `header.cwd`.
 */
export function sessionWorkspaceCwd(session: unknown): string | undefined {
  const s = session as { header?: { cwd?: string }; cwd?: string } | null;
  const headerCwd = s?.header?.cwd;
  if (typeof headerCwd === "string" && headerCwd.length > 0) return headerCwd;
  const cwd = s?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/** One question sent to the human via ctx.userQuestions. */
export interface Question {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
}

/** Answer received from the human. custom carries free text (e.g. a repo name). */
export interface QuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** Structural view of the plugin context (Cordis Context + injected services). */
export interface Ctx {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  tools: { register(tool: unknown): unknown };
  credentials: {
    resolve(ref: string): Promise<{ value: string; source?: string } | undefined>;
    describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
  };
  userQuestions: {
    ask(request: {
      questions: Question[];
      agent?: unknown;
      signal?: AbortSignal;
    }): Promise<{ answers: QuestionAnswer[] }>;
  };
  /** dsh-settings: register the user-editable "git-sync" namespace. */
  settings: {
    register(
      ns: string,
      schema: unknown,
      options?: { base?: unknown; applies?: string; validate?: unknown },
    ): {
      get(): unknown;
      watch(callback: () => void): () => void;
      update(patch: Record<string, unknown>): Promise<unknown>;
      replace(section: Record<string, unknown>): Promise<unknown>;
    };
  };
  /** TODO(verify): dsh-agent-instructions seam, if composed. */
  agentInstructions?: { register?(text: string): unknown };
}

/** Ask the human one question and return the answer. */
export async function askUser(
  ctx: Ctx,
  exec: ToolExec,
  question: Question,
): Promise<QuestionAnswer> {
  const result = await ctx.userQuestions.ask({
    questions: [question],
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  });
  const answer = result.answers[0];
  if (!answer) throw new Error(`user question "${question.id}" was not answered`);
  return answer;
}
