"use client";

import React, { useState, useCallback, useRef, useEffect, memo } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  /** Pre-highlighted HTML from rehype-highlight, rendered via dangerouslySetInnerHTML. */
  highlightedHtml: string;
  language?: string;
  className?: string;
}

export const CodeBlock = memo(function CodeBlock({
  highlightedHtml,
  language,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clear copy-reset timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(highlightedHtml);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = highlightedHtml;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  }, [highlightedHtml]);

  return (
    <div
      className="code-block-wrapper group"
      role="region"
      aria-label={language ? `Code block, ${language}` : "Code block"}
    >
      <div className="code-block-header">
        <span className="code-block-lang">{language || "text"}</span>
        <button
          className={`code-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
          type="button"
        >
          {copied ? (
            <>
              <Check size={14} aria-hidden="true" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="code-block-content">
        <code className={className} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      </pre>
    </div>
  );
});

export default CodeBlock;
