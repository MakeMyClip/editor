import { useState } from 'react';

export interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}

interface RunToolError {
  message: string;
  issues?: ZodIssueLike[];
}

/**
 * POST /api/tools/:name with the given body. Returns { run, loading, error,
 * result }. `error` carries Zod issues when the server returned a 400 with
 * structured detail; the form layer can use those to highlight bad fields.
 */
export function useRunTool<TResult>(toolName: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RunToolError | null>(null);
  const [result, setResult] = useState<TResult | null>(null);

  async function run(body: unknown): Promise<TResult | null> {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/tools/${toolName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const errPayload: RunToolError = {
          message: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`,
          issues: Array.isArray(json.issues) ? (json.issues as ZodIssueLike[]) : undefined,
        };
        setError(errPayload);
        return null;
      }
      const r = json as unknown as TResult;
      setResult(r);
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError({ message });
      return null;
    } finally {
      setLoading(false);
    }
  }

  return { run, loading, error, result };
}
