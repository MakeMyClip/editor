import { useState } from 'react';

interface ImportedFile {
  originalName: string;
  path: string;
}

interface ImportResponse {
  imported: ImportedFile[];
}

/**
 * Uploads one or more files to `/api/import` as multipart. The server
 * streams them into the workspace, runs `ingest`, and appends one session
 * entry per file. Caller is responsible for refreshing the session after
 * `run` resolves successfully.
 */
export function useImport() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastImported, setLastImported] = useState<ImportedFile[]>([]);

  async function run(files: FileList | File[]): Promise<ImportedFile[] | null> {
    const list = Array.from(files);
    if (list.length === 0) return null;

    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of list) {
        form.append('files', file, file.name);
      }
      const res = await fetch('/api/import', { method: 'POST', body: form });
      const json = (await res.json()) as Partial<ImportResponse> & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return null;
      }
      const imported = json.imported ?? [];
      setLastImported(imported);
      return imported;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }

  return { run, loading, error, lastImported };
}
