import { QuoteIcon, InvoiceIcon, CustomerIcon } from "../components/Icons";

interface DashboardPageProps {
  session?: { email: string; fullName: string; tenantId: string } | null;
  onLogout?: () => void;
}

export function DashboardPage({ session }: DashboardPageProps) {
  return (
    <div className="min-h-screen bg-zinc-950 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-8 text-3xl font-bold text-white">
          {session?.fullName ? `Welcome, ${session.fullName.split(" ")[0]}` : "Welcome to QuoteFly"}
        </h1>

        {/* Stats Grid */}
        <div className="mb-8 grid gap-4 sm:grid-cols-3">
          {[
            { icon: <QuoteIcon size={24} />, label: "Quotes This Month", value: "0" },
            { icon: <CustomerIcon size={24} />, label: "Active Customers", value: "0" },
            { icon: <InvoiceIcon size={24} />, label: "Total Revenue", value: "$0" },
          ].map((stat, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 hover:border-zinc-700 transition-colors"
            >
              <div className="mb-4 text-quotefly-blue">{stat.icon}</div>
              <p className="text-sm text-zinc-400">{stat.label}</p>
              <p className="text-2xl font-bold text-white">{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Onboarding */}
        <div className="rounded-lg border border-quotefly-blue/30 bg-quotefly-blue/5 p-8">
          <h2 className="mb-4 text-xl font-bold text-white">Get Started in 3 Steps</h2>
          <div className="space-y-4">
            {[
              { step: "1", title: "Set Your Base Pricing", desc: "Configure hourly rates and material costs for your trade" },
              { step: "2", title: "Connect to Your Phone", desc: "Link your business phone number for SMS job capture" },
              { step: "3", title: "Send Your First Quote", desc: "Receive a job via SMS and generate your first quote" },
            ].map((item, idx) => (
              <div key={idx} className="flex gap-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-quotefly-blue font-bold text-white">
                  {item.step}
                </div>
                <div>
                  <h3 className="font-semibold text-white">{item.title}</h3>
                  <p className="text-sm text-zinc-400">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Placeholder Message */}
        <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-zinc-400">
            Dashboard coming soon! The full CRM experience is under development.
          </p>
        </div>
      </div>
    </div>
  );
}
