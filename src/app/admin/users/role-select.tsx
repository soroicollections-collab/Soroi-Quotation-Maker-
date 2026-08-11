"use client";

import { useTransition } from "react";
import { updateUserRole } from "./actions";

export function RoleSelect({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: "RATE_MANAGER" | "RESERVATIONS" | "SALES";
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <select
      defaultValue={currentRole}
      disabled={isPending}
      onChange={(e) => {
        const value = e.target.value;
        const role = value === "RATE_MANAGER" || value === "SALES" ? value : "RESERVATIONS";
        startTransition(() => {
          updateUserRole(userId, role);
        });
      }}
      className="rounded border px-2 py-1"
    >
      <option value="RESERVATIONS">Reservations</option>
      <option value="SALES">Sales</option>
      <option value="RATE_MANAGER">Rate Manager</option>
    </select>
  );
}
