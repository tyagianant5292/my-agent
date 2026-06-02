import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My Agent",
  description: "Apna agentic AI chatbot",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
