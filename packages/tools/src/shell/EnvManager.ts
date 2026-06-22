/**
 * @file EnvManager — read environment variables, masking values that look
 * like secrets.
 */
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for `get_env`. */
export const GetEnvInputSchema = z.object({
  names: z
    .array(z.string().min(1))
    .optional()
    .describe('Specific var names to read. Omit to dump all non-secret vars.'),
});

/** Output schema for `get_env`. */
export const GetEnvOutputSchema = z.object({
  vars: z.record(z.string(), z.string()),
});

export type GetEnvInput = z.infer<typeof GetEnvInputSchema>;
export type GetEnvOutput = z.infer<typeof GetEnvOutputSchema>;

/** Heuristic — does this var name/value pair look like a secret? */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL)/i;
const SECRET_VALUE_LENIENT = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIAL)/i;

function mask(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/** Decide whether a (name, value) pair should be masked. */
function isSecret(name: string, value: string): boolean {
  if (SECRET_NAME.test(name)) return true;
  // Long opaque values containing a secret-y keyword are also masked.
  if (value.length >= 16 && SECRET_VALUE_LENIENT.test(value)) return true;
  return false;
}

/**
 * EnvManagerTool — read environment variables, masking secret-looking ones.
 *
 * @example
 * ```ts
 * const res = await new EnvManagerTool().execute(
 *   { names: ['PATH', 'OPENAI_API_KEY'] },
 *   ctx,
 * );
 * ```
 */
export class EnvManagerTool implements SanixTool<GetEnvInput, GetEnvOutput> {
  readonly name = 'get_env';
  readonly description =
    'Read environment variables. Values whose name or content looks like a secret (KEY/TOKEN/SECRET/PASSWORD) are masked.';
  readonly inputSchema = GetEnvInputSchema;
  readonly outputSchema = GetEnvOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 4_000;

  async execute(
    input: GetEnvInput,
    _context: ToolContext,
  ): Promise<ToolResult<GetEnvOutput>> {
    const start = Date.now();
    try {
      const out: Record<string, string> = {};
      const names = input.names ?? Object.keys(process.env);
      for (const name of names) {
        const value = process.env[name];
        if (value === undefined) continue;
        out[name] = isSecret(name, value) ? mask(value) : value;
      }
      return okResult<GetEnvOutput>({ vars: out }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<GetEnvOutput>(`get_env failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: GetEnvOutput): string {
    const lines = Object.entries(result.vars).map(([k, v]) => `${k}=${v}`);
    return lines.length ? lines.join('\n') : '(no env vars)';
  }
}
