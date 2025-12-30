import React, { useState } from "react";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Printer, Loader2 } from "lucide-react";

export function PrintPipelineButton({ orgId }) {
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      const url = createPageUrl(`PrintPipeline?orgId=${orgId}`);
      const printWindow = window.open(url, "_blank", "noopener,noreferrer");
      if (!printWindow) {
        alert("Your browser blocked the print tab. Please allow pop-ups for this site and try again.");
      }
    } catch (err) {
      console.error(err);
      alert("Could not open the print preview. Please try again.");
    } finally {
      // Give the new tab a moment to open before resetting the state
      setTimeout(() => setBusy(false), 1000);
    }
  };

  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={busy}
      title={busy ? "Preparing print…" : "Print Pipeline"}
    >
      {busy ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <Printer className="w-4 h-4 mr-2" />
      )}
      {busy ? "Preparing…" : "Print Pipeline"}
    </Button>
  );
}