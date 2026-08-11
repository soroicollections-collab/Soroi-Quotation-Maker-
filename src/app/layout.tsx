import type { Metadata, Viewport } from "next";
import { Cinzel, Poppins } from "next/font/google";
import { AuthSessionProvider } from "@/components/session-provider";
import { AppHeader } from "@/components/app-header";
import "./globals.css";

// Matches the brand used in the generated quote PDFs (Cinzel headings, Poppins body).
// NOTE: placeholder pairing pending a look at the live soroi.com site - swap if it
// turns out the website itself uses different faces.
const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Soroi Quotation Maker",
  description: "Internal quotation tool for Soroi Collection travel quotes",
};

// Without this, there's no viewport meta tag at all, so mobile browsers fall back to
// their own default (desktop-width) viewport and render the page zoomed out - the
// responsive breakpoints below md never actually kick in until the visitor manually
// pinches to zoom, which is the "padding looks wrong until I zoom out" symptom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthSessionProvider>
          <AppHeader />
          <div className="flex flex-1 flex-col">{children}</div>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
