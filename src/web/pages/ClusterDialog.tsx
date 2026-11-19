import { useState } from "react";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import { useOnOpen } from "@/lib/use-on-open";
import type { Cluster } from "@/lib/types";

export function ClusterDialog({
  open,
  onOpenChange,
  cluster,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cluster?: Cluster;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useOnOpen(open, () => {
    setName(cluster?.name ?? "");
    setDescription(cluster?.description ?? "");
  });
  const body = () => ({ name, description: description.trim() || null });
  const save = useAction(
    () => (cluster ? api.patch(`/clusters/${cluster.id}`, body()) : api.post("/clusters", body())),
    { invalidate: [["clusters"], ["overview"]], success: cluster ? "Cluster saved" : "Cluster added" },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cluster ? `Edit ${cluster.name}` : "Add cluster"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          <Field label="Name" htmlFor="cluster-name">
            <Input id="cluster-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Description" htmlFor="cluster-description">
            <Input id="cluster-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {cluster ? "Save" : "Add cluster"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
