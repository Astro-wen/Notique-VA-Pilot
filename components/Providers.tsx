"use client";
import { ToastProvider } from "./ui";
import { SessionProvider } from "./Session";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SessionProvider>{children}</SessionProvider>
    </ToastProvider>
  );
}
