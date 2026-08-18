"use client";

/**
 * Connectors tab — external tools + credentials that agents (and therefore
 * routines) can use. A connector is metadata + a pointer to a Secrets Manager
 * bundle; this page lists them, lets you enter credentials securely (the value
 * never comes back), and register a new one. Agents bind connectors by id (the
 * Routine Builder does this conversationally, or via agents.json).
 */

import { useCallback, useEffect, useState } from "react";
import { Plus, Plug, KeyRound, CheckCircle2, AlertCircle, Trash2, Boxes, Globe, ServerCog } from "lucide-react";
import type { ConnectorSummary, ConnectorKind } from "@/lib/connectors/types";
import CredentialModal from "@/components/connectors/CredentialModal";

const KIND_META: Record<ConnectorKind, { label: string; icon: typeof Globe; hint: string }> = {
  env: { label: "REST / env", icon: Globe, hint: "Credentials injected as env vars; agent calls the API" },
  mcp: { label: "MCP server", icon: ServerCog, hint: "Streamable-HTTP MCP server with a token header" },
  gateway: { label: "SigV4 gateway", icon: Boxes, hint: "AgentCore gateway signed with the runtime's IAM identity" },
};

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [credFor, setCredFor] = useState<ConnectorSummary | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const flash = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchConnectors = useCallback(async () => {
    try {
      const res = await fetch("/api/connectors");
      if (res.ok) setConnectors((await res.json()).connectors || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnectors();
    const t = setInterval(fetchConnectors, 8000);
    return () => clearInterval(t);
  }, [fetchConnectors]);

  const remove = async (c: ConnectorSummary) => {
    if (!confirm(`Delete connector "${c.name}"? This removes its stored credentials.`)) return;
    setConnectors((cs) => cs.filter((x) => x.id !== c.id));
    try {
      const res = await fetch(`/api/connectors/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      flash("Connector deleted");
    } catch {
      flash("Delete failed", "error");
      fetchConnectors();
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Plug className="w-5 h-5 text-[var(--color-brand-500)]" />
            Connectors
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            External tools + credentials your agents can use — Meta Ads, private APIs, MCP servers. Credentials live in Secrets Manager; agents get them just-in-time.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-brand-500)] hover:bg-[var(--color-brand-600)] text-white text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New connector
        </button>
      </div>

      {loading ? (
        <div className="text-center text-sm text-[var(--color-text-muted)] py-16">Loading connectors…</div>
      ) : connectors.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 border border-dashed border-[var(--color-border)] rounded-xl">
          <div className="w-14 h-14 rounded-full bg-[color-mix(in_srgb,var(--color-brand-500)_10%,transparent)] flex items-center justify-center mb-4">
            <Plug className="w-6 h-6 text-[var(--color-brand-500)]" />
          </div>
          <h3 className="text-base font-semibold text-[var(--color-text-primary)] mb-1">No connectors yet</h3>
          <p className="text-sm text-[var(--color-text-muted)] max-w-md">
            Register a connector to give an agent access to an outside service. The Routine Builder can also create these for you when a routine needs external data.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {connectors.map((c) => {
            const km = KIND_META[c.kind];
            const KindIcon = km.icon;
            const needsCreds = c.status === "needs_credentials";
            return (
              <div key={c.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <KindIcon className="w-4 h-4 text-[var(--color-brand-500)]" />
                    <div>
                      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{c.name}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">{km.label} · {c.id}</div>
                    </div>
                  </div>
                  <button onClick={() => remove(c)} className="text-[var(--color-text-muted)] hover:text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {c.description && <p className="text-xs text-[var(--color-text-muted)] mt-2">{c.description}</p>}

                <div className="flex items-center justify-between mt-3">
                  {needsCreds ? (
                    <span className="flex items-center gap-1 text-[11px] text-amber-500">
                      <AlertCircle className="w-3.5 h-3.5" /> Needs credentials
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-green-500">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Active
                    </span>
                  )}
                  {c.secretKeys.length > 0 && (
                    <button
                      onClick={() => setCredFor(c)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-[var(--color-bg-tertiary)] hover:bg-[color-mix(in_srgb,var(--color-brand-500)_10%,transparent)] text-[var(--color-text-secondary)]"
                    >
                      <KeyRound className="w-3 h-3" /> {needsCreds ? "Connect" : "Update"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {credFor && (
        <CredentialModal
          connector={credFor}
          onClose={() => setCredFor(null)}
          onSaved={() => {
            setCredFor(null);
            flash("Credentials saved");
            fetchConnectors();
          }}
        />
      )}

      {showNew && (
        <NewConnectorModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            flash("Connector created");
            fetchConnectors();
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed right-5 bottom-5 z-50 px-3 py-2 rounded-lg shadow-lg text-xs font-medium ${
            toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

function NewConnectorModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("env");
  const [secretKeys, setSecretKeys] = useState("");
  const [urlTemplate, setUrlTemplate] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          kind,
          secretKeys: secretKeys.split(",").map((s) => s.trim()).filter(Boolean),
          urlTemplate: kind === "mcp" ? urlTemplate : undefined,
          gatewayUrl: kind === "gateway" ? gatewayUrl : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create connector");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">New connector</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meta Ads"
              className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Facebook/Instagram ad performance via Graph API"
              className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ConnectorKind)}
              className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
            >
              <option value="env">REST / env — inject creds as env vars</option>
              <option value="mcp">MCP server — token in header</option>
              <option value="gateway">SigV4 gateway — IAM signed, no secret</option>
            </select>
          </label>
          {kind === "mcp" && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">MCP URL</span>
              <input
                value={urlTemplate}
                onChange={(e) => setUrlTemplate(e.target.value)}
                placeholder="https://tools.example.com/mcp"
                className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
              />
            </label>
          )}
          {kind === "gateway" && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">Gateway URL</span>
              <input
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                placeholder="https://abc.bedrock-agentcore.us-east-1.amazonaws.com/mcp"
                className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
              />
            </label>
          )}
          {kind !== "gateway" && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                Secret key names <span className="text-[var(--color-text-muted)]">(comma-separated — names only, not values)</span>
              </span>
              <input
                value={secretKeys}
                onChange={(e) => setSecretKeys(e.target.value)}
                placeholder="META_ACCESS_TOKEN, META_AD_ACCOUNT_ID"
                className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-500)]"
              />
            </label>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!name.trim() || saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-brand-500)] hover:bg-[var(--color-brand-600)] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
