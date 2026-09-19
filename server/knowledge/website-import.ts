import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TEXT_CHARACTERS = 50_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = new URL("http://[" + address + "]/").hostname.slice(1, -1).toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("2001:db8") || normalized === "2001::" || normalized.startsWith("2001:0:") || normalized.startsWith("2002:")) return false;
  return true;
}

async function resolvePublicAddress(hostname: string) {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error("Website imports cannot access private or local network addresses.");
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  const publicRecord = records.find((record) => isPublicAddress(record.address));
  if (!publicRecord) throw new Error("Website imports require a publicly reachable website.");
  return publicRecord;
}

function validateUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Website imports support only HTTP and HTTPS URLs.");
  if (url.username || url.password) throw new Error("Website URLs cannot include credentials.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Website imports support only standard web ports.");
  if (!url.hostname || url.hostname.toLowerCase() === "localhost") throw new Error("Website imports require a public hostname.");
  return url;
}

function decodeEntities(text: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function htmlToKnowledgeText(input: string) {
  const withoutUnsafeBlocks = input
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[^]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|section|article|h[1-6]|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutUnsafeBlocks);
  return decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARACTERS);
}

async function download(url: URL, redirects = 0): Promise<{ url: URL; contentType: string; body: string }> {
  if (redirects > MAX_REDIRECTS) throw new Error("Website import stopped after too many redirects.");
  const resolved = await resolvePublicAddress(url.hostname);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  return new Promise((resolve, reject) => {
    const request = transport({
      protocol: url.protocol,
      hostname: resolved.address,
      family: resolved.family,
      port,
      method: "GET",
      path: url.pathname + url.search,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      headers: {
        Host: url.host,
        "User-Agent": "AI-Caller-Knowledge-Importer/1.0",
        Accept: "text/html,text/plain,text/markdown,application/xhtml+xml",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const redirected = validateUrl(new URL(response.headers.location, url).toString());
        void download(redirected, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error("Website returned HTTP " + (status || "error") + "."));
        return;
      }

      const contentType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const supported = contentType === "text/html"
        || contentType === "application/xhtml+xml"
        || contentType === "text/plain"
        || contentType === "text/markdown"
        || contentType === "";
      if (!supported) {
        response.resume();
        reject(new Error("Website import supports HTML, plain text, and Markdown pages only."));
        return;
      }

      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        response.resume();
        reject(new Error("Website content is too large to import."));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Website content is too large to import."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        url,
        contentType,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Website import timed out.")));
    request.on("error", reject);
    request.end();
  });
}

export async function importWebsiteText(value: string) {
  const requestedUrl = validateUrl(value.trim());
  const downloaded = await download(requestedUrl);
  const content = downloaded.contentType.includes("html")
    ? htmlToKnowledgeText(downloaded.body)
    : downloaded.body.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT_CHARACTERS);
  if (content.length < 20) throw new Error("The website did not contain enough readable text to import.");
  return {
    sourceUrl: downloaded.url.toString(),
    label: downloaded.url.hostname,
    content,
  };
}
