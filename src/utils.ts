/** Small pure utils (truncation). */

export function truncateToBytes(text: string, maxBytes: number, suffix = ""): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end)) + suffix;
}

const MAX_CONTEXT_TURNS = 10;
const MAX_CONTEXT_CHARS = 20_000;

export function normalizeContextTurns(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(MAX_CONTEXT_TURNS, Math.floor(value)));
}

function partText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && (p as { type?: unknown }).type === "text") {
        const t = (p as { text?: unknown }).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .filter((t) => t.trim())
    .join("\n")
    .trim();
}

export function buildRecentContext(entries: unknown[], turns: number | undefined): string | undefined {
  const maxTurns = normalizeContextTurns(turns);
  const messages: Array<{ role: string; text: string }> = [];
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (e?.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = partText(e.message.content);
    if (!text) continue;
    messages.unshift({ role: role as string, text });
    if (role === "user") {
      seen++;
      if (seen >= maxTurns) break;
    }
  }
  if (messages.length === 0) return undefined;
  let rendered = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
  if (rendered.length > MAX_CONTEXT_CHARS) {
    rendered = `[truncated to last ${MAX_CONTEXT_CHARS} chars]\n` + rendered.slice(rendered.length - MAX_CONTEXT_CHARS).trimStart();
  }
  return rendered;
}
