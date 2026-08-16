export class SquareImageError extends Error {}

export interface CompressSquareImageOptions {
  maxEdge: number;
  quality: number;
  maxDataUrlLength: number;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new SquareImageError("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new SquareImageError("That file isn't a readable image."));
    image.src = src;
  });
}

export async function compressSquareImage(
  file: File,
  options: CompressSquareImageOptions,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new SquareImageError("Please choose an image file.");
  }

  const image = await loadImage(await readFileAsDataUrl(file));
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceEdge = Math.min(sourceWidth, sourceHeight);
  if (sourceEdge <= 0) throw new SquareImageError("That image has no pixels.");

  const edge = Math.min(options.maxEdge, sourceEdge);
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new SquareImageError("Image compression isn't supported in this browser.");
  }

  context.drawImage(
    image,
    (sourceWidth - sourceEdge) / 2,
    (sourceHeight - sourceEdge) / 2,
    sourceEdge,
    sourceEdge,
    0,
    0,
    edge,
    edge,
  );
  const webp = canvas.toDataURL("image/webp", options.quality);
  const dataUrl = webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL("image/jpeg", options.quality);
  if (dataUrl.length > options.maxDataUrlLength) {
    throw new SquareImageError("That image is too large even after compression.");
  }
  return dataUrl;
}
