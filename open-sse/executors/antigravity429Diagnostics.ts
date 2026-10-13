import { createHash } from "node:crypto";

// Only fixed field names and enumerated error codes can enter the call-log diagnostic.
const HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-goog-user-project",
  "retry-after",
  "x-goog-api-client",
  "x-goog-request-params",
  "x-request-id",
]);
const ENVELOPE_NAMES = new Set([
  "project",
  "model",
  "request",
  "requestId",
  "requestType",
  "userAgent",
  "enabledCreditTypes",
]);
const UPSTREAM_CODES = new Set([
  "RESOURCE_EXHAUSTED",
  "RATE_LIMIT_EXCEEDED",
  "QUOTA_EXCEEDED",
  "USER_RATE_LIMIT_EXCEEDED",
  "MODEL_CAPACITY_EXHAUSTED",
]);

type HeaderInput = Headers | Record<string, unknown> | null | undefined;
type DiagnosticInput = {
  status: number;
  provider: string | null | undefined;
  upstreamBody?: unknown;
  requestHeaders?: HeaderInput;
  responseHeaders?: HeaderInput;
  envelope?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function allowedNames(input: HeaderInput, allowed: Set<string>): string[] {
  const names = input instanceof Headers ? Array.from(input.keys()) : Object.keys(record(input));
  return [
    ...new Set(names.map((name) => name.toLowerCase()).filter((name) => allowed.has(name))),
  ].sort();
}

function upstreamCode(value: unknown): string | null {
  return typeof value === "string" && UPSTREAM_CODES.has(value) ? value : null;
}

export type Antigravity429Diagnostic = NonNullable<
  ReturnType<typeof buildAntigravity429Diagnostic>
>;

const diagnostics = new WeakMap<Response, Antigravity429Diagnostic>();

export function attachAntigravity429Diagnostic(
  response: Response,
  diagnostic: Antigravity429Diagnostic | null
): Response {
  if (diagnostic) diagnostics.set(response, diagnostic);
  return response;
}

export function getAntigravity429Diagnostic(response: Response): Antigravity429Diagnostic | null {
  return diagnostics.get(response) ?? null;
}

export function buildAntigravity429Diagnostic(input: DiagnosticInput) {
  if (input.status !== 429 || !["agy", "antigravity"].includes(input.provider ?? "")) {
    return null;
  }
  const upstream = record(input.upstreamBody);
  const details = record(upstream.upstream_details);
  const error = record(upstream.error);
  const detailError = record(details.error);
  const errorDetail = Array.isArray(error.details) ? record(error.details[0]) : {};
  const requestHeaderNames = allowedNames(input.requestHeaders, HEADER_NAMES);
  const responseHeaderNames = allowedNames(input.responseHeaders, HEADER_NAMES);
  const envelopeNames = Object.keys(record(input.envelope))
    .filter((name) => ENVELOPE_NAMES.has(name))
    .sort();
  const shapeHash = createHash("sha256")
    .update(JSON.stringify([requestHeaderNames, responseHeaderNames, envelopeNames]))
    .digest("hex")
    .slice(0, 16);

  return {
    httpStatus: 429,
    upstreamStatus: upstreamCode(detailError.status ?? error.status ?? upstream.status),
    reason: upstreamCode(
      detailError.reason ?? error.reason ?? errorDetail.reason ?? upstream.reason
    ),
    requestHeaderNames,
    responseHeaderNames,
    envelopeNames,
    shapeHash,
  };
}
