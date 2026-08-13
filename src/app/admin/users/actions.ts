"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

async function requireRateManager() {
  const session = await auth();
  if (session?.user?.role !== "RATE_MANAGER") {
    throw new Error("Only a Rate Manager can manage users.");
  }
  return session;
}

export async function updateUserRole(userId: string, role: "RATE_MANAGER" | "RESERVATIONS" | "SALES") {
  await requireRateManager();
  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath("/admin/users");
}

export async function updateUserName(userId: string, name: string) {
  await requireRateManager();
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Name cannot be empty.");
  }
  await prisma.user.update({ where: { id: userId }, data: { name: trimmed } });
  revalidatePath("/admin/users");
}

export async function createUser(formData: FormData) {
  await requireRateManager();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const roleValue = formData.get("role");
  const role = roleValue === "RATE_MANAGER" || roleValue === "SALES" ? roleValue : "RESERVATIONS";

  if (!email || !name || password.length < 8) {
    throw new Error("Email, name, and a password of at least 8 characters are required.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { email, name, passwordHash, role } });
  revalidatePath("/admin/users");
}
