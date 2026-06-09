import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tyagi — Voice Assistant",
  description: 'Say "Hey Tyagi" — a Jarvis-style voice assistant by Anant Kumar',
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
