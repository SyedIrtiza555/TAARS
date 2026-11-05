import { useState, useCallback, useEffect, useRef } from 'react';
import { X, Check, Pointer } from 'lucide-react';
import { Button, Input, Textarea, Card, CardContent } from '../components/ui';

export function AnnotationOverlay() {
  const [open, setOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Array<{ selector: string; comment: string }>>([]);
  const [selector, setSelector] = useState('');
  const [comment, setComment] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/annotations');
      const data = (await res.json()) as { annotations: Array<{ selector: string; comment: string }> };
      setAnnotations(data.annotations || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const path = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').filter(Boolean).join('.') : '');
      setSelector(path);
      setHovered(String(el.getAttribute('data-annotation-id') || path.slice(0, 80)));
    };
    window.addEventListener('mousemove', onMove, { capture: true });
    return () => window.removeEventListener('mousemove', onMove, { capture: true });
  }, [open]);

  const saveAnnotation = async () => {
    if (!selector.trim() || !comment.trim()) return;
    const next = [...annotations, { selector: selector.trim(), comment: comment.trim() }];
    setAnnotations(next);
    setComment('');
    try {
      await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: next }),
      });
    } catch {
      // best effort
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="fixed bottom-6 right-6 z-50 shadow-xl"
        onClick={() => setOpen((v) => !v)}
        title="Annotation mode"
      >
        <Pointer className="h-4 w-4" />
        Annotate UI
      </Button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-end p-6 pointer-events-none">
          <Card className="w-80 pointer-events-auto shadow-2xl">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Annotation mode</p>
                <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              </div>
              <p className="text-xs text-muted-foreground">Hover over any element to capture its selector, then add a comment.</p>
              <div className="rounded-lg border border-border bg-background/50 px-2 py-1.5 text-[11px] font-mono truncate">{hovered || 'No element selected'}</div>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="What should be fixed or changed here?" className="text-xs" />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); setComment(''); }}>Cancel</Button>
                <Button size="sm" onClick={() => void saveAnnotation()} disabled={!selector.trim() || !comment.trim()}>
                  <Check className="h-3.5 w-3.5" /> Save
                </Button>
              </div>
              {annotations.length > 0 && (
                <div className="max-h-40 overflow-y-auto space-y-1.5 rounded-lg border border-border bg-muted/20 p-2">
                  {annotations.map((a, i) => (
                    <div key={i} className="text-[10px] leading-snug">
                      <span className="font-mono text-muted-foreground">{a.selector.slice(0, 40)}</span>
                      <span className="text-muted-foreground">: {a.comment}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
