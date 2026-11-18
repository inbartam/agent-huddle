/**
 * Draws an agent reply from view/markdown.ts as React elements. Every string is a text child, never HTML
 * (SECURITY.md): a reply that contains `<script>` shows those characters.
 */
import { Fragment } from 'react';
import { parseInline, parseMarkdown, type Block } from '../view/markdown.js';

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === 'code' ? (
          <code key={i} className="md-code">
            {part.text}
          </code>
        ) : part.kind === 'strong' ? (
          <strong key={i}>{part.text}</strong>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6';
      return (
        <Tag className={`md-h md-h${String(block.level)}`}>
          <InlineText text={block.text} />
        </Tag>
      );
    }
    case 'para':
      return (
        <p className="md-p">
          <InlineText text={block.text} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <InlineText text={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      );
    }
    case 'code':
      return (
        <pre className="md-pre" aria-label={block.lang ? `${block.lang} code` : 'Code'}>
          <code>{block.text}</code>
        </pre>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i}>
                    <InlineText text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>
                      <InlineText text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'quote':
      return (
        <blockquote className="md-quote">
          <InlineText text={block.text} />
        </blockquote>
      );
    case 'rule':
      return <hr className="md-rule" />;
  }
}

export function MessageText({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
