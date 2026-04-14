export interface SEOProps {
  title: string;
  description: string;
  keywords?: string;
  ogImage?: string;
  ogType?: string;
  canonicalUrl?: string;
  robots?: string;
  twitterTitle?: string;
  twitterDescription?: string;
}

export function setSEOMetadata(props: SEOProps) {
  const hasBrandInTitle = /\bquotefly\b/i.test(props.title);
  const resolvedTitle = hasBrandInTitle ? props.title : `${props.title} | QuoteFly`;
  const resolvedCanonicalUrl = props.canonicalUrl || `${window.location.origin}${window.location.pathname}`;

  // Update document title
  document.title = resolvedTitle;

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

  // Update canonical URL
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    document.head.appendChild(canonical);
  }
  canonical.setAttribute("href", resolvedCanonicalUrl);

  // Update robots
  let robots = document.querySelector('meta[name="robots"]');
  if (!robots) {
    robots = document.createElement("meta");
    robots.setAttribute("name", "robots");
    document.head.appendChild(robots);
  }
  robots.setAttribute("content", props.robots || "index,follow");

  // Update Open Graph tags
  const ogTitle = document.querySelector('meta[property="og:title"]') || createMetaTag("og:title");
  ogTitle?.setAttribute("content", resolvedTitle);

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
  ogUrl?.setAttribute("content", resolvedCanonicalUrl);

  // Update Twitter tags
  const twitterTitle = ensureNamedMeta("twitter:title");
  twitterTitle?.setAttribute("content", props.twitterTitle || resolvedTitle);

  const twitterDescription = ensureNamedMeta("twitter:description");
  twitterDescription?.setAttribute("content", props.twitterDescription || props.description);

  const twitterImage = ensureNamedMeta("twitter:image");
  twitterImage?.setAttribute(
    "content",
    props.ogImage || "https://quotefly.us/og-image.png"
  );
}

function createMetaTag(property: string) {
  const tag = document.createElement("meta");
  tag.setAttribute("property", property);
  document.head.appendChild(tag);
  return tag;
}

function ensureNamedMeta(name: string) {
  let tag = document.querySelector(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("name", name);
    document.head.appendChild(tag);
  }
  return tag;
}
