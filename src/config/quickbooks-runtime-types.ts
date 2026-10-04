/** Structural provider configuration shared by the API and the isolated worker. */
export interface QuickBooksProviderHttpEnv {
  QUICKBOOKS_ENVIRONMENT: "sandbox" | "production";
  QUICKBOOKS_PROVIDER_TIMEOUT_MS: number;
  QUICKBOOKS_PROVIDER_READ_RETRIES: number;
}

export interface QuickBooksCredentialRuntimeEnv extends QuickBooksProviderHttpEnv {
  QUICKBOOKS_CLIENT_ID: string;
  QUICKBOOKS_CLIENT_SECRET: string;
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: string;
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: string;
  /** Legacy token envelopes still require this until they have been migrated. */
  JWT_SECRET: string;
}

export interface QuickBooksOAuthRuntimeEnv extends QuickBooksCredentialRuntimeEnv {
  API_URL: string;
  QUICKBOOKS_REDIRECT_URI: string;
}
