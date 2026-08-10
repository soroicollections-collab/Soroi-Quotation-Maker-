"use client";

import { useTransition } from "react";
import { updateUserRole } from "./actions";

export function RoleSelect({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: "RATE_MANAGER" | "STAFF";
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <select
      defaultValue={currentRole}
      disabled={isPending}
      onChange={(e) => {
        const role = e.target.value === "RATE_MANAGER" ? "RATE_MANAGER" : "STAFF";
        startTransition(() => {
          updateUserRole(userId, role);
        });
      }}
      className="rounded border px-2 py-1"
    >
      <option value="STAFF">Staff</option>
      <option value="RATE_MANAGER">Rate Manager</option>
    </select>
  );
}
