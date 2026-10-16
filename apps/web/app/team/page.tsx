"use client";
import { useEffect, useState } from "react";
type User = {
  id: string;
  username: string;
  admin: boolean;
  memberships: { projectId: string; role: string }[];
};
type Project = { id: string; title: string };
async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  return value;
}
export default function Team() {
  const [users, setUsers] = useState<User[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [userId, setUserId] = useState(""),
    [projectId, setProjectId] = useState(""),
    [role, setRole] = useState("analysis"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const [u, p] = await Promise.all([
      api("/api/users"),
      api("/api/portfolio"),
    ]);
    setUsers(u.users);
    setProjects(p.projects);
    setUserId((v) => v || u.users[0]?.id || "");
    setProjectId((v) => v || p.projects[0]?.id || "");
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main dir="rtl" className="max-w-4xl mx-auto p-6 space-y-6">
      <nav className="flex gap-4">
        <a href="/portfolio">فضای پروژه‌ها</a>
        <a href="/">اجرا و بازبینی</a>
      </nav>
      <h1 className="text-2xl font-bold">حساب‌ها و دسترسی پروژه</h1>
      <p className="subtle">
        این صفحه مخصوص مدیر سیستم است. دسترسی‌ها در سرور اعمال می‌شوند. نقش مدیر
        پروژه اجازهٔ تأیید تخصصی مرحله را نمی‌دهد؛ نقش بازبین را جداگانه اختصاص
        دهید.
      </p>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-emerald-700">
          {notice}
        </p>
      )}
      <form
        className="frost p-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await api("/api/users", { username, password });
            setPassword("");
            setUsername("");
            setNotice("حساب ایجاد شد.");
          });
        }}
      >
        <h2 className="font-bold">حساب جدید</h2>
        <input
          className="input"
          placeholder="نام کاربری لاتین"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          className="input"
          placeholder="گذرواژه، حداقل ۱۲ نویسه"
          autoComplete="new-password"
          type="password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="btn" disabled={busy}>
          ایجاد حساب
        </button>
      </form>
      <form
        className="frost p-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await api(`/api/users/${userId}/memberships`, { projectId, role });
            setNotice(
              "دسترسی و عضویت ثبت شد؛ بازبین تسک‌های جدید از این تیم انتخاب می‌شود.",
            );
          });
        }}
      >
        <h2 className="font-bold">اختصاص نقش پروژه</h2>
        <select
          className="input"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          {[
            ["manager", "مدیر پروژه"],
            ["analysis", "تحلیلگر"],
            ["backend", "بک‌اند"],
            ["frontend", "فرانت‌اند"],
            ["qa", "QA"],
            ["viewer", "مشاهده‌گر"],
          ].map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy || !projectId || !userId}>
          ثبت دسترسی
        </button>
      </form>
      <section className="frost p-5 space-y-4">
        <h2 className="font-bold">اعضای ثبت‌شده</h2>
        {users.map((u) => (
          <div key={u.id} className="border-t py-3">
            <strong>
              {u.username}
              {u.admin ? " · مدیر سیستم" : ""}
            </strong>
            {u.memberships.map((m) => (
              <p className="subtle mt-2" key={`${m.projectId}/${m.role}`}>
                {projects.find((p) => p.id === m.projectId)?.title ||
                  m.projectId}{" "}
                · {m.role}
              </p>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}
