import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Reading the text off a payment screenshot.
 *
 * Shells out to the tesseract BINARY rather than using the JavaScript build. The JS one
 * carries a WASM engine and downloads its language data at runtime, and both of those cost
 * memory in a worker that has already been OOM-killed once for holding too much at a time.
 * The native binary runs in its own process, takes its memory with it when it exits, and
 * needs nothing from the network.
 *
 * Every failure here is soft. OCR is a convenience on top of the mail: if the binary is
 * missing, the image is unreadable, or it simply takes too long, the quotation stays where
 * it was and somebody looks at the screenshot themselves — which is what happened before
 * this existed. Nothing about the ingest depends on it.
 */

/**
 * Big enough for a phone screenshot, small enough that a mistake cannot exhaust the worker.
 * A UPI receipt is well under a megabyte; anything past this is not the kind of image this
 * is for.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * A receipt is a few hundred words of high-contrast text and takes a second or two. Past
 * this it is not slow, it is stuck, and the sweep behind it is waiting.
 */
const OCR_TIMEOUT_MS = 25_000;

/** Only formats tesseract actually reads. A PDF quotation is not a screenshot. */
const READABLE = /^image\/(png|jpe?g|webp|bmp|tiff?)$/i;

export function isReadableImage(mimeType: string, sizeBytes: number): boolean {
  return READABLE.test((mimeType ?? "").trim()) && sizeBytes > 0 && sizeBytes <= MAX_IMAGE_BYTES;
}

function runTesseract(imagePath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "tesseract",
      [
        imagePath,
        "stdout",
        "-l",
        "eng",
        // Screenshots are one block of laid-out text rather than a scanned page; 6 tells
        // tesseract to read it as such instead of hunting for columns.
        "--psm",
        "6",
      ],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Includes "not installed" and "timed out". Neither is worth a stack trace every
          // sweep — the caller treats an empty read as "could not tell".
          console.error(`[screenshotReader] tesseract failed: ${error.message}`);
          resolve("");
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

/**
 * OCR one image.
 *
 * Written to a temp file because tesseract reads a path, and to a directory of its own so
 * two sweeps cannot collide on a name. The directory is removed whatever happens — a worker
 * that runs every three minutes must not leave a screenshot behind each time.
 */
export async function readImageText(input: {
  content: Buffer;
  mimeType: string;
}): Promise<string> {
  if (!isReadableImage(input.mimeType, input.content.byteLength)) return "";

  let dir = "";
  try {
    dir = await mkdtemp(path.join(tmpdir(), "ocr-"));
    const file = path.join(dir, "shot.img");
    await writeFile(file, input.content);
    return (await runTesseract(file)).trim();
  } catch (error) {
    console.error(
      "[screenshotReader] could not read the image:",
      error instanceof Error ? error.message : error,
    );
    return "";
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        /* a leftover temp dir is not worth failing the sweep over */
      });
    }
  }
}
