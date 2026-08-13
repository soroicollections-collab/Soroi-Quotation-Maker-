"use client";

import { useState, useTransition } from "react";
import { updateUserName } from "./actions";

export function NameEditor({ userId, currentName }: { userId: string; currentName: string }) {
  const [value, setValue] = useState(currentName);
  const [isPending, startTransition] = useTransition();

  function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === currentName) {
      setValue(currentName);
      return;
    }
    startTransition(() => {
      updateUserName(userId, trimmed);
    });
  }

  return (
    <input
      value={value}
      disabled={isPending}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setValue(currentName);
          e.currentTarget.blur();
        }
      }}
      className="rounded border px-2 py-1"
    />
  );
}
