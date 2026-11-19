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

/** Select value that creates a cluster with the typed name. */
const NEW_CLUSTER = "new";

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
  const [picked, setPicked] = useState("");
  const [newCluster, setNewCluster] = useState("");
  const { data: clusters = [], isSuccess: clustersLoaded } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.get<{ clusters: Cluster[] }>("/clusters"),
    select: (d) => d.clusters,
    enabled: open,
  });

  useOnOpen(open, () => {
    setName(node?.name ?? "");
    setDescription(node?.description ?? "");
    setPicked(node?.clusterId ?? "");
    setNewCluster("");
  });

  // With one cluster it is the obvious pick; with none, a new one is the only choice.
  const clusterChoice =
    picked || (clusters.length === 1 ? clusters[0]!.id : clustersLoaded && clusters.length === 0 ? NEW_CLUSTER : "");
  const creating = clusterChoice === NEW_CLUSTER;
  const ready = !!name.trim() && !!clusterChoice && (!creating || !!newCluster.trim());

  const save = useAction(
    async () => {
      const clusterId = creating
        ? (await api.post<{ cluster: Cluster }>("/clusters", { name: newCluster.trim() })).cluster.id
        : clusterChoice;
      const body = { name, description: description.trim() || null, clusterId };
      return node
        ? api.patch<{ node: KeepNode }>(`/nodes/${node.id}`, body)
        : api.post<{ node: KeepNode }>("/nodes", body);
    },
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
            <Select value={clusterChoice} onValueChange={setPicked} required>
              <SelectTrigger className="w-full" aria-label="Cluster">
                <SelectValue placeholder="Pick a cluster" />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CLUSTER}>New cluster</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {creating && (
            <Field label="New cluster name" htmlFor="node-new-cluster">
              <Input
                id="node-new-cluster"
                value={newCluster}
                placeholder="homelab"
                onChange={(e) => setNewCluster(e.target.value)}
                required
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !ready}>
              {node ? "Save" : "Add and set up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
