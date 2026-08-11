import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "RATE_MANAGER" | "RESERVATIONS" | "SALES";
    } & DefaultSession["user"];
  }

  interface User {
    role: "RATE_MANAGER" | "RESERVATIONS" | "SALES";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: "RATE_MANAGER" | "RESERVATIONS" | "SALES";
  }
}
