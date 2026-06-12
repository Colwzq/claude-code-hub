import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import postgres from "postgres";

const SCHEMA_VERSION = "cch-audit-export-v1";
const EVENT_SCHEMA_VERSION = "cch-audit-archive-event-v1";
const SPOOL_DIR = process.env.AUDIT_ARCHIVE_SPOOL_DIR || "/app/data/audit-spool";
const PENDING_DIR = path.join(SPOOL_DIR, "pending");
const PROCESSING_DIR = path.join(SPOOL_DIR, "processing");
const FAILED_DIR = path.join(SPOOL_DIR, "failed");
const EXPORT_TMP_DIR = path.join(SPOOL_DIR, "exports-tmp");
const POLL_INTERVAL_MS = Number.parseInt(process.env.AUDIT_ARCHIVE_WORKER_POLL_INTERVAL_MS || "2000", 10);
const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.AUDIT_ARCHIVE_WORKER_CONCURRENCY || "1", 10)
);
const GZIP_LEVEL = Math.min(
  9,
  Math.max(1, Number.parseInt(process.env.AUDIT_ARCHIVE_GZIP_LEVEL || "1", 10))
);
const DAILY_EXPORT_TIME = process.env.AUDIT_ARCHIVE_DAILY_EXPORT_TIME || "02:00";
const EXPORT_TIME_ZONE = process.env.AUDIT_ARCHIVE_TIME_ZONE || process.env.TZ || "Asia/Shanghai";
const EXPORT_ON_START = process.env.AUDIT_ARCHIVE_EXPORT_ON_START === "true";
const BUCKET = process.env.AUDIT_ARCHIVE_S3_BUCKET || "cch-audit-archive";
const S3_ENDPOINT = process.env.AUDIT_ARCHIVE_S3_ENDPOINT || "http://minio:9000";
const S3_ACCESS_KEY = process.env.AUDIT_ARCHIVE_S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.AUDIT_ARCHIVE_S3_SECRET_KEY || "";
const S3_REGION = process.env.AUDIT_ARCHIVE_S3_REGION || "us-east-1";
const S3_FORCE_PATH_STYLE = process.env.AUDIT_ARCHIVE_S3_FORCE_PATH_STYLE !== "false";
const DSN = process.env.DSN;

if (!DSN) {
  console.error("[AuditWorker] DSN is required");
  process.exit(1);
}

if (!S3_ACCESS_KEY || !S3_SECRET_KEY) {
  console.error("[AuditWorker] AUDIT_ARCHIVE_S3_ACCESS_KEY/SECRET_KEY are required");
  process.exit(1);
}

const sql = postgres(DSN, { max: 4 });

function log(message, details) {
  if (details === undefined) {
    console.log(`[AuditWorker] ${message}`);
    return;
  }
  console.log(`[AuditWorker] ${message}`, JSON.stringify(details));
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256String(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortJson(value[key]);
    }
    return result;
  }
  return value;
}

function gzipJson(value) {
  return gzipSync(Buffer.from(`${stableStringify(value)}\n`, "utf8"), { level: GZIP_LEVEL });
}

function gzipText(value) {
  return gzipSync(Buffer.from(value.endsWith("\n") ? value : `${value}\n`, "utf8"), {
    level: GZIP_LEVEL,
  });
}

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }
  return date;
}

function dateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EXPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getPreviousDateKey(now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

function requestMessagesFromBody(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) return { source: "messages", messages: body.messages };
  if (Array.isArray(body.input)) return { source: "input", messages: body.input };
  if (Array.isArray(body.contents)) return { source: "contents", messages: body.contents };
  if (body.request && typeof body.request === "object" && Array.isArray(body.request.contents)) {
    return { source: "request.contents", messages: body.request.contents };
  }
  return null;
}

function inferRole(segment) {
  if (!segment || typeof segment !== "object") return null;
  if (typeof segment.role === "string") return segment.role;
  if (typeof segment.type === "string") return segment.type;
  return null;
}

function walkContentBlocks(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkContentBlocks(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value.content)) walkContentBlocks(value.content, visitor);
  if (Array.isArray(value.contents)) walkContentBlocks(value.contents, visitor);
  if (Array.isArray(value.parts)) walkContentBlocks(value.parts, visitor);
}

