// CUA frame contract: producer-issued frame integrity metadata and
// the image/image_ref pairing rules the host enforces on model-bound content.
import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "./vendor/dist-index.js";

export { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY };

// Value compared with === by consumers; stable unique kind string.
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

// Producer caps agent-visible inline rasters at AGENT_B64_BUDGET (190 KiB);
// the consumer-side cap keeps headroom for envelope overhead.
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

const IMAGE_REF_MAX_TEXT_CHARS = 1024;
const IMAGE_REF_CREDENTIAL_KEY = "image_ref";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Producer-side image_ref payload: { actionable, frame_id, width, height }.
function parseImageRefObject(value) {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "actionable,frame_id,height,width") return undefined;
  if (
    typeof value.frame_id !== "string" ||
    value.frame_id.length === 0 ||
    !Number.isInteger(value.width) ||
    value.width <= 0 ||
    !Number.isInteger(value.height) ||
    value.height <= 0 ||
    value.actionable !== true
  ) {
    return undefined;
  }
  return value;
}

// Whole-text image_ref credential: a text block that is exactly one
// {"image_ref": {...}} JSON document.
function parseWholeTextImageRef(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > IMAGE_REF_MAX_TEXT_CHARS) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return undefined;
  return parseImageRefObject(parsed[IMAGE_REF_CREDENTIAL_KEY]);
}

export function isOfficialCuaImageRefText(text) {
  return parseWholeTextImageRef(text) !== undefined;
}

// Looser scan used by media pairing: the text *contains* a credential-bearing
// image_ref JSON object, not necessarily as the whole block.
export function containsOfficialCuaImageRefCredentialText(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (isOfficialCuaImageRefText(text)) return true;
  const scanLimit = Math.min(text.length, 256 * 1024 + IMAGE_REF_MAX_TEXT_CHARS);
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(`"${IMAGE_REF_CREDENTIAL_KEY}"`, searchFrom);
    if (start < 0 || start > scanLimit) return false;
    // Walk backwards to the enclosing '{' and try to parse a balanced object.
    const objStart = text.lastIndexOf("{", start);
    if (objStart < 0) return false;
    const candidate = extractBalancedJsonObject(text, objStart, IMAGE_REF_MAX_TEXT_CHARS);
    if (candidate !== undefined && parseWholeTextImageRef(candidate)) return true;
    searchFrom = start + IMAGE_REF_CREDENTIAL_KEY.length;
  }
}

export function containsImageRefAuthority(text) {
  return typeof text === "string" && text.includes(`"${IMAGE_REF_CREDENTIAL_KEY}"`);
}

function extractBalancedJsonObject(text, start, maxChars) {
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length && i - start < maxChars; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function parseOfficialCuaImageRef(text) {
  const ref = parseWholeTextImageRef(text);
  return ref ? { authority: JSON.stringify({ [IMAGE_REF_CREDENTIAL_KEY]: ref }) } : undefined;
}

// Reads the producer's integrity envelope out of a tool result's _meta and
// reports the digest algorithm the host should verify against.
export function readRasterEnvelopeIdentity(input) {
  if (!isRecord(input)) return undefined;
  const meta = isRecord(input._meta) ? input._meta : input;
  const envelope = meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (!isRecord(envelope)) return undefined;
  if (envelope.version !== 1 || typeof envelope.sha256 !== "string" || envelope.sha256.length === 0) {
    return undefined;
  }
  return { algorithm: "sha256" };
}

function isImageBlock(block) {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0
  );
}

function isImageRefTextBlock(block) {
  return isRecord(block) && block.type === "text" && isOfficialCuaImageRefText(block.text);
}

export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index + 1 < content.length; index += 1) {
    const image = content[index];
    const imageRef = content[index + 1];
    if (isImageBlock(image) && isImageRefTextBlock(imageRef)) {
      return { image, imageRef, imageIndex: index, imageRefIndex: index + 1 };
    }
  }
  return undefined;
}

function hasFrameIntegrityMeta(result) {
  return isRecord(result) && isRecord(result._meta) && isRecord(result._meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]);
}

// Producer-attested results keep their canonical [image, image_ref] head and
// the hidden integrity envelope. Downstream normalization must not compress,
// drop, reorder, or rewrite the pair; other content passes through unchanged.
export async function preserveOfficialCuaFrameResult(result, _options) {
  return result;
}

export function attestOfficialCuaFrameContent(content, expectedKind) {
  if (expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) return undefined;
  if (findOfficialCuaFrameContentPair(content) === undefined) return undefined;
  return { kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION };
}

export { hasFrameIntegrityMeta as hasOfficialCuaFrameIntegrityMeta };
