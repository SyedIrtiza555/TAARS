import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { createLogger } from './logger.js';
import { nowIso, newId, truncate } from './util.js';

const log = createLogger('rag');

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

type EmbeddingPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export type KnowledgeDocument = {
  id: string;
  title: string;
  source_type: string;
  source_name: string | null;
  mime_type: string | null;
  status: string;
  error: string | null;
  char_count: number;
  chunk_count: number;
  owner_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SearchResult = {
  chunkId: number;
  documentId: string;
  title: string;
  content: string;
  score: number;
  lexicalScore: number;
  vectorScore: number;
};

type ChunkRow = {
  id: number;
  document_id: string;
  content: string;
  embedding: Uint8Array | null;
  title: string;
};

type IndexedChunk = ChunkRow & {
  tokens: string[];
  tokenCounts: Map<string, number>;
  length: number;
};

export type ChunkOptions = {
  maxChars?: number;
  overlapChars?: number;
};

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just me my no not of on or our out she so than that the their them then there these they this to too us was we were what when where which who why will with would you your`.split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token)).slice(0, 5000);
}

function hardSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function sentenceSegments(text: string): string[] {
  const segments: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const clean = paragraph.trim();
    if (!clean) continue;
    const sentences = clean.match(/[^.!?…\n]+(?:[.!?…]+|\n|$)/g) || [clean];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed) segments.push(trimmed);
    }
  }
  return segments;
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = Math.max(300, options.maxChars ?? 1200);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? 180, maxChars - 200));
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const segments = sentenceSegments(clean).flatMap((segment) => hardSplit(segment, maxChars));
  const chunks: string[] = [];
  let current = '';

  for (const segment of segments) {
    if (!current) {
      current = segment;
      continue;
    }
    if (current.length + segment.length + 1 <= maxChars) {
      current += ` ${segment}`;
      continue;
    }
    chunks.push(current.trim());
    const tail = current.slice(Math.max(0, current.length - overlapChars)).trim();
    const overlap = tail.length > 0 && tail.length < current.length ? tail : '';
    current = overlap ? `${overlap} ${segment}` : segment;
    if (current.length > maxChars) {
      const pieces = hardSplit(current, maxChars);
      chunks.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] || '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function encodeEmbedding(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function decodeEmbedding(buffer: Uint8Array): Float32Array {
  const copy = new Uint8Array(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export class RagService {
  private embedderPromise: Promise<EmbeddingPipeline | null> | null = null;
  private embedderReady = false;
  private embeddingError: string | null = null;
  private cacheVersion = 0;
  private cachedVersion = -1;
  private cachedChunks: IndexedChunk[] = [];
  private indexing = new Set<string>();

  constructor() {
    this.resumePending = this.resumePending.bind(this);
  }

  resumePending(): void {
    const rows = db
      .prepare("SELECT id FROM knowledge_documents WHERE status = 'indexing'")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      log.info({ documentId: row.id }, 'Resuming interrupted knowledge indexing');
      void this.indexDocument(row.id);
    }
  }

  getEmbeddingStatus(): { model: string; ready: boolean; error: string | null } {
    return { model: EMBEDDING_MODEL, ready: this.embedderReady, error: this.embeddingError };
  }

  warmEmbeddings(): void {
    void this.getEmbedder();
  }

  private async getEmbedder(): Promise<EmbeddingPipeline | null> {
    if (this.embedderPromise) return this.embedderPromise;
    this.embedderPromise = (async () => {
      try {
        log.info({ model: EMBEDDING_MODEL }, 'Loading local embedding model (first run may download ~25 MB)');
        const transformers = await import('@huggingface/transformers');
        transformers.env.cacheDir = path.join(config.modelsDir, 'transformers');
        transformers.env.allowRemoteModels = true;
        const extractor = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL, {
          dtype: 'q8',
        });
        this.embedderReady = true;
        this.embeddingError = null;
        log.info('Local embedding model ready');
        return extractor as unknown as EmbeddingPipeline;
      } catch (error) {
        this.embeddingError = error instanceof Error ? error.message : String(error);
        log.warn({ error: this.embeddingError }, 'Local embeddings unavailable; using keyword search only');
        return null;
      }
    })();
    return this.embedderPromise;
  }

  private async embedTexts(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    const extractor = await this.getEmbedder();
    if (!extractor) return null;
    try {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 24) {
        const batch = texts.slice(i, i + 24);
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const list = output.tolist();
        vectors.push(...list);
      }
      return vectors;
    } catch (error) {
      this.embeddingError = error instanceof Error ? error.message : String(error);
      log.warn({ error: this.embeddingError }, 'Embedding generation failed; indexing with keyword search only');
      return null;
    }
  }

  /** Public embedding helper used by the per-agent memory system. Returns null when embeddings are unavailable. */
  async embed(texts: string[]): Promise<number[][] | null> {
    return this.embedTexts(texts);
  }

  listDocuments(): KnowledgeDocument[] {
    return db
      .prepare(
        `SELECT id, title, source_type, source_name, mime_type, status, error, char_count, chunk_count,
                owner_agent_id, created_at, updated_at
         FROM knowledge_documents ORDER BY created_at DESC`,
      )
      .all() as unknown as KnowledgeDocument[];
  }

  listOwnedDocumentIds(agentId: string): string[] {
    return (db.prepare('SELECT id FROM knowledge_documents WHERE owner_agent_id = ?').all(agentId) as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  getDocument(id: string): KnowledgeDocument | null {
    return (db
      .prepare(
        `SELECT id, title, source_type, source_name, mime_type, status, error, char_count, chunk_count,
                owner_agent_id, created_at, updated_at
         FROM knowledge_documents WHERE id = ?`,
      )
      .get(id) as unknown as KnowledgeDocument) || null;
  }

  addDocument(input: {
    title: string;
    content: string;
    sourceType?: string;
    sourceName?: string;
    mimeType?: string;
    ownerAgentId?: string | null;
  }): KnowledgeDocument {
    const content = input.content.replace(/\u0000/g, '').trim();
    if (!content) throw new Error('Document content is empty.');
    if (content.length > 5_000_000) throw new Error('Document is too large (5 MB of text max).');
    const id = newId('doc');
    const at = nowIso();
    const title = input.title.trim().slice(0, 200) || 'Untitled document';
    db.prepare(
      `INSERT INTO knowledge_documents
       (id, title, source_type, source_name, mime_type, content, status, char_count, chunk_count, owner_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'indexing', ?, 0, ?, ?, ?)`,
    ).run(
      id,
      title,
      input.sourceType || 'text',
      input.sourceName || null,
      input.mimeType || null,
      content,
      content.length,
      input.ownerAgentId || null,
      at,
      at,
    );
    this.cacheVersion++;
    void this.indexDocument(id);
    return this.getDocument(id)!;
  }

  async addDocumentAndWait(input: {
    title: string;
    content: string;
    sourceType?: string;
    sourceName?: string;
    mimeType?: string;
    ownerAgentId?: string | null;
  }): Promise<KnowledgeDocument> {
    const doc = this.addDocument(input);
    await this.waitForDocument(doc.id);
    return this.getDocument(doc.id)!;
  }

  private async waitForDocument(id: string): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if (!this.indexing.has(id)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async indexDocument(id: string): Promise<void> {
    if (this.indexing.has(id)) return;
    this.indexing.add(id);
    const doc = db
      .prepare('SELECT id, title, content FROM knowledge_documents WHERE id = ?')
      .get(id) as { id: string; title: string; content: string } | undefined;
    if (!doc) {
      this.indexing.delete(id);
      return;
    }

    try {
      db.prepare("UPDATE knowledge_documents SET status = 'indexing', error = NULL, updated_at = ? WHERE id = ?").run(
        nowIso(),
        id,
      );
      const chunks = chunkText(doc.content);
      if (chunks.length === 0) throw new Error('No indexable text found in this document.');

      const vectors = await this.embedTexts(chunks);
      const at = nowIso();
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id);
        const insert = db.prepare(
          `INSERT INTO knowledge_chunks
           (document_id, chunk_index, content, token_count, embedding, embedding_model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        chunks.forEach((chunk, index) => {
          const vector = vectors?.[index];
          insert.run(
            id,
            index,
            chunk,
            tokenize(chunk).length,
            vector ? encodeEmbedding(vector) : null,
            vector ? EMBEDDING_MODEL : null,
            at,
          );
        });
        db.prepare(
          `UPDATE knowledge_documents
           SET status = 'ready', error = ?, chunk_count = ?, updated_at = ? WHERE id = ?`,
        ).run(
          vectors ? null : `Keyword-only index: ${this.embeddingError || 'embeddings unavailable'}`,
          chunks.length,
          at,
          id,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      this.cacheVersion++;
      log.info({ documentId: id, chunks: chunks.length, embeddings: Boolean(vectors) }, 'Knowledge document indexed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        "UPDATE knowledge_documents SET status = 'error', error = ?, chunk_count = 0, updated_at = ? WHERE id = ?",
      ).run(truncate(message, 1000), nowIso(), id);
      this.cacheVersion++;
      log.error({ documentId: id, error: message }, 'Knowledge document indexing failed');
    } finally {
      this.indexing.delete(id);
    }
  }

  deleteDocument(id: string): boolean {
    const result = db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id);
    this.cacheVersion++;
    return result.changes > 0;
  }

  getStats(): { documents: number; chunks: number; embeddedChunks: number } {
    const docs = db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get() as { n: number };
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as { n: number };
    const embedded = db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE embedding IS NOT NULL')
      .get() as { n: number };
    return { documents: docs.n, chunks: chunks.n, embeddedChunks: embedded.n };
  }

  private loadChunks(): IndexedChunk[] {
    if (this.cachedVersion === this.cacheVersion) return this.cachedChunks;
    const rows = db
      .prepare(
        `SELECT c.id, c.document_id, c.content, c.embedding, d.title
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE d.status = 'ready'
         ORDER BY c.id ASC`,
      )
      .all() as unknown as ChunkRow[];
    this.cachedChunks = rows.map((row) => {
      const tokens = tokenize(row.content);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      return { ...row, tokens, tokenCounts: counts, length: tokens.length };
    });
    this.cachedVersion = this.cacheVersion;
    return this.cachedChunks;
  }

  /**
   * Hybrid BM25 + vector search. When `documentIds` is given, ranking happens only inside
   * that set, so an agent's search can never surface (or be crowded out by) other documents.
   */
  async search(
    query: string,
    topK = 5,
    minScore = 0.18,
    options: { documentIds?: string[] } = {},
  ): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    const allChunks = this.loadChunks();
    const allowed = options.documentIds ? new Set(options.documentIds) : null;
    if (allowed && allowed.size === 0) return [];
    const chunks = allowed ? allChunks.filter((chunk) => allowed.has(chunk.document_id)) : allChunks;
    if (chunks.length === 0) return [];

    const queryTokens = tokenize(cleanQuery);
    if (queryTokens.length === 0) return [];

    const df = new Map<string, number>();
    for (const chunk of chunks) {
      for (const token of new Set(chunk.tokens)) df.set(token, (df.get(token) || 0) + 1);
    }
    const avgLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / Math.max(1, chunks.length);
    const k1 = 1.5;
    const b = 0.75;

    const lexicalScores = new Map<number, number>();
    let maxLexical = 0;
    for (const chunk of chunks) {
      let score = 0;
      for (const token of queryTokens) {
        const frequency = chunk.tokenCounts.get(token) || 0;
        if (frequency === 0) continue;
        const docFreq = df.get(token) || 0;
        const idf = Math.log(1 + (chunks.length - docFreq + 0.5) / (docFreq + 0.5));
        score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (chunk.length / avgLength))));
      }
      if (score > 0) {
        lexicalScores.set(chunk.id, score);
        if (score > maxLexical) maxLexical = score;
      }
    }

    const embedding = (await this.embedTexts([cleanQuery]))?.[0];
    const queryVector = embedding ? new Float32Array(embedding) : null;
    const vectorScores = new Map<number, number>();
    if (queryVector) {
      for (const chunk of chunks) {
        if (!chunk.embedding) continue;
        vectorScores.set(chunk.id, cosine(queryVector, decodeEmbedding(chunk.embedding)));
      }
    }

    const candidateIds = new Set<number>([...lexicalScores.keys(), ...vectorScores.keys()]);
    const results: SearchResult[] = [];
    for (const chunk of chunks) {
      if (!candidateIds.has(chunk.id)) continue;
      const lexical = maxLexical > 0 ? (lexicalScores.get(chunk.id) || 0) / maxLexical : 0;
      const vector = Math.max(0, vectorScores.get(chunk.id) || 0);
      const score = queryVector ? 0.55 * vector + 0.45 * lexical : lexical;
      results.push({
        chunkId: chunk.id,
        documentId: chunk.document_id,
        title: chunk.title,
        content: chunk.content,
        score: Number(score.toFixed(4)),
        lexicalScore: Number(lexical.toFixed(4)),
        vectorScore: Number(vector.toFixed(4)),
      });
    }

    return results
      .filter((result) => result.score >= minScore)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, Math.max(1, Math.min(20, topK)));
  }

  buildContext(results: SearchResult[]): string {
    if (results.length === 0) return '';
    return results
      .map(
        (result, index) =>
          `[${index + 1}] Source: ${result.title}\nRelevance: ${(result.score * 100).toFixed(0)}%\n${result.content}`,
      )
      .join('\n\n---\n\n');
  }
}

export const rag = new RagService();
