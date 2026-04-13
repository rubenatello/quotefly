type QuoteMessageDraft = {
  subject: string;
  body: string;
};

export function fileLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "quote"
  );
}

export function createPdfFile(blob: Blob, quoteTitle: string) {
  return new File([blob], `${fileLabel(quoteTitle)}.pdf`, { type: "application/pdf" });
}

export function supportsNativeFileShare(file: File) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  const checker = (navigator as Navigator & { canShare?: (data?: ShareData) => boolean }).canShare;
  if (typeof checker !== "function") return false;
  try {
    return checker.call(navigator, { files: [file] });
  } catch {
    return false;
  }
}

export function canNativePdfShareOnDevice() {
  try {
    const testFile = new File([new Blob(["test"], { type: "application/pdf" })], "quote.pdf", {
      type: "application/pdf",
    });
    return supportsNativeFileShare(testFile);
  } catch {
    return false;
  }
}

export function isLikelyMobileRuntime() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const mobileUserAgent = /android|iphone|ipad|ipod|iemobile|opera mini|mobile/i.test(navigator.userAgent);
  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const narrowViewport = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1024px)").matches;

  return mobileUserAgent || (coarsePointer && narrowViewport);
}

export function openPdfPreviewBlob(blob: Blob) {
  const objectUrl = URL.createObjectURL(blob);
  const revokeLater = () => window.setTimeout(() => URL.revokeObjectURL(objectUrl), 300_000);

  if (isLikelyMobileRuntime()) {
    window.location.assign(objectUrl);
    revokeLater();
    return "same-tab" as const;
  }

  const previewWindow = window.open(objectUrl, "_blank", "noopener,noreferrer");

  if (!previewWindow) {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  revokeLater();
  return "new-tab" as const;
}

export async function sharePdfBlobNatively(blob: Blob, quoteTitle: string, draft: QuoteMessageDraft) {
  const file = createPdfFile(blob, quoteTitle);
  if (!supportsNativeFileShare(file) || typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }

  await navigator.share({
    title: draft.subject,
    text: draft.body,
    files: [file],
  });

  return true;
}
