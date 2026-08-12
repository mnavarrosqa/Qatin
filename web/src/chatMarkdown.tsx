import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './components/Icon';

const OL_RE = /^(\d+)[.)]\s+(.*)$/;
const UL_RE = /^[-*•]\s+(.*)$/;
const HEADING_RE = /^(#{2,3})\s+(.*)$/;
const CSV_HEADER_RE = /^summary\s*,\s*description\b/i;

type ListItem = {
  text: string;
  notes?: string[];
  children?: string[];
};

type CsvBlock = {
  type: 'csv';
  headers: string[];
  rows: string[][];
};

type ContentBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'para'; text: string }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; items: ListItem[]; start?: number }
  | { type: 'code'; text: string }
  | CsvBlock;

type OpenList = {
  type: 'ol' | 'ul';
  start?: number;
  items: ListItem[];
};

function extractScreenshots(text: string): string[] {
  const matches = text.match(/\/screenshots\/[^\s)]+/g);
  return matches ? [...new Set(matches)] : [];
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(
    /(\*\*[^*]+\*\*|`[^`]+`|\/screenshots\/[^\s)]+|\/runs\?id=\d+|[A-Z][A-Z0-9]+-\d+)/g
  );
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('/screenshots/')) {
      return null;
    }
    if (/^\/runs\?id=\d+$/.test(part)) {
      return (
        <Link key={key} className="chat-inline-link" to={part}>
          Ejecuciones
        </Link>
      );
    }
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(part)) {
      return (
        <span key={key} className="chat-ticket">
          {part}
        </span>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function lastItem(open: OpenList | null): ListItem | null {
  if (!open?.items.length) return null;
  return open.items[open.items.length - 1];
}

function parseLines(chunk: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let open: OpenList | null = null;
  let paraBuf: string[] = [];

  const flushList = () => {
    if (!open) return;
    if (open.type === 'ol') {
      blocks.push({
        type: 'ol',
        items: open.items,
        ...(open.start && open.start !== 1 ? { start: open.start } : {}),
      });
    } else {
      blocks.push({ type: 'ul', items: open.items });
    }
    open = null;
  };

  const flushPara = () => {
    if (!paraBuf.length) return;
    const text = paraBuf.join('\n').trim();
    paraBuf = [];
    if (!text) return;

    const item = lastItem(open);
    if (open?.type === 'ol' && item) {
      if (item.children?.length) {
        flushList();
        blocks.push({ type: 'para', text });
      } else {
        item.notes = item.notes || [];
        item.notes.push(text);
      }
      return;
    }

    flushList();
    blocks.push({ type: 'para', text });
  };

  for (const raw of chunk.split('\n')) {
    const trimmed = raw.trim();

    if (!trimmed) {
      flushPara();
      continue;
    }

    const heading = trimmed.match(HEADING_RE);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({
        type: 'heading',
        level: heading[1] === '###' ? 3 : 2,
        text: heading[2],
      });
      continue;
    }

    const ol = trimmed.match(OL_RE);
    if (ol) {
      flushPara();
      const n = Number(ol[1]);
      if (open?.type !== 'ol') {
        flushList();
        open = { type: 'ol', start: n, items: [] };
      }
      open.items.push({ text: ol[2] });
      continue;
    }

    const ul = trimmed.match(UL_RE);
    if (ul) {
      flushPara();
      const item = lastItem(open);
      if (open?.type === 'ol' && item) {
        item.children = item.children || [];
        item.children.push(ul[1]);
        continue;
      }
      if (open?.type !== 'ul') {
        flushList();
        open = { type: 'ul', items: [] };
      }
      open.items.push({ text: ul[1] });
      continue;
    }

    paraBuf.push(trimmed);
  }

  flushPara();
  flushList();
  return blocks;
}

function isCsvHeader(line: string): boolean {
  return CSV_HEADER_RE.test(line.trim());
}

function looksLikeCsv(lang: string, text: string): boolean {
  if (lang === 'csv' || lang === 'tsv') return true;
  const first = text.trim().split('\n').find((line) => line.trim());
  return Boolean(first && isCsvHeader(first));
}

function parseCsv(input: string): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushRow = () => {
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  if (!inQuotes && (field.length > 0 || row.length > 0)) {
    row.push(field);
    pushRow();
  }

  return { rows, complete: !inQuotes };
}

function csvBlockFromText(text: string): CsvBlock {
  const { rows } = parseCsv(text);
  if (!rows.length) {
    return { type: 'csv', headers: [], rows: [] };
  }
  return {
    type: 'csv',
    headers: rows[0],
    rows: rows.slice(1),
  };
}

function splitUnfencedCsv(chunk: string): ContentBlock[] {
  const lines = chunk.split('\n');
  const headerIdx = lines.findIndex((line) => isCsvHeader(line));
  if (headerIdx < 0) return parseLines(chunk);

  const before = lines.slice(0, headerIdx).join('\n');
  const csvText = lines.slice(headerIdx).join('\n');
  const blocks: ContentBlock[] = [];
  if (before.trim()) blocks.push(...parseLines(before));
  blocks.push(csvBlockFromText(csvText));
  return blocks;
}

function parseBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf('```', i);
    if (start < 0) {
      const rest = text.slice(i);
      if (rest) blocks.push(...splitUnfencedCsv(rest));
      break;
    }
    if (start > i) {
      blocks.push(...splitUnfencedCsv(text.slice(i, start)));
    }

    const afterOpen = start + 3;
    const nl = text.indexOf('\n', afterOpen);
    const langEnd = nl < 0 ? text.length : nl;
    const lang = text.slice(afterOpen, langEnd).trim().toLowerCase();
    const bodyStart = nl < 0 ? text.length : nl + 1;
    const close = text.indexOf('```', bodyStart);
    const closed = close >= 0;
    const inner = (closed ? text.slice(bodyStart, close) : text.slice(bodyStart))
      .replace(/\n$/, '');

    if (looksLikeCsv(lang, inner)) {
      blocks.push(csvBlockFromText(inner));
    } else {
      blocks.push({ type: 'code', text: inner });
    }

    if (!closed) break;
    i = close + 3;
    if (text[i] === '\n') i += 1;
  }

  return blocks;
}

