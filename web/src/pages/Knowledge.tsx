import { useState } from 'react';
import {
  BookOpen,
  Database,
  FileText,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from '../components/ui';
import { EmptyState, ErrorBlock, Field, PageHeader, StatCard } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import { fmtNumber, timeAgo } from '../lib/types';
import type { Doc, Source } from '../lib/types';
import { api } from '../api';

type KnowledgeResponse = {
  documents: Doc[];
  stats: { documents: number; chunks: number; embeddedChunks: number };
  embeddings: { ready: boolean; error: string | null };
};

const ACCEPTED = '.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.log,.xml,.html,.htm,.pdf,.docx';

export function KnowledgePage({ notify }: { notify: Notify }) {
  const knowledge = useApi<KnowledgeResponse>('/knowledge');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Source[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const data = knowledge.data;
  const docs = data?.documents ?? [];
  const stats = data?.stats ?? { documents: 0, chunks: 0, embeddedChunks: 0 };
  const embeddings = data?.embeddings ?? { ready: false, error: null };

  const addText = async () => {
    if (!title.trim() || !text.trim() || adding) return;
    setAdding(true);
    try {
      await api.post('/knowledge', { title: title.trim(), text });
      setTitle('');
      setText('');
      await knowledge.refetch(true);
      notify('Document added and indexed', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not add document', 'error');
    } finally {
      setAdding(false);
    }
  };

  const upload = async () => {
    if (!file || uploading) return;
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    try {
      await api.postForm('/knowledge/upload', form);
      setFile(null);
      await knowledge.refetch(true);
      notify('File indexed', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const search = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    try {
      const response = await api.post<{ results: Source[] }>('/knowledge/search', {
        query: query.trim(),
        k: 5,
      });
      setResults(response.results ?? []);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Search failed', 'error');
    } finally {
      setSearching(false);
    }
  };

  const reindex = async (doc: Doc) => {
    setBusyId(doc.id);
    try {
      await api.post(`/knowledge/${encodeURIComponent(doc.id)}/reindex`);
      let latestStatus = 'indexing';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const latest = await api.get<{ documents: Doc[] }>('/knowledge');
        const current = latest.documents.find((item) => item.id === doc.id);
        if (!current) break;
        latestStatus = current.status;
        if (latestStatus !== 'indexing') {
          if (latestStatus === 'error') {
            throw new Error(current.error || 'Reindex failed');
          }
          break;
        }
      }
      await knowledge.refetch(true);
      notify(
        latestStatus === 'indexing'
          ? `Reindex started for "${doc.title}"`
          : `Reindexed "${doc.title}"`,
        latestStatus === 'indexing' ? 'info' : 'success',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Reindex failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (doc: Doc) => {
    if (!window.confirm(`Delete "${doc.title}" and its ${doc.chunk_count} chunk(s)?`)) return;
    setBusyId(doc.id);
    try {
      await api.del(`/knowledge/${encodeURIComponent(doc.id)}`);
      await knowledge.refetch(true);
      notify('Document deleted', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Delete failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Give the agent private facts it can retrieve. Text is chunked, embedded locally, and searched with hybrid ranking."
        actions={
          <Button variant="outline" onClick={() => void knowledge.refetch()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Documents" value={fmtNumber(stats.documents)} icon={FileText} tone="primary" />
        <StatCard label="Chunks" value={fmtNumber(stats.chunks)} icon={Layers} tone="sky" />
        <StatCard
          label="Embedded"
          value={`${fmtNumber(stats.embeddedChunks)} / ${fmtNumber(stats.chunks)}`}
          hint={embeddings.ready ? 'Local embeddings ready' : 'Keyword-only fallback'}
          icon={Database}
          tone="violet"
        />
      </div>

      {!embeddings.ready && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200/90">
          Semantic embeddings are not loaded{embeddings.error ? `: ${embeddings.error}` : ''}. Search still works using
          keyword ranking.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="space-y-0">
            <CardTitle className="text-base">Add text</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Title">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Refund policy"
                maxLength={200}
              />
            </Field>
            <Field label="Content" hint="Markdown, notes, FAQs — up to 5 MB of text.">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={7}
                placeholder="Paste the facts the agent should know…"
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {fmtNumber(text.length)} characters
              </span>
              <Button disabled={!title.trim() || !text.trim() || adding} onClick={() => void addText()}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {adding ? 'Indexing…' : 'Add document'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-0">
            <CardTitle className="text-base">Upload a file</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/30 px-4 py-8 text-center transition-colors hover:border-primary/40 hover:bg-primary/5">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm font-medium">{file ? file.name : 'Choose a file'}</span>
              <span className="text-[11px] text-muted-foreground">PDF, DOCX, TXT, MD, CSV, JSON, HTML</span>
              <input
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {file && (
              <div className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-xs">
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
              </div>
            )}
            <Button className="w-full" disabled={!file || uploading} onClick={() => void upload()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? 'Uploading…' : 'Upload and index'}
            </Button>
            <p className="text-[11px] text-muted-foreground">Maximum file size 25 MB. Text is extracted locally.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="text-base">Search knowledge</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void search();
                }}
                placeholder="What is the refund policy?"
                className="pl-9"
              />
            </div>
            <Button onClick={() => void search()} disabled={!query.trim() || searching}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </div>

          {results !== null && (
            <div className="space-y-2">
              {results.length === 0 ? (
                <p className="rounded-lg border border-border bg-background/30 p-3 text-xs text-muted-foreground">
                  No passages matched. Try broader wording.
                </p>
              ) : (
                results.map((result, index) => (
                  <div key={`${result.documentId}-${result.chunkId}-${index}`} className="rounded-lg border border-border bg-background/40 p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-primary">{result.title}</span>
                      <Badge variant="outline" size="sm">{Math.round(result.score * 100)}%</Badge>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                      {result.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Documents</CardTitle>
          <Badge variant="outline" size="sm">{docs.length}</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {knowledge.loading && !data ? (
            <div className="p-4 text-sm text-muted-foreground">Loading documents…</div>
          ) : knowledge.error ? (
            <div className="p-4">
              <ErrorBlock message={knowledge.error} onRetry={() => void knowledge.refetch()} />
            </div>
          ) : docs.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={BookOpen}
                title="No knowledge yet"
                description="Add text or upload a document; it will be available to the agent immediately."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="table-th">Title</th>
                    <th className="table-th">Source</th>
                    <th className="table-th">Status</th>
                    <th className="table-th">Chars</th>
                    <th className="table-th">Chunks</th>
                    <th className="table-th">Added</th>
                    <th className="table-th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((doc) => {
                    const busy = busyId === doc.id;
                    return (
                      <tr key={doc.id} className="border-b border-border/60 last:border-0">
                        <td className="table-td max-w-64">
                          <p className="truncate font-medium">{doc.title}</p>
                          {doc.error && <p className="truncate text-[11px] text-red-300">{doc.error}</p>}
                        </td>
                        <td className="table-td text-xs text-muted-foreground">
                          {doc.source_name || doc.source_type}
                        </td>
                        <td className="table-td">
                          <Badge
                            size="sm"
                            variant={doc.status === 'ready' ? 'success' : doc.status === 'error' ? 'destructive' : 'warning'}
                          >
                            {doc.status}
                          </Badge>
                        </td>
                        <td className="table-td text-xs">{fmtNumber(doc.char_count)}</td>
                        <td className="table-td text-xs">{fmtNumber(doc.chunk_count)}</td>
                        <td className="table-td whitespace-nowrap text-xs text-muted-foreground">
                          {timeAgo(doc.created_at)}
                        </td>
                        <td className="table-td">
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void reindex(doc)}>
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                              Reindex
                            </Button>
                            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(doc)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
