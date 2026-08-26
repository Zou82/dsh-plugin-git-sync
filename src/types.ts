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
  agent?: unknown;
  /** Abort signal for the current tool call. */
  signal?: AbortSignal;
  /** TODO(verify): whether the runtime exposes the workspace/cwd here. */
  cwd?: string;
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
