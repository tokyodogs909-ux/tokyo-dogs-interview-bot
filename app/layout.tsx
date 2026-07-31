import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const host = /^[a-z0-9.:[\]-]+$/i.test(rawHost) ? rawHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "https" || !host.startsWith("localhost") ? "https" : "http";
  const metadataBase = new URL(`${protocol}://${host}`);
  const title = "TOKYO DOGS オンライン一次面接｜採用選考ポータル";
  const description = "TOKYO DOGSの採用選考におけるオンライン一次面接ポータルです。オンライン採用担当者の茂木が、これまでの経験、仕事選びの考え方、働き方の希望をお伺いします。";

  return {
    metadataBase,
    title,
    description,
    icons: {
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: new URL("/og-online-first-interview-v3.png", metadataBase).toString(), width: 1732, height: 908, alt: "TOKYO DOGS オンライン一次面接 採用選考ポータル" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [new URL("/og-online-first-interview-v3.png", metadataBase).toString()],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
