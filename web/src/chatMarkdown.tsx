import type { ReactNode } from 'react';

const OL_RE = /^(\d+)[.)]\s+(.*)$/;
const UL_RE = /^[-*•]\s+(.*)$/;
const HEADING_RE = /^(#{2,3})\s+(.*)$/;

type ListItem = {
  text: string;
  notes?: string[];
  children?: string[];
};

type ContentBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'para'; text: string }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; items: ListItem[]; start?: number }
  | { type: 'code'; text: string };

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
    /(\*\*[^*]+\*\*|`[^`]+`|\/screenshots\/[^\s)]+|[A-Z][A-Z0-9]+-\d+)/g
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

function parseBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const fenceSplit = text.split(/(```[\s\S]*?```)/g);

  for (const chunk of fenceSplit) {
    if (!chunk) continue;
    if (chunk.startsWith('```') && chunk.endsWith('```')) {
      const inner = chunk.slice(3, -3).replace(/^\w*\n?/, '');
      blocks.push({ type: 'code', text: inner.replace(/\n$/, '') });
      continue;
    }
    blocks.push(...parseLines(chunk));
  }

  return blocks;
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
      {streaming && <span className="chat-stream-caret" aria-hidden />}
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
