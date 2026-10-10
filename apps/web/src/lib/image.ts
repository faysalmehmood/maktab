/** PLAN §6: photos are compressed on the phone to ≤ 100 KB before upload (server caps at 200 KB). */
export const PHOTO_TARGET_BYTES = 100 * 1024;

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/** Downscale and re-encode as JPEG, stepping size and quality down until it fits. */
export async function resizeToJpeg(file: Blob, maxBytes = PHOTO_TARGET_BYTES): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let edge = 800;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('photo_failed');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.7, 0.55]) {
      const blob = await toBlob(canvas, q);
      if (blob && blob.size <= maxBytes) return blob;
    }
    edge = Math.round(edge * 0.75);
  }
  throw new Error('photo_too_big');
}
