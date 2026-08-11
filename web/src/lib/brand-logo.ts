export const BRAND_LOGO_DATA_URL_MAX_LENGTH = 900_000;
export const BRAND_LOGO_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const BRAND_LOGO_TARGET_DATA_URL_LENGTH = 850_000;

export function isSupportedBrandLogoDataUrl(logoUrl?: string | null): logoUrl is string {
  return Boolean(
    logoUrl &&
      logoUrl.length <= BRAND_LOGO_DATA_URL_MAX_LENGTH &&
      /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoUrl),
  );
}

export async function resizeBrandLogoFile(file: File): Promise<string> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    throw new Error("Choose a PNG or JPG logo.");
  }
  if (file.size > BRAND_LOGO_UPLOAD_MAX_BYTES) {
    throw new Error("Logo file is too large. Keep it under 8 MB before upload.");
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the logo file."));
    };
    reader.onerror = () => reject(new Error("Could not read the logo file."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("The logo is not a valid PNG or JPG image."));
    nextImage.src = dataUrl;
  });

  const maxDimension = 1_200;
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the logo image.");
  context.clearRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const pngDataUrl = canvas.toDataURL("image/png");
  if (pngDataUrl.length <= BRAND_LOGO_TARGET_DATA_URL_LENGTH) return pngDataUrl;

  const smallerScale = Math.min(scale, 900 / Math.max(image.width, image.height));
  const smallerWidth = Math.max(1, Math.round(image.width * smallerScale));
  const smallerHeight = Math.max(1, Math.round(image.height * smallerScale));
  canvas.width = smallerWidth;
  canvas.height = smallerHeight;
  context.clearRect(0, 0, smallerWidth, smallerHeight);
  context.drawImage(image, 0, 0, smallerWidth, smallerHeight);

  const smallerPngDataUrl = canvas.toDataURL("image/png");
  if (smallerPngDataUrl.length <= BRAND_LOGO_TARGET_DATA_URL_LENGTH) return smallerPngDataUrl;

  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, smallerWidth, smallerHeight);
  context.restore();

  for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
    const jpegDataUrl = canvas.toDataURL("image/jpeg", quality);
    if (jpegDataUrl.length <= BRAND_LOGO_TARGET_DATA_URL_LENGTH) return jpegDataUrl;
  }

  throw new Error("This logo is too detailed to prepare safely. Try a smaller PNG or JPG file.");
}
