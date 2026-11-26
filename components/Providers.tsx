"use client";
import { ToastProvider } from "./ui";
import { SessionProvider } from "./Session";
import { UpdateNotice } from "./UpdateNotice";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SessionProvider>{children}</SessionProvider>
      <UpdateNotice />
    </ToastProvider>
  );
}
