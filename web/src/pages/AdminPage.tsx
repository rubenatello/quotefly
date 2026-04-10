import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api, type OrganizationUser, type OrgUserRole, type TenantEntitlements } from "../lib/api";
import { setSEOMetadata } from "../lib/seo";

interface AdminPageProps {
  session?: {
    tenantId: string;
    role: string;
    entitlements?: TenantEntitlements;
  } | null;
}

type NewUserForm = {
  fullName: string;
  email: string;
  password: string;
  role: OrgUserRole;
};

const EMPTY_NEW_USER: NewUserForm = {
  fullName: "",
  email: "",
  password: "",
  role: "member",
};

function normalizeRole(role: string): OrgUserRole {
  const value = role.trim().toLowerCase();
  if (value === "owner" || value === "admin") return value;
  return "member";
}

function roleLabel(role: OrgUserRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

function dateText(value: string): string {
  return new Date(value).toLocaleDateString();
}

export function AdminPage({ session }: AdminPageProps) {
  const [members, setMembers] = useState<OrganizationUser[]>([]);
  const [teamMembersLimit, setTeamMembersLimit] = useState<number | null>(
    session?.entitlements?.limits.teamMembers ?? null,
  );
  const [teamMembersUsed, setTeamMembersUsed] = useState(0);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<NewUserForm>(EMPTY_NEW_USER);

  const sessionRole = normalizeRole(session?.role ?? "member");
  const ownerView = sessionRole === "owner";

  useEffect(() => {
    setSEOMetadata({
      title: "Organization Admin",
      description: "Manage team members and organization access settings.",
    });
    void loadMembers();
  }, []);

  async function loadMembers() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.org.users.list();
      setMembers(result.members);
      setCanManageUsers(result.policy.canManageUsers);
      setTeamMembersLimit(result.policy.teamMembersLimit);
      setTeamMembersUsed(result.policy.teamMembersUsed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading organization users.");
    } finally {
      setLoading(false);
    }
  }

  async function createMember(event: FormEvent) {
    event.preventDefault();
    if (!canManageUsers) return;

    setSaving(true);
    setError(null);
    try {
      await api.org.users.create({
        fullName: form.fullName.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
      });
      setForm(EMPTY_NEW_USER);
      await loadMembers();
      setNotice("Team member added.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating team member.");
    } finally {
      setSaving(false);
    }
  }

  async function updateMemberRole(memberId: string, role: OrgUserRole) {
    if (!ownerView) return;
    setSaving(true);
    setError(null);
    try {
      await api.org.users.updateRole(memberId, { role });
      await loadMembers();
      setNotice("Role updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating member role.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMember(memberId: string) {
    if (!ownerView) return;
    if (!confirm("Remove this member from your organization?")) return;

    setSaving(true);
    setError(null);
    try {
      await api.org.users.remove(memberId);
      await loadMembers();
      setNotice("Member removed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed removing member.");
    } finally {
      setSaving(false);
    }
  }

  const seatUsageText = useMemo(() => {
    if (teamMembersLimit === null) return `${teamMembersUsed} seats in use`;
    return `${teamMembersUsed}/${teamMembersLimit} seats in use`;
  }, [teamMembersLimit, teamMembersUsed]);

  if (loading) {
    return <div className="min-h-screen bg-slate-50 p-6 text-slate-700">Loading organization settings...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <h1 className="text-2xl font-bold text-slate-900">Organization Admin</h1>
          <p className="mt-2 text-sm text-slate-600">
            Manage team users and seat limits by subscription tier.
          </p>
          <div className="mt-3 inline-flex rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
            {seatUsageText}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Role permissions: Owner can edit roles/remove members. Admin can add members. Member is read-only.
          </div>
        </section>

        {error && (
          <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <form onSubmit={createMember} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Add Team Member</h2>
            <input
              placeholder="Full name"
              value={form.fullName}
              onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving}
              required
            />
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving}
              required
            />
            <input
              type="password"
              minLength={8}
              placeholder="Temporary password (min 8)"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving}
              required
            />
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as OrgUserRole }))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              disabled={!canManageUsers || saving}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
            <button
              type="submit"
              disabled={!canManageUsers || saving}
              className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {saving ? "Saving..." : "Add User"}
            </button>
            {!canManageUsers && (
              <p className="text-xs text-slate-500">
                Your role cannot add users. Ask an Owner/Admin.
              </p>
            )}
          </form>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold text-slate-900">Organization Users</h2>
            <div className="space-y-3">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:flex sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{member.user.fullName}</p>
                    <p className="text-xs text-slate-600">{member.user.email}</p>
                    <p className="text-[11px] text-slate-500">Joined {dateText(member.createdAt)}</p>
                  </div>
                  <div className="mt-3 flex items-center gap-2 sm:mt-0">
                    <select
                      value={member.role}
                      disabled={!ownerView || saving}
                      onChange={(event) =>
                        void updateMemberRole(member.id, event.target.value as OrgUserRole)
                      }
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-60"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                    <span className="rounded-full border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700">
                      {roleLabel(member.role)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeMember(member.id)}
                      disabled={!ownerView || member.role === "owner" || saving}
                      className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {!members.length && (
                <p className="rounded-lg border border-slate-200 bg-white px-3 py-4 text-sm text-slate-500">
                  No organization users found.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
