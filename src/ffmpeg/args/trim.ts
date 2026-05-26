export interface TrimArgs {
  input: string;
  start: string;
  end: string;
  output: string;
}

export function buildTrimArgs({ input, start, end, output }: TrimArgs): string[] {
  return [
    '-y',
    '-ss', start,
    '-to', end,
    '-i', input,
    '-c', 'copy',
    output,
  ];
}
