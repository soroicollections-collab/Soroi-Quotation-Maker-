import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createUser } from "./actions";
import { RoleSelect } from "./role-select";

export default async function AdminUsersPage() {
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    return <main className="p-8">Not authorized.</main>;
  }

  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
      <h1 className="text-2xl font-semibold">Users &amp; roles</h1>
      <p className="text-sm text-gray-500">
        Rate Manager can upload/publish rate updates. Reservations and Sales can only use
        the quote chat - the two are currently identical in what they can access, this is
        just for telling accounts apart at a glance. Handing the Rate Manager role to
        someone else is just a dropdown change here - no redeploy needed.
      </p>

      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2">Name</th>
            <th className="py-2">Email</th>
            <th className="py-2">Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b">
              <td className="py-2">{u.name}</td>
              <td className="py-2">{u.email}</td>
              <td className="py-2">
                <RoleSelect userId={u.id} currentRole={u.role} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Add a new account</h2>
        <form action={createUser} className="flex flex-col gap-3 max-w-sm">
          <input name="name" placeholder="Full name" required className="rounded border px-3 py-2" />
          <input name="email" type="email" placeholder="Email" required className="rounded border px-3 py-2" />
          <input name="password" type="password" placeholder="Temporary password (min 8 chars)" required minLength={8} className="rounded border px-3 py-2" />
          <select name="role" defaultValue="RESERVATIONS" className="rounded border px-3 py-2">
            <option value="RESERVATIONS">Reservations</option>
            <option value="SALES">Sales</option>
            <option value="RATE_MANAGER">Rate Manager</option>
          </select>
          <button type="submit" className="rounded bg-black px-3 py-2 text-white">
            Create account
          </button>
        </form>
      </section>
    </main>
  );
}
