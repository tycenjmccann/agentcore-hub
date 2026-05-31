"use client";

import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: MarkdownRendererProps) {
  return (
    <div className="prose prose-sm prose-invert max-w-none agent-output-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            // Unwrap <pre> so CodeBlock handles the presentation
            return <>{children}</>;
          },
          code({ children, className, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const content = String(children).replace(/\n$/, "");
            const isBlock = Boolean(match);

            if (isBlock) {
              const lang = match?.[1];
              // Skip CodeBlock chrome for "text" language — just render as plain pre
              if (lang === "text" || lang === "plaintext") {
                return (
                  <pre className="code-block-content" style={{ margin: "0.75rem 0", padding: "0.75rem 1rem", background: "rgba(13, 17, 23, 0.6)", borderRadius: "6px", border: "1px solid #21262d" }}>
                    <code>{content}</code>
                  </pre>
                );
              }
              return (
                <CodeBlock language={lang} className={className} highlightedHtml={content} />
              );
            }

            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...props }) {
            return (
              <img
                src={src}
                alt={alt || ""}
                loading="lazy"
                {...(props as React.ImgHTMLAttributes<HTMLImageElement>)}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
