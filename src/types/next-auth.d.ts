import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "RATE_MANAGER" | "STAFF";
    } & DefaultSession["user"];
  }

  interface User {
    role: "RATE_MANAGER" | "STAFF";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: "RATE_MANAGER" | "STAFF";
  }
}
