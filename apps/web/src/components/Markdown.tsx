'use client';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { prepareMath } from '@/lib/math';

const remarkPlugins = [remarkGfm, remarkMath];
// throwOnError:false → a malformed/half-streamed formula shows as red source instead of crashing the message.
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' }],
];

/**
 * Memoized: parsing Markdown (remark/rehype) is real CPU work, and this is
 * called once per message. Without memoization, any re-render of an ancestor
 * (e.g. a streaming sibling elsewhere in the tree) re-parses every instance
 * of this that's currently mounted.
 */
export const Markdown = memo(function Markdown({
  content,
  onWikiLink,
}: {
  content: string;
  /** When set, Obsidian-style [[Note]] / [[Note|label]] links render as in-app links. */
  onWikiLink?: (target: string) => void;
}) {
  const linked = onWikiLink
    ? content.replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_m, t: string, label?: string) =>
        `[${(label || t).trim()}](#wiki:${encodeURIComponent(t.trim())})`,
      )
    : content;
  const text = prepareMath(linked);
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          a: ({ href, ...props }) =>
            onWikiLink && href?.startsWith('#wiki:') ? (
              <a
                {...props}
                href={href}
                className="wikilink"
                onClick={(e) => {
                  e.preventDefault();
                  onWikiLink(decodeURIComponent(href.slice(6)));
                }}
              />
            ) : (
              <a target="_blank" rel="noreferrer" href={href} {...props} />
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
