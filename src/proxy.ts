import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const { pathname } = req.nextUrl;
  const isLoginPage = pathname === "/login";
  const isAdminRoute = pathname.startsWith("/admin") || pathname.startsWith("/api/rates");

  if (!isLoggedIn && !isLoginPage) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  if (isLoggedIn && isAdminRoute && req.auth?.user.role !== "RATE_MANAGER") {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  if (isLoggedIn && isLoginPage) {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }
});

export const config = {
  // Excludes API auth routes, Next internals, and public static assets (images/icons/fonts)
  // from the auth check - without this, an unauthenticated request for e.g. /soroi-logo.png
  // on the login page itself gets redirected to /login (a 307, not an image).
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff|woff2)$).*)"],
};
