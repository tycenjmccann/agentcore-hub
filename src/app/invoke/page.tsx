"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function InvokeRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agent");

  useEffect(() => {
    if (agentId) {
      router.replace(`/agents/${agentId}`);
    } else {
      router.replace("/agents");
    }
  }, [agentId, router]);

  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-sm text-gray-500">Redirecting...</p>
    </div>
  );
}

export default function InvokePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><span className="text-gray-500 text-sm">Loading...</span></div>}>
      <InvokeRedirect />
    </Suspense>
  );
}
