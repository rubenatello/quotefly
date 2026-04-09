import { useState } from "react";
import { CloseIcon } from "./Icons";
import { api, ApiError, type AuthPayload } from "../lib/api";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (payload: AuthPayload) => void;
}

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      let payload: AuthPayload;
      if (mode === "signup") {
        payload = await api.auth.signup({ email, password, fullName, companyName: businessName });
      } else {
        payload = await api.auth.signin({ email, password });
      }

      localStorage.setItem("qf_token", payload.token);
      localStorage.setItem("qf_tenant_id", payload.tenant.id);

      onSuccess?.(payload);
      setEmail(""); setPassword(""); setFullName(""); setBusinessName("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-6 py-4">
          <h2 className="text-xl font-bold text-white">
            {mode === "signin" ? "Sign In" : "Start Free Trial"}
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {/* Error banner */}
          {error && (
            <div className="rounded-lg bg-red-900/40 border border-red-700/50 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Sign Up: Full Name */}
          {mode === "signup" && (
            <div>
              <label htmlFor="fullName" className="block text-sm font-medium text-zinc-300 mb-2">
                Your Name
              </label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-quotefly-blue transition-colors"
                required
              />
            </div>
          )}

          {/* Sign Up: Business Name */}
          {mode === "signup" && (
            <div>
              <label htmlFor="business" className="block text-sm font-medium text-zinc-300 mb-2">
                Business Name
              </label>
              <input
                id="business"
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Your Contracting Company"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-quotefly-blue transition-colors"
                required
              />
            </div>
          )}

          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-zinc-300 mb-2">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-quotefly-blue transition-colors"
              required
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-zinc-300 mb-2">
              Password {mode === "signup" && <span className="text-zinc-500">(min 8 chars)</span>}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={mode === "signup" ? 8 : 1}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-quotefly-blue transition-colors"
              required
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-quotefly-blue px-4 py-2 font-semibold text-white hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? "Loading..." : mode === "signin" ? "Sign In" : "Start Free Trial"}
          </button>

          {/* Mode Toggle */}
          <div className="border-t border-zinc-700 pt-4 text-center text-sm text-zinc-400">
            {mode === "signin" ? (
              <>
                Don't have an account?{" "}
                <button type="button" onClick={() => switchMode("signup")} className="text-quotefly-blue hover:text-blue-400 transition-colors font-medium">
                  Start free trial
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" onClick={() => switchMode("signin")} className="text-quotefly-blue hover:text-blue-400 transition-colors font-medium">
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>

        {/* Footer info */}
        <div className="border-t border-zinc-700 bg-zinc-800/50 px-6 py-4 text-xs text-zinc-400">
          <p className="mb-2">✓ 14-day free trial • No credit card required</p>
          <p>By signing up, you agree to our Terms of Service and Privacy Policy</p>
        </div>
      </div>
    </div>
  );
}
