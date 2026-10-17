/** Skeleton files of a new knowledge base, following the LLM Wiki layout (raw sources, compiled wiki, index, log, schema). */

/** Files written into a new repository. */
export function templateFiles(title: string, now: Date): Array<{ path: string; data: Buffer }> {
  const day = now.toISOString().slice(0, 10)
  const files: Record<string, string> = {
    'schema.md': `# Schema

Conventions the compiler and agents follow for this knowledge base.

- \`raw/\` holds immutable sources (Markdown, text, PDF, DOCX, HTML). Never edit them; add new files instead.
- \`wiki/\` holds compiled pages, one concept or entity per page, named \`wiki/<slug>.md\` with lower-case words joined by hyphens.
- Each page starts with a level-one heading, then a one-paragraph summary, then sections. Link related pages with relative Markdown links.
- Every factual claim cites its source as \`(source: raw/<file>)\`. Contradictions between sources are stated, not resolved silently.
- \`index.md\` lists every page in \`wiki/\` with a one-line description. Queries read it first.
- \`log.md\` is append-only: one entry per ingest, lint or edit, newest last.
`,
    'index.md': `# ${title}\n\nCatalog of the pages in \`wiki/\`. Each line: a link and a one-line description.\n\n<!-- No pages yet. Add sources to raw/ and run a compile. -->\n`,
    'log.md': `# Log\n\n## ${day} create\n\nKnowledge base created from the template.\n`,
    'raw/.gitkeep': '',
    'wiki/.gitkeep': '',
  }
  return Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text, 'utf8') }))
}