function extractToolEvents(segment, segmentSha, createdAt) {
  const events = [];
  walkContentBlocks(segment, (block) => {
    if (["tool_use", "tool_result", "server_tool_use"].includes(block.type)) {
      events.push({
        tool_name: block.name ?? block.tool_name ?? block.toolUseId ?? block.tool_use_id ?? "unknown",
        event_type: block.type,
        source: "structured",
        segment_sha256: segmentSha,
        created_at: createdAt,
      });
    }

    const text = typeof block.text === "string" ? block.text : null;
    if (text) {
      const matches = text.matchAll(/\bCalled the\s+([A-Za-z0-9_.:-]+)\s+tool\b/g);
      for (const match of matches) {
        events.push({
          tool_name: match[1],
          event_type: "called_tool_text",
          source: "claude_code_text",
          segment_sha256: segmentSha,
          created_at: createdAt,
        });
      }
    }
  });
  return events;
}

function objectKeyFor(kind, sha, ext) {
  return `${kind}/sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${ext}.gz`;
}

function s3Uri(objectKey) {
  return `s3://${BUCKET}/${objectKey}`;
}

async function putObject(objectKey, body, contentType) {
  const endpoint = new URL(S3_ENDPOINT);
  const encodedKey = objectKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const host = endpoint.host;
  const pathname = S3_FORCE_PATH_STYLE
    ? `/${encodeURIComponent(BUCKET)}/${encodedKey}`
    : `/${encodedKey}`;
  const requestHost = S3_FORCE_PATH_STYLE ? host : `${BUCKET}.${host}`;
  const url = `${endpoint.protocol}//${requestHost}${pathname}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Buffer(body);
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${requestHost}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join("\n");
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256String(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(S3_SECRET_KEY, dateStamp, S3_REGION, "s3");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": amzDate,
      Authorization: authorization,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`S3 PUT failed ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
}

