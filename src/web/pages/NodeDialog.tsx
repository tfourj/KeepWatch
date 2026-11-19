import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import { useOnOpen } from "@/lib/use-on-open";
import type { Cluster, KeepNode } from "@/lib/types";

const NO_CLUSTER = "none";

/** Create or edit a node. Creating one opens the setup wizard afterwards. */
export function NodeDialog({
  open,
  onOpenChange,
  node,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  node?: KeepNode;
  onCreated?: (node: KeepNode) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [clusterId, setClusterId] = useState(NO_CLUSTER);
  const { data: clusters = [] } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.get<{ clusters: Cluster[] }>("/clusters"),
    select: (d) => d.clusters,
    enabled: open,
  });

  useOnOpen(open, () => {
    setName(node?.name ?? "");
    setDescription(node?.description ?? "");
    setClusterId(node?.clusterId ?? NO_CLUSTER);
  });

  const body = () => ({
    name,
    description: description.trim() || null,
    clusterId: clusterId === NO_CLUSTER ? null : clusterId,
  });
  const save = useAction(
    () =>
      node
        ? api.patch<{ node: KeepNode }>(`/nodes/${node.id}`, body())
        : api.post<{ node: KeepNode }>("/nodes", body()),
    {
      invalidate: [["nodes"], ["clusters"], ["overview"]],
      success: node ? "Node saved" : undefined,
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{node ? `Edit ${node.name}` : "Add node"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await save.mutateAsync(undefined);
            onOpenChange(false);
            if (!node) onCreated?.(result.node);
          }}
        >
          <Field label="Name" htmlFor="node-name">
            <Input id="node-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Description" htmlFor="node-description">
            <Input id="node-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Cluster">
            <Select value={clusterId} onValueChange={setClusterId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CLUSTER}>No cluster</SelectItem>
                {clusters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {node ? "Save" : "Add and set up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
