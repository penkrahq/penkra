// FILE: avatarImage.ts
// Purpose: Compress a user-picked profile photo entirely on-device into a tiny, square
// data URL so it can be persisted in localStorage without consuming much space. No I/O
// leaves the device.
// Layer: web profile feature.

import { SquareImageError, compressSquareImage } from "~/lib/squareImage";

// Square output edge in CSS px. 160 covers the largest avatar (size-20 / share card) at 2x
// without storing anything close to the original photo.
const AVATAR_MAX_EDGE = 160;
const AVATAR_QUALITY = 0.82;

// Hard cap on the encoded string so a pathological image can never blow the localStorage
// budget. Comfortable for a 160px square (~5–12 KB typical).
export const AVATAR_MAX_DATA_URL_LENGTH = 200_000;

export class AvatarImageError extends Error {}

// Resize + center-crop to a square and re-encode (WebP, JPEG fallback) at low quality.
export async function compressAvatarImage(file: File): Promise<string> {
  try {
    return await compressSquareImage(file, {
      maxEdge: AVATAR_MAX_EDGE,
      quality: AVATAR_QUALITY,
      maxDataUrlLength: AVATAR_MAX_DATA_URL_LENGTH,
    });
  } catch (error) {
    if (error instanceof SquareImageError) throw new AvatarImageError(error.message);
    throw error;
  }
}
