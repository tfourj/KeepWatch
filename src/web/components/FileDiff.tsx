import { lineDiff, withContext } from "@/lib/diff";
import { cn } from "@/lib/utils";

/** A config file change as a line diff with a little context. */
export function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const lines = withContext(lineDiff(before, after));
  const changed = lines.some((l) => l && l.kind !== "same");
  return (
    <details className="rounded-md border text-sm" open={changed}>
      <summary className="cursor-pointer px-3 py-2 font-mono text-xs">
        {before ? path : `${path} (new)`}
        {!changed && <span className="text-muted-foreground"> unchanged</span>}
      </summary>
      {changed && (
        <div className="bg-muted/50 max-h-72 overflow-auto border-t p-2 font-mono text-xs">
          {lines.map((line, i) =>
            line === null ? (
              <div key={i} className="text-muted-foreground">
                ⋯
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  "break-all whitespace-pre-wrap",
                  line.kind === "add" && "text-success",
                  line.kind === "remove" && "text-destructive line-through decoration-1",
                  line.kind === "same" && "text-muted-foreground",
                )}
              >
                {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                {line.text}
              </div>
            ),
          )}
        </div>
      )}
    </details>
  );
}
