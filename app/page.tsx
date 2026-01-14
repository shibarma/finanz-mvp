"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "../lib/supabaseClient";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const checkSession = async () => {
      const session = await getSession();

      if (session) {
        router.replace("/app");
        return;
      }

      router.replace("/login");
    };

    checkSession();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-neutral-800">
      <p className="text-base text-neutral-600">Проверяем сессию...</p>
    </div>
  );
}