function serializeCsv(headers: string[], rows: string[][]): string {
  const esc = (cell: string) => {
    if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
    return cell;
  };
  return [headers, ...rows].map((row) => row.map(esc).join(',')).join('\n');
}

function downloadCsv(headers: string[], rows: string[][]) {
  const blob = new Blob([serializeCsv(headers, rows) + '\n'], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'casos-xray.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function CsvTable({
  block,
  streaming,
}: {
  block: CsvBlock;
  streaming: boolean;
}) {
  const generating = streaming;
  const ready = !streaming && block.headers.length > 0 && block.rows.length > 0;

  return (
    <div className="chat-csv">
      <div className="chat-csv-bar">
        <div className="chat-csv-meta">
          <span className="chat-csv-title">CSV para Xray</span>
          {block.rows.length > 0 ? (
            <span className="chat-csv-count">
              {block.rows.length} {block.rows.length === 1 ? 'fila' : 'filas'}
            </span>
          ) : generating ? (
            <span className="chat-csv-count">Generando…</span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => downloadCsv(block.headers, block.rows)}
          disabled={!ready}
        >
          <Icon name="download" size={14} />
          Descargar
        </button>
      </div>
      {block.headers.length > 0 ? (
        <div className="chat-csv-scroll">
          <table aria-label="Casos en CSV para Xray">
            <thead>
              <tr>
                {block.headers.map((h, i) => (
                  <th key={`${i}-${h}`}>{h.trim() || `Col ${i + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {block.headers.map((_, ci) => (
                    <td key={ci} title={row[ci] || ''}>
                      {row[ci] || ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="chat-csv-empty">
          {generating ? (
            <span className="chat-stream-caret" aria-hidden />
          ) : null}
          Armando el archivo…
        </p>
      )}
      {generating && block.headers.length > 0 ? (
        <p className="chat-csv-status">
          <span className="chat-stream-caret" aria-hidden />
          Generando filas…
        </p>
      ) : null}
    </div>
  );
}

function ListItemView({
  item,
  itemKey,
  titled,
}: {
  item: ListItem;
  itemKey: string;
  titled?: boolean;
}) {
  const hasBody = Boolean(item.notes?.length || item.children?.length);
  return (
    <li>
      {item.text ? (
        titled && hasBody ? (
          <p className="chat-li-title">{renderInline(item.text, itemKey)}</p>
        ) : (
          renderInline(item.text, itemKey)
        )
      ) : null}
      {item.notes?.map((note, i) => (
        <p key={`${itemKey}-n${i}`} className="chat-li-note">
          {renderInline(note, `${itemKey}-n${i}`)}
        </p>
      ))}
      {item.children?.length ? (
        <ul className="chat-list chat-list-nested">
          {item.children.map((child, i) => (
            <li key={i}>{renderInline(child, `${itemKey}-c${i}`)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function MessageBody({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const shots = extractScreenshots(text);
  const cleaned = text
    .replace(/\/screenshots\/[^\s)]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const blocks = cleaned ? parseBlocks(cleaned) : [];
  const last = blocks[blocks.length - 1];
  const caretAfterText = streaming && last?.type !== 'csv';

  return (
    <div className="chat-content">
      {blocks.map((block, bi) => {
        const key = `b-${bi}`;
        if (block.type === 'heading') {
          const Tag = block.level === 3 ? 'h4' : 'h3';
          return (
            <Tag key={key} className={`chat-heading chat-heading-${block.level}`}>
              {renderInline(block.text, key)}
            </Tag>
          );
        }
        if (block.type === 'csv') {
          return (
            <CsvTable
              key={key}
              block={block}
              streaming={streaming && bi === blocks.length - 1}
            />
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={key} className="chat-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={key} className="chat-list">
              {block.items.map((item, li) => (
                <ListItemView
                  key={li}
                  item={item}
                  itemKey={`${key}-${li}`}
                />
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol
              key={key}
              className="chat-list chat-list-ol"
              start={block.start}
            >
              {block.items.map((item, li) => (
                <ListItemView
                  key={li}
                  item={item}
                  itemKey={`${key}-${li}`}
                  titled
                />
              ))}
            </ol>
          );
        }
        const lines = block.text.split('\n');
        return (
          <p key={key} className="chat-para">
            {lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${key}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
      {caretAfterText && <span className="chat-stream-caret" aria-hidden />}
      {shots.length > 0 && (
        <div className="chat-shots">
          <p className="chat-shots-label">Evidencias</p>
          <div className="chat-shots-grid">
            {shots.map((url, i) => (
              <a
                key={url}
                className="chat-shot-link"
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Abrir evidencia"
              >
                <img
                  className="chat-shot"
                  src={url}
                  alt={`Evidencia ${i + 1}`}
                  loading="lazy"
                />
                <span className="chat-shot-cap">Ver completa</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
