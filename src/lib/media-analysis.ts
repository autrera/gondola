import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAsset } from "./assets";
import { veniceJson } from "./venice";

// Structured artifact analysis and verification.
//
// The key discipline (borrowed from Hermes-style skill verification): never ask
// a model to judge what code can check. File existence, size, and image
// dimensions are verified deterministically; a vision model is used only for
// subjective, semantic evaluation against the stated objective and criteria.

const VIDEO_VISION_CAP_BYTES = 12 * 1024 * 1024;

export interface EvaluationCriterion {
  name: string;
  description?: string;
}

export interface MediaEvaluation {
  summary: string;
  criteria: Array<{ name: string; passed: boolean; score?: number; evidence: string }>;
  technicalChecks: {
    readable: boolean;
    mediaType?: string;
    contentType?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    hasAudio?: boolean;
    fileSizeBytes?: number;
  };
  overallScore?: number;
  recommendedChanges: string[];
}

export interface AnalyzeMediaInput {
  source: string;
  mediaType?: "image" | "video" | "audio" | "auto";
  objective: string;
  criteria?: EvaluationCriterion[];
  model?: string;
}

type MediaKind = "image" | "video" | "audio" | "unknown";

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function guessContentType(pathOrUrl: string): string {
  const ext = path.extname(pathOrUrl.split("?")[0]).replace(".", "").toLowerCase();
  return EXTENSION_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

function mediaKindOf(contentType: string): MediaKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "unknown";
}

/** Read pixel dimensions from an image header without decoding it. */
export function imageDimensions(buffer: Buffer): { width: number; height: number; format: string } | undefined {
  if (buffer.length < 24) return undefined;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: "gif" };
  }
  // JPEG: walk segments to the start-of-frame marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), format: "jpeg" };
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength <= 0) break;
      offset += 2 + segmentLength;
    }
    return undefined;
  }
  // WebP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const format = buffer.toString("ascii", 12, 16);
    if (format === "VP8X" && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { width, height, format: "webp" };
    }
    if (format === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    if (format === "VP8L" && buffer.length >= 25) {
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    }
  }
  return undefined;
}

interface ResolvedSource {
  bytes: Buffer;
  contentType: string;
  mediaKind: MediaKind;
  origin: string;
}

async function resolveSource(source: string): Promise<ResolvedSource> {
  const asset = await getAsset(source).catch(() => undefined);
  const effective = asset?.path ?? source;

  const dataUrlMatch = effective.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUrlMatch) {
    const contentType = dataUrlMatch[1];
    return { bytes: Buffer.from(dataUrlMatch[2], "base64"), contentType, mediaKind: mediaKindOf(contentType), origin: "data-url" };
  }
  if (/^https?:\/\//i.test(effective)) {
    const response = await fetch(effective, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not fetch ${effective} (${response.status})`);
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? guessContentType(effective);
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType, mediaKind: mediaKindOf(contentType), origin: effective };
  }
  const filePath = path.isAbsolute(effective) ? effective : path.resolve(process.cwd(), effective);
  const bytes = await readFile(filePath);
  const contentType = guessContentType(filePath);
  return { bytes, contentType, mediaKind: mediaKindOf(contentType), origin: filePath };
}

interface SubjectiveEvaluation {
  summary: string;
  criteria: Array<{ name: string; passed: boolean; score?: number; evidence: string }>;
  recommendedChanges: string[];
  overallScore?: number;
}

async function critiqueVisual(
  visionSource: string,
  isVideo: boolean,
  input: AnalyzeMediaInput,
  model: string,
  signal?: AbortSignal,
): Promise<SubjectiveEvaluation> {
  const criteriaList = (input.criteria ?? []).map((criterion) => (criterion.description ? `${criterion.name}: ${criterion.description}` : criterion.name));
  const criteriaText = criteriaList.length
    ? `Evaluate specifically against these criteria: ${criteriaList.join("; ")}.`
    : "Evaluate overall quality and how well it meets the objective.";
  const mediaPart = isVideo
    ? { type: "video_url", video_url: { url: visionSource } }
    : { type: "image_url", image_url: { url: visionSource } };
  const response = await veniceJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    "/chat/completions",
    {
      model,
      messages: [
        {
          role: "system",
          content: "You are a rigorous creative director evaluating a generated media artifact against a stated objective. Judge only what is actually visible or audible, cite concrete evidence, and never invent details. Return exactly one JSON object matching the schema.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Objective: ${input.objective}\n${criteriaText}\nFor each criterion, return passed (boolean), score (0-10), and concrete evidence from the artifact. Also give a short summary, an overallScore (0-10), and specific recommendedChanges.` },
            mediaPart,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "media_evaluation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              criteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    passed: { type: "boolean" },
                    score: { type: "number" },
                    evidence: { type: "string" },
                  },
                  required: ["name", "passed", "score", "evidence"],
                  additionalProperties: false,
                },
              },
              recommendedChanges: { type: "array", items: { type: "string" } },
              overallScore: { type: "number" },
            },
            required: ["summary", "criteria", "recommendedChanges", "overallScore"],
            additionalProperties: false,
          },
        },
      },
      max_completion_tokens: 900,
      temperature: 0.2,
      venice_parameters: { disable_thinking: true, strip_thinking_response: true, include_venice_system_prompt: false },
    },
    signal,
  );
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("The evaluation model returned no content");
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as Partial<SubjectiveEvaluation>;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
    recommendedChanges: Array.isArray(parsed.recommendedChanges) ? parsed.recommendedChanges : [],
    overallScore: typeof parsed.overallScore === "number" ? parsed.overallScore : undefined,
  };
}

export async function analyzeMedia(
  input: AnalyzeMediaInput,
  options: { defaultVisionModel: string; signal?: AbortSignal },
): Promise<MediaEvaluation> {
  const resolved = await resolveSource(input.source);
  const mediaKind: MediaKind = input.mediaType && input.mediaType !== "auto" ? input.mediaType : resolved.mediaKind;

  const technicalChecks: MediaEvaluation["technicalChecks"] = {
    readable: resolved.bytes.length > 0,
    mediaType: mediaKind === "unknown" ? undefined : mediaKind,
    contentType: resolved.contentType,
    fileSizeBytes: resolved.bytes.length,
  };
  if (mediaKind === "image") {
    const dimensions = imageDimensions(resolved.bytes);
    if (dimensions) {
      technicalChecks.width = dimensions.width;
      technicalChecks.height = dimensions.height;
    }
  }

  const model = input.model?.trim() || options.defaultVisionModel;
  const canCritiqueImage = mediaKind === "image";
  const canCritiqueVideo = mediaKind === "video" && resolved.bytes.length <= VIDEO_VISION_CAP_BYTES;

  if (canCritiqueImage || canCritiqueVideo) {
    try {
      const dataUrl = `data:${resolved.contentType};base64,${resolved.bytes.toString("base64")}`;
      const subjective = await critiqueVisual(dataUrl, canCritiqueVideo, input, model, options.signal);
      return { ...subjective, technicalChecks };
    } catch (error) {
      return {
        summary: `Verified technical properties, but the subjective evaluation could not run: ${error instanceof Error ? error.message : "unknown error"}.`,
        criteria: [],
        technicalChecks,
        recommendedChanges: [],
      };
    }
  }

  return {
    summary: `Verified technical properties only. Subjective evaluation is not available for ${mediaKind} media in this build${mediaKind === "video" ? " (the file exceeds the inline size limit for direct model input)" : ""}.`,
    criteria: [],
    technicalChecks,
    recommendedChanges: [],
  };
}
