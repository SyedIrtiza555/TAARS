import type { ReactNode } from 'react';

const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|_[^_\n]+_|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN).filter((part) => part !== '');
  return parts.map((part, index) => {
    const key = `${keyBase}-${index}`;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {part.slice(1, -1)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.9em] text-emerald-300"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }

    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a
          key={key}
          href={link[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {link[1]}
        </a>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

/**
 * Small, dependency-free renderer for the formatting the agent actually emits:
 * WhatsApp-style bold/italic, inline code, fenced code, links, and lists.
 * Everything is rendered as React text nodes (no dangerouslySetInnerHTML).
 */
export function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let bullets: string[] = [];
  let numbers: string[] = [];
  let code: string[] | null = null;

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1.5 list-disc space-y-1 pl-5">
        {items.map((item, index) => (
          <li key={index}>{inline(item, `ul-${blocks.length}-${index}`)}</li>
        ))}
      </ul>,
    );
  };

  const flushNumbers = () => {
    if (numbers.length === 0) return;
    const items = numbers;
    numbers = [];
    blocks.push(
      <ol key={`ol-${blocks.length}`} className="my-1.5 list-decimal space-y-1 pl-5">
        {items.map((item, index) => (
          <li key={index}>{inline(item, `ol-${blocks.length}-${index}`)}</li>
        ))}
      </ol>,
    );
  };

  const flushAll = () => {
    flushBullets();
    flushNumbers();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim().startsWith('```')) {
      if (code === null) {
        flushAll();
        code = [];
      } else {
        const body = code.join('\n');
        code = null;
        blocks.push(
          <pre
            key={`code-${blocks.length}`}
            className="my-2 overflow-x-auto rounded-lg border border-border bg-black/40 p-3 font-mono text-xs leading-relaxed text-emerald-200/90"
          >
            <code>{body}</code>
          </pre>,
        );
      }
      continue;
    }

    if (code !== null) {
      code.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const bullet = /^\s*[•\-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushNumbers();
      bullets.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushBullets();
      numbers.push(numbered[1]);
      continue;
    }

    flushAll();
    blocks.push(
      <p key={`p-${blocks.length}`} className="my-1 first:mt-0 last:mb-0">
        {inline(line, `p-${blocks.length}-${index}`)}
      </p>,
    );
  }

  if (code !== null) {
    blocks.push(
      <pre
        key={`code-${blocks.length}`}
        className="my-2 overflow-x-auto rounded-lg border border-border bg-black/40 p-3 font-mono text-xs text-emerald-200/90"
      >
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }
  flushAll();

  return <div className="space-y-1 break-words leading-relaxed">{blocks}</div>;
}
