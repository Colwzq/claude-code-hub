import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UsageMetrics } from "@/app/v1/_lib/proxy/response-handler";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { logger } from "@/lib/logger";

export const AUDIT_ARCHIVE_SCHEMA_VERSION = "cch-audit-archive-event-v1";

export type AuditArchiveTurnEvent = {
  schemaVersion: typeof AUDIT_ARCHIVE_SCHEMA_VERSION;
  eventType: "turn_completed";
  eventId: string;
  capturedAt: string;
  messageRequestId: number;
  createdAt: string;
  sessionId: string | null;
  requestSequence: number | null;
  user: {
    id: number | null;
    name: string | null;
  };
  key: {
    id: number | null;
    name: string | null;
  };
  client: {
    ip: string | null;
    userAgent: string | null;
  };
  routing: {
    providerId: number | null;
    providerName: string | null;
    providerType: string | null;
    model: string | null;
    originalModel: string | null;
    actualResponseModel: string | null;
    endpoint: string | null;
    statusCode: number;
    isStreaming: boolean;
    clientAborted: boolean;
    errorMessage: string | null;
  };
  metrics: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
    cacheCreation5mInputTokens: number | null;
    cacheCreation1hInputTokens: number | null;
    cacheTtlApplied: string | null;
    durationMs: number;
    ttfbMs: number | null;
    costUsd: string | null;
    sseEventCount: number | null;
  };
  requestAfter: unknown;
  responseAfter: string;
};

export type CaptureAuditArchiveTurnInput = {
  session: ProxySession;
  responseText: string;
  usageMetrics: UsageMetrics | null | undefined;
  costUsd?: string;
  statusCode: number;
  durationMs: number;
  isStreaming: boolean;
  sseEventCount?: number;
  errorMessage?: string;
  actualResponseModel?: string | null;
  clientAborted?: boolean;
};

function auditArchiveEnabled(): boolean {
  return process.env.AUDIT_ARCHIVE_ENABLED === "true" || process.env.AUDIT_ARCHIVE_ENABLED === "1";
}

function getSpoolDir(): string {
  return process.env.AUDIT_ARCHIVE_SPOOL_DIR || "/app/data/audit-spool";
}

function parseForwardedRequestBody(session: ProxySession): unknown {
  const body = session.forwardedRequestBody;
  if (!body) {
    return session.request.message;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function writeEventAtomically(event: AuditArchiveTurnEvent): Promise<void> {
  const baseDir = getSpoolDir();
  const pendingDir = path.join(baseDir, "pending");
  const tmpDir = path.join(baseDir, "tmp");
  await mkdir(pendingDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const fileName = `${event.createdAt.replace(/[:.]/g, "-")}-${event.messageRequestId}-${event.eventId}.json`;
  const tmpPath = path.join(tmpDir, fileName);
  const pendingPath = path.join(pendingDir, fileName);
  await writeFile(tmpPath, `${JSON.stringify(event)}\n`, "utf8");
  await rename(tmpPath, pendingPath);
}

export function captureAuditArchiveTurn(input: CaptureAuditArchiveTurnInput): void {
  if (!auditArchiveEnabled()) return;

  const { session } = input;
  const messageContext = session.messageContext;
  if (!messageContext) return;

  const event: AuditArchiveTurnEvent = {
    schemaVersion: AUDIT_ARCHIVE_SCHEMA_VERSION,
    eventType: "turn_completed",
    eventId: randomUUID(),
    capturedAt: new Date().toISOString(),
    messageRequestId: messageContext.id,
    createdAt: messageContext.createdAt.toISOString(),
    sessionId: session.sessionId,
    requestSequence: session.getRequestSequence(),
    user: {
      id: messageContext.user?.id ?? null,
      name: messageContext.user?.name ?? null,
    },
    key: {
      id: messageContext.key?.id ?? null,
      name: messageContext.key?.name ?? null,
    },
    client: {
      ip: session.clientIp ?? null,
      userAgent: session.userAgent ?? null,
    },
    routing: {
      providerId: session.provider?.id ?? null,
      providerName: session.provider?.name ?? null,
      providerType: session.provider?.providerType ?? null,
      model: session.getCurrentModel(),
      originalModel: session.getOriginalModel(),
      actualResponseModel: input.actualResponseModel ?? null,
      endpoint: session.getEndpoint(),
      statusCode: input.statusCode,
      isStreaming: input.isStreaming,
      clientAborted: input.clientAborted ?? false,
      errorMessage: input.errorMessage ?? null,
    },
    metrics: {
      inputTokens: input.usageMetrics?.input_tokens ?? null,
      outputTokens: input.usageMetrics?.output_tokens ?? null,
      cacheCreationInputTokens: input.usageMetrics?.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: input.usageMetrics?.cache_read_input_tokens ?? null,
      cacheCreation5mInputTokens: input.usageMetrics?.cache_creation_5m_input_tokens ?? null,
      cacheCreation1hInputTokens: input.usageMetrics?.cache_creation_1h_input_tokens ?? null,
      cacheTtlApplied: input.usageMetrics?.cache_ttl ?? null,
      durationMs: input.durationMs,
      ttfbMs: session.ttfbMs,
      costUsd: input.costUsd ?? null,
      sseEventCount: input.sseEventCount ?? null,
    },
    requestAfter: parseForwardedRequestBody(session),
    responseAfter: input.responseText,
  };

  void writeEventAtomically(event).catch((error) => {
    logger.error("[AuditArchive] Failed to spool turn event", {
      error: error instanceof Error ? error.message : String(error),
      messageRequestId: messageContext.id,
    });
  });
}
