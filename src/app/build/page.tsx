"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Send, Bot, User, Rocket, Copy, Check, RefreshCw, MessageSquare } from "lucide-react";
import { streamBuilderChat, HarnessConfig, deployHarnessAgent, parseHarnessConfig } from "@/lib/agentcore-stream";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

export default function BuildPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "agent",
      content: "I'm the Agent Builder. Tell me what kind of agent you need and I'll generate a harness configuration for you.\n\nFor example:\n- \"I need a backend API agent that writes Go microservices\"\n- \"Create a security audit agent\"\n- \"Build me an iOS agent for SwiftUI development\"",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ agentId: string; status: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    const agentMsgId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      { id: agentMsgId, role: "agent", content: "", timestamp: new Date().toISOString() },
    ]);

    // Build history from previous messages (exclude the latest user message we just added)
    const history = messages
      .filter((m) => m.id !== "welcome" && m.content.trim())
      .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content }));

    try {
      await streamBuilderChat({
        prompt: input,
        sessionId,
        history,
        onChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === agentMsgId ? { ...msg, content: msg.content + chunk } : msg
            )
          );
        },
        onConfig: (newConfig) => {
          setConfig(newConfig);
        },
        onDone: (fullResponse) => {
          // Try to extract config from the agent's text output (harness agent mode)
          if (!config) {
            const extracted = parseHarnessConfig(fullResponse);
            if (extracted) setConfig(extracted);
          }
          setIsStreaming(false);
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === agentMsgId
                ? { ...msg, content: `Error: ${err.message}` }
                : msg
            )
          );
          setIsStreaming(false);
        },
      });
    } catch {
      setIsStreaming(false);
    }
  }, [input, isStreaming, sessionId]);

  const handleDeploy = async () => {
    if (!config) return;
    setDeploying(true);
    try {
      const result = await deployHarnessAgent(config);
      setDeployResult(result);
    } catch (err) {
      setDeployResult({ agentId: "", status: `Failed: ${err}` });
    } finally {
      setDeploying(false);
    }
  };

  const handleCopy = () => {
    if (!config) return;
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 overflow-hidden">
      {/* Left Panel - Chat with Builder Agent */}
      <div className="flex-1 flex flex-col min-w-0 w-0">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-4 h-4 text-brand-400" />
          <h2 className="text-sm font-semibold text-gray-300">Agent Builder Chat</h2>
          <span className="text-xs bg-brand-600/20 text-brand-400 px-2 py-0.5 rounded-full">
            Harness Mode
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-3 pb-3" data-testid="builder-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "agent" && (
                <div className="w-7 h-7 bg-brand-600/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-brand-400" />
                </div>
              )}
              <div
                className={`max-w-[85%] overflow-hidden ${
                  msg.role === "user"
                    ? "bg-brand-600/20 border border-brand-600/30 rounded-2xl rounded-tr-sm"
                    : "bg-surface-2 border border-surface-4 rounded-2xl rounded-tl-sm"
                } px-3 py-2`}
              >
                {msg.role === "agent" ? (
                  <div className="text-sm text-gray-200 prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-cyan-300 prose-code:bg-surface-1 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-surface-1 prose-pre:border prose-pre:border-surface-4 prose-a:text-brand-400 break-words">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-200 whitespace-pre-wrap">{msg.content}</p>
                )}
                {msg.role === "agent" && isStreaming && msg.id === messages[messages.length - 1]?.id && (
                  <div className="flex items-center gap-1 mt-1.5">
                    <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="w-7 h-7 bg-surface-3 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <User className="w-3.5 h-3.5 text-gray-400" />
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-surface-4 pt-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Describe the agent you want to build..."
              rows={1}
              className="flex-1 bg-surface-2 border border-surface-4 rounded-xl px-3 py-2.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-brand-500/50 resize-none overflow-y-auto"
              style={{ maxHeight: "120px" }}
              data-testid="build-description-input"
              disabled={isStreaming}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              className="btn-primary p-2.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
              data-testid="build-submit-btn"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[10px] text-gray-600 mt-1">Shift+Enter for new line</p>
        </div>
      </div>

      {/* Right Panel - Live Config Preview */}
      <div className="w-[420px] flex flex-col border-l border-surface-4 pl-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">Harness Configuration</h2>
          {config && (
            <button
              onClick={handleCopy}
              className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>

        {/* Config Display */}
        <div className="flex-1 overflow-y-auto">
          {config ? (
            <div className="bg-surface-1 border border-surface-4 rounded-lg p-3 font-mono text-xs">
              <pre className="text-gray-300 whitespace-pre-wrap overflow-x-auto" data-testid="config-preview">
                {JSON.stringify(config, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="w-12 h-12 bg-surface-2 rounded-xl flex items-center justify-center mb-3">
                <RefreshCw className="w-5 h-5 text-gray-600" />
              </div>
              <p className="text-sm text-gray-500">
                Chat with the builder agent to generate your agent&apos;s harness configuration.
              </p>
              <p className="text-xs text-gray-600 mt-2">
                The config will appear here as the agent creates it.
              </p>
            </div>
          )}
        </div>

        {/* Deploy Button */}
        <div className="border-t border-surface-4 pt-3 mt-3">
          {deployResult ? (
            <div className="bg-green-400/10 border border-green-400/30 rounded-lg p-3">
              <p className="text-xs text-green-400 font-medium">Agent Deployed!</p>
              <p className="text-xs text-gray-400 mt-1">ID: {deployResult.agentId}</p>
              <p className="text-xs text-gray-500 mt-0.5">Status: {deployResult.status}</p>
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => router.push(`/invoke?agent=${deployResult.agentId}`)}
                  className="text-xs text-brand-400 hover:underline flex items-center gap-1"
                >
                  <MessageSquare className="w-3 h-3" />
                  Chat with this agent
                </button>
                <button
                  onClick={() => { setDeployResult(null); setConfig(null); }}
                  className="text-xs text-gray-500 hover:underline"
                >
                  Build another
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleDeploy}
              disabled={!config || deploying}
              className="w-full btn-primary flex items-center justify-center gap-2 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="deploy-agent-btn"
            >
              {deploying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket className="w-4 h-4" />
                  Deploy Agent
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
