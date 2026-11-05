import path from 'node:path';

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export type ExtractedFile = {
  title: string;
  text: string;
  mimeType: string;
};

export async function extractFile(filename: string, buffer: Buffer): Promise<ExtractedFile> {
  const ext = path.extname(filename).toLowerCase();
  const baseTitle = path.basename(filename, ext).replace(/[_-]+/g, ' ').trim() || 'Document';
  if (buffer.length > 25 * 1024 * 1024) throw new Error('File is too large (25 MB max).');

  if (['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.xml'].includes(ext)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/^\uFEFF/, '');
    return { title: baseTitle, text, mimeType: 'text/plain' };
  }

  if (['.html', '.htm'].includes(ext)) {
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    return { title: baseTitle, text: stripHtml(html), mimeType: 'text/html' };
  }

  if (ext === '.pdf') {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    if (typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('No selectable text found in this PDF. Scanned PDFs need OCR first.');
    }
    return { title: baseTitle, text: result.text, mimeType: 'application/pdf' };
  }

  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });
    if (!result.value.trim()) throw new Error('No text found in this Word document.');
    return {
      title: baseTitle,
      text: result.value,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }

  throw new Error(`Unsupported file type "${ext || 'unknown'}". Use TXT, MD, CSV, JSON, HTML, PDF, or DOCX.`);
}
