import type { Metadata } from "next";
import "./globals.css";
import "./frontend-fixes.css";
import "./toast.css";
import { ToastHost } from "@/components/toast";

export const metadata: Metadata = {
  title: "AI Caller",
  description: "AI-powered customer communication and appointment booking.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<ToastHost /></body>
    </html>
  );
}
