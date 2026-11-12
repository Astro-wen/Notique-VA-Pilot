"use client";
import { Suspense } from "react";
import { Authed } from "@/components/Session";
import { Spinner } from "@/components/ui";
import { Console } from "@/components/va/Console";

export default function VaPage() {
  return (
    <Authed roles={["va", "admin"]}>
      <Suspense fallback={<Spinner />}>
        <Console />
      </Suspense>
    </Authed>
  );
}
