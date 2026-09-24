import { resolveWorkspaceContext } from "@/server/auth/workspace-context";
import { requireWorkspacePermission } from "@/server/auth/permissions";
import { AppError, toErrorResponse } from "@/server/http/errors";
import { getKnowledgeSourceUsage, saveKnowledgeSource } from "@/server/knowledge/repository";

const MAX_FILE_BYTES = 256 * 1024;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md"]);
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 64 * 1024;

// Stream-limit before parsing multipart; Request.formData() alone buffers
// the entire untrusted request before uploaded.size can be checked.
async function limitedFormData(request: Request) {
  if (!request.body) throw new AppError("KNOWLEDGE_FILE_REQUIRED", "Choose a file to upload.", 422);
  const chunks: Buffer[] = [];
  const reader = request.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MULTIPART_BYTES) {
      await reader.cancel();
      throw new AppError("KNOWLEDGE_FILE_TOO_LARGE", "Knowledge files must be 256 KB or smaller.", 413);
    }
    chunks.push(Buffer.from(value));
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: Buffer.concat(chunks) }).formData();
}

function extension(filename: string) {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

export async function POST(request: Request) {
  try {
    const context = await resolveWorkspaceContext(request.headers);
    requireWorkspacePermission(context.membership.role, "integration.manage");
    if ((await getKnowledgeSourceUsage(context.workspace.id)).limit === 0) {
      throw new AppError("KNOWLEDGE_IMPORT_REQUIRES_UNLIMITED", "Upgrade to Unlimited to import business knowledge.", 403);
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES + 65_536)
      throw new AppError("KNOWLEDGE_FILE_TOO_LARGE", "Knowledge files must be 256 KB or smaller.", 413);
    const form = await limitedFormData(request);
    const uploaded = form.get("file");
    if (!(uploaded instanceof File)) throw new AppError("KNOWLEDGE_FILE_REQUIRED", "Choose a TXT or MD file to upload.", 422);
    if (!ALLOWED_EXTENSIONS.has(extension(uploaded.name))) {
      throw new AppError("KNOWLEDGE_FILE_TYPE", "Only TXT and MD files are supported.", 415);
    }
    if (uploaded.size <= 0) throw new AppError("KNOWLEDGE_FILE_EMPTY", "The uploaded file is empty.", 422);
    if (uploaded.size > MAX_FILE_BYTES) throw new AppError("KNOWLEDGE_FILE_TOO_LARGE", "Knowledge files must be 256 KB or smaller.", 413);

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(await uploaded.arrayBuffer()).trim();
    } catch {
      throw new AppError("KNOWLEDGE_FILE_ENCODING", "Knowledge files must contain valid UTF-8 text.", 422);
    }
    if (!content) throw new AppError("KNOWLEDGE_FILE_EMPTY", "The uploaded file does not contain readable text.", 422);
    if (content.includes("\u0000")) throw new AppError("KNOWLEDGE_FILE_BINARY", "Binary files are not supported. Upload a plain TXT or MD file.", 422);

    const source = await saveKnowledgeSource(context.workspace.id, {
      kind: "FILE",
      label: uploaded.name.slice(0, 240),
      content: content.slice(0, 100_000),
    });
    return Response.json({ source: { ...source, content: undefined } }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