async function ensureBucket() {
  const endpoint = new URL(S3_ENDPOINT);
  const pathname = `/${encodeURIComponent(BUCKET)}`;
  const requestHost = endpoint.host;
  const url = `${endpoint.protocol}//${requestHost}${pathname}`;
  const empty = Buffer.alloc(0);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Buffer(empty);
  const canonicalHeaders = [
    `host:${requestHost}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256String(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(S3_SECRET_KEY, dateStamp, S3_REGION, "s3");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "PUT",
    body: empty,
    headers: {
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": amzDate,
      Authorization: authorization,
    },
  });

  if (![200, 409].includes(response.status)) {
    const text = await response.text().catch(() => "");
    throw new Error(`S3 bucket ensure failed ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS audit_archive_segment (
      sha256 text PRIMARY KEY,
      role text,
      source text NOT NULL,
      content jsonb NOT NULL,
      tool_events jsonb NOT NULL DEFAULT '[]'::jsonb,
      first_seen_at timestamptz NOT NULL,
      uri text NOT NULL,
      size_bytes integer NOT NULL,
      compressed_size_bytes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_archive_response (
      sha256 text PRIMARY KEY,
      content_type text NOT NULL,
      content_text text,
      content_json jsonb,
      first_seen_at timestamptz NOT NULL,
      model text,
      uri text NOT NULL,
      size_bytes integer NOT NULL,
      compressed_size_bytes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_archive_turn (
      id uuid PRIMARY KEY,
      message_request_id integer NOT NULL UNIQUE REFERENCES message_request(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL,
      captured_at timestamptz NOT NULL,
      exported_date date NOT NULL,
      session_id text,
      request_sequence integer,
      user_id integer,
      user_name text,
      key_id integer,
      key_name text,
      client_ip text,
      user_agent text,
      provider_id integer,
      provider_name text,
      provider_type text,
      model text,
      original_model text,
      actual_response_model text,
      endpoint text,
      status_code integer NOT NULL,
      is_streaming boolean NOT NULL DEFAULT false,
      client_aborted boolean NOT NULL DEFAULT false,
      error_message text,
      metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_source text NOT NULL,
      request_segment_sha256s text[] NOT NULL DEFAULT ARRAY[]::text[],
      request_envelope_sha256 text,
      response_sha256 text,
      tool_events jsonb NOT NULL DEFAULT '[]'::jsonb,
      processed_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_archive_export (
      export_date date PRIMARY KEY,
      schema_version text NOT NULL,
      status text NOT NULL,
      turn_count integer NOT NULL DEFAULT 0,
      segment_count integer NOT NULL DEFAULT 0,
      response_count integer NOT NULL DEFAULT 0,
      pending_spool_count integer NOT NULL DEFAULT 0,
      manifest_uri text,
      turns_uri text,
      segments_uri text,
      responses_uri text,
      sha256sums_uri text,
      generated_at timestamptz NOT NULL DEFAULT now(),
      error_message text
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_archive_turn_export_date ON audit_archive_turn(exported_date, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_archive_turn_session ON audit_archive_turn(session_id, request_sequence)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_archive_turn_user ON audit_archive_turn(user_id, created_at)`;
}

async function uploadUniqueJson(kind, value, firstSeenAt) {
  const canonical = stableStringify(value);
  const sha = sha256String(canonical);
  const body = gzipSync(Buffer.from(`${canonical}\n`, "utf8"), { level: GZIP_LEVEL });
  const objectKey = objectKeyFor(kind, sha, "json");
  await putObject(objectKey, body, "application/json");
  return {
    sha,
    uri: s3Uri(objectKey),
    sizeBytes: Buffer.byteLength(canonical, "utf8"),
    compressedSizeBytes: body.length,
    firstSeenAt,
  };
}

async function upsertSegment(segment, source, firstSeenAt) {
  const role = inferRole(segment);
  const canonicalInput = { role, source, content: sortJson(segment) };
  const canonical = stableStringify(canonicalInput);
  const sha = sha256String(canonical);
  const toolEvents = extractToolEvents(segment, sha, firstSeenAt.toISOString());
  const body = gzipSync(Buffer.from(`${canonical}\n`, "utf8"), { level: GZIP_LEVEL });
  const objectKey = objectKeyFor("segments", sha, "json");
  const uri = s3Uri(objectKey);
  await putObject(objectKey, body, "application/json");
  await sql`
    INSERT INTO audit_archive_segment (
      sha256, role, source, content, tool_events, first_seen_at, uri, size_bytes, compressed_size_bytes
    )
    VALUES (
      ${sha}, ${role}, ${source}, ${sql.json(segment)}, ${sql.json(toolEvents)}, ${firstSeenAt}, ${uri},
      ${Buffer.byteLength(canonical, "utf8")}, ${body.length}
    )
    ON CONFLICT (sha256) DO NOTHING
  `;
  return { sha, role, source, toolEvents };
}

async function upsertResponse(responseAfter, model, firstSeenAt) {
  let contentJson = null;
  let contentText = responseAfter;
  let contentType = "text/plain";
  try {
    contentJson = JSON.parse(responseAfter);
    contentText = null;
    contentType = "application/json";
  } catch {
    // keep text
  }

  const canonical =
    contentJson === null ? responseAfter : stableStringify(contentJson);
  const sha = sha256String(canonical);
  const body =
    contentJson === null
      ? gzipText(responseAfter)
      : gzipJson(contentJson);
  const objectKey = objectKeyFor("responses", sha, contentJson === null ? "txt" : "json");
  const uri = s3Uri(objectKey);
  await putObject(objectKey, body, contentJson === null ? "text/plain" : "application/json");
  await sql`
    INSERT INTO audit_archive_response (
      sha256, content_type, content_text, content_json, first_seen_at, model, uri, size_bytes, compressed_size_bytes
    )
    VALUES (
      ${sha}, ${contentType}, ${contentText}, ${contentJson === null ? null : sql.json(contentJson)},
      ${firstSeenAt}, ${model}, ${uri}, ${Buffer.byteLength(canonical, "utf8")}, ${body.length}
    )
    ON CONFLICT (sha256) DO NOTHING
  `;
  return { sha, uri, contentType };
}

async function processEventFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const event = JSON.parse(raw);
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION || event.eventType !== "turn_completed") {
    throw new Error(`Unsupported event schema ${event.schemaVersion}/${event.eventType}`);
  }

  const createdAt = normalizeDate(event.createdAt);
  const capturedAt = normalizeDate(event.capturedAt);
  const exportedDate = dateKey(createdAt);
  const messages = requestMessagesFromBody(event.requestAfter);
  const segmentSha256s = [];
  const toolEvents = [];
  let requestSource = "envelope";
  let envelopeSha = null;

  if (messages) {
    requestSource = messages.source;
    for (const segment of messages.messages) {
      const result = await upsertSegment(segment, messages.source, createdAt);
      segmentSha256s.push(result.sha);
      toolEvents.push(...result.toolEvents);
    }
  } else {
    const envelope = await uploadUniqueJson("envelopes", event.requestAfter, createdAt);
    envelopeSha = envelope.sha;
  }

  const response = await upsertResponse(
    event.responseAfter ?? "",
    event.routing?.actualResponseModel ?? event.routing?.model ?? null,
    createdAt
  );

  await sql`
    INSERT INTO audit_archive_turn (
      id, message_request_id, created_at, captured_at, exported_date, session_id, request_sequence,
      user_id, user_name, key_id, key_name, client_ip, user_agent, provider_id, provider_name,
      provider_type, model, original_model, actual_response_model, endpoint, status_code,
      is_streaming, client_aborted, error_message, metrics, request_source,
      request_segment_sha256s, request_envelope_sha256, response_sha256, tool_events
    )
    VALUES (
      ${event.eventId || randomUUID()}, ${event.messageRequestId}, ${createdAt}, ${capturedAt},
      ${exportedDate}, ${event.sessionId}, ${event.requestSequence}, ${event.user?.id ?? null},
      ${event.user?.name ?? null}, ${event.key?.id ?? null}, ${event.key?.name ?? null},
      ${event.client?.ip ?? null}, ${event.client?.userAgent ?? null}, ${event.routing?.providerId ?? null},
      ${event.routing?.providerName ?? null}, ${event.routing?.providerType ?? null},
      ${event.routing?.model ?? null}, ${event.routing?.originalModel ?? null},
      ${event.routing?.actualResponseModel ?? null}, ${event.routing?.endpoint ?? null},
      ${event.routing?.statusCode ?? 0}, ${event.routing?.isStreaming ?? false},
      ${event.routing?.clientAborted ?? false}, ${event.routing?.errorMessage ?? null},
      ${sql.json(event.metrics ?? {})}, ${requestSource}, ${segmentSha256s}, ${envelopeSha},
      ${response.sha}, ${sql.json(toolEvents)}
    )
    ON CONFLICT (message_request_id) DO UPDATE SET
      captured_at = EXCLUDED.captured_at,
      status_code = EXCLUDED.status_code,
      client_aborted = EXCLUDED.client_aborted,
      error_message = EXCLUDED.error_message,
      metrics = EXCLUDED.metrics,
      request_source = EXCLUDED.request_source,
      request_segment_sha256s = EXCLUDED.request_segment_sha256s,
      request_envelope_sha256 = EXCLUDED.request_envelope_sha256,
      response_sha256 = EXCLUDED.response_sha256,
      tool_events = EXCLUDED.tool_events,
      processed_at = now()
  `;
}

async function listPendingFiles(limit) {
  await mkdir(PENDING_DIR, { recursive: true });
  const entries = await readdir(PENDING_DIR);
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(0, limit)
    .map((name) => path.join(PENDING_DIR, name));
}

async function moveFile(src, destDir) {
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  await rename(src, dest);
  return dest;
}

async function processOne(filePath) {
  let processingPath = null;
  try {
    processingPath = await moveFile(filePath, PROCESSING_DIR);
    await processEventFile(processingPath);
    await rm(processingPath, { force: true });
  } catch (error) {
    const source = processingPath ?? filePath;
    log("Failed to process event", {
      file: path.basename(source),
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await moveFile(source, FAILED_DIR);
    } catch {
      // leave in place for manual recovery
    }
  }
}

async function processPendingBatch() {
  const files = await listPendingFiles(CONCURRENCY);
  if (files.length === 0) return 0;
  await Promise.all(files.map(processOne));
  return files.length;
}

function jsonlLine(value) {
  return `${JSON.stringify(value)}\n`;
}

async function getPendingSpoolCount() {
  try {
    await mkdir(PENDING_DIR, { recursive: true });
    return (await readdir(PENDING_DIR)).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function uploadExportObject(objectKey, content, contentType) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  await putObject(objectKey, body, contentType);
  return {
    uri: s3Uri(objectKey),
    sha256: sha256Buffer(body),
    sizeBytes: body.length,
  };
}

async function generateDailyExport(exportDate) {
  const [existing] = await sql`
    SELECT status FROM audit_archive_export WHERE export_date = ${exportDate}
  `;
  if (existing?.status === "completed" && process.env.AUDIT_ARCHIVE_FORCE_EXPORT !== "true") {
    return;
  }

  log("Generating daily export", { exportDate });
  await mkdir(EXPORT_TMP_DIR, { recursive: true });

  await sql`
    INSERT INTO audit_archive_export (export_date, schema_version, status)
    VALUES (${exportDate}, ${SCHEMA_VERSION}, 'running')
    ON CONFLICT (export_date) DO UPDATE SET status = 'running', generated_at = now(), error_message = NULL
  `;

  try {
    const turns = await sql`
      SELECT *
      FROM audit_archive_turn
      WHERE exported_date = ${exportDate}
      ORDER BY created_at ASC, session_id ASC NULLS LAST, request_sequence ASC NULLS LAST
    `;
    const segmentRows = await sql`
      SELECT DISTINCT s.*
      FROM audit_archive_segment s
      JOIN audit_archive_turn t ON s.sha256 = ANY(t.request_segment_sha256s)
      WHERE t.exported_date = ${exportDate}
      ORDER BY s.first_seen_at ASC, s.sha256 ASC
    `;
    const responseRows = await sql`
      SELECT DISTINCT r.*
      FROM audit_archive_response r
      JOIN audit_archive_turn t ON r.sha256 = t.response_sha256
      WHERE t.exported_date = ${exportDate}
      ORDER BY r.first_seen_at ASC, r.sha256 ASC
    `;

    const turnsJsonl = turns
      .map((row) =>
        jsonlLine({
          schema_version: SCHEMA_VERSION,
          export_date: exportDate,
          turn_id: row.id,
          message_request_id: row.message_request_id,
          created_at: row.created_at,
          session: {
            id: row.session_id,
            request_sequence: row.request_sequence,
          },
          actor: {
            user_id: row.user_id,
            user_name: row.user_name,
            key_id: row.key_id,
            key_name: row.key_name,
            client_ip: row.client_ip,
            user_agent: row.user_agent,
          },
          routing: {
            provider_id: row.provider_id,
            provider_name: row.provider_name,
            provider_type: row.provider_type,
            model: row.model,
            original_model: row.original_model,
            actual_response_model: row.actual_response_model,
            endpoint: row.endpoint,
            status_code: row.status_code,
            is_streaming: row.is_streaming,
            client_aborted: row.client_aborted,
            error_message: row.error_message,
          },
          metrics: row.metrics,
          request: {
            source: row.request_source,
            segment_sha256s: row.request_segment_sha256s,
            envelope_sha256: row.request_envelope_sha256,
          },
          response: {
            sha256: row.response_sha256,
          },
          tool_events: row.tool_events,
        })
      )
      .join("");

    const segmentsJsonl = segmentRows
      .map((row) =>
        jsonlLine({
          schema_version: "cch-audit-segment-v1",
          sha256: row.sha256,
          role: row.role,
          source: row.source,
          content: row.content,
          tool_events: row.tool_events,
          first_seen_at: row.first_seen_at,
          uri: row.uri,
          size_bytes: row.size_bytes,
          compressed_size_bytes: row.compressed_size_bytes,
        })
      )
      .join("");

    const responsesJsonl = responseRows
      .map((row) =>
        jsonlLine({
          schema_version: "cch-audit-response-v1",
          sha256: row.sha256,
          content_type: row.content_type,
          content: row.content_json ?? row.content_text,
          model: row.model,
          first_seen_at: row.first_seen_at,
          uri: row.uri,
          size_bytes: row.size_bytes,
          compressed_size_bytes: row.compressed_size_bytes,
        })
      )
      .join("");

    const base = `daily/${exportDate}`;
    const turnsObj = await uploadExportObject(
      `${base}/turns.jsonl.gz`,
      gzipText(turnsJsonl),
      "application/gzip"
    );
    const segmentsObj = await uploadExportObject(
      `${base}/segments.jsonl.gz`,
      gzipText(segmentsJsonl),
      "application/gzip"
    );
    const responsesObj = await uploadExportObject(
      `${base}/responses.jsonl.gz`,
      gzipText(responsesJsonl),
      "application/gzip"
    );
    const pendingSpoolCount = await getPendingSpoolCount();
    const manifest = {
      schema_version: SCHEMA_VERSION,
      export_date: exportDate,
      generated_at: new Date().toISOString(),
      turn_count: turns.length,
      segment_count: segmentRows.length,
      response_count: responseRows.length,
      pending_spool_count: pendingSpoolCount,
      files: {
        turns: turnsObj,
        segments: segmentsObj,
        responses: responsesObj,
      },
    };
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestObj = await uploadExportObject(
      `${base}/manifest.json`,
      manifestBody,
      "application/json"
    );
    const sha256sums = [
      `${turnsObj.sha256}  turns.jsonl.gz`,
      `${segmentsObj.sha256}  segments.jsonl.gz`,
      `${responsesObj.sha256}  responses.jsonl.gz`,
      `${manifestObj.sha256}  manifest.json`,
      "",
    ].join("\n");
    const sumsObj = await uploadExportObject(
      `${base}/sha256sums.txt`,
      sha256sums,
      "text/plain"
    );

    await sql`
      UPDATE audit_archive_export
      SET status = 'completed',
          turn_count = ${turns.length},
          segment_count = ${segmentRows.length},
          response_count = ${responseRows.length},
          pending_spool_count = ${pendingSpoolCount},
          manifest_uri = ${manifestObj.uri},
          turns_uri = ${turnsObj.uri},
          segments_uri = ${segmentsObj.uri},
          responses_uri = ${responsesObj.uri},
          sha256sums_uri = ${sumsObj.uri},
          generated_at = now(),
          error_message = NULL
      WHERE export_date = ${exportDate}
    `;
    log("Daily export completed", {
      exportDate,
      turnCount: turns.length,
      segmentCount: segmentRows.length,
      responseCount: responseRows.length,
    });
  } catch (error) {
    await sql`
      UPDATE audit_archive_export
      SET status = 'failed',
          generated_at = now(),
          error_message = ${error instanceof Error ? error.message : String(error)}
      WHERE export_date = ${exportDate}
    `;
    throw error;
  }
}

function msUntilNextExport() {
  const [hoursRaw, minutesRaw] = DAILY_EXPORT_TIME.split(":");
  const hours = Number.parseInt(hoursRaw || "2", 10);
  const minutes = Number.parseInt(minutesRaw || "0", 10);
  const now = new Date();
  const next = new Date(now.getTime());
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleDailyExport() {
  const delay = msUntilNextExport();
  log("Next daily export scheduled", { delayMs: delay, time: DAILY_EXPORT_TIME });
  setTimeout(async () => {
    try {
      await generateDailyExport(getPreviousDateKey());
    } catch (error) {
      log("Daily export failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      scheduleDailyExport();
    }
  }, delay);
}

async function main() {
  await mkdir(PENDING_DIR, { recursive: true });
  await mkdir(PROCESSING_DIR, { recursive: true });
  await mkdir(FAILED_DIR, { recursive: true });
  await ensureSchema();
  await ensureBucket();
  log("Started", { spoolDir: SPOOL_DIR, bucket: BUCKET, concurrency: CONCURRENCY });

  if (EXPORT_ON_START) {
    await generateDailyExport(getPreviousDateKey()).catch((error) => {
      log("Initial export failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  scheduleDailyExport();

  while (true) {
    const processed = await processPendingBatch();
    if (processed === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

process.on("SIGTERM", async () => {
  log("Received SIGTERM, shutting down");
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
});

main().catch(async (error) => {
  console.error("[AuditWorker] Fatal error", error);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
