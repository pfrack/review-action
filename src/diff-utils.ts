export interface DiffChunk {
  header: string;
  content: string;
  startLine: number;
}

export function chunkDiff(diff: string, maxTokens: number = 12000): DiffChunk[] {
  const lines = diff.split('\n');
  const chunks: DiffChunk[] = [];
  let preamble: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let lastHunkHeader = '';
  let nextStartLine = 1;

  function countContentLines(chunk: string[]): number {
    return chunk.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
  }

  function pushChunk() {
    if (currentChunk.length > 0 && currentTokens > 0) {
      chunks.push({
        header: lastHunkHeader || currentChunk[0] || '',
        content: currentChunk.join('\n'),
        startLine: nextStartLine,
      });
      nextStartLine += countContentLines(currentChunk);
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (headerMatch) {
      pushChunk();
      currentChunk = preamble.length > 0 ? [...preamble, line] : [line];
      preamble = [];
      lastHunkHeader = line;
      nextStartLine = parseInt(headerMatch[1], 10);
      currentTokens = currentChunk.join('\n').length;
    } else if (currentChunk.length === 0) {
      preamble.push(line);
    } else {
      currentChunk.push(line);
      currentTokens += line.length;
      if (currentTokens > maxTokens * 4) {
        currentChunk.pop();
        currentTokens -= line.length;
        pushChunk();
        currentChunk = [line];
        currentTokens = line.length;
      }
    }
  }

  pushChunk();

  if (preamble.length > 0 && chunks.length === 0) {
    chunks.push({ header: '', content: preamble.join('\n'), startLine: 1 });
  }

  return chunks.length > 0 ? chunks : [{ header: '', content: diff, startLine: 1 }];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
