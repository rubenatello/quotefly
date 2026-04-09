export function QuoteFlyLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Blue gradient circle */}
      <defs>
        <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>
      </defs>

      {/* Circle background */}
      <circle cx="20" cy="20" r="18" fill="url(#logoGradient)" opacity="0.1" />

      {/* Quote mark - minimalist design */}
      <path
        d="M11 12C11 10.8954 11.8954 10 13 10C14.1046 10 15 10.8954 15 12V16C15 19.3137 12.3137 22 9 22H8V20C8 18.8954 8.8954 18 10 18H11V12Z"
        fill="url(#logoGradient)"
      />
      <path
        d="M25 12C25 10.8954 25.8954 10 27 10C28.1046 10 29 10.8954 29 12V16C29 19.3137 26.3137 22 23 22H22V20C22 18.8954 22.8954 18 24 18H25V12Z"
        fill="url(#logoGradient)"
        opacity="0.6"
      />
    </svg>
  );
}
