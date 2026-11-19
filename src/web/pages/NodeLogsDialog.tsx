import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { KeepNode } from "@/lib/types";

/** The last lines of keepalived's journal on a node. */
export function NodeLogsDialog({ node, onClose }: { node: KeepNode | null; onClose: () => void }) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["node-logs", node?.id],
    queryFn: () => api.post<{ log: string }>(`/nodes/${node!.id}/logs`, { lines: 300 }),
    enabled: !!node,
    retry: false,
  });
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-8">
          <DialogTitle>keepalived log on {node?.name}</DialogTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "animate-spin" : ""} />
            Refresh
          </Button>
        </DialogHeader>
        {error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : !data ? (
          <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
        ) : (
          <pre
            className={
              "bg-muted/50 max-h-[60vh] overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap"
            }
          >
            {data.log.trim() || "No log lines"}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
