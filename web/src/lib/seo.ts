export interface SEOProps {
  title: string;
  description: string;
  keywords?: string;
  ogImage?: string;
  ogType?: string;
}

export function setSEOMetadata(props: SEOProps) {
  // Update document title
  document.title = `${props.title} | QuoteFly`;

  // Update meta description
  let metaDescription = document.querySelector('meta[name="description"]');
  if (!metaDescription) {
    metaDescription = document.createElement("meta");
    metaDescription.setAttribute("name", "description");
    document.head.appendChild(metaDescription);
  }
  metaDescription.setAttribute("content", props.description);

  // Update keywords
  if (props.keywords) {
    let metaKeywords = document.querySelector('meta[name="keywords"]');
    if (!metaKeywords) {
      metaKeywords = document.createElement("meta");
      metaKeywords.setAttribute("name", "keywords");
      document.head.appendChild(metaKeywords);
    }
    metaKeywords.setAttribute("content", props.keywords);
  }

  // Update Open Graph tags
  const ogTitle = document.querySelector('meta[property="og:title"]') || createMetaTag("og:title");
  ogTitle?.setAttribute("content", props.title);

  const ogDescription =
    document.querySelector('meta[property="og:description"]') || createMetaTag("og:description");
  ogDescription?.setAttribute("content", props.description);

  const ogImage = document.querySelector('meta[property="og:image"]') || createMetaTag("og:image");
  ogImage?.setAttribute(
    "content",
    props.ogImage || "https://quotefly.us/og-image.png"
  );

  const ogType = document.querySelector('meta[property="og:type"]') || createMetaTag("og:type");
  ogType?.setAttribute("content", props.ogType || "website");

  const ogUrl = document.querySelector('meta[property="og:url"]') || createMetaTag("og:url");
  ogUrl?.setAttribute("content", window.location.href);
}

function createMetaTag(property: string) {
  const tag = document.createElement("meta");
  tag.setAttribute("property", property);
  document.head.appendChild(tag);
  return tag;
}
