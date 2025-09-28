import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clarytix LLM Topic Splitter",
  description: "Upload a book PDF and generate chapter topics using OpenAI.",
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
