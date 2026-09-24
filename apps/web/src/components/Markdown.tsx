'use client';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Memoized: parsing Markdown (remark/rehype) is real CPU work, and this is
 * called once per message. Without memoization, any re-render of an ancestor
 * (e.g. a streaming sibling elsewhere in the tree) re-parses every instance
 * of this that's currently mounted.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
